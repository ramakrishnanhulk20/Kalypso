// An in-memory ledger for the history, payslip and audit tests. Token events carry real
// ciphertexts built with the SDK's witness builders, so every decryption in the code under test
// is real. It answers ChainPort reads with independently built XDR, serves its events as an RPC
// EventsPort and as the archive's v1 HTTP routes, and can tamper with either. What it does NOT
// model: proof verification, fees, rent, auth, or the payroll contract's own refusals (each
// helper does what the test asks).
import { createHash } from 'node:crypto';
import { Address, xdr } from '@stellar/stellar-sdk/base';
import {
  buildTransferWitness,
  buildWithdrawWitness,
  commit,
  groupAdd,
  H,
  IDENTITY,
  scalarMul,
  type KeyPair,
  type Point,
} from 'stellar-confidential-token-sdk';
import { ContractCallError, type ChainPort, type SimResult } from '../src/chain/ports.js';
import type { EventsPort, RpcContractEvent } from '../src/history/rpc-events.js';
import { accountStruct, be32, pointBytes, raw } from './independent-xdr.js';

interface AccountRecord {
  keys: KeyPair;
  auditorId: number;
  spend: { v: bigint; r: bigint };
  receive: { v: bigint; r: bigint };
}

interface CompanyRecord {
  admin: string;
  auditorId: number;
  label: string;
}

export interface ArchiveOptions {
  /** Ledgers the archive never ingested. Any request whose range touches one answers complete: false. */
  gap?: [number, number];
  mode?: 'ok' | 'down' | 'status500' | 'malformed' | 'foreign-event';
  /** Event ids the archive leaves out without saying so, as a dishonest archive would. */
  drop?: Set<string>;
  pageSize?: number;
}

export type EventFields = Record<string, xdr.ScVal>;

const BASE = 'https://archive.kalypso.test/api/archive/';
export const sym = (name: string) => xdr.ScVal.scvSymbol(name);
const addressOf = (v: xdr.ScVal) => Address.fromScVal(v).toString();

export class FakeLedger implements ChainPort {
  ledger = 6_000_000;
  oldestLedger = 5_000_000;
  readonly events: RpcContractEvent[] = [];
  readonly accounts = new Map<string, AccountRecord>();
  readonly auditorKeys = new Map<number, Point>();
  readonly companies = new Map<bigint, CompanyRecord>();
  readonly runs = new Map<string, { label: string; expected: number; paid: number }>();
  readonly members = new Map<string, 'Invited' | 'Active' | 'Removed'>();
  readonly paid = new Set<string>();
  /** Turns a paid flag off on chain while the events stay, to model C18's on-chain check. */
  readonly unpaidOverride = new Set<string>();
  private txCount = 0;

  constructor(readonly contracts: { payroll: string; token: string; auditor: string }) {}

  static readonly archiveBase = BASE;

  setAuditorKey(id: number, secret: bigint): Point {
    const key = scalarMul(secret, H);
    this.auditorKeys.set(id, key);
    return key;
  }

  /** Runs `emit` as one transaction in a new ledger and returns its hash. `contract` may also be any other contract id. */
  tx(emit: (emitEvent: (contract: 'token' | 'payroll' | (string & {}), topics: xdr.ScVal[], data: EventFields | xdr.ScVal) => void) => void): string {
    this.ledger++;
    this.txCount++;
    const txHash = createHash('sha256').update(`fake tx ${this.txCount}`).digest('hex');
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
    return this.tx((emit) => emit('token', [sym('register'), raw.address(address)], { auditor_id: raw.u32(auditorId) }));
  }

  deposit(from: string, to: string, amount: bigint): string {
    const account = this.account(to);
    account.receive = { v: account.receive.v + amount, r: account.receive.r };
    return this.tx((emit) => emit('token', [sym('deposit'), raw.address(from), raw.address(to)], { amount: raw.i128(amount) }));
  }

  merge(address: string): string {
    const account = this.account(address);
    account.spend = { v: account.spend.v + account.receive.v, r: groupAdd(account.spend.r, account.receive.r) };
    account.receive = { v: 0n, r: 0n };
    return this.tx((emit) => emit('token', [sym('merge'), raw.address(address)], {}));
  }

  /** The transfer event's topics and data, with the sender's and recipient's balances moved as the token does. */
  transferEvent(from: string, to: string, amount: bigint, tamper?: (fields: EventFields) => void): { topics: xdr.ScVal[]; data: EventFields } {
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
    return { topics: [sym('transfer'), raw.address(from), raw.address(to)], data };
  }

  /** A confidential transfer outside payroll, such as one account paying another directly. */
  transfer(from: string, to: string, amount: bigint, tamper?: (fields: EventFields) => void): string {
    return this.tx((emit) => {
      const { topics, data } = this.transferEvent(from, to, amount, tamper);
      emit('token', topics, data);
    });
  }

  withdraw(from: string, to: string, amount: bigint): string {
    const sender = this.account(from);
    const w = buildWithdrawWitness({ keys: sender.keys, v: sender.spend.v, r: sender.spend.r, amount, kAudS: this.auditorKey(sender.auditorId) });
    sender.spend = { v: w.next.v, r: w.next.r };
    const p = w.payload;
    return this.tx((emit) =>
      emit('token', [sym('withdraw'), raw.address(from), raw.address(to)], {
        amount: raw.i128(amount),
        r_e_point: raw.bytes(pointBytes(p.rE)),
        sigma: raw.bytes(be32(p.sigma)),
        b_tilde: raw.bytes(be32(p.bTilde)),
        b_tilde_aud_s: raw.bytes(be32(p.bAudS)),
      }),
    );
  }

  createCompany(id: bigint, admin: string, auditorId: number, label: string): string {
    this.companies.set(id, { admin, auditorId, label });
    return this.tx((emit) =>
      emit('payroll', [sym('company_created'), raw.u64(id)], { admin: raw.address(admin), auditor_id: raw.u32(auditorId), label: raw.str(label) }),
    );
  }

  changeAdmin(id: bigint, newAdmin: string): string {
    const company = this.companies.get(id) as CompanyRecord;
    const previous = company.admin;
    company.admin = newAdmin;
    return this.tx((emit) =>
      emit('payroll', [sym('admin_changed'), raw.u64(id)], { previous_admin: raw.address(previous), new_admin: raw.address(newAdmin) }),
    );
  }

  join(id: bigint, worker: string): string {
    this.members.set(`${id}/${worker}`, 'Active');
    return this.tx((emit) => emit('payroll', [sym('worker_joined'), raw.u64(id), raw.address(worker)], {}));
  }

  openRun(id: bigint, runId: bigint, label: string, expected: number): string {
    this.runs.set(`${id}/${runId}`, { label, expected, paid: 0 });
    return this.tx((emit) =>
      emit('payroll', [sym('run_opened'), raw.u64(id), raw.u64(runId)], { period_label: raw.str(label), expected_count: raw.u32(expected) }),
    );
  }

  /** One pay transaction, as the payroll contract emits it: per item a token transfer, then its payslip. */
  pay(id: bigint, runId: bigint, items: { worker: string; amount: bigint; tamper?: (fields: EventFields) => void }[]): string {
    const company = this.companies.get(id) as CompanyRecord;
    const run = this.runs.get(`${id}/${runId}`) as { paid: number };
    return this.tx((emit) => {
      for (const item of items) {
        const { topics, data } = this.transferEvent(company.admin, item.worker, item.amount, item.tamper);
        emit('token', topics, data);
        emit('payroll', [sym('payslip_issued'), raw.u64(id), raw.u64(runId), raw.address(item.worker)], {});
        this.paid.add(`${id}/${runId}/${item.worker}`);
        run.paid++;
      }
    });
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
    if (contractId === this.contracts.payroll) {
      const companyId = a0.u64().toBigInt();
      if (method === 'get_company') {
        const c = this.companies.get(companyId);
        if (c === undefined) throw new ContractCallError(method, 1);
        return raw.struct({
          admin: raw.address(c.admin),
          auditor_id: raw.u32(c.auditorId),
          label: raw.str(c.label),
          created_ledger: raw.u32(1),
          active_workers: raw.u32(0),
          roster_len: raw.u32(0),
        });
      }
      if (method === 'get_run') {
        const run = this.runs.get(`${companyId}/${a1.u64().toBigInt()}`);
        if (run === undefined) throw new ContractCallError(method, 10);
        return raw.struct({
          status: raw.u32(0),
          period_label: raw.str(run.label),
          expected_count: raw.u32(run.expected),
          paid_count: raw.u32(run.paid),
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
      let rows = this.events.filter((e) => e.ledger >= from);
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
          data_xdr: e.dataXdr,
        })),
        cursor: more ? [page.at(-1)?.ledger, page.at(-1)?.txIndex, page.at(-1)?.opIndex, page.at(-1)?.eventIndex].join('-') : null,
        complete,
        ingested_through: gap !== undefined && gap[1] >= this.ledger ? gap[0] - 1 : this.ledger,
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
