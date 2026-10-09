import type { xdr } from '@stellar/stellar-sdk/base';
import { FR_MODULUS, randomScalar } from 'stellar-confidential-token-sdk';
import { PayrollErrorCode, isPayrollError } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import type { HistoryEvent } from '../history/decode.js';
import { fetchAccountHistory, type HistorySource } from '../history/events.js';
import type { ContractEventsQuery, EventsPort } from '../history/rpc-events.js';
import { oncePerHash, type TxSourcePort } from '../history/tx-binding.js';
import { mapInOrder } from '../map-in-order.js';
import { AuditError, auditCompany } from './accountant.js';
import { chainChecks, confirmRuns, readCompanyPayslips, transferInTx, type CompanyPayslips } from './company.js';

export interface SealedPayment {
  runId: bigint;
  periodLabel: string;
  /** G or C address. */
  worker: string;
  /** The pay transaction, 64 hex. */
  txHash: string;
  /** Hex of the ciphertext the accountant's key opens for this payment: the transfer event's v_tilde_aud_s, big-endian, 64 characters, no 0x. */
  sealed: string;
  /** Stroops the auditor secret opened; null when the audit did not count this payment, whatever the reason. */
  amount: bigint | null;
}

export interface SealedPayroll {
  companyId: bigint;
  /** The audit's complete flag (C48), and false as well if the audit counted a payment these rows do not show. */
  complete: boolean;
  /** Newest run first, then the order the audit lists lines. */
  payments: SealedPayment[];
  /** Sum of the opened amounts. */
  total: bigint;
}

export type SealedPayrollStep = 'history' | 'opening' | 'done';

/** A fresh auditor secret that no auditor holds, for showing what a stranger's key opens: nothing. */
export function randomAuditorSecret(): bigint {
  return randomScalar();
}

/** One answer per question for the life of one call. A failed read stays failed, so a repeat sees what the first caller saw. */
function remember<T>(answers: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let answer = answers.get(key);
  if (answer === undefined) {
    answer = read();
    answers.set(key, answer);
  }
  return answer;
}

function rememberingChainPort(port: ChainPort): ChainPort {
  const reads = new Map<string, Promise<xdr.ScVal>>();
  return {
    simulate: (txXdr) => port.simulate(txXdr),
    submit: (signedTxXdr) => port.submit(signedTxXdr),
    waitFor: (hash, timeoutMs) => port.waitFor(hash, timeoutMs),
    sourceAccount: (address) => port.sourceAccount(address),
    latestLedger: () => port.latestLedger(),
    // XDR is one canonical encoding, so equal arguments always make the same key.
    read: (contractId, method, args) => remember(reads, [contractId, method, ...args.map((a) => a.toXDR('base64'))].join(' '), () => port.read(contractId, method, args)),
  };
}

function rememberingEventsPort(port: EventsPort): EventsPort {
  let window: ReturnType<EventsPort['ledgerWindow']> | undefined;
  const pages = new Map<string, ReturnType<EventsPort['contractEvents']>>();
  const pageKey = (q: ContractEventsQuery) => ('cursor' in q ? `${q.contractId} ${q.limit} cursor ${q.cursor}` : `${q.contractId} ${q.limit} from ${q.startLedger}`);
  return {
    ledgerWindow: () => (window ??= port.ledgerWindow()),
    contractEvents: (query) => remember(pages, pageKey(query), () => port.contractEvents(query)),
  };
}

const lineKey = (runId: bigint, worker: string, txHash: string) => `${runId}/${worker}/${txHash}`;

/** The payslip set every key sees (C18, C48): confirmed runs newest first, each payslip whose transfer its treasury's history holds. */
async function sealedRows(
  company: CompanyPayslips,
  confirmedRuns: ReadonlySet<bigint>,
  histories: ReadonlyMap<string, HistoryEvent[]>,
  periodLabel: (runId: bigint) => Promise<string | null>,
): Promise<Omit<SealedPayment, 'amount'>[]> {
  const rows: Omit<SealedPayment, 'amount'>[] = [];
  for (const runId of [...company.runIds].reverse()) {
    if (!confirmedRuns.has(runId)) continue;
    // Over-long labels are refused as the audit refuses them (C25); the audit then counts nothing in the run and is incomplete.
    const label = await periodLabel(runId);
    if (label === null) continue;
    for (const candidate of company.candidates) {
      if (candidate.runId !== runId) continue;
      const found = transferInTx(histories.get(candidate.treasury) ?? [], candidate.meta.txHash, candidate.treasury, candidate.worker);
      // A missing, doubled or unreadable transfer has no one ciphertext to show, and the audit marks itself incomplete for it.
      if ('problem' in found) continue;
      rows.push({
        runId,
        periodLabel: label,
        worker: candidate.worker,
        txHash: candidate.meta.txHash,
        sealed: found.transfer.event.vAudS.toString(16).padStart(64, '0'),
      });
    }
  }
  return rows;
}

/**
 * A company's payroll as a stranger sees it, each payment's sealed ciphertext, beside the amount
 * the auditor secret opens for it. The rows are the C18 payslip set from readCompanyPayslips and
 * confirmRuns, the same for every key, with each run's label read with get_run. The amounts come
 * only from auditCompany's counted lines, so every C18, C19, C30 and C48 rule applies unchanged;
 * a payment the audit did not count, for any reason, stays sealed with amount null. A secret that
 * is not the company's opens nothing, so every row shows with amount null and the total is 0n.
 *
 * The history step makes every network read: the company's payslips and runs, each treasury's
 * history, and each payment's is_paid and transaction. The opening step is auditCompany, which
 * on the RPC path finds every read it makes already answered by this call's own memory, so it
 * spends its time on decryption and checks, not the network. That memory lasts one call. On the
 * archive path the archive is read twice, once by each step, because its fetches are not held.
 * A stranger's key also reads the transactions the audit would not ask for, so both keys wait
 * for the same reads.
 *
 * @param treasury the company's treasury, which must be one of the accounts its history shows as
 *   admin; parsed with the same address parser as every account it is compared with.
 * @param auditorSecret the secret k under the company's auditor id, or any other in (0, FR_MODULUS).
 * @param onProgress called with ('history', 0, 0) at the start, ('history', done, total) as each
 *   payment's reads finish, ('opening', 0, total) before decryption, then ('done', opened, total).
 * @throws AuditError INVALID_INPUT for a bad contract id, company id, treasury, auditor secret or
 *   transaction source, or a treasury that was never the company's; COMPANY_NOT_FOUND; or the
 *   port's or history's own errors.
 */
export async function readSealedPayroll(input: {
  port: ChainPort;
  history: HistorySource;
  txSource: TxSourcePort;
  contracts: { payroll: string; token: string };
  companyId: bigint;
  treasury: string;
  auditorSecret: bigint;
  onProgress?: (step: SealedPayrollStep, done: number, total: number) => void;
}): Promise<SealedPayroll> {
  // The same refusals auditCompany makes, made here first because the history step reads before it runs.
  let contracts: { payroll: string; token: string };
  let companyId: bigint;
  let treasury: string;
  try {
    contracts = { payroll: requireAccount(input.contracts.payroll, ['C']), token: requireAccount(input.contracts.token, ['C']) };
    companyId = requireU64(input.companyId, 'companyId');
    treasury = requireAccount(input.treasury, ['G', 'C']);
  } catch {
    throw new AuditError('INVALID_INPUT');
  }
  const secret = input.auditorSecret;
  if (typeof secret !== 'bigint' || secret <= 0n || secret >= FR_MODULUS) throw new AuditError('INVALID_INPUT');
  if (typeof input.txSource?.transaction !== 'function') throw new AuditError('INVALID_INPUT');
  const progress = input.onProgress ?? (() => undefined);
  const port = rememberingChainPort(input.port);
  const history: HistorySource = { ...input.history, rpc: rememberingEventsPort(input.history.rpc) };
  const txSource = oncePerHash(input.txSource);

  progress('history', 0, 0);
  let company: CompanyPayslips;
  try {
    company = await readCompanyPayslips({ port, history, contracts, companyId });
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new AuditError('COMPANY_NOT_FOUND');
    throw err;
  }
  if (!company.treasuries.includes(treasury)) throw new AuditError('INVALID_INPUT');
  const checks = chainChecks(port, contracts.payroll);
  const confirmed = await confirmRuns(checks, { ...company, companyId });
  const reads = await mapInOrder(company.treasuries, (account) =>
    fetchAccountHistory({ port: history.rpc, ...(history.archive ? { archive: history.archive } : {}), contracts, account, fromLedger: history.fromLedger }),
  );
  const histories = new Map(company.treasuries.map((account, i) => [account, reads[i]?.events ?? []]));
  const rows = await sealedRows(company, new Set(confirmed.runs.keys()), histories, (runId) => checks.periodLabel(companyId, runId));

  let fetched = 0;
  progress('history', 0, rows.length);
  await mapInOrder(rows, async (row) => {
    // Settled, not awaited: a failed read is remembered and reaches auditCompany, which handles it as it always does.
    await Promise.allSettled([checks.isPaid(companyId, row.runId, row.worker), txSource.transaction(row.txHash)]);
    progress('history', ++fetched, rows.length);
  });

  progress('opening', 0, rows.length);
  const audit = await auditCompany({ port, history, contracts, companyId, auditorSecret: secret, txSource });
  const opened = new Map<string, bigint>();
  for (const run of audit.runs) for (const line of run.lines) opened.set(lineKey(run.runId, line.worker, line.txHash), line.amount);
  const payments = rows.map((row): SealedPayment => ({ ...row, amount: opened.get(lineKey(row.runId, row.worker, row.txHash)) ?? null }));
  const shown = payments.filter((p) => p.amount !== null);
  progress('done', shown.length, payments.length);
  return {
    companyId,
    // Only the archive path can see two histories; a counted line with no row means the rows understate the audit.
    complete: audit.complete && shown.length === opened.size,
    payments,
    total: shown.reduce((sum, p) => sum + (p.amount as bigint), 0n),
  };
}
