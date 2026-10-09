// Covers the sponsor client: the exact request bodies and paths, reply checking, every refusal code
// to its sentence and outcome, a refusal versus a timeout, polling for the relayed hash, and the
// birth index calls with the wallet kept out of every URL.
// Does NOT cover: the live /api/sponsor routes (packages/server tests do), Channels itself, or
// whether an index answer is a real birth (passkey.test.ts checks every pointer against chain).
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { SPONSOR_ERROR_CODES, SponsorError, createHttpSponsor, waitForRelayHash, type SponsorPort } from "./sponsor";

type Init = { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" };

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
const WALLET = "CBSDDY2NMUMLVTXGTKJ2R7JBJDRWG2NJN6J7ZHLZHT6NJID6ZEYFGKSK";
const LONG_DASH = String.fromCharCode(0x2014);

describe("createHttpSponsor", () => {
  it("posts exactly the func and auth body to /api/sponsor as JSON", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { transactionId: "tx_1", status: "pending" } }));
    const sponsor = createHttpSponsor({ fetch: f.fetch });
    const reply = await sponsor.send({ func: "AAAA", auth: ["BBBB", "CCCC"] });
    expect(reply).toEqual({ transactionId: "tx_1", status: "pending" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/sponsor");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ func: "AAAA", auth: ["BBBB", "CCCC"] });
  });

  it("posts an envelope body as { xdr } and lets nothing else ride along", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { transactionId: "tx_2", status: "sent" } }));
    await createHttpSponsor({ fetch: f.fetch, baseUrl: "https://kalypso-payroll.vercel.app" }).send({ xdr: "EEEE" });
    expect(f.calls[0]!.url).toBe("https://kalypso-payroll.vercel.app/api/sponsor");
    expect(f.calls[0]!.init.body).toBe('{"xdr":"EEEE"}');
  });

  it("refuses a body in any other shape before making a request", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const sponsor = createHttpSponsor({ fetch: f.fetch });
    const bad = [{ func: "A", auth: ["B"], xdr: "C" }, { func: "A" }, { xdr: "" }, { func: "A", auth: [1] }];
    for (const body of bad) await expect(sponsor.send(body as never)).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });

  it("asks the status route with the id as a query value and checks the hash format", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { status: "submitted", hash: HASH } }));
    const sponsor = createHttpSponsor({ fetch: f.fetch });
    expect(await sponsor.status("tx_9-a")).toEqual({ status: "submitted", hash: HASH });
    expect(f.calls[0]!.url).toBe("/api/sponsor/status?id=tx_9-a");
    expect(f.calls[0]!.init.method).toBe("GET");
    await expect(sponsor.status("../admin")).rejects.toMatchObject({ code: "bad_id" });
    expect(f.calls).toHaveLength(1);
  });

  it("turns a reply in the wrong shape into bad_reply, never a value", async () => {
    const replies = [
      { status: 200, body: { transactionId: "tx 1", status: "pending" } },
      { status: 200, body: { transactionId: "tx_1", status: "landed" } },
      { status: 200, body: { transactionId: "tx_1", status: "pending", hash: HASH } },
      { status: 200, body: "not json" },
      { status: 200, body: "x".repeat(70_000) },
    ];
    for (const reply of replies) {
      const sponsor = createHttpSponsor({ fetch: fakeFetch(() => reply).fetch });
      await expect(sponsor.send({ xdr: "E" })).rejects.toMatchObject({ code: "bad_reply", outcome: "unknown" });
    }
    const status = createHttpSponsor({ fetch: fakeFetch(() => ({ status: 200, body: { status: "submitted", hash: "AB".repeat(32) } })).fetch });
    await expect(status.status("tx_1")).rejects.toMatchObject({ code: "bad_reply" });
  });

  it("reads a 400 refusal as not sent, with the sponsor's sentence", async () => {
    const sponsor = createHttpSponsor({ fetch: fakeFetch(() => ({ status: 400, body: { error: "fee_over_cap" } })).fetch });
    const err = await sponsor.send({ xdr: "E" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SponsorError);
    expect(err).toMatchObject({ code: "fee_over_cap", outcome: "not_sent", httpStatus: 400 });
    expect((err as Error).message).toBe("This transaction costs more than the fee sponsor pays for one action.");
  });

  it("reads a timeout as unknown, because the relay may have gone out", async () => {
    const hang = (_url: string, init: Init) =>
      new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const sponsor = createHttpSponsor({ fetch: fakeFetch(hang).fetch, sendTimeoutMs: 20 });
    await expect(sponsor.send({ xdr: "E" })).rejects.toMatchObject({ code: "timeout", outcome: "unknown", httpStatus: undefined });
    const offline = createHttpSponsor({ fetch: fakeFetch(() => Promise.reject(new TypeError("Failed to fetch"))).fetch });
    await expect(offline.send({ xdr: "E" })).rejects.toMatchObject({ code: "network", outcome: "unknown" });
  });

  it("asks the birth index by POST with the wallet in the body, never the URL, and checks each reply's exact shape, more included", async () => {
    const relayed = [{ transactionId: "tx_1", hash: null }, { transactionId: null, hash: null }, { transactionId: "tx_2", hash: HASH }];
    const f = fakeFetch((url) => ({ status: 200, body: url.endsWith("/lookup") ? { hash: HASH, relayed, more: true } : { recorded: true } }));
    const index = createHttpSponsor({ fetch: f.fetch });
    expect(await index.birth(` ${WALLET}\n`)).toEqual({ hash: HASH, relayed, more: true });
    await index.recordBirth(WALLET, HASH);
    expect(f.calls.map((c) => [c.url, c.init.method, c.init.headers, JSON.parse(c.init.body!)])).toEqual([
      ["/api/sponsor/birth/lookup", "POST", { "content-type": "application/json" }, { address: WALLET }],
      ["/api/sponsor/birth", "POST", { "content-type": "application/json" }, { address: WALLET, hash: HASH }],
    ]);
    expect(f.calls.every((c) => c.init.redirect === "error" && !c.url.includes(WALLET))).toBe(true);
    const entry = { transactionId: "tx_1", hash: null };
    for (const body of [
      { hash: "AB".repeat(32), relayed: [], more: false },
      { hash: HASH, relayed: [], more: false, extra: 1 },
      { hash: null, more: false },
      { hash: null, relayed: {}, more: false },
      { hash: null, relayed: Array.from({ length: 21 }, () => entry), more: true },
      { hash: null, relayed: [{ transactionId: "tx 1", hash: null }], more: false },
      { hash: null, relayed: [{ transactionId: "tx_1", hash: "AB".repeat(32) }], more: false },
      { hash: null, relayed: [{ transactionId: "tx_1" }], more: false },
      { hash: null, relayed: [{ ...entry, extra: 1 }], more: false },
      { hash: null, relayed: ["tx_1"], more: false },
      { hash: null, relayed: [] },
      { hash: null, relayed: [], more: "false" },
      { hash: null, relayed: [], more: 0 },
      { hash: null, relayed: [], more: null },
      {},
      "x".repeat(70_000),
    ]) {
      await expect(createHttpSponsor({ fetch: fakeFetch(() => ({ status: 200, body })).fetch }).birth(WALLET), JSON.stringify(body).slice(0, 80)).rejects.toMatchObject({ code: "bad_reply" });
    }
    expect(await createHttpSponsor({ fetch: fakeFetch(() => ({ status: 200, body: { hash: null, relayed: [], more: false } })).fetch }).birth(WALLET)).toEqual({ hash: null, relayed: [], more: false });
    const twenty = Array.from({ length: 20 }, () => entry);
    expect(await createHttpSponsor({ fetch: fakeFetch(() => ({ status: 200, body: { hash: null, relayed: twenty, more: true } })).fetch }).birth(WALLET)).toEqual({ hash: null, relayed: twenty, more: true });
    for (const body of [{ recorded: false }, { recorded: true, hash: HASH }]) {
      await expect(createHttpSponsor({ fetch: fakeFetch(() => ({ status: 200, body })).fetch }).recordBirth(WALLET, HASH)).rejects.toMatchObject({ code: "bad_reply" });
    }
  });

  it("refuses a malformed wallet or hash before asking, and reads the index's refusals with their sentences", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const index = createHttpSponsor({ fetch: f.fetch });
    await expect(index.birth(Keypair.random().publicKey())).rejects.toMatchObject({ code: "bad_address" });
    await expect(index.birth("C123")).rejects.toMatchObject({ code: "bad_address" });
    await expect(index.recordBirth(WALLET, "AB".repeat(32))).rejects.toMatchObject({ code: "bad_hash" });
    expect(f.calls).toHaveLength(0);
    const refusing = (status: number, error: string) => createHttpSponsor({ fetch: fakeFetch(() => ({ status, body: { error } })).fetch });
    await expect(refusing(404, "birth_unavailable").recordBirth(WALLET, HASH)).rejects.toMatchObject({ code: "birth_unavailable", outcome: "not_sent", httpStatus: 404 });
    await expect(refusing(400, "not_a_birth").recordBirth(WALLET, HASH)).rejects.toMatchObject({ code: "not_a_birth", httpStatus: 400 });
    await expect(refusing(429, "rate_limited").birth(WALLET)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("treats a 504 relay timeout and an unknown or client-only code as unknown", async () => {
    for (const [status, body, code] of [
      [504, { error: "relay_timeout" }, "relay_timeout"],
      [400, { error: "something_new" }, "unknown_refusal"],
      [400, { error: "relay_failed" }, "unknown_refusal"],
      [502, "<html>", "unknown_refusal"],
    ] as const) {
      const sponsor = createHttpSponsor({ fetch: fakeFetch(() => ({ status, body })).fetch });
      await expect(sponsor.send({ xdr: "E" })).rejects.toMatchObject({ code, outcome: "unknown" });
    }
  });
});

describe("refusal sentences", () => {
  it("gives every code its own plain sentence, with no code name or long dash in it", () => {
    const sentences = new Set<string>();
    for (const code of SPONSOR_ERROR_CODES) {
      const err = new SponsorError(code);
      expect(err.message, code).toMatch(/^[A-Z].*\.$/);
      expect(err.message, code).not.toContain("_");
      expect(err.message, code).not.toContain(LONG_DASH);
      expect(["not_sent", "unknown"]).toContain(err.outcome);
      sentences.add(err.message);
    }
    expect(sentences.size).toBe(SPONSOR_ERROR_CODES.length);
  });

  it("marks only the refusals that happen before the relay as not sent", () => {
    const notSent = SPONSOR_ERROR_CODES.filter((c) => new SponsorError(c).outcome === "not_sent");
    for (const code of ["relay_timeout", "relay_unavailable", "relay_refused", "relay_bad_reply", "internal_error", "duplicate_in_flight", "auth_entry_in_use", "network", "timeout"]) {
      expect(notSent).not.toContain(code);
    }
    for (const code of ["contract_creation", "root_contract_not_allowed", "fee_over_cap", "rate_limited", "address_rate_limited", "daily_budget_spent", "not_configured"]) {
      expect(notSent).toContain(code);
    }
  });
});

describe("waitForRelayHash", () => {
  function scripted(answers: (() => { status: string; hash: string | null })[]) {
    let i = 0;
    const sponsor: SponsorPort = {
      send: async () => ({ transactionId: "tx_1", status: "pending" }),
      status: async () => {
        const next = answers[Math.min(i++, answers.length - 1)]!;
        return next() as { status: "pending"; hash: string | null };
      },
    };
    return { sponsor, looks: () => i };
  }

  it("polls until the relayer names the hash, waiting longer each time", async () => {
    const waits: number[] = [];
    const { sponsor, looks } = scripted([() => ({ status: "pending", hash: null }), () => ({ status: "pending", hash: null }), () => ({ status: "submitted", hash: HASH })]);
    const out = await waitForRelayHash(sponsor, "tx_1", { sleep: async (ms) => void waits.push(ms) });
    expect(out).toEqual({ hash: HASH, status: "submitted" });
    expect(looks()).toBe(3);
    expect(waits).toEqual([1500, 2250, 3375]);
  });

  it("keeps looking through a rate limit on the status route", async () => {
    const { sponsor } = scripted([
      () => {
        throw new SponsorError("rate_limited", 429);
      },
      () => ({ status: "confirmed", hash: HASH }),
    ]);
    expect(await waitForRelayHash(sponsor, "tx_1", { sleep: async () => {} })).toEqual({ hash: HASH, status: "confirmed" });
  });

  it("says nothing was sent when the relayer gave up before submitting", async () => {
    const { sponsor } = scripted([() => ({ status: "failed", hash: null })]);
    await expect(waitForRelayHash(sponsor, "tx_1", { sleep: async () => {} })).rejects.toMatchObject({ code: "relay_failed", outcome: "not_sent" });
  });

  it("stops at the deadline as still pending, outcome unknown", async () => {
    let clock = 0;
    const { sponsor } = scripted([() => ({ status: "pending", hash: null })]);
    const sleep = async (ms: number) => {
      clock += ms;
    };
    await expect(waitForRelayHash(sponsor, "tx_1", { sleep, now: () => clock, timeoutMs: 10_000 })).rejects.toMatchObject({ code: "still_pending", outcome: "unknown" });
  });
});
