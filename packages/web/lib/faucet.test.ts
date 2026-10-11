// Covers the faucet client: the exact request (path, method, JSON body, redirect refusal, a timeout
// signal), a good reply read strictly (exact keys, a 64-character lowercase hex hash, an amount of
// digits only, the asset that was asked for), every server refusal code to its FaucetError, an
// unknown or missing code to "unknown", a failed request or a timeout to "network", and a reply in
// the wrong shape to "bad_reply".
// Does NOT cover the live /api/faucet route (packages/server tests do) or the sentences shown for
// each code (messages.test.ts requires one per code in every language).
import { describe, expect, it } from "vitest";
import { FAUCET_MAX_MS } from "@kalypso/server";
import { FAUCET_CLIENT_TIMEOUT_MS, FAUCET_CODES, FaucetError, claimTestFunds } from "./faucet";

type Init = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" };

function fakeFetch(answer: (url: string, init: Init) => { status: number; body: unknown } | Promise<never>) {
  const calls: { url: string; init: Init }[] = [];
  const fetch = async (url: string, init: Init) => {
    calls.push({ url, init });
    const a = await answer(url, init);
    return { status: a.status, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}

const HASH = "ab".repeat(32);
const ADDRESS = "GBSDDY2NMUMLVTXGTKJ2R7JBJDRWG2NJN6J7ZHLZHT6NJID6ZEYFGKSK";
const LONG_DASH = String.fromCharCode(0x2014);

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(FaucetError);
    return (err as FaucetError).code;
  }
}

describe("claimTestFunds", () => {
  it("posts the address and asset as JSON to /api/faucet and reads the payout", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { hash: HASH, asset: "xlm", amount: "1000000000" } }));
    const paid = await claimTestFunds(ADDRESS, "xlm", f.fetch);
    expect(paid).toEqual({ hash: HASH, asset: "xlm", amount: 1_000_000_000n });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/faucet");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(f.calls[0]!.init.body)).toEqual({ address: ADDRESS, asset: "xlm" });
  });

  it("asks for usdc by name and returns the amount as a bigint", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { hash: HASH, asset: "usdc", amount: "1000000000" } }));
    expect(await claimTestFunds(ADDRESS, "usdc", f.fetch)).toEqual({ hash: HASH, asset: "usdc", amount: 1_000_000_000n });
    expect(JSON.parse(f.calls[0]!.init.body)).toEqual({ address: ADDRESS, asset: "usdc" });
  });

  it.each([
    ["rate_limited", 429],
    ["already_claimed", 429],
    ["network_limit", 429],
    ["daily_limit", 429],
    ["no_account", 409],
    ["no_trustline", 409],
    ["trustline_unauthorized", 409],
    ["trustline_full", 409],
    ["faucet_empty", 503],
    ["faucet_busy", 503],
    ["not_configured", 503],
    ["rpc_unavailable", 503],
    ["payout_failed", 409],
    ["bad_request", 400],
    ["bad_request", 413],
    ["bad_request", 415],
    ["bad_address", 400],
    ["method_not_allowed", 405],
    ["no_client_ip", 400],
    ["internal_error", 500],
  ])("turns the refusal %s (HTTP %i) into a FaucetError with that code", async (code, status) => {
    const f = fakeFetch(() => ({ status, body: { error: code } }));
    expect(await codeOf(claimTestFunds(ADDRESS, "xlm", f.fetch))).toBe(code);
  });

  it("carries the payout's hash on payout_unconfirmed, and calls that reply bad_reply unless it is exactly { error, hash } with a good hash", async () => {
    const f = fakeFetch(() => ({ status: 503, body: { error: "payout_unconfirmed", hash: HASH } }));
    let caught: unknown;
    await claimTestFunds(ADDRESS, "usdc", f.fetch).catch((err: unknown) => (caught = err));
    expect(caught).toBeInstanceOf(FaucetError);
    expect([(caught as FaucetError).code, (caught as FaucetError).hash]).toEqual(["payout_unconfirmed", HASH]);
    for (const body of [
      { error: "payout_unconfirmed" },
      { error: "payout_unconfirmed", hash: HASH.toUpperCase() },
      { error: "payout_unconfirmed", hash: HASH.slice(2) },
      { error: "payout_unconfirmed", hash: `${HASH.slice(1)}g` },
      { error: "payout_unconfirmed", hash: 7 },
      { error: "payout_unconfirmed", hash: HASH, extra: "x" },
    ]) {
      const bad = fakeFetch(() => ({ status: 503, body }));
      expect(await codeOf(claimTestFunds(ADDRESS, "usdc", bad.fetch)), JSON.stringify(body)).toBe("bad_reply");
    }
  });

  it("puts a hash on no other refusal", async () => {
    const f = fakeFetch(() => ({ status: 503, body: { error: "faucet_busy", hash: HASH } }));
    let caught: unknown;
    await claimTestFunds(ADDRESS, "xlm", f.fetch).catch((err: unknown) => (caught = err));
    expect([(caught as FaucetError).code, (caught as FaucetError).hash]).toEqual(["faucet_busy", undefined]);
  });

  it("calls a code it does not know, or no code at all, unknown", async () => {
    for (const body of [{ error: "made_up" }, { error: 7 }, { nope: true }, "not json", "[]", null]) {
      const f = fakeFetch(() => ({ status: 409, body }));
      expect(await codeOf(claimTestFunds(ADDRESS, "usdc", f.fetch))).toBe("unknown");
    }
  });

  it("does not take a client-only code from the server's reply", async () => {
    for (const code of ["network", "bad_reply"]) {
      const f = fakeFetch(() => ({ status: 503, body: { error: code } }));
      expect(await codeOf(claimTestFunds(ADDRESS, "xlm", f.fetch))).toBe("unknown");
    }
  });

  it("waits at least 15 s longer than the server's own bound on a claim, so it never gives up first", () => {
    expect(FAUCET_CLIENT_TIMEOUT_MS).toBeGreaterThanOrEqual(FAUCET_MAX_MS + 15_000);
  });

  it("calls a failed request, and a timeout, network", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await codeOf(claimTestFunds(ADDRESS, "xlm", down.fetch))).toBe("network");
    const slow = fakeFetch(() => Promise.reject(new DOMException("signal timed out", "TimeoutError")));
    expect(await codeOf(claimTestFunds(ADDRESS, "xlm", slow.fetch))).toBe("network");
  });

  it("calls a reply that cannot be read network when the body fails to arrive", async () => {
    const fetch = async () => ({
      status: 200,
      text: async (): Promise<string> => {
        throw new TypeError("terminated");
      },
    });
    expect(await codeOf(claimTestFunds(ADDRESS, "xlm", fetch))).toBe("network");
  });

  it.each([
    ["a missing key", { hash: HASH, asset: "xlm" }],
    ["an extra key", { hash: HASH, asset: "xlm", amount: "1", extra: "x" }],
    ["a different asset", { hash: HASH, asset: "usdc", amount: "1000000000" }],
    ["an upper-case hash", { hash: HASH.toUpperCase(), asset: "xlm", amount: "1000000000" }],
    ["a short hash", { hash: HASH.slice(2), asset: "xlm", amount: "1000000000" }],
    ["a hash with a non-hex letter", { hash: `${HASH.slice(1)}g`, asset: "xlm", amount: "1000000000" }],
    ["a numeric amount", { hash: HASH, asset: "xlm", amount: 1000000000 }],
    ["an amount with a decimal point", { hash: HASH, asset: "xlm", amount: "100.0" }],
    ["a negative amount", { hash: HASH, asset: "xlm", amount: "-1" }],
    ["an empty amount", { hash: HASH, asset: "xlm", amount: "" }],
    ["an amount in scientific notation", { hash: HASH, asset: "xlm", amount: "1e9" }],
    ["an array", [HASH, "xlm", "1"]],
    ["null", null],
    ["text that is not JSON", "ok"],
  ])("calls %s in a 200 reply bad_reply", async (_name, body) => {
    const f = fakeFetch(() => ({ status: 200, body }));
    expect(await codeOf(claimTestFunds(ADDRESS, "xlm", f.fetch))).toBe("bad_reply");
  });

  it("does not read a good-looking body as a payout when the status is not 200", async () => {
    const f = fakeFetch(() => ({ status: 201, body: { hash: HASH, asset: "xlm", amount: "1000000000" } }));
    expect(await codeOf(claimTestFunds(ADDRESS, "xlm", f.fetch))).toBe("unknown");
  });
});

describe("FAUCET_CODES", () => {
  it("lists the server's refusals and the three client codes, each once", () => {
    expect(new Set(FAUCET_CODES).size).toBe(FAUCET_CODES.length);
    for (const code of ["rate_limited", "already_claimed", "network_limit", "daily_limit", "no_account", "no_trustline", "trustline_unauthorized", "trustline_full", "faucet_empty", "faucet_busy", "not_configured", "rpc_unavailable", "payout_unconfirmed", "payout_failed", "bad_request", "bad_address", "method_not_allowed", "no_client_ip", "internal_error", "network", "bad_reply", "unknown"]) {
      expect(FAUCET_CODES).toContain(code);
    }
    expect(FAUCET_CODES).toHaveLength(22);
  });

  it("carries no long dash in any error message", () => {
    for (const code of FAUCET_CODES) expect(new FaucetError(code).message.includes(LONG_DASH)).toBe(false);
  });
});
