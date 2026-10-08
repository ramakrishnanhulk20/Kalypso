// Does NOT cover: real proofs or the live network (scratchpad/m5b3/e2e-views.mjs runs these
// views on testnet), or an archive and an RPC that agree on a lie about which events exist.
// Every ciphertext here is real, built by the SDK's witness builders on the fake ledger.
import { Address, xdr } from '@stellar/stellar-sdk/base';
import { commit, ecdh, encryptAmount, fromBytesBE, H, scalarMul } from 'stellar-confidential-token-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUsdc } from '../src/amounts.js';
import type { RpcContractEvent } from '../src/history/rpc-events.js';
import type { TxSourcePort } from '../src/history/tx-binding.js';
import { loadWorkerBalance, loadWorkerView, WorkerViewError, type WorkerView } from '../src/payslips/worker.js';
import { FakeLedger, sym, type ArchiveOptions } from './fake-ledger.js';
import { be32, pointBytes, raw, testAccount, testContract } from './independent-xdr.js';
import { COMPANY, COMPANY_AUDITOR_ID, CONTRACTS, PAY, RUN, keysFor, scenario, type Scenario } from './scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const archive = { baseUrl: FakeLedger.archiveBase };

function view(
  s: Scenario,
  worker: string,
  opts: { archive?: ArchiveOptions; companyIds?: bigint[]; keysOf?: string; txSource?: TxSourcePort } = {},
): Promise<WorkerView> {
  if (opts.archive !== undefined) vi.stubGlobal('fetch', s.ledger.archiveFetch(opts.archive).fetch);
  const history = opts.archive === undefined ? { rpc: s.ledger.rpc(), fromLedger: s.fromLedger } : { archive, rpc: s.ledger.rpc(), fromLedger: s.fromLedger };
  const txSource = opts.txSource ?? s.ledger.txSource();
  return loadWorkerView({ port: s.ledger, history, contracts: CONTRACTS, worker, keys: keysFor(opts.keysOf ?? worker), companyIds: opts.companyIds ?? [COMPANY], txSource });
}

const payslipOf = (s: Scenario, i: number) => ({
  companyId: COMPANY,
  runId: RUN,
  periodLabel: 'October 2026',
  amount: PAY[i] as bigint,
  txHash: s.payTx,
  ledger: s.ledger.events.find((e) => e.txHash === s.payTx)?.ledger,
});

describe('loadWorkerView: payslips (C18)', () => {
  it('shows each worker exactly their own payslip and a verified balance', async () => {
    const s = scenario();
    for (const [i, worker] of s.workers.entries()) {
      expect(await view(s, worker)).toEqual({ complete: true, spendable: 0n, receiving: PAY[i], payslips: [payslipOf(s, i)], gaps: [] });
    }
    s.ledger.merge(s.workers[0] as string);
    expect(await view(s, s.workers[0] as string)).toMatchObject({ complete: true, spendable: PAY[0], receiving: 0n });
  });

  it('never turns a direct confidential transfer or a deposit into a payslip, but counts them in the balance', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.deposit(s.outsider, s.outsider, 50_000_000n);
    s.ledger.merge(s.outsider);
    s.ledger.transfer(s.outsider, worker, 1_000_001n);
    s.ledger.deposit(s.outsider, worker, 2_000_002n);
    s.ledger.transfer(s.treasury, worker, 3_000_003n);
    const result = await view(s, worker);
    expect(result.payslips).toEqual([payslipOf(s, 0)]);
    expect(result).toMatchObject({ complete: true, receiving: (PAY[0] as bigint) + 1_000_001n + 2_000_002n + 3_000_003n });
  });

  it('drops a payslip the chain says was not paid', async () => {
    const s = scenario();
    s.ledger.unpaidOverride.add(`${COMPANY}/${RUN}/${s.workers[0]}`);
    expect(await view(s, s.workers[0] as string)).toMatchObject({ complete: true, payslips: [], gaps: [] });
  });

  it('ignores a payslip event from any contract but ours, even with a treasury transfer and a paid flag', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const copycat = testContract(99);
    s.ledger.paid.add(`${COMPANY}/2/${worker}`);
    s.ledger.tx((emit) => {
      const { topics, data } = s.ledger.transferEvent(s.treasury, worker, 4_000_004n);
      emit('token', topics, data);
      emit(copycat, [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(2n), raw.address(worker)], {});
    });
    expect((await view(s, worker)).payslips).toEqual([payslipOf(s, 0)]);
  });

  it('refuses a payslip whose transfer in that transaction is not from the treasury, and says history is incomplete', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.deposit(s.outsider, s.outsider, 50_000_000n);
    s.ledger.merge(s.outsider);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    s.ledger.paid.add(`${COMPANY}/2/${worker}`);
    s.ledger.tx((emit) => {
      const { topics, data } = s.ledger.transferEvent(s.outsider, worker, 4_000_004n);
      emit('token', topics, data);
      emit('payroll', [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(2n), raw.address(worker)], {});
    });
    const result = await view(s, worker);
    expect(result.payslips).toEqual([payslipOf(s, 0)]);
    expect(result.complete).toBe(false);
  });

  it('ignores a company the worker never joined, even one that paid them, and a company that does not exist', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.deposit(s.outsider, s.outsider, 50_000_000n);
    s.ledger.merge(s.outsider);
    s.ledger.createCompany(8n, s.outsider, 13, 'Stranger Co');
    s.ledger.openRun(8n, RUN, 'Stranger run', 1);
    s.ledger.pay(8n, RUN, [{ worker, amount: 7_000_007n }]);
    const result = await view(s, worker, { companyIds: [COMPANY, 8n, 8n, 99n] });
    expect(result.payslips).toEqual([payslipOf(s, 0)]);
    expect(result).toMatchObject({ complete: true, gaps: [] });
  });

  it('counts a company as joined only from its roster, so an invite from a stranger cannot stand in for a hidden company (C48)', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.createCompany(9n, s.outsider, 13, 'Inviting Co');
    s.ledger.members.set(`9/${worker}`, 'Invited');
    s.ledger.createCompany(10n, s.outsider, 13, 'Revoked Co');
    s.ledger.members.set(`10/${worker}`, 'Removed');
    expect(await view(s, worker, { companyIds: [COMPANY, 9n, 10n] })).toMatchObject({ complete: true, payslips: [payslipOf(s, 0)], gaps: [] });

    // The worker also joined company 8, which the list leaves out; a pending invite must not make up the count.
    s.ledger.createCompany(8n, s.outsider, 13, 'Joined Co');
    s.ledger.join(8n, worker);
    expect(await view(s, worker, { companyIds: [COMPANY, 9n] })).toMatchObject({ complete: false, gaps: [{ reason: 'company_count_mismatch', expected: 2, found: 1 }] });
  });

  it('finds the worker on a roster longer than one page', async () => {
    const s = scenario();
    const worker = s.workers[1] as string;
    const roster = s.ledger.companies.get(COMPANY)?.roster as string[];
    roster.unshift(...Array.from({ length: 120 }, (_, i) => testAccount(`roster filler ${i}`).publicKey()));
    expect(await view(s, worker)).toEqual({ complete: true, spendable: 0n, receiving: PAY[1], payslips: [payslipOf(s, 1)], gaps: [] });
  });

  it('attributes each payslip to the treasury of its time across an admin handover', async () => {
    const s = scenario();
    const worker = s.workers[1] as string;
    const next = testAccount('scenario next treasury').publicKey();
    s.ledger.register(next, keysFor(next), COMPANY_AUDITOR_ID);
    s.ledger.deposit(next, next, 90_000_000n);
    s.ledger.merge(next);
    s.ledger.changeAdmin(COMPANY, next);
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 2);
    const second = s.ledger.pay(COMPANY, 2n, [{ worker, amount: 5_100_015n }]);
    const result = await view(s, worker);
    expect(result.complete).toBe(true);
    expect(result.payslips.map((p) => [p.runId, p.amount, p.txHash])).toEqual([
      [RUN, PAY[1], s.payTx],
      [2n, 5_100_015n, second],
    ]);
  });

  it('trusts no payslip of a company whose admin changes do not add up', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.tx((emit) =>
      emit('payroll', [sym('admin_changed'), raw.u64(COMPANY)], { previous_admin: raw.address(s.outsider), new_admin: raw.address(s.treasury) }),
    );
    expect(await view(s, worker)).toMatchObject({ complete: false, payslips: [] });
  });

  it('gives no number for a payslip whose ciphertext does not open to money', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    const forged = s.ledger.pay(COMPANY, 2n, [{ worker, amount: 6_000_006n, tamper: (f) => void (f.v_tilde = raw.bytes(new Uint8Array(32).fill(0x0f))) }]);
    const result = await view(s, worker);
    expect(result.payslips.some((p) => p.txHash === forged)).toBe(false);
    expect(result).toEqual({ complete: false, payslips: [payslipOf(s, 0)], gaps: [{ reason: 'payslip_missing', companyId: COMPANY, runId: 2n }] });
  });
});

/**
 * What a lying archive can do with public keys alone: re-encrypt the amount of the transfer to
 * `worker` in `txHash` under the worker's public viewing key, with a fresh ephemeral scalar.
 */
function reEncrypted(s: Scenario, worker: string, txHash: string, amount: bigint): Map<string, string> {
  const event = s.ledger.events.find(
    (e) => e.txHash === txHash && e.contractId === CONTRACTS.token && Address.fromScVal(xdr.ScVal.fromXDR(e.topicsXdr[2] as string, 'base64')).toString() === worker,
  );
  if (event === undefined) throw new Error('no transfer to that worker in that transaction');
  const fields = new Map((xdr.ScVal.fromXDR(event.dataXdr, 'base64').map() ?? []).map((entry) => [entry.key().sym().toString(), entry.val()]));
  const sigma = fromBytesBE(new Uint8Array((fields.get('sigma') as xdr.ScVal).bytes()));
  const ephemeral = 0x7e5e_ed00_0001n;
  fields.set('r_e_point', raw.bytes(pointBytes(scalarMul(ephemeral, H))));
  fields.set('v_tilde', raw.bytes(be32(encryptAmount(amount, ecdh(ephemeral, keysFor(worker).PVK), sigma))));
  return new Map([[`${event.ledger}-${event.txHash}-${event.opIndex}-${event.eventIndex}`, raw.struct(Object.fromEntries(fields)).toXDR('base64')]]);
}

describe('loadWorkerView: every shown amount is bound to its transaction (C18, C19)', () => {
  it('shows no payslip, and says incomplete, when the archive re-encrypts a paid transfer after a merge and a withdrawal', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.merge(worker);
    s.ledger.withdraw(worker, worker, 100n);
    const replace = reEncrypted(s, worker, s.payTx, 9_190_000_018n);
    const result = await view(s, worker, { archive: { replace } });
    expect(result.payslips).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('shows no payslip whose transaction no source has', async () => {
    const s = scenario();
    expect(await view(s, s.workers[0] as string, { txSource: s.ledger.txSource({ missing: new Set([s.payTx]) }) })).toMatchObject({ complete: false, payslips: [] });
  });

  it('never turns a direct transfer into a payslip, even with a payslip event and a paid flag forged around it', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    s.ledger.paid.add(`${COMPANY}/2/${worker}`);
    const { topics, data, payload } = s.ledger.transferEvent(s.treasury, worker, 4_000_004n);
    const call = { contract: 'token', method: 'confidential_transfer', args: [raw.address(s.treasury), raw.address(worker), raw.bytes(payload)] };
    s.ledger.tx((emit) => {
      emit('token', topics, data);
      emit('payroll', [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(2n), raw.address(worker)], {});
    }, call);
    const result = await view(s, worker);
    expect(result.payslips).toEqual([payslipOf(s, 0)]);
    expect(result.complete).toBe(false);
  });

  it('refuses a payslip event for one run placed in the pay transaction of another', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    s.ledger.paid.add(`${COMPANY}/2/${worker}`);
    const slip = s.ledger.events.find((e) => e.txHash === s.payTx && e.contractId === CONTRACTS.payroll) as RpcContractEvent;
    const topics = [sym('payslip_issued'), raw.u64(COMPANY), raw.u64(2n), raw.address(worker)];
    s.ledger.events.push({ ...slip, eventIndex: 9, topicsXdr: topics.map((t) => t.toXDR('base64')) });
    const result = await view(s, worker);
    expect(result.payslips).toEqual([payslipOf(s, 0)]);
    expect(result.complete).toBe(false);
  });

  it("gives no number when what the worker decrypts does not open the transaction's c_transfer", async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.openRun(COMPANY, 2n, 'November 2026', 1);
    const forged = s.ledger.pay(COMPANY, 2n, [{ worker, amount: 6_000_006n, forge: (p) => ({ ...p, cTx: commit(6_000_007n, 1n) }) }]);
    const result = await view(s, worker);
    expect(result.payslips.some((p) => p.txHash === forged)).toBe(false);
    expect(result).toMatchObject({ complete: false, payslips: [payslipOf(s, 0)] });
  });
});

describe('loadWorkerView: balances only when history is complete and opens the chain (C16, C17)', () => {
  it('reads the archive and gives the same view as the RPC', async () => {
    const s = scenario();
    expect(await view(s, s.workers[0] as string, { archive: {} })).toEqual(await view(s, s.workers[0] as string));
  });

  it('gives no balance when the archive says its history is incomplete', async () => {
    const s = scenario();
    const result = await view(s, s.workers[0] as string, { archive: { gap: [s.fromLedger, s.fromLedger] } });
    expect(result).toEqual({ complete: false, payslips: [payslipOf(s, 0)], gaps: [] });
    expect('spendable' in result || 'receiving' in result).toBe(false);
  });

  it('gives no balance, and no opening to withdraw from, when the archive silently drops one event', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const dropped = s.ledger.deposit(s.outsider, worker, 2_000_002n);
    const event = s.ledger.events.find((e) => e.txHash === dropped);
    const drop = new Set([`${event?.ledger}-${dropped}-0-0`]);
    vi.stubGlobal('fetch', s.ledger.archiveFetch({ drop }).fetch);
    const balance = await loadWorkerBalance({ port: s.ledger, history: { archive, rpc: s.ledger.rpc(), fromLedger: s.fromLedger }, contracts: CONTRACTS, worker, keys: keysFor(worker) });
    expect(balance.history).toMatchObject({ source: 'archive', complete: true });
    expect([balance.complete, balance.spendable, balance.receiving]).toEqual([false, undefined, undefined]);
    expect(await view(s, worker, { archive: { drop } })).toEqual({ complete: false, payslips: [payslipOf(s, 0)], gaps: [] });
  });

  it('gives no balance, and says incomplete, when the archive ends more than 12 ledgers behind the chain', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.ledger += 20;
    expect(await view(s, worker, { archive: { lag: 12 } })).toMatchObject({ complete: true, spendable: 0n, receiving: PAY[0] });
    expect(await view(s, worker, { archive: { lag: 13 } })).toEqual({ complete: false, payslips: [payslipOf(s, 0)], gaps: [] });
  });

  it('gives no balance when the RPC window starts after the worker registered', async () => {
    const s = scenario();
    s.ledger.oldestLedger = s.fromLedger + 3;
    expect(await view(s, s.workers[0] as string)).toEqual({ complete: false, payslips: [payslipOf(s, 0)], gaps: [] });
  });
});

describe('loadWorkerView refusals', () => {
  it('refuses keys that are not the worker\'s, before decrypting anything', async () => {
    const s = scenario();
    const err = await view(s, s.workers[0] as string, { keysOf: s.outsider }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerViewError);
    expect((err as WorkerViewError).code).toBe('KEYS_MISMATCH');
  });

  it('refuses an unregistered worker and bad settings', async () => {
    const s = scenario();
    const stranger = testAccount('never registered').publicKey();
    await expect(view(s, stranger)).rejects.toMatchObject({ code: 'NOT_REGISTERED' });
    await expect(view(s, 'MAAAA', { keysOf: s.treasury })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(view(s, s.treasury, { companyIds: Array.from({ length: 51 }, (_, i) => BigInt(i)) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(view(s, s.treasury, { companyIds: [-1n] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never puts an amount in an error or a console line (C12)', async () => {
    const seen: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void seen.push(args.map(String).join(' ')));
    }
    const s = scenario();
    const worker = s.workers[0] as string;
    s.ledger.merge(worker);
    const record = (e: unknown) => seen.push(`${(e as Error).name} ${(e as Error).message} ${JSON.stringify(e)}`);
    await view(s, worker, { keysOf: s.outsider }).catch(record);
    await view(s, testAccount('never registered').publicKey()).catch(record);
    await view(s, worker, { companyIds: [-1n] }).catch(record);
    await view(s, worker, { archive: { mode: 'malformed' } });
    expect(seen.filter((line) => line.startsWith('WorkerViewError'))).toHaveLength(3);
    const haystack = seen.join(' | ');
    for (const amount of [...PAY, PAY.reduce((a, b) => a + b, 0n)]) {
      for (const text of [amount.toString(), formatUsdc(amount), amount.toString(16)]) expect(haystack).not.toContain(text);
    }
  });
});

describe('loadWorkerView reads in parallel without reading more', () => {
  it('keeps at most eight reads in flight and makes the same reads it made one at a time', async () => {
    const s = scenario();
    const worker = s.workers[0] as string;
    const ids = [COMPANY];
    for (let c = 1; c < 3; c++) {
      const admin = testAccount(`parallel admin ${c}`).publicKey();
      s.ledger.register(admin, keysFor(admin), 13);
      s.ledger.deposit(admin, admin, 900_000_000n);
      s.ledger.merge(admin);
      s.ledger.createCompany(100n + BigInt(c), admin, 13, `Parallel ${c}`);
      s.ledger.join(100n + BigInt(c), worker);
      ids.push(100n + BigInt(c));
    }
    for (const id of ids) {
      for (let r = id === COMPANY ? 1 : 0; r < 4; r++) {
        s.ledger.openRun(id, 500n + BigInt(r), `Run ${r}`, 1);
        s.ledger.pay(id, 500n + BigInt(r), [{ worker, amount: 1_000n + BigInt(r) }]);
      }
    }
    const reads = new Map<string, number>();
    let inFlight = 0;
    let most = 0;
    const read = s.ledger.read.bind(s.ledger);
    s.ledger.read = async (contractId, method, args) => {
      reads.set(method, (reads.get(method) ?? 0) + 1);
      most = Math.max(most, ++inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await read(contractId, method, args);
      } finally {
        inFlight--;
      }
    };
    const txSource = s.ledger.txSource();
    const result = await view(s, worker, { companyIds: ids, txSource });
    // The counts scratchpad/wo-b/reads-p2.txt measured for 3 companies of 4 paid runs, read one at a time.
    expect(Object.fromEntries(reads)).toEqual({ confidential_balance: 1, memberships_of: 1, get_company: 3, get_roster: 3, get_run: 12, is_paid: 12 });
    expect([result.complete, result.gaps, result.payslips.length, txSource.calls.length]).toEqual([true, [], 12, 12]);
    expect(result.payslips.map((p) => p.ledger)).toEqual(result.payslips.map((p) => p.ledger).sort((a, b) => a - b));
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });
});
