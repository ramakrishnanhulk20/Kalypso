// An in-memory model of the payroll contract, the confidential token and the auditor registry,
// behind the same ChainPort the live RPC uses. It reads envelopes with the XDR types directly
// and answers reads with independently built XDR. What it does NOT model: real proof
// verification (the fake proof carries the commitment it was built on, and the fake token
// checks that against the stored balance, as the verifier reads C_spend), fees, or rent.
import { bytesToHex } from '@noble/hashes/utils.js';
import { Address, Keypair, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { G, pointFromBytes, type Point } from 'stellar-confidential-token-sdk';
import { ContractCallError, SubmitRejectedError, type ChainPort, type SimResult } from '../src/chain/ports.js';
import { PASSPHRASE, accountStruct, pointBytes, raw } from './independent-xdr.js';

/** What happens to the next submitted transaction. OK applies it normally. */
export type SubmitMode = 'OK' | 'FAILED' | 'DROPPED' | 'LOST_STATUS' | 'CRASH' | 'TAMPER' | 'REJECTED' | 'LYING_SUCCESS';

type WorkerState = 'Invited' | 'Active' | 'Removed';
interface CompanyState {
  admin: string;
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

export class FakeChain implements ChainPort {
  ledger = 5_100_000;
  companies = new Map<bigint, CompanyState>();
  workers = new Map<string, WorkerState>();
  runs = new Map<string, RunState>();
  paid = new Set<string>();
  accounts = new Map<string, AccountState>();
  auditorKeys = new Map<number, Point>();
  sequences = new Map<string, bigint>();
  /** Confidential transfers each worker received. Above 1 for a worker is a double payment. */
  transfersTo = new Map<string, number>();
  /** Every submitted transaction hash, in order, including failed and dropped ones. */
  submitted: string[] = [];
  simulations = 0;
  simulationFailures = 0;
  violations: string[] = [];
  timeline: string[] = [];
  private pending: string | undefined;
  private modes: SubmitMode[] = [];
  private results = new Map<string, { status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number; crash?: boolean }>();

  constructor(readonly contracts: { payroll: string; token: string; auditor: string }) {}

  /** Queues what happens to the next submissions, one mode per submission. */
  failNext(...modes: SubmitMode[]): void {
    this.modes.push(...modes);
  }

  /** The network finished with whatever was in flight, as it would while a crashed app is closed. */
  settle(): void {
    this.pending = undefined;
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
    this.sequences.set(tx.source, sequence);
    this.ledger++;
    if (mode === 'FAILED') {
      this.results.set(hash, { status: 'FAILED', ledger: this.ledger });
      return { hash };
    }
    const before = this.snapshot();
    try {
      this.apply(tx);
    } catch (err) {
      if (!(err instanceof Revert)) throw err;
      // A failing call undoes everything it did, as on chain.
      this.restore(before);
      this.results.set(hash, { status: 'FAILED', ledger: this.ledger });
      return { hash };
    }
    if (mode === 'TAMPER') {
      const treasury = this.accounts.get(tx.source) as AccountState;
      treasury.spendable = treasury.spendable.add(G);
    }
    this.results.set(hash, {
      status: mode === 'LOST_STATUS' ? 'NOT_FOUND' : 'SUCCESS',
      ledger: this.ledger,
      crash: mode === 'CRASH',
    });
    return { hash };
  }

  async waitFor(hash: string): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number }> {
    const result = this.results.get(hash) ?? { status: 'NOT_FOUND' as const };
    if (result.crash) throw new Error('connection lost while waiting for the transaction');
    if (this.pending === hash) this.pending = undefined;
    return result.ledger === undefined || result.status === 'NOT_FOUND' ? { status: result.status } : { status: result.status, ledger: result.ledger };
  }

  private answer(contractId: string, method: string, args: xdr.ScVal[]): xdr.ScVal {
    const [a0, a1, a2] = args;
    if (contractId === this.contracts.payroll) {
      const companyId = (a0 as xdr.ScVal).u64().toBigInt();
      if (method === 'get_company') {
        const c = this.companies.get(companyId);
        if (!c) throw contractError(1);
        return raw.struct({
          admin: raw.address(c.admin),
          auditor_id: raw.u32(c.auditorId),
          label: raw.str('Fake Co'),
          created_ledger: raw.u32(1),
          active_workers: raw.u32(c.activeWorkers),
          roster_len: raw.u32(c.activeWorkers),
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
    throw new Error(`the fake chain has no ${method} on ${contractId}`);
  }

  /** Applies pay the way contract.rs does, with the source account as the only signer. */
  private apply(tx: Transaction): void {
    const op = tx.toEnvelope().v1().tx().operations()[0] as xdr.Operation;
    const call = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const contractId = StrKey.encodeContract(Buffer.from(call.contractAddress().contractId() as unknown as Uint8Array));
    if (contractId !== this.contracts.payroll || call.functionName().toString() !== 'pay') throw new Revert('not a pay call');
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
  }

  private transfer(from: string, to: string, data: Uint8Array): void {
    const sender = this.accounts.get(from);
    const recipient = this.accounts.get(to);
    if (!sender || !recipient) throw contractError(3501);
    const d = readTransferData(data);
    if (!pointFromBytes(d.proof.subarray(0, 64)).equals(sender.spendable)) throw contractError(3506);
    sender.spendable = d.cSpendNew;
    recipient.receiving = recipient.receiving.add(d.cTransfer);
    this.transfersTo.set(to, (this.transfersTo.get(to) ?? 0) + 1);
  }

  private snapshot() {
    return {
      runs: new Map([...this.runs].map(([k, v]) => [k, { ...v }])),
      paid: new Set(this.paid),
      accounts: new Map([...this.accounts].map(([k, v]) => [k, { ...v }])),
      transfersTo: new Map(this.transfersTo),
    };
  }

  private restore(s: ReturnType<FakeChain['snapshot']>): void {
    this.runs = s.runs;
    this.paid = s.paid;
    this.accounts = s.accounts;
    this.transfersTo = s.transfersTo;
  }
}
