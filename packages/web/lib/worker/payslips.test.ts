// Covers what payslips() hands core's loadWorkerView and keeps on this browser: with empty storage,
// the company named by the payroll contract's own join event (found by core's real discovery over
// a stand-in RPC) is read; the record then holds exactly the companies the view confirmed on the
// roster, so forged join events are read and dropped, never stored, and a record an earlier
// version filled with them heals; a join recorded meanwhile stays; a refused write changes
// nothing; a failed join-event read fails like a view read; and NOT_REGISTERED is kept only for a
// worker the chain lists in no company.
// Does NOT cover: the view's own checks on real ciphertexts and rosters (core's worker.test.ts,
// archive-lies.test.ts and memberships.test.ts; here a stand-in applies the roster rule), the
// archive route, or the screen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import * as core from "@kalypso/core";
import type { EventsPort, HistoryGap, KalypsoKeys, RpcContractEvent } from "@kalypso/core";
import { workerConfig } from "./config";
import { payslips } from "./payslips";
import { openSession, type WorkerRuntime } from "./session";
import { readWorkerRecord, setCompanies, updateWorkerRecord, withCompany, type KeyValueStorage } from "./storage";

vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  getCompany: vi.fn(),
  getMembershipsOf: vi.fn(),
  loadWorkerView: vi.fn(),
}));

const config = workerConfig();
const CREATED = config.tokenDeployLedger + 10;
const LATEST = config.tokenDeployLedger + 1_000;
const PAID = 25_000_000n;
const REAL = 31n;
const FORGED = Array.from({ length: core.MAX_WORKER_COMPANIES }, (_, i) => 9000n + BigInt(i));

/** The companies with the worker on their roster on chain, which the stand-in view confirms. */
let roster = new Set<bigint>();

function memory(): KeyValueStorage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

/** WorkerJoined exactly as the payroll contract emits it: its name, the company id, the worker. */
function joinEvent(companyId: bigint, worker: string, ledger: number): RpcContractEvent {
  const topics = [xdr.ScVal.scvSymbol("worker_joined"), xdr.ScVal.scvU64(new xdr.Uint64(companyId)), new Address(worker).toScVal()];
  return {
    ledger,
    txIndex: 1,
    opIndex: 0,
    eventIndex: 0,
    txHash: ledger.toString(16).padStart(64, "0"),
    contractId: config.contracts.payroll,
    topicsXdr: topics.map((t) => t.toXDR("base64")),
    dataXdr: xdr.ScVal.scvMap([]).toXDR("base64"),
    successful: true,
  };
}

/** RPC's window, holding the token's deploy ledger, with these payroll events in it. */
function rpcWith(events: RpcContractEvent[]): EventsPort & { startLedgers: number[] } {
  const startLedgers: number[] = [];
  return {
    startLedgers,
    async ledgerWindow() {
      return { oldestLedger: config.tokenDeployLedger - 5, latestLedger: LATEST };
    },
    async contractEvents(query) {
      if ("startLedger" in query) startLedgers.push(query.startLedger);
      return { events: events.filter((e) => e.contractId === query.contractId), cursor: null, latestLedger: LATEST };
    },
  };
}

function runtime(events: EventsPort, storage: KeyValueStorage | null = memory()) {
  return { config, port: {}, events, txSource: { transaction: async () => null }, storage } as unknown as WorkerRuntime;
}

function walletWorker() {
  const address = Keypair.random().publicKey();
  return openSession({ kind: "wallet", address, cashOutAddress: address, keys: {} as KalypsoKeys, auditorId: null }, { kind: "wallet", wallet: {} as never });
}

const slip = (companyId: bigint) => ({ companyId, runId: 1n, periodLabel: "October 2026", amount: PAID, txHash: "ef".repeat(32), ledger: CREATED + 30 });
const joins = (worker: string, ids: readonly bigint[], from = CREATED + 1) => ids.map((id, i) => joinEvent(id, worker, from + i));

beforeEach(() => {
  roster = new Set();
  vi.mocked(core.getCompany)
    .mockReset()
    .mockImplementation(async (_port, _payroll, companyId) => {
      if (companyId >= 9000n) throw new core.ContractCallError("get_company", core.PayrollErrorCode.CompanyNotFound);
      return { createdLedger: CREATED } as core.Company;
    });
  vi.mocked(core.getMembershipsOf).mockReset().mockResolvedValue(0);
  // loadWorkerView's own rule: only companies with the worker on their roster count, and their
  // number must equal memberships_of (here, the roster's size).
  vi.mocked(core.loadWorkerView)
    .mockReset()
    .mockImplementation(async (input) => {
      const confirmedCompanyIds = input.companyIds.filter((id) => roster.has(id));
      const gaps: HistoryGap[] = confirmedCompanyIds.length === roster.size ? [] : [{ reason: "company_count_mismatch", expected: roster.size, found: confirmedCompanyIds.length }];
      return { complete: gaps.length === 0, spendable: 0n, receiving: PAID, payslips: confirmedCompanyIds.map(slip), gaps, confirmedCompanyIds };
    });
});

const readFor = () => vi.mocked(core.loadWorkerView).mock.calls.at(-1)![0];

describe("payslips() finds the worker's companies on chain", () => {
  it("with empty storage, reads the company the join event names, returns its payslip, and records it once the roster confirms it", async () => {
    roster = new Set([7n]);
    const worker = walletWorker();
    const rpc = rpcWith([joinEvent(7n, worker.address, CREATED + 5)]);
    const rt = runtime(rpc);
    const view = await payslips(rt, worker);
    expect([view.payslips, view.confirmedCompanyIds, view.gaps]).toEqual([[slip(7n)], [7n], []]);
    expect(readWorkerRecord(rt.storage, worker.address).companyIds).toEqual([7n]);
    expect(rpc.startLedgers[0]).toBe(config.tokenDeployLedger);
    expect([readFor().companyIds, readFor().history.fromLedger, readFor().worker]).toEqual([[7n], CREATED, worker.address]);
  });

  it("reads recorded companies the join events no longer name first, then the named ones in ledger order, and never another worker's join", async () => {
    roster = new Set([5n, 3n, 7n]);
    const worker = walletWorker();
    const rt = runtime(rpcWith([joinEvent(9n, Keypair.random().publicKey(), CREATED + 1), joinEvent(3n, worker.address, CREATED + 2), joinEvent(7n, worker.address, CREATED + 3)]));
    updateWorkerRecord(rt.storage, worker.address, (r) => setCompanies(r, [7n, 5n]));
    const view = await payslips(rt, worker);
    expect(readFor().companyIds).toEqual([5n, 3n, 7n]);
    expect([view.confirmedCompanyIds, readWorkerRecord(rt.storage, worker.address).companyIds]).toEqual([[5n, 3n, 7n], [5n, 3n, 7n]]);
  });
});

describe("payslips() stores only companies the roster confirmed (F2)", () => {
  it("gets over a lying read of 50 forged joins: the next honest read records the real company and shows no mismatch", async () => {
    roster = new Set([REAL]);
    const worker = walletWorker();
    const storage = memory();
    const lying = await payslips(runtime(rpcWith(joins(worker.address, FORGED)), storage), worker);
    expect(readFor().companyIds).toEqual(FORGED);
    expect(lying.gaps).toEqual([{ reason: "company_count_mismatch", expected: 1, found: 0 }]);
    expect(readWorkerRecord(storage, worker.address).companyIds).toEqual([]);

    const honest = await payslips(runtime(rpcWith([joinEvent(REAL, worker.address, CREATED + 60)]), storage), worker);
    expect([honest.complete, honest.gaps, honest.confirmedCompanyIds]).toEqual([true, [], [REAL]]);
    expect(readWorkerRecord(storage, worker.address).companyIds).toEqual([REAL]);
  });

  it("never stores a forged id read beside a real one", async () => {
    roster = new Set([REAL]);
    const worker = walletWorker();
    const rt = runtime(rpcWith(joins(worker.address, [REAL, 9001n])));
    await payslips(rt, worker);
    expect(readFor().companyIds).toEqual([REAL, 9001n]);
    expect(readWorkerRecord(rt.storage, worker.address).companyIds).toEqual([REAL]);
  });

  it("heals a record an earlier version filled with 50 unconfirmed ids on the next honest read", async () => {
    roster = new Set([REAL]);
    const worker = walletWorker();
    const rt = runtime(rpcWith([joinEvent(REAL, worker.address, CREATED + 60)]));
    updateWorkerRecord(rt.storage, worker.address, (r) => setCompanies(r, FORGED));
    const view = await payslips(rt, worker);
    expect(readFor().companyIds).toEqual([...FORGED.slice(1), REAL]);
    expect([view.gaps, readWorkerRecord(rt.storage, worker.address).companyIds]).toEqual([[], [REAL]]);
  });

  it("keeps a company a join recorded while the view was being read", async () => {
    roster = new Set([7n]);
    const worker = walletWorker();
    const rt = runtime(rpcWith([joinEvent(7n, worker.address, CREATED + 5)]));
    const read = vi.mocked(core.loadWorkerView).getMockImplementation()!;
    vi.mocked(core.loadWorkerView).mockImplementationOnce(async (input) => {
      updateWorkerRecord(rt.storage, worker.address, (r) => withCompany(r, 12n));
      return read(input);
    });
    await payslips(rt, worker);
    expect(readWorkerRecord(rt.storage, worker.address).companyIds).toEqual([7n, 12n]);
  });

  it("still reads the view when this browser refuses to save, or has no storage", async () => {
    roster = new Set([7n]);
    const worker = walletWorker();
    const full: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    for (const storage of [full, null]) {
      const view = await payslips(runtime(rpcWith([joinEvent(7n, worker.address, CREATED + 5)]), storage), worker);
      expect([view.confirmedCompanyIds, view.payslips]).toEqual([[7n], [slip(7n)]]);
    }
  });

  it("fails a join-event read the same way it fails a view read, before reading the view", async () => {
    const down: EventsPort = {
      ledgerWindow: async () => Promise.reject(new core.RpcTimeoutError("getHealth")),
      contractEvents: async () => Promise.reject(new core.RpcTimeoutError("getEvents")),
    };
    await expect(payslips(runtime(down), walletWorker())).rejects.toMatchObject({ name: "WorkerError", code: "NETWORK" });
    expect(core.loadWorkerView).not.toHaveBeenCalled();
  });
});

describe("payslips() for a worker not registered with the token", () => {
  beforeEach(() => {
    vi.mocked(core.loadWorkerView).mockRejectedValue(new core.WorkerViewError("NOT_REGISTERED"));
  });

  it("says NOT_REGISTERED only when memberships_of is 0", async () => {
    await expect(payslips(runtime(rpcWith([])), walletWorker())).rejects.toMatchObject({ name: "WorkerError", code: "NOT_REGISTERED" });
  });

  it("calls it the chain disagreeing when memberships_of counts a company, and passes a failed count read on", async () => {
    vi.mocked(core.getMembershipsOf).mockResolvedValue(1);
    await expect(payslips(runtime(rpcWith([])), walletWorker())).rejects.toMatchObject({ code: "CHAIN_DISAGREES" });
    vi.mocked(core.getMembershipsOf).mockRejectedValue(new core.RpcTimeoutError("simulateTransaction"));
    await expect(payslips(runtime(rpcWith([])), walletWorker())).rejects.toMatchObject({ code: "NETWORK" });
  });
});
