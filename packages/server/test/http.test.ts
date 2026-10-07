// Not covered here: real network behaviour (DNS, TLS, slow peers on the
// internet). The handler tests run a real local HTTP server; the smoke script
// runs against real testnet RPC.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BODY_BYTES,
  OutboundError,
  errorResponse,
  fetchWithTimeout,
  json,
  readJsonBody,
  type OutboundTarget,
} from "../src/http.ts";
import { createLogger } from "../src/log.ts";
import { testConfig } from "./helpers.ts";

const cfg = testConfig();

function post(body: string | Uint8Array | ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}): Request {
  return new Request("https://server.test/api/sponsor", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(16 * 1024, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x20));
    },
  });
}

describe("json helpers", () => {
  it("sets the JSON, no-store and nosniff headers", async () => {
    const res = json({ a: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("error bodies carry only the code", async () => {
    const res = errorResponse(400, "bad_shape");
    expect(await res.json()).toEqual({ error: "bad_shape" });
  });
});

describe("readJsonBody", () => {
  it("parses a body under the cap", async () => {
    expect(await readJsonBody(post(JSON.stringify({ x: [1, 2] })))).toEqual({ ok: true, value: { x: [1, 2] } });
  });

  it("refuses a declared length over 64 KiB without reading the body", async () => {
    const body = streamOf(10);
    const spy = vi.spyOn(body, "getReader");
    const res = await readJsonBody(post(body, { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(res).toEqual({ ok: false, status: 413, code: "body_too_large" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a streamed body over 64 KiB even with no length header", async () => {
    expect(await readJsonBody(post(streamOf(MAX_BODY_BYTES + 1)))).toEqual({
      ok: false,
      status: 413,
      code: "body_too_large",
    });
  });

  it("accepts exactly 64 KiB", async () => {
    const text = JSON.stringify("x".repeat(MAX_BODY_BYTES - 2));
    expect((await readJsonBody(post(text))).ok).toBe(true);
  });

  it("refuses bad JSON, bad UTF-8 and an empty body", async () => {
    expect(await readJsonBody(post("{nope"))).toMatchObject({ ok: false, code: "invalid_json" });
    expect(await readJsonBody(post(new Uint8Array([0x22, 0xff, 0x22])))).toMatchObject({ ok: false, code: "invalid_json" });
    expect(await readJsonBody(post(null))).toMatchObject({ ok: false, code: "invalid_json" });
    expect(await readJsonBody(post("{}", { "content-length": "12abc" }))).toMatchObject({ code: "body_too_large" });
  });
});

describe("fetchWithTimeout", () => {
  const ok = (body = "{}") => vi.fn(async () => new Response(body, { status: 200 }));

  it("calls exactly the configured URL, with redirects refused", async () => {
    const fetchImpl = ok();
    const res = await fetchWithTimeout(cfg, "RPC_URL", { method: "POST", body: "{}" }, fetchImpl);
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(cfg.RPC_URL);
    expect(init.redirect).toBe("error");
  });

  it("refuses a target that is not a config key, even if a caller forces one", async () => {
    const fetchImpl = ok();
    const forced = "https://evil.example" as unknown as OutboundTarget;
    await expect(fetchWithTimeout(cfg, forced, { method: "GET" }, fetchImpl)).rejects.toThrow(OutboundError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a config value that breaks the outbound rule", async () => {
    const tampered = { ...cfg, RPC_URL: "http://internal.example" };
    await expect(fetchWithTimeout(tampered, "RPC_URL", { method: "GET" }, ok())).rejects.toMatchObject({
      failure: "network",
    });
  });

  it("times out, and a caller deadline aborts", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await expect(fetchWithTimeout(cfg, "RPC_URL", { method: "GET", timeoutMs: 20 }, hang)).rejects.toMatchObject({
      failure: "timeout",
    });
    await expect(
      fetchWithTimeout(cfg, "RPC_URL", { method: "GET", signal: AbortSignal.timeout(10) }, hang),
    ).rejects.toMatchObject({ failure: "aborted" });
  });

  it("caps the response size and hides upstream error text", async () => {
    await expect(
      fetchWithTimeout(cfg, "RPC_URL", { method: "GET", maxResponseBytes: 8 }, ok("0123456789")),
    ).rejects.toMatchObject({ failure: "response_too_large" });
    const boom = vi.fn(async () => {
      throw new Error("upstream said token=abc123");
    });
    const err = await fetchWithTimeout(cfg, "CHANNELS_URL", { method: "POST" }, boom).catch((e: Error) => e);
    expect(err).toMatchObject({ failure: "network" });
    expect((err as Error).message).not.toContain("abc123");
  });
});

describe("createLogger", () => {
  it("scrubs every spelling of every secret from the finished line", () => {
    const lines: string[] = [];
    const secret = 'pa"ss/word+1';
    const log = createLogger([secret, "abc"], (l) => lines.push(l));
    log.warn("upstream_error", {
      raw: "failed with " + secret,
      url: "postgres://u:" + encodeURIComponent(secret) + "@h/db",
      big: 12n,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("ss/word");
    expect(lines[0]).not.toContain(encodeURIComponent(secret));
    expect(lines[0]).toContain("[redacted]");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", event: "upstream_error", big: "12" });
  });

  it("still logs when fields cannot be serialised", () => {
    const lines: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    createLogger([], (l) => lines.push(l)).info("x", { cyclic });
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "x", note: "fields not serialisable" });
  });
});
