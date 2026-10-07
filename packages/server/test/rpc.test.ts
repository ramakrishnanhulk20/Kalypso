// Not covered here: the live RPC service. scripts/smoke-rpc.mjs reads real
// testnet events through this client.
import { describe, expect, it, vi } from "vitest";
import { RPC_INVALID_REQUEST, RpcError, createRpcClient } from "../src/rpc.ts";
import { TOKEN, testConfig } from "./helpers.ts";

const cfg = testConfig();

function rpcWith(reply: (body: any) => { status?: number; body: unknown }) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const out = reply(request);
    return new Response(typeof out.body === "string" ? out.body : JSON.stringify(out.body), { status: out.status ?? 200 });
  });
  return { rpc: createRpcClient(cfg, fetchImpl), fetchImpl };
}

const ok = (result: unknown) => (req: any) => ({ body: { jsonrpc: "2.0", id: req.id, result } });

describe("createRpcClient", () => {
  it("reads health from the configured RPC URL", async () => {
    const { rpc, fetchImpl } = rpcWith(ok({ status: "healthy", latestLedger: 50, oldestLedger: 10, ledgerRetentionWindow: 40 }));
    expect(await rpc.getHealth()).toEqual({ status: "healthy", latestLedger: 50, oldestLedger: 10 });
    expect(fetchImpl.mock.calls[0]![0]).toBe(cfg.RPC_URL);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({ jsonrpc: "2.0", method: "getHealth" });
  });

  it("sends startLedger without a cursor, and a cursor without startLedger", async () => {
    const page = { events: [], cursor: "0000000000000000001-0000000000", latestLedger: 50, oldestLedger: 10 };
    const { rpc, fetchImpl } = rpcWith(ok(page));
    await rpc.getEvents({ startLedger: 12, contractIds: [TOKEN], limit: 7 });
    await rpc.getEvents({ cursor: "abc", contractIds: [TOKEN], limit: 7 });
    const [first, second] = fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1]!.body)).params);
    expect(first).toEqual({ startLedger: 12, filters: [{ type: "contract", contractIds: [TOKEN] }], pagination: { limit: 7 } });
    expect(second).toEqual({ filters: [{ type: "contract", contractIds: [TOKEN] }], pagination: { cursor: "abc", limit: 7 } });
  });

  it("simulates in enforce mode by default, and in record mode on request", async () => {
    const reply = { latestLedger: 50, minResourceFee: "123", transactionData: "AAAA", results: [{ auth: ["AAAB"], xdr: "AAAAAQ==" }] };
    const { rpc, fetchImpl } = rpcWith(ok(reply));
    expect(await rpc.simulateTransaction("AAAA")).toEqual(reply);
    expect(await rpc.simulateTransaction("AAAA", "record")).toEqual(reply);
    const sent = fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1]!.body)).params);
    expect(sent).toEqual([
      { transaction: "AAAA", authMode: "enforce" },
      { transaction: "AAAA", authMode: "record" },
    ]);
  });

  it("turns every unexpected reply into an RpcError without upstream text in its message", async () => {
    const cases: Array<[(req: any) => { status?: number; body: unknown }, RpcError["code"]]> = [
      [(req) => ({ body: { jsonrpc: "2.0", id: req.id, error: { code: RPC_INVALID_REQUEST, message: "startLedger out of range" } } }), RPC_INVALID_REQUEST],
      [(req) => ({ body: { jsonrpc: "2.0", id: req.id + 1, result: {} } }), "bad_reply"],
      [() => ({ body: "<html>gateway</html>" }), "bad_reply"],
      [() => ({ status: 503, body: {} }), "http_status"],
      [ok({ status: "unhealthy", latestLedger: 50, oldestLedger: 10 }), "bad_reply"],
      [ok({ status: "healthy", latestLedger: 5, oldestLedger: 10 }), "bad_reply"],
    ];
    for (const [reply, code] of cases) {
      const err = await rpcWith(reply).rpc.getHealth().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(code);
      expect((err as RpcError).message).not.toMatch(/gateway|out of range/);
    }
  });

  it("refuses event pages that break the schema", async () => {
    const bad = { events: [{ type: "contract", ledger: -1 }], latestLedger: 50 };
    await expect(rpcWith(ok(bad)).rpc.getEvents({ startLedger: 1, contractIds: [TOKEN], limit: 1 })).rejects.toMatchObject({
      code: "bad_reply",
    });
  });
});
