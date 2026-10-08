// An in-memory model of the payroll contract, the confidential token and the auditor registry,
// behind the same ChainPort the live RPC uses. It reads envelopes with the XDR types directly
// and answers reads with independently built XDR. What it does NOT model: real proof
// verification (the fake proof carries the commitment and the three keys it was built on, and
// the fake token checks them against the stored balance, the recipient's viewing key and both
// auditor keys, as the verifier reads its public inputs from chain), fees, or rent. Its ledger
// clock only moves when a caller waits for a transaction the network has not settled. The
// registry hands out ids through register_key; key rotation and id handovers are not modelled.
// Token history: each included transfer emits its token event, and recordRegister and
// depositAndMerge emit theirs, served by rpc() in one page; payroll events are not emitted.
import { createHash } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Address, Keypair, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { G, commit, pointFromBytes, type Point } from 'stellar-confidential-token-sdk';
import { ContractCallError, SubmitRejectedError, type ChainPort, type SimResult } from '../src/chain/ports.js';
import { RpcTimeoutError } from '../src/chain/rpc-port.js';
import type { EventsPort, RpcContractEvent } from '../src/history/rpc-events.js';
import { PASSPHRASE, accountStruct, pointBytes, raw } from './independent-xdr.js';

/**
 * What happens to the next submitted transaction. OK applies it normally. HELD accepts it
 * without applying it or moving the sequence on until land(); while held, waiting on it throws
 * and further submits from its source are refused. TIMEOUT_AFTER_ACCEPT applies it, then the
 * submit throws as if the reply was lost.
 */
export type SubmitMode =
  | 'OK'
  | 'FAILED'
  | 'DROPPED'
  | 'LOST_STATUS'
  | 'CRASH'
  | 'TAMPER'
  | 'REJECTED'
  | 'LYING_SUCCESS'
  | 'HELD'
  | 'TIMEOUT_AFTER_ACCEPT';

type WorkerState = 'Invited' | 'Active' | 'Removed';
interface CompanyState {
  admin: string;
  accountant?: string;
  auditorId: number;
  activeWorkers: number;
}
interface RunState {
  open: boolean;
  expected: number;
  paid: number;
}
export interface AccountState {
  auditorId: number;
  spendingKey: Point;
  pvk: Point;
  spendable: Point;
  receiving: Point;
}

class Revert extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}
const contractError = (code: number) => new Revert(`HostError: Error(Contract, #${code})`);

const WORKER_CODES: Record<WorkerState, number> = { Invited: 0, Active: 1, Removed: 2 };

function addressOf(value: xdr.ScVal): string {
  return Address.fromScVal(value).toString();
}

/** Decodes the token's transfer `data` the way storage.rs does: a {payload, proof} struct. */
export function readTransferData(data: Uint8Array) {
  const fields = new Map((xdr.ScVal.fromXDR(Buffer.from(data)).map() ?? []).map((e) => [e.key().sym().toString(), e.val()]));
  const payload = new Map((fields.get('payload')?.map() ?? []).map((e) => [e.key().sym().toString(), e.val()]));
  const bytes = (name: string) => new Uint8Array((payload.get(name) as xdr.ScVal).bytes());
  return {
    cSpendNew: pointFromBytes(bytes('c_spend_new')),
    cTransfer: pointFromBytes(bytes('c_transfer')),
    sigma: bytesToHex(bytes('sigma')),
    proof: new Uint8Array((fields.get('proof') as xdr.ScVal).bytes()),
  };
}

/** The token transfer event's data: the payload's fields without its two commitments, as storage.rs emits it. */
function transferEventData(data: Uint8Array): xdr.ScVal {
  const fields = new Map((xdr.ScVal.fromXDR(Buffer.from(data)).map() ?? []).map((e) => [e.key().sym().toString(), e.val()]));
  const payload = (fields.get('payload')?.map() ?? []).filter((e) => !['c_spend_new', 'c_transfer'].includes(e.key().sym().toString()));
  return raw.struct(Object.fromEntries(payload.map((e) => [e.key().sym().toString(), e.val()])));
}

export class FakeChain implements ChainPort {
  ledger = 5_100_000;
  /** The first ledger of the token history rpc() serves: a fromLedger at or before every registration. */
  readonly historyStart = this.ledger;
  /** Every token event of an included transaction or a history helper, in ledger order. */
  events: RpcContractEvent[] = [];
  companies = new Map<bigint, CompanyState>();
  workers = new Map<string, WorkerState>();
  runs = new Map<string, RunState>();
  paid = new Set<string>();
  accounts = new Map<string, AccountState>();
  auditorKeys = new Map<number, Point>();
  /** Owners of ids handed out by register_key. Keys placed straight into auditorKeys have none. */
  auditorOwners = new Map<number, string>();
  /** The registry's key_count: the id the next register_key hands out. */
  keyCount = 0;
  sequences = new Map<string, bigint>();
  /** Confidential transfers each worker received. Above 1 for a worker is a double payment. */
  transfersTo = new Map<string, number>();
  /** Every submitted transaction hash, in order, including failed and dropped ones. */
  submitted: string[] = [];
  simulations = 0;
  simulationFailures = 0;
  violations: string[] = [];
  timeline: string[] = [];
  /** Close time of the latest ledger, Unix seconds. */
  closeTime = Math.floor(Date.now() / 1000);
  /** False models an RPC that gives no close time with NOT_FOUND. */
  reportsCloseTime = true;
  private pending: string | undefined;
  private held: Transaction | undefined;
  private modes: SubmitMode[] = [];
  /** Token events of the transaction being applied, kept only if it is included. */
  private emitted: { topics: xdr.ScVal[]; data: xdr.ScVal }[] = [];
  private results = new Map<
    string,
    { status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number; crash?: boolean; returnValue?: xdr.ScVal }
  >();

  constructor(readonly contracts: { payroll: string; token: string; auditor: string }) {}

  /** Queues what happens to the next submissions, one mode per submission. */
  failNext(...modes: SubmitMode[]): void {
    this.modes.push(...modes);
  }

  /** The network finished with whatever was in flight, as it would while a crashed app is closed. */
  settle(): void {
    this.pending = undefined;
    for (const result of this.results.values()) result.crash = false;
  }

  /** The network finally applies the held transaction. */
  land(): void {
    const tx = this.held;
    if (tx === undefined) throw new Error('no transaction is held');
    this.held = undefined;
    this.include(tx, bytesToHex(tx.hash()), 'OK');
  }

  async read(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    try {
      return this.answer(contractId, method, args);
    } catch (err) {
      if (err instanceof Revert) throw new ContractCallError(method, Number(/#(\d+)/.exec(err.text)?.[1]), err.text);
      throw err;
    }
  }

  async sourceAccount(address: string): Promise<{ sequence: string }> {
    return { sequence: (this.sequences.get(address) ?? 0n).toString() };
  }

  async latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    return { sequence: this.ledger, closeTime: this.closeTime };
  }

  async simulate(txXdr: string): Promise<SimResult> {
    this.simulations++;
    if (this.simulationFailures > 0) {
      this.simulationFailures--;
      return { ok: false, error: 'HostError: Error(Budget, ExceededLimit)', latestLedger: this.ledger };
    }
    const tx = TransactionBuilder.fromXDR(txXdr, PASSPHRASE) as Transaction;
    const snapshot = this.snapshot();
    try {
      this.apply(tx);
      return {
        ok: true,
        minResourceFee: '90000',
        transactionDataXdr: new SorobanDataBuilder().setResources(180_000_000, 50_000, 10_000).setResourceFee(90_000).build().toXDR('base64'),
        authXdr: [],
        latestLedger: this.ledger,
      };
    } catch (err) {
      if (err instanceof Revert) return { ok: false, error: err.text, latestLedger: this.ledger };
      throw err;
    } finally {
      this.restore(snapshot);
      this.emitted = [];
    }
  }

  async submit(signedTxXdr: string): Promise<{ hash: string }> {
    this.timeline.push('submit');
    if (this.pending !== undefined) this.violations.push(`submit while ${this.pending.slice(0, 8)} is in flight`);
    const tx = TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE) as Transaction;
    const signature = tx.signatures[0];
    if (tx.signatures.length !== 1 || !signature || !Keypair.fromPublicKey(tx.source).verify(tx.hash(), signature.signature())) {
      throw new SubmitRejectedError('ERROR', 'txBadAuth');
    }
    if (this.held?.source === tx.source) throw new SubmitRejectedError('TRY_AGAIN_LATER');
    const sequence = BigInt(tx.sequence);
    if (sequence !== (this.sequences.get(tx.source) ?? 0n) + 1n) throw new SubmitRejectedError('ERROR', 'txBadSeq');
    if (tx.toEnvelope().v1().tx().ext().switch() !== 1) throw new SubmitRejectedError('ERROR', 'txMalformed');

    const mode = this.modes.shift() ?? 'OK';
    if (mode === 'REJECTED') throw new SubmitRejectedError('TRY_AGAIN_LATER');
    const hash = bytesToHex(tx.hash());
    this.submitted.push(hash);
    this.pending = hash;
    if (mode === 'DROPPED') {
      this.results.set(hash, { status: 'NOT_FOUND' });
      return { hash };
    }
    if (mode === 'LYING_SUCCESS') {
      // An RPC or relayer that reports success for a transaction the chain never applied.
      this.results.set(hash, { status: 'SUCCESS', ledger: this.ledger });
      return { hash };
    }
    if (mode === 'HELD') {
      this.held = tx;
      return { hash };
    }
    this.include(tx, hash, mode);
    if (mode === 'TIMEOUT_AFTER_ACCEPT') throw new RpcTimeoutError('sendTransaction');
    return { hash };
  }

  async waitFor(
    hash: string,
    timeoutMs: number,
  ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number; closeTime?: number; returnValue?: xdr.ScVal }> {
    if (this.held !== undefined && bytesToHex(this.held.hash()) === hash) throw new Error('the RPC stopped answering about this transaction');
    const result = this.results.get(hash) ?? { status: 'NOT_FOUND' as const };
    if (result.crash) throw new Error('connection lost while waiting for the transaction');
    if (this.pending === hash) this.pending = undefined;
    if (result.status === 'NOT_FOUND') {
      // Rounded down, so the clock tends to fall a little short of the caller's own estimate,
      // as it does when the last ledger closed just before the deadline.
      this.closeTime += Math.floor(timeoutMs / 1000);
      return this.reportsCloseTime ? { status: 'NOT_FOUND', closeTime: this.closeTime } : { status: 'NOT_FOUND' };
    }
    const { status, ledger, returnValue } = result;
    return {
      status,
      ...(ledger === undefined ? {} : { ledger }),
      ...(status === 'SUCCESS' && returnValue !== undefined ? { returnValue } : {}),
    };
  }

  /** Puts a transaction in a ledger: moves the source's sequence on, then applies it or fails it. */
  private include(tx: Transaction, hash: string, mode: SubmitMode): void {
    this.sequences.set(tx.source, BigInt(tx.sequence));
    this.ledger++;
    if (mode === 'FAILED') {
      this.results.set(hash, { status: 'FAILED', ledger: this.ledger });
      return;
    }
    const before = this.snapshot();
    let returnValue: xdr.ScVal | undefined;
    this.emitted = [];
    try {
      returnValue = this.apply(tx);
    } catch (err) {
      if (!(err instanceof Revert)) throw err;
      // A failing call undoes everything it did, as on chain.
      this.restore(before);
      this.emitted = [];
      this.results.set(hash, { status: 'FAILED', ledger: this.ledger });
      return;
    }
    this.recordEvents(hash, this.emitted);
    this.emitted = [];
    if (mode === 'TAMPER') {
      const treasury = this.accounts.get(tx.source) as AccountState;
      treasury.spendable = treasury.spendable.add(G);
    }
    this.results.set(hash, {
      status: mode === 'LOST_STATUS' ? 'NOT_FOUND' : 'SUCCESS',
      ledger: this.ledger,
      crash: mode === 'CRASH',
      ...(returnValue === undefined ? {} : { returnValue }),
    });
  }

  private answer(contractId: string, method: string, args: xdr.ScVal[]): xdr.ScVal {
    const [a0, a1, a2] = args;
    if (contractId === this.contracts.payroll && method === 'memberships_of') {
      const worker = addressOf(a0 as xdr.ScVal);
      // The fake has no revoke_invite, so any status past Invited followed a join.
      const joined = [...this.workers].filter(([key, status]) => key.endsWith(`/${worker}`) && status !== 'Invited');
      return raw.u32(joined.length);
    }
    if (contractId === this.contracts.payroll) {
      const companyId = (a0 as xdr.ScVal).u64().toBigInt();
      if (method === 'get_company') {
        const c = this.companies.get(companyId);
        if (!c) throw contractError(1);
        return raw.struct({
          admin: raw.address(c.admin),
          // Engine fixtures set no accountant, so the admin stands in for one.
          accountant: raw.address(c.accountant ?? c.admin),
          auditor_id: raw.u32(c.auditorId),
          label: raw.str('Fake Co'),
          created_ledger: raw.u32(1),
          active_workers: raw.u32(c.activeWorkers),
          roster_len: raw.u32(c.activeWorkers),
          runs_opened: raw.u32([...this.runs.keys()].filter((key) => key.startsWith(`${companyId}/`)).length),
          admin_changes: raw.u32(0),
        });
      }
      if (method === 'get_run') {
        const r = this.runs.get(`${companyId}/${(a1 as xdr.ScVal).u64().toBigInt()}`);
        if (!r) throw contractError(10);
        return raw.struct({
          status: raw.u32(r.open ? 0 : 1),
          period_label: raw.str('October 2026'),
          expected_count: raw.u32(r.expected),
          paid_count: raw.u32(r.paid),
          opened_ledger: raw.u32(2),
        });
      }
      if (method === 'is_paid') {
        return raw.bool(this.paid.has(`${companyId}/${(a1 as xdr.ScVal).u64().toBigInt()}/${addressOf(a2 as xdr.ScVal)}`));
      }
      if (method === 'worker_status') {
        const status = this.workers.get(`${companyId}/${addressOf(a1 as xdr.ScVal)}`);
        return status === undefined ? raw.void() : raw.u32(WORKER_CODES[status]);
      }
    }
    if (contractId === this.contracts.token && method === 'confidential_balance') {
      const account = this.accounts.get(addressOf(a0 as xdr.ScVal));
      if (!account) throw contractError(3501);
      return accountStruct(account);
    }
    if (contractId === this.contracts.auditor && method === 'get_key') {
      const key = this.auditorKeys.get((a0 as xdr.ScVal).u32());
      if (!key) throw contractError(3301);
      return raw.bytes(pointBytes(key));
    }
    if (contractId === this.contracts.auditor && method === 'owner_of') {
      const owner = this.auditorOwners.get((a0 as xdr.ScVal).u32());
      if (owner === undefined) throw contractError(100);
      return raw.address(owner);
    }
    if (contractId === this.contracts.auditor && method === 'key_count') return raw.u32(this.keyCount);
    throw new Error(`the fake chain has no ${method} on ${contractId}`);
  }

  /**
   * Applies pay the way contract.rs does, or the registry's register_key, with the source account
   * as the only signer. Returns the call's return value when it has one the tests read.
   */
  private apply(tx: Transaction): xdr.ScVal | undefined {
    const op = tx.toEnvelope().v1().tx().operations()[0] as xdr.Operation;
    const call = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const contractId = StrKey.encodeContract(Buffer.from(call.contractAddress().contractId() as unknown as Uint8Array));
    const method = call.functionName().toString();
    if (contractId === this.contracts.auditor && method === 'register_key') return this.registerKey(tx.source, call.args());
    if (contractId !== this.contracts.payroll || method !== 'pay') throw new Revert('the fake chain applies only pay and register_key');
    const [companyArg, runArg, itemsArg] = call.args() as [xdr.ScVal, xdr.ScVal, xdr.ScVal];
    const companyId = companyArg.u64().toBigInt();
    const runId = runArg.u64().toBigInt();
    const company = this.companies.get(companyId);
    if (!company) throw contractError(1);
    if (tx.source !== company.admin) throw new Revert('HostError: Error(Auth, InvalidAction)');
    const run = this.runs.get(`${companyId}/${runId}`);
    if (!run) throw contractError(10);
    if (!run.open) throw contractError(11);
    const items = itemsArg.vec() ?? [];
    if (items.length === 0) throw contractError(12);
    if (items.length > 2) throw contractError(13);
    for (const item of items) {
      const [workerArg, dataArg] = item.vec() as [xdr.ScVal, xdr.ScVal];
      const worker = addressOf(workerArg);
      if (worker === company.admin) throw contractError(5);
      if (this.workers.get(`${companyId}/${worker}`) !== 'Active') throw contractError(8);
      const paidKey = `${companyId}/${runId}/${worker}`;
      if (this.paid.has(paidKey)) throw contractError(14);
      this.paid.add(paidKey);
      run.paid++;
      if (run.paid > run.expected) throw contractError(15);
      this.transfer(company.admin, worker, new Uint8Array(dataArg.bytes()));
    }
    return undefined;
  }

  /** register_key(owner, point) as packages/contracts/auditor does it: the next id, never reused. */
  private registerKey(source: string, args: xdr.ScVal[]): xdr.ScVal {
    const [ownerArg, pointArg] = args as [xdr.ScVal, xdr.ScVal];
    const owner = addressOf(ownerArg);
    if (owner !== source) throw new Revert('HostError: Error(Auth, InvalidAction)');
    const bytes = new Uint8Array(pointArg.bytes());
    if (bytes.length !== 64) throw new Revert('HostError: Error(Value, UnexpectedType)');
    let point: Point;
    try {
      point = pointFromBytes(bytes);
      if (!point.is0()) point.assertValidity();
    } catch {
      throw contractError(3303);
    }
    if (point.is0()) throw contractError(3302);
    const auditorId = this.keyCount;
    this.auditorKeys.set(auditorId, point);
    this.auditorOwners.set(auditorId, owner);
    this.keyCount++;
    return raw.u32(auditorId);
  }

  private transfer(from: string, to: string, data: Uint8Array): void {
    const sender = this.accounts.get(from);
    const recipient = this.accounts.get(to);
    if (!sender || !recipient) throw contractError(3501);
    const d = readTransferData(data);
    const audR = this.auditorKeys.get(recipient.auditorId);
    const audS = this.auditorKeys.get(sender.auditorId);
    const bound = (i: number) => pointFromBytes(d.proof.subarray(64 * i, 64 * (i + 1)));
    if (d.proof.length !== 256 || !audR || !audS) throw contractError(3506);
    if (!bound(0).equals(sender.spendable) || !bound(1).equals(audR) || !bound(2).equals(audS) || !bound(3).equals(recipient.pvk)) {
      throw contractError(3506);
    }
    sender.spendable = d.cSpendNew;
    recipient.receiving = recipient.receiving.add(d.cTransfer);
    this.transfersTo.set(to, (this.transfersTo.get(to) ?? 0) + 1);
    this.emitted.push({ topics: [xdr.ScVal.scvSymbol('transfer'), raw.address(from), raw.address(to)], data: transferEventData(data) });
  }

  /** The register event of an account already placed in accounts, in a ledger of its own. */
  recordRegister(address: string): void {
    const account = this.accounts.get(address) as AccountState;
    this.ledger++;
    this.recordEvents(this.helperHash('register', address), [
      { topics: [xdr.ScVal.scvSymbol('register'), raw.address(address)], data: raw.struct({ auditor_id: raw.u32(account.auditorId) }) },
    ]);
  }

  /** A public deposit into the account and its merge, each in a ledger of its own, moving the spendable balance as the token does. */
  depositAndMerge(address: string, amount: bigint): void {
    const account = this.accounts.get(address) as AccountState;
    this.ledger++;
    this.recordEvents(this.helperHash('deposit', address), [
      { topics: [xdr.ScVal.scvSymbol('deposit'), raw.address(address), raw.address(address)], data: raw.struct({ amount: raw.i128(amount) }) },
    ]);
    this.ledger++;
    this.recordEvents(this.helperHash('merge', address), [{ topics: [xdr.ScVal.scvSymbol('merge'), raw.address(address)], data: raw.struct({}) }]);
    account.spendable = account.spendable.add(commit(amount, 0n));
  }

  /**
   * The RPC's getEvents view of the token history, from historyStart, in one page. oldestLedger
   * moves the start of the window, as an RPC that has dropped older ledgers would.
   */
  rpc(opts: { oldestLedger?: number } = {}): EventsPort {
    return {
      ledgerWindow: async () => ({ oldestLedger: opts.oldestLedger ?? this.historyStart, latestLedger: this.ledger }),
      contractEvents: async (query) => {
        const from = 'startLedger' in query ? query.startLedger : this.historyStart;
        const events = this.events.filter((e) => e.contractId === query.contractId && e.ledger >= from).map((e) => ({ ...e }));
        return { events, cursor: null, latestLedger: this.ledger };
      },
    };
  }

  private helperHash(name: string, address: string): string {
    return createHash('sha256').update(`fake chain ${name} ${address} ${this.ledger}`).digest('hex');
  }

  private recordEvents(txHash: string, events: { topics: xdr.ScVal[]; data: xdr.ScVal }[]): void {
    events.forEach(({ topics, data }, eventIndex) =>
      this.events.push({
        ledger: this.ledger,
        txIndex: 1,
        opIndex: 0,
        eventIndex,
        txHash,
        contractId: this.contracts.token,
        topicsXdr: topics.map((t) => t.toXDR('base64')),
        dataXdr: data.toXDR('base64'),
        successful: true,
      }),
    );
  }

  private snapshot() {
    return {
      runs: new Map([...this.runs].map(([k, v]) => [k, { ...v }])),
      paid: new Set(this.paid),
      accounts: new Map([...this.accounts].map(([k, v]) => [k, { ...v }])),
      transfersTo: new Map(this.transfersTo),
      keyCount: this.keyCount,
      auditorKeys: new Map(this.auditorKeys),
      auditorOwners: new Map(this.auditorOwners),
    };
  }

  private restore(s: ReturnType<FakeChain['snapshot']>): void {
    this.runs = s.runs;
    this.paid = s.paid;
    this.accounts = s.accounts;
    this.transfersTo = s.transfersTo;
    this.keyCount = s.keyCount;
    // Refilled in place, because engine tests keep changing chain.auditorKeys between calls.
    this.auditorKeys.clear();
    for (const [id, key] of s.auditorKeys) this.auditorKeys.set(id, key);
    this.auditorOwners.clear();
    for (const [id, owner] of s.auditorOwners) this.auditorOwners.set(id, owner);
  }
}
