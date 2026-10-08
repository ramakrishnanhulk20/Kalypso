import { Address, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { OutboundError } from "../../src/http.ts";
import { RPC_INVALID_REQUEST, RpcError, type GetEventsQuery, type RpcClient, type RpcEvent, type RpcEventsPage } from "../../src/rpc.ts";

/**
 * An in-memory stand-in for Stellar RPC's getHealth and getEvents, written to
 * the behaviour measured on live testnet RPC on 7 Oct 2026: a call scans at
 * most `window` ledgers; a full page's cursor is its last event id; a page
 * that is not full ends with the end-of-ledger cursor of the last ledger
 * scanned; a start below the retention floor is error -32600.
 */
export class FakeChain implements RpcClient {
  events: RpcEvent[] = [];
  latestLedger: number;
  oldestLedger: number;
  window = 10_000;
  calls = 0;
  /** Lets a test move the floor between getHealth and getEvents. */
  beforeGetEvents: (() => void) | null = null;
  delayMs = 0;
  /** Off plays an RPC that returns events from contracts nobody asked for. */
  filterByContract = true;

  constructor(oldestLedger: number, latestLedger: number) {
    this.oldestLedger = oldestLedger;
    this.latestLedger = latestLedger;
  }

  add(...events: RpcEvent[]): this {
    this.events.push(...events);
    this.events.sort((a, b) => {
      const [ta, tb] = [BigInt(a.id.split("-")[0]!), BigInt(b.id.split("-")[0]!)];
      return ta < tb ? -1 : ta > tb ? 1 : eventOrder(a) - eventOrder(b);
    });
    return this;
  }

  async getHealth(signal?: AbortSignal) {
    await this.wait(signal);
    return { status: "healthy" as const, latestLedger: this.latestLedger, oldestLedger: this.oldestLedger };
  }

  async getEvents(query: GetEventsQuery, signal?: AbortSignal): Promise<RpcEventsPage> {
    this.calls++;
    this.beforeGetEvents?.();
    await this.wait(signal);
    let startKey: [bigint, number];
    let startLedger: number;
    if (query.cursor !== undefined) {
      const [toid, ev] = query.cursor.split("-");
      startKey = [BigInt(toid!), Number(ev) + 1];
      startLedger = Number(BigInt(toid!) >> 32n);
    } else {
      startLedger = query.startLedger!;
      if (startLedger < this.oldestLedger || startLedger > this.latestLedger) {
        throw new RpcError(RPC_INVALID_REQUEST, "startLedger must be within the ledger range");
      }
      startKey = [BigInt(startLedger) << 32n, 0];
    }
    const windowEnd = Math.min(startLedger + this.window - 1, this.latestLedger);
    const picked = this.events
      .filter((e) => (!this.filterByContract || query.contractIds.includes(e.contractId)) && e.ledger <= windowEnd)
      .filter((e) => {
        const [toid, ev] = e.id.split("-");
        const key = BigInt(toid!);
        return key > startKey[0] || (key === startKey[0] && Number(ev) >= startKey[1]);
      })
      .slice(0, query.limit);
    const cursor =
      picked.length === query.limit ? picked[picked.length - 1]!.id : endOfLedgerCursor(windowEnd);
    return { events: picked, cursor, latestLedger: this.latestLedger, oldestLedger: this.oldestLedger };
  }

  async simulateTransaction(): Promise<never> {
    throw new Error("not used by the archive");
  }

  async getLedgerEntries(): Promise<never> {
    throw new Error("not used by the archive");
  }

  private async wait(signal?: AbortSignal) {
    if (this.delayMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new OutboundError("aborted"));
      });
    });
  }
}

const eventOrder = (e: RpcEvent) => Number(e.id.split("-")[1]);

export function endOfLedgerCursor(ledger: number): string {
  const toid = (BigInt(ledger) << 32n) | (0xfffffn << 12n) | 0xfffn;
  return toid.toString().padStart(19, "0") + "-4294967295";
}

export interface EventSpec {
  ledger: number;
  tx?: number;
  index?: number;
  contract: string;
  topics: xdr.ScVal[];
  value?: xdr.ScVal;
  ok?: boolean;
}

export function rpcEvent(spec: EventSpec): RpcEvent {
  const tx = spec.tx ?? 1;
  const index = spec.index ?? 0;
  const toid = (BigInt(spec.ledger) << 32n) | (BigInt(tx) << 12n);
  return {
    type: "contract",
    ledger: spec.ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 9, 1) + spec.ledger * 5_000).toISOString().replace(".000", ""),
    contractId: spec.contract,
    id: toid.toString().padStart(19, "0") + "-" + String(index).padStart(10, "0"),
    operationIndex: 0,
    transactionIndex: tx,
    txHash: hash(Buffer.from("tx " + spec.ledger + " " + tx)).toString("hex"),
    inSuccessfulContractCall: spec.ok ?? true,
    topic: spec.topics.map((t) => t.toXDR("base64")),
    value: (spec.value ?? xdr.ScVal.scvMap([])).toXDR("base64"),
  };
}

export const sym = (s: string) => xdr.ScVal.scvSymbol(s);
export const addrVal = (a: string) => new Address(a).toScVal();
export const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });

export function transferEvent(contract: string, ledger: number, from: string, to: string, tx = 1, index = 0): RpcEvent {
  return rpcEvent({
    ledger,
    tx,
    index,
    contract,
    topics: [sym("transfer"), addrVal(from), addrVal(to)],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("b_tilde"), val: xdr.ScVal.scvBytes(Buffer.alloc(32, ledger % 251)) }),
      new xdr.ScMapEntry({ key: sym("r_e_point"), val: xdr.ScVal.scvBytes(Buffer.alloc(64, 3)) }),
    ]),
  });
}

export const mergeEvent = (contract: string, ledger: number, account: string, tx = 1, index = 0): RpcEvent =>
  rpcEvent({ ledger, tx, index, contract, topics: [sym("merge"), addrVal(account)] });

export const depositEvent = (contract: string, ledger: number, from: string, to: string, amount: bigint, tx = 1): RpcEvent =>
  rpcEvent({
    ledger,
    tx,
    contract,
    topics: [sym("deposit"), addrVal(from), addrVal(to)],
    value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: sym("amount"), val: nativeToScVal(amount, { type: "i128" }) })]),
  });

/*
 * Payroll events shaped exactly as packages/contracts/payroll/src/events.rs
 * emits them with soroban-sdk's #[contractevent]: topic 0 is the struct name
 * in snake case, then each #[topic] field in order (company_id: u64 first),
 * then a data map of the remaining fields with keys in sorted order. An event
 * with no data fields carries an empty map, as the live token's merge event
 * does on testnet.
 */
export const payslipIssued = (contract: string, ledger: number, companyId: bigint, runId: bigint, worker: string, tx = 1): RpcEvent =>
  rpcEvent({
    ledger,
    tx,
    contract,
    topics: [sym("payslip_issued"), u64(companyId), u64(runId), addrVal(worker)],
    value: xdr.ScVal.scvMap([]),
  });

export const companyCreated = (contract: string, ledger: number, companyId: bigint, admin: string, label: string, tx = 1): RpcEvent =>
  rpcEvent({
    ledger,
    tx,
    contract,
    topics: [sym("company_created"), u64(companyId)],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("admin"), val: addrVal(admin) }),
      new xdr.ScMapEntry({ key: sym("auditor_id"), val: xdr.ScVal.scvU32(0) }),
      new xdr.ScMapEntry({ key: sym("label"), val: xdr.ScVal.scvString(label) }),
    ]),
  });
