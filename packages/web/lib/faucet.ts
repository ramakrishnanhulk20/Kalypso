/**
 * The browser's side of the test-money faucet: POST /api/faucet, which pays 100 test XLM (creating
 * the account if it does not exist) or 100 test USDC (the account must already hold a USDC
 * trustline). Every refusal the server sends, and the three failures this client finds itself,
 * has a code here and a sentence in every language (threat model C56).
 */

export type FaucetAsset = "xlm" | "usdc";

/** The codes the server's faucet handler refuses with. The first four are its limits, all HTTP 429. */
const SERVER_CODES = [
  "rate_limited",
  "already_claimed",
  "network_limit",
  "daily_limit",
  "no_account",
  "no_trustline",
  "trustline_unauthorized",
  "trustline_full",
  "faucet_empty",
  "faucet_busy",
  "not_configured",
  "rpc_unavailable",
  "payout_unconfirmed",
  "payout_failed",
  "bad_request",
  "bad_address",
  "method_not_allowed",
  "no_client_ip",
  "internal_error",
] as const;

/** Failures with no usable answer from the server: no connection, a reply that is not the agreed shape, a code nobody knows. */
const CLIENT_CODES = ["network", "bad_reply", "unknown"] as const;

/** Every code a claim can fail with, for screens and tests that list them. */
export const FAUCET_CODES = [...SERVER_CODES, ...CLIENT_CODES] as const;

export type FaucetCode = (typeof FAUCET_CODES)[number];

/**
 * A claim did not end in a confirmed payout. `code` says why; the screen picks the sentence. `hash`
 * is set only for payout_unconfirmed: the payout the server sent and could not yet see on chain.
 */
export class FaucetError extends Error {
  readonly code: FaucetCode;
  readonly hash: string | undefined;

  constructor(code: FaucetCode, hash?: string) {
    super(`The faucet did not pay: ${code}.`);
    this.name = "FaucetError";
    this.code = code;
    this.hash = hash;
  }
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * How long the page waits for a claim: 15 s past the server's own bound on a claim, FAUCET_MAX_MS
 * (45 s, packages/server/src/faucet/limits.ts), so the page never gives up on a payout the server is
 * still confirming. A literal, because this file runs in the browser and must import nothing from
 * the server package; lib/faucet.test.ts holds the two numbers together.
 */
export const FAUCET_CLIENT_TIMEOUT_MS = 60_000;
const MAX_REPLY_CHARS = 4 * 1024;
const TX_HASH = /^[0-9a-f]{64}$/;
const DIGITS = /^\d{1,30}$/;

function isServerCode(value: unknown): value is (typeof SERVER_CODES)[number] {
  return typeof value === "string" && (SERVER_CODES as readonly string[]).includes(value);
}

function parseJson(text: string): unknown {
  if (text.length > MAX_REPLY_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asks the faucet to pay `address` test money, and returns what it paid once the payout is on
 * chain. `amount` is in stroops. The reply must be exactly `{ hash, asset, amount }`, with a
 * 64-character lowercase hex hash, an amount of digits only, and the asset that was asked for;
 * anything else is bad_reply, so a wrong answer is never shown as a payout.
 *
 * @throws FaucetError with a server code for a refusal (an unknown code in a refusal is "unknown");
 *   payout_unconfirmed carries the payout's hash, and one whose reply is not exactly
 *   `{ error, hash }` with a 64-character lowercase hex hash is "bad_reply";
 *   "network" when the request fails or runs past FAUCET_CLIENT_TIMEOUT_MS, "bad_reply" for a reply in the wrong shape.
 */
export async function claimTestFunds(
  address: string,
  asset: FaucetAsset,
  fetchImpl: FetchLike = fetch,
): Promise<{ hash: string; asset: FaucetAsset; amount: bigint }> {
  let response: { status: number; text(): Promise<string> };
  let text: string;
  try {
    response = await fetchImpl("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, asset }),
      signal: AbortSignal.timeout(FAUCET_CLIENT_TIMEOUT_MS),
      redirect: "error",
    });
    text = await response.text();
  } catch {
    throw new FaucetError("network");
  }

  const body = parseJson(text);
  if (response.status !== 200) {
    if (isRecord(body) && body.error === "payout_unconfirmed") {
      // The hash goes into a link, so it is held to the same rule as a payout's.
      const exact = Object.keys(body).length === 2 && typeof body.hash === "string" && TX_HASH.test(body.hash);
      throw exact ? new FaucetError("payout_unconfirmed", body.hash as string) : new FaucetError("bad_reply");
    }
    throw new FaucetError(isRecord(body) && isServerCode(body.error) ? body.error : "unknown");
  }

  if (
    !isRecord(body) ||
    Object.keys(body).length !== 3 ||
    typeof body.hash !== "string" ||
    !TX_HASH.test(body.hash) ||
    body.asset !== asset ||
    typeof body.amount !== "string" ||
    !DIGITS.test(body.amount)
  ) {
    throw new FaucetError("bad_reply");
  }
  return { hash: body.hash, asset, amount: BigInt(body.amount) };
}
