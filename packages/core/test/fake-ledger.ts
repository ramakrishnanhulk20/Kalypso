// An in-memory ledger for the history, payslip and audit tests. Token events carry real
// ciphertexts built with the SDK's witness builders, so every decryption in the code under test
// is real. Every transaction is a real testnet envelope built with @stellar/stellar-sdk, whose
// one call carries the same TransferPayload the SDK's encoder writes, and its hash is the real
// hash of that envelope. It answers ChainPort reads with independently built XDR, serves its
// events as an RPC EventsPort and as the archive's v1 HTTP routes, serves its envelopes as a
// TxSourcePort, and can tamper with any of them. What it does NOT model: proof verification,
// fees, rent, auth, or the payroll contract's own refusals (each helper does what the test asks).
import { Account, Address, BASE_FEE, Contract, TimeoutInfinite, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import {
  buildTransferWitness,
  buildWithdrawWitness,
  commit,
  encodeTransferData,
  encodeWithdrawData,
  groupAdd,
  H,
  IDENTITY,
  scalarMul,
  type KeyPair,
  type Point,
  type TransferWitness,
} from 'stellar-confidential-token-sdk';
import { ContractCallError, type ChainPort, type SimResult } from '../src/chain/ports.js';
import type { EventsPort, RpcContractEvent } from '../src/history/rpc-events.js';
import type { TxRecord, TxSourcePort } from '../src/history/tx-binding.js';
import { PASSPHRASE, accountStruct, be32, pointBytes, raw, testAccount } from './independent-xdr.js';

interface AccountRecord {
  keys: KeyPair;
  auditorId: number;
  spend: { v: bigint; r: bigint };
  receive: { v: bigint; r: bigint };
}

interface CompanyRecord {
  admin: string;
  accountant: string;
  auditorId: number;
  label: string;
  /** Raised by every accepted handover, as accept_admin does. */
  adminChanges: number;
  /** Every worker who ever joined, in first-join order, as get_roster pages it. */
  roster: string[];
}

export interface ArchiveOptions {
  /** Ledgers the archive never ingested. Any request whose range touches one answers complete: false. */
  gap?: [number, number];
  mode?: 'ok' | 'down' | 'status500' | 'malformed' | 'foreign-event';
  /** Event ids the archive leaves out without saying so, as a dishonest archive would. */
  drop?: Set<string>;
  /** Event id to the data XDR the archive serves instead of the real one. */
  replace?: Map<string, string>;
  /** Ledgers the archive trails the chain by: it has ingested, and serves, only up to the newest minus lag. */
  lag?: number;
  pageSize?: number;
}

export type EventFields = Record<string, xdr.ScVal>;

/** The one contract call a fake transaction carries. `contract` may also be any other contract id. */
export interface FakeCall {
  contract: 'token' | 'payroll' | (string & {});
  method: string;
  args: xdr.ScVal[];
}

export interface TxSourceOptions {
  /** Hashes the source says it does not have. */
  missing?: Set<string>;
  /** Hash to the record the source answers instead of the real one. */
  serve?: Map<string, TxRecord>;
}

const BASE = 'https://archive.kalypso.test/api/archive/';
/** Pays every fake transaction's fee. Testnet only, no funds. */
const SUBMITTER = testAccount('fake ledger submitter').publicKey();
/** The token takes any proof bytes in this model, since it verifies none. */
const STAND_IN_PROOF = new Uint8Array([4, 2]);
/** The accountant a company names when a test does not care which. */
export const FAKE_ACCOUNTANT = testAccount('fake ledger accountant').publicKey();
export const sym = (name: string) => xdr.ScVal.scvSymbol(name);
const addressOf = (v: xdr.ScVal) => Address.fromScVal(v).toString();

export class FakeLedger implements ChainPort {
  ledger = 6_000_000;
  oldestLedger = 5_000_000;
  readonly events: RpcContractEvent[] = [];
  /** Every transaction by its real hash, as the RPC or Horizon would serve it. */
  readonly transactions = new Map<string, TxRecord>();
  readonly accounts = new Map<string, AccountRecord>();
  readonly auditorKeys = new Map<number, Point>();
  readonly companies = new Map<bigint, CompanyRecord>();
  readonly runs = new Map<string, { label: string; expected: number }>();
  readonly members = new Map<string, 'Invited' | 'Active' | 'Removed'>();
  readonly paid = new Set<string>();
  /** Turns a paid flag off on chain while the events stay, to model C18's on-chain check. */
  readonly unpaidOverride = new Set<string>();
  /** `company/run` to the paid_count get_run reports instead of the number of paid flags. */
  readonly paidCountOverride = new Map<string, number>();
  private txCount = 0;

  constructor(readonly contracts: { payroll: string; token: string; auditor: string }) {}

  static readonly archiveBase = BASE;

  setAuditorKey(id: number, secret: bigint): Point {
    const key = scalarMul(secret, H);
    this.auditorKeys.set(id, key);
    return key;
  }

  /** A signed-shape testnet envelope with `call` as its one operation, and its real hash. */
  envelope(call: FakeCall, sequence = this.txCount): { envelopeXdr: string; txHash: string } {
    const contractId = call.contract === 'token' ? this.contracts.token : call.contract === 'payroll' ? this.contracts.payroll : call.contract;
    const tx = new TransactionBuilder(new Account(SUBMITTER, String(sequence)), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(contractId).call(call.method, ...call.args))
      .setTimeout(TimeoutInfinite)
      .build();
    return { envelopeXdr: tx.toXDR(), txHash: tx.hash().toString('hex') };
  }

  /**
   * Runs `emit` as one transaction in a new ledger and returns its hash. `call` is the transaction's
   * own contract call; without one it calls a method no reader binds to. `contract` may also be
   * any other contract id.
   */
  tx(emit: (emitEvent: (contract: 'token' | 'payroll' | (string & {}), topics: xdr.ScVal[], data: EventFields | xdr.ScVal) => void) => void, call?: FakeCall): string {
    this.ledger++;
    this.txCount++;
    const { envelopeXdr, txHash } = this.envelope(call ?? { contract: 'token', method: 'unbound_call', args: [] });
    this.transactions.set(txHash, { envelopeXdr, successful: true, ledger: this.ledger });
    let eventIndex = 0;
    emit((contract, topics, data) => {
      const value = data instanceof xdr.ScVal ? data : raw.struct(data);
      this.events.push({
        ledger: this.ledger,
        txIndex: 1,
        opIndex: 0,
        eventIndex: eventIndex++,
        txHash,
        contractId: contract === 'token' ? this.contracts.token : contract === 'payroll' ? this.contracts.payroll : contract,
        topicsXdr: topics.map((t) => t.toXDR('base64')),
        dataXdr: value.toXDR('base64'),
        successful: true,
      });
    });
    return txHash;
  }

  register(address: string, keys: KeyPair, auditorId: number): string {
    this.accounts.set(address, { keys, auditorId, spend: { v: 0n, r: 0n }, receive: { v: 0n, r: 0n } });
    const call = { contract: 'token', method: 'register', args: [raw.address(address), raw.u32(auditorId), raw.bytes(STAND_IN_PROOF)] };
    return this.tx((emit) => emit('token', [sym('register'), raw.address(address)], { auditor_id: raw.u32(auditorId) }), call);
  }

  deposit(from: string, to: string, amount: bigint): string {
    const account = this.account(to);
    account.receive = { v: account.receive.v + amount, r: account.receive.r };
    const call = { contract: 'token', method: 'deposit', args: [raw.address(from), raw.address(to), raw.i128(amount)] };
    return this.tx((emit) => emit('token', [sym('deposit'), raw.address(from), raw.address(to)], { amount: raw.i128(amount) }), call);
  }

  merge(address: string): string {
    const account = this.account(address);
    account.spend = { v: account.spend.v + account.receive.v, r: groupAdd(account.spend.r, account.receive.r) };
    account.receive = { v: 0n, r: 0n };
    return this.tx((emit) => emit('token', [sym('merge'), raw.address(address)], {}), { contract: 'token', method: 'merge', args: [raw.address(address)] });
  }

  /**
   * The transfer event's topics and data, with the sender's and recipient's balances moved as the
   * token does. `payload` is the honest `data: Bytes` the transaction carries, from the SDK's own
   * encoder; `tamper` edits only the event, as a dishonest history source would, and `forge`
   * edits only the payload, which the real token would refuse but this model does not check.
   */
  transferEvent(
    from: string,
    to: string,
    amount: bigint,
    tamper?: (fields: EventFields) => void,
    forge?: (payload: TransferWitness['payload']) => TransferWitness['payload'],
  ): { topics: xdr.ScVal[]; data: EventFields; payload: Uint8Array } {
    const sender = this.account(from);
    const recipient = this.account(to);
    const w = buildTransferWitness({
      keys: sender.keys,
      v: sender.spend.v,
      r: sender.spend.r,
      amount,
      pvkB: recipient.keys.PVK,
      kAudR: this.auditorKey(recipient.auditorId),
      kAudS: this.auditorKey(sender.auditorId),
    });
    sender.spend = { v: w.next.v, r: w.next.r };
    recipient.receive = { v: recipient.receive.v + w.recipientView.vTx, r: groupAdd(recipient.receive.r, w.recipientView.rTx) };
    const p = w.payload;
    const data: EventFields = {
      r_e_point: raw.bytes(pointBytes(p.rE)),
      v_tilde: raw.bytes(be32(p.vTilde)),
      sigma: raw.bytes(be32(p.sigma)),
      b_tilde: raw.bytes(be32(p.bTilde)),
      v_tilde_aud_r: raw.bytes(be32(p.vAudR)),
      r_tilde_aud_r: raw.bytes(be32(p.rAudR)),
      v_tilde_aud_s: raw.bytes(be32(p.vAudS)),
      b_tilde_aud_s: raw.bytes(be32(p.bAudS)),
    };
    tamper?.(data);
    const payload = new Uint8Array(encodeTransferData(forge === undefined ? w : { ...w, payload: forge(w.payload) }, STAND_IN_PROOF).bytes());
    return { topics: [sym('transfer'), raw.address(from), raw.address(to)], data, payload };
  }

  /** A confidential transfer outside payroll, such as one account paying another directly. */
  transfer(from: string, to: string, amount: bigint, tamper?: (fields: EventFields) => void): string {
    const { topics, data, payload } = this.transferEvent(from, to, amount, tamper);
    const call = { contract: 'token', method: 'confidential_transfer', args: [raw.address(from), raw.address(to), raw.bytes(payload)] };
    return this.tx((emit) => emit('token', topics, data), call);
  }

  withdraw(from: string, to: string, amount: bigint): string {
    const sender = this.account(from);
    const w = buildWithdrawWitness({ keys: sender.keys, v: sender.spend.v, r: sender.spend.r, amount, kAudS: this.auditorKey(sender.auditorId) });
    sender.spend = { v: w.next.v, r: w.next.r };
    const p = w.payload;
    const data = new Uint8Array(encodeWithdrawData(w, STAND_IN_PROOF).bytes());
    const call = { contract: 'token', method: 'withdraw', args: [raw.address(from), raw.address(to), raw.i128(amount), raw.bytes(data)] };
    return this.tx(
      (emit) =>
        emit('token', [sym('withdraw'), raw.address(from), raw.address(to)], {
          amount: raw.i128(amount),
          r_e_point: raw.bytes(pointBytes(p.rE)),
          sigma: raw.bytes(be32(p.sigma)),
          b_tilde: raw.bytes(be32(p.bTilde)),
          b_tilde_aud_s: raw.bytes(be32(p.bAudS)),
        }),
      call,
    );
  }

  createCompany(id: bigint, admin: string, auditorId: number, label: string, accountant = FAKE_ACCOUNTANT): string {
    this.companies.set(id, { admin, accountant, auditorId, label, adminChanges: 0, roster: [] });
    const call = { contract: 'payroll', method: 'create_company', args: [raw.address(admin), raw.address(accountant), raw.u32(auditorId), raw.str(label)] };
    return this.tx(
      (emit) => emit('payroll', [sym('company_created'), raw.u64(id)], { admin: raw.address(admin), accountant: raw.address(accountant), auditor_id: raw.u32(auditorId), label: raw.str(label) }),
      call,
    );
  }

  changeAdmin(id: bigint, newAdmin: string): string {
    const company = this.companies.get(id) as CompanyRecord;
    const previous = company.admin;
    company.admin = newAdmin;
    company.adminChanges++;
    return this.tx(
      (emit) => emit('payroll', [sym('admin_changed'), raw.u64(id)], { previous_admin: raw.address(previous), new_admin: raw.address(newAdmin) }),
      { contract: 'payroll', method: 'accept_admin', args: [raw.u64(id)] },
    );
  }

  join(id: bigint, worker: string): string {
    this.members.set(`${id}/${worker}`, 'Active');
    const roster = (this.companies.get(id) as CompanyRecord).roster;
    if (!roster.includes(worker)) roster.push(worker);
    return this.tx((emit) => emit('payroll', [sym('worker_joined'), raw.u64(id), raw.address(worker)], {}), {
      contract: 'payroll',
      method: 'accept_invite',
      args: [raw.u64(id), raw.address(worker)],
    });
  }

  openRun(id: bigint, runId: bigint, label: string, expected: number): string {
    this.runs.set(`${id}/${runId}`, { label, expected });
    const call = { contract: 'payroll', method: 'open_run', args: [raw.u64(id), raw.u64(runId), raw.str(label), raw.u32(expected)] };
    return this.tx(
      (emit) => emit('payroll', [sym('run_opened'), raw.u64(id), raw.u64(runId)], { period_label: raw.str(label), expected_count: raw.u32(expected) }),
      call,
    );
  }

  /**
   * One pay transaction, as the payroll contract emits it: per item a token transfer, then its
   * payslip. The envelope calls pay(company, run, items) with each item's honest payload.
   */
  pay(
    id: bigint,
    runId: bigint,
    items: { worker: string; amount: bigint; tamper?: (fields: EventFields) => void; forge?: (payload: TransferWitness['payload']) => TransferWitness['payload'] }[],
  ): string {
    const company = this.companies.get(id) as CompanyRecord;
    const transfers = items.map((item) => ({ worker: item.worker, ...this.transferEvent(company.admin, item.worker, item.amount, item.tamper, item.forge) }));
    const call = {
      contract: 'payroll',
      method: 'pay',
      args: [raw.u64(id), raw.u64(runId), raw.vec(transfers.map((t) => raw.vec([raw.address(t.worker), raw.bytes(t.payload)])))],
    };
    return this.tx((emit) => {
      for (const t of transfers) {
        emit('token', t.topics, t.data);
        emit('payroll', [sym('payslip_issued'), raw.u64(id), raw.u64(runId), raw.address(t.worker)], {});
        this.paid.add(`${id}/${runId}/${t.worker}`);
      }
    }, call);
  }

  account(address: string): AccountRecord {
    const account = this.accounts.get(address);
    if (account === undefined) throw new Error(`the fake ledger has no account ${address}`);
    return account;
  }

  auditorKey(id: number): Point {
    const key = this.auditorKeys.get(id);
    if (key === undefined) throw new Error(`the fake ledger has no auditor ${id}`);
    return key;
  }

  /** What the chain stores for an account right now: the commitments to its openings. */
  commitments(address: string): { spendable: Point; receiving: Point } {
    const a = this.account(address);
    return { spendable: commit(a.spend.v, a.spend.r), receiving: a.receive.v === 0n && a.receive.r === 0n ? IDENTITY : commit(a.receive.v, a.receive.r) };
  }

  async read(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const [a0, a1, a2] = args as [xdr.ScVal, xdr.ScVal, xdr.ScVal];
    const address = addressOf;
    if (contractId === this.contracts.token && method === 'confidential_balance') {
      const who = address(a0);
      const account = this.accounts.get(who);
      if (account === undefined) throw new ContractCallError(method, 3501);
      const { spendable, receiving } = this.commitments(who);
      return accountStruct({ auditorId: account.auditorId, spendingKey: account.keys.Y, pvk: account.keys.PVK, spendable, receiving });
    }
    if (contractId === this.contracts.auditor && method === 'get_key') {
      const key = this.auditorKeys.get(a0.u32());
      if (key === undefined) throw new ContractCallError(method, 3301);
      return raw.bytes(pointBytes(key));
    }
    if (contractId === this.contracts.payroll && method === 'memberships_of') {
      const worker = address(a0);
      return raw.u32([...this.companies.values()].filter((c) => c.roster.includes(worker)).length);
    }
    if (contractId === this.contracts.payroll) {
      const companyId = a0.u64().toBigInt();
      if (method === 'get_company') {
        const c = this.companies.get(companyId);
        if (c === undefined) throw new ContractCallError(method, 1);
        const active = c.roster.filter((w) => this.members.get(`${companyId}/${w}`) === 'Active').length;
        return raw.struct({
          admin: raw.address(c.admin),
          accountant: raw.address(c.accountant),
          auditor_id: raw.u32(c.auditorId),
          label: raw.str(c.label),
          created_ledger: raw.u32(1),
          active_workers: raw.u32(active),
          roster_len: raw.u32(c.roster.length),
          runs_opened: raw.u32([...this.runs.keys()].filter((key) => key.startsWith(`${companyId}/`)).length),
          admin_changes: raw.u32(c.adminChanges),
        });
      }
      if (method === 'get_roster') {
        const c = this.companies.get(companyId);
        if (c === undefined) throw new ContractCallError(method, 1);
        const from = a1.u32();
        return raw.vec(c.roster.slice(from, from + a2.u32()).map((w) => raw.address(w)));
      }
      if (method === 'get_run') {
        const key = `${companyId}/${a1.u64().toBigInt()}`;
        const run = this.runs.get(key);
        if (run === undefined) throw new ContractCallError(method, 10);
        // The contract counts a payment exactly when it sets its paid flag.
        const flagged = [...this.paid].filter((flag) => flag.startsWith(`${key}/`) && !this.unpaidOverride.has(flag)).length;
        return raw.struct({
          status: raw.u32(0),
          period_label: raw.str(run.label),
          expected_count: raw.u32(run.expected),
          paid_count: raw.u32(this.paidCountOverride.get(key) ?? flagged),
          opened_ledger: raw.u32(1),
        });
      }
      if (method === 'is_paid') {
        const key = `${companyId}/${a1.u64().toBigInt()}/${address(a2)}`;
        return raw.bool(this.paid.has(key) && !this.unpaidOverride.has(key));
      }
      if (method === 'worker_status') {
        const status = this.members.get(`${companyId}/${address(a1)}`);
        return status === undefined ? raw.void() : raw.u32({ Invited: 0, Active: 1, Removed: 2 }[status]);
      }
    }
    throw new Error(`the fake ledger has no ${method} on ${contractId}`);
  }

  async simulate(): Promise<SimResult> {
    throw new Error('the fake ledger does not simulate');
  }

  async submit(): Promise<{ hash: string }> {
    throw new Error('the fake ledger does not take transactions');
  }

  async waitFor(): Promise<{ status: 'NOT_FOUND' }> {
    return { status: 'NOT_FOUND' };
  }

  async sourceAccount(): Promise<{ sequence: string }> {
    return { sequence: '41' };
  }

  /** Ledgers close every 5 seconds from a fixed testnet-era start, so the clock follows the ledger count. */
  async latestLedger(): Promise<{ sequence: number; closeTime: number }> {
    return { sequence: this.ledger, closeTime: 1_791_000_000 + this.ledger * 5 };
  }

  /**
   * The RPC view: only ledgers from oldestLedger, at most `limit` events a page, cursors in the
   * RPC's toid format. Like the real RPC, a request scans at most `scanLedgers` ledgers; a page
   * shorter than the limit ends with the end-of-ledger cursor of the last ledger it scanned.
   */
  rpc(opts: { scanLedgers?: number; duplicate?: boolean } = {}): EventsPort & { calls: number } {
    const ledger = this;
    const port = {
      calls: 0,
      async ledgerWindow() {
        return { oldestLedger: ledger.oldestLedger, latestLedger: ledger.ledger };
      },
      async contractEvents(query: Parameters<EventsPort['contractEvents']>[0]) {
        port.calls++;
        const resume = 'cursor' in query ? toidOf(query.cursor) : null;
        const from = resume === null ? (query as { startLedger: number }).startLedger : Number(resume >> 64n);
        if (from < ledger.oldestLedger) throw new Error('startLedger is older than the RPC window');
        const scanEnd = Math.min(ledger.ledger, from + (opts.scanLedgers ?? 1_000_000) - 1);
        const matching = ledger.events.filter(
          (e) =>
            e.contractId === query.contractId &&
            e.ledger >= from &&
            e.ledger <= scanEnd &&
            (resume === null || positionKey(e) > resume),
        );
        const page = matching.slice(0, query.limit);
        const last = page[page.length - 1];
        const cursor = page.length === query.limit && last !== undefined ? rpcId(last) : `${((BigInt(scanEnd) << 32n) | 0xffff_ffffn).toString().padStart(19, '0')}-4294967295`;
        const events = page.map((e) => ({ ...e }));
        return { events: opts.duplicate ? [...events, ...events] : events, cursor, latestLedger: ledger.ledger };
      },
    };
    return port;
  }

  /** The RPC and Horizon view of transactions: each envelope by its hash. `calls` lists the hashes asked for. */
  txSource(opts: TxSourceOptions = {}): TxSourcePort & { calls: string[] } {
    const ledger = this;
    const port = {
      calls: [] as string[],
      async transaction(txHash: string) {
        port.calls.push(txHash);
        if (opts.missing?.has(txHash)) return null;
        return opts.serve?.get(txHash) ?? ledger.transactions.get(txHash) ?? null;
      },
    };
    return port;
  }

  /** A fetch for the archive's v1 routes under archiveBase. Returns the fetch and the URLs it was called with. */
  archiveFetch(opts: ArchiveOptions = {}) {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      if (opts.mode === 'down') throw new TypeError('fetch failed');
      if (opts.mode === 'status500') return { ok: false, status: 500, text: async () => '{"error":"internal_error"}' };
      const u = new URL(url);
      if (!u.href.startsWith(BASE)) throw new Error(`unexpected archive URL ${url}`);
      const parts = u.pathname.slice(new URL(BASE).pathname.length).split('/');
      const from = Math.max(Number(u.searchParams.get('from_ledger') ?? '1'), 1);
      const limit = Number(u.searchParams.get('limit') ?? '200');
      const cursor = u.searchParams.get('cursor');
      const through = this.ledger - (opts.lag ?? 0);
      let rows = this.events.filter((e) => e.ledger >= from && e.ledger <= through);
      if (parts[1] === 'tokens') {
        const account = parts[4] as string;
        rows = rows.filter((e) => e.contractId === parts[2] && e.topicsXdr.slice(1).some((t) => topicIsAddress(t, account)));
      } else {
        const company = BigInt(parts[4] as string);
        rows = rows.filter((e) => e.contractId === parts[2] && topicU64(e.topicsXdr[1]) === company);
      }
      if (opts.mode === 'foreign-event') rows = this.events.slice(0, 1);
      rows = rows.filter((e) => !opts.drop?.has(`${e.ledger}-${e.txHash}-${e.opIndex}-${e.eventIndex}`));
      if (cursor !== null) rows = rows.filter((e) => archiveAfter(e, cursor));
      const size = Math.min(limit, opts.pageSize ?? limit);
      const page = rows.slice(0, size);
      const more = rows.length > size;
      const gap = opts.gap;
      const complete = gap === undefined || gap[1] < from || gap[0] > this.ledger;
      const body = {
        events: page.map((e) => ({
          ledger_seq: e.ledger,
          tx_hash: e.txHash,
          tx_application_order: e.txIndex,
          operation_index: e.opIndex,
          event_index: e.eventIndex,
          ledger_close_time: '2026-10-08T00:00:00.000Z',
          contract_id: e.contractId,
          topics_xdr: e.topicsXdr,
          data_xdr: opts.replace?.get(`${e.ledger}-${e.txHash}-${e.opIndex}-${e.eventIndex}`) ?? e.dataXdr,
        })),
        cursor: more ? [page.at(-1)?.ledger, page.at(-1)?.txIndex, page.at(-1)?.opIndex, page.at(-1)?.eventIndex].join('-') : null,
        complete,
        ingested_through: gap !== undefined && gap[1] >= this.ledger ? gap[0] - 1 : through,
      };
      const text = opts.mode === 'malformed' ? JSON.stringify({ ...body, complete: 'yes' }) : JSON.stringify(body);
      return { ok: true, status: 200, text: async () => text };
    };
    return { fetch, urls };
  }
}

function topicIsAddress(b64: string, account: string): boolean {
  const v = xdr.ScVal.fromXDR(b64, 'base64');
  return v.switch().name === 'scvAddress' && Address.fromScVal(v).toString() === account;
}

function topicU64(b64: string | undefined): bigint | null {
  if (b64 === undefined) return null;
  const v = xdr.ScVal.fromXDR(b64, 'base64');
  return v.switch().name === 'scvU64' ? v.u64().toBigInt() : null;
}

/** True when the event sits after the archive cursor `ledger-txIndex-opIndex-eventIndex`. */
function archiveAfter(e: RpcContractEvent, cursor: string): boolean {
  const [l, t, o, i] = cursor.split('-').map(Number) as [number, number, number, number];
  const difference = [e.ledger - l, e.txIndex - t, e.opIndex - o, e.eventIndex - i].find((d) => d !== 0) ?? 0;
  return difference > 0;
}

function positionKey(e: RpcContractEvent): bigint {
  return (((BigInt(e.ledger) << 32n) | (BigInt(e.txIndex) << 12n) | BigInt(e.opIndex)) << 32n) | BigInt(e.eventIndex);
}

function toidOf(cursor: string): bigint {
  const [toid, index] = cursor.split('-') as [string, string];
  return (BigInt(toid) << 32n) | BigInt(index);
}

/** The RPC's event id for an event: the toid of its operation, then its index, zero-padded as the RPC does. */
export function rpcId(e: { ledger: number; txIndex: number; opIndex: number; eventIndex: number }): string {
  const toid = (BigInt(e.ledger) << 32n) | (BigInt(e.txIndex) << 12n) | BigInt(e.opIndex);
  return `${toid.toString().padStart(19, '0')}-${e.eventIndex.toString().padStart(10, '0')}`;
}
