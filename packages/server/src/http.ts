import { isAllowedOutboundUrl, type Config } from "./config.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const OUTBOUND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/**
 * Error bodies carry one of our own short codes and nothing else from the
 * failure: no upstream text, no exception message, no request echo. That is
 * what keeps a secret that leaked into an upstream reply from reaching a
 * caller.
 */
export function errorResponse(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json({ error: code }, status, headers);
}

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; code: "body_too_large" | "invalid_json" };

/**
 * Reads a JSON request body, refusing anything over `maxBytes`. The declared
 * Content-Length is checked first so an honest oversized request is refused
 * without reading it, and the stream is still counted byte by byte because
 * the header can lie or be absent.
 */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, status: 413, code: "body_too_large" };
  }
  const bytes = await readCapped(req.body, maxBytes);
  if (bytes === null) return { ok: false, status: 413, code: "body_too_large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, status: 400, code: "invalid_json" };
  }
}

/** Returns null as soon as the stream passes `maxBytes`, and cancels it. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type OutboundTarget = "RPC_URL" | "CHANNELS_URL";

export type OutboundFailure = "timeout" | "aborted" | "network" | "response_too_large";

export class OutboundError extends Error {
  readonly failure: OutboundFailure;
  constructor(failure: OutboundFailure) {
    super("outbound request failed: " + failure);
    this.name = "OutboundError";
    this.failure = failure;
  }
}

export interface OutboundRequest {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** A caller deadline on top of the fixed timeout; the archive's lazy catch-up uses it. */
  signal?: AbortSignal;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface OutboundResponse {
  status: number;
  body: Uint8Array;
}

/**
 * The only outbound HTTP call in the server (threat model C22).
 *
 * It takes the NAME of a config key, never a URL, so no value from a request
 * can choose where the server connects. The URL is re-checked against the
 * outbound rule, redirects are refused (a redirect could move the call to
 * another origin), every call ends within the timeout (10 s unless a test
 * shortens it), and the response body is capped.
 *
 * Throws OutboundError with a fixed failure name; the message never carries
 * upstream text.
 */
export async function fetchWithTimeout(
  cfg: Pick<Config, OutboundTarget>,
  target: OutboundTarget,
  request: OutboundRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<OutboundResponse> {
  if (target !== "RPC_URL" && target !== "CHANNELS_URL") throw new OutboundError("network");
  const url = cfg[target];
  if (!isAllowedOutboundUrl(url)) throw new OutboundError("network");

  const timeout = AbortSignal.timeout(request.timeoutMs ?? OUTBOUND_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  const init: RequestInit = { method: request.method, redirect: "error", signal };
  if (request.headers) init.headers = request.headers;
  if (request.body !== undefined) init.body = request.body;
  try {
    const res = await fetchImpl(url, init);
    const body = await readCapped(res.body, request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    if (body === null) throw new OutboundError("response_too_large");
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof OutboundError) throw err;
    if (timeout.aborted) throw new OutboundError("timeout");
    if (request.signal?.aborted) throw new OutboundError("aborted");
    throw new OutboundError("network");
  }
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
