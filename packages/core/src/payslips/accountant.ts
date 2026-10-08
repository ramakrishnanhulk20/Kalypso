import { FR_MODULUS } from 'stellar-confidential-token-sdk';
import { auditTransferRecipientChannel, auditTransferSenderChannel, auditWithdraw } from 'stellar-confidential-token-sdk/chain';
import { formatUsdc } from '../amounts.js';
import { toSafeCsvCell } from '../csv.js';
import { mapInOrder } from '../map-in-order.js';
import { PayrollErrorCode, isPayrollError } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import type { HistoryEvent } from '../history/decode.js';
import { fetchAccountHistory, reachesLedger, type HistoryResult, type HistorySource } from '../history/events.js';
import { bindTransferToTransaction, oncePerHash, type BindingFailure, type TxSourcePort } from '../history/tx-binding.js';
import { bindsAsPayslip, chainChecks, confirmRuns, isMoney, readCompanyPayslips, transferInTx, type HistoryGap } from './company.js';

export interface AuditLine {
  worker: string;
  amount: bigint;
  txHash: string;
}

export interface AuditRun {
  runId: bigint;
  periodLabel: string;
  lines: AuditLine[];
  total: bigint;
}

/**
 * What the company paid, as its accountant reads it. Only the C18 payslip set is counted, and
 * only amounts that passed every C19 check and are bound to their transaction. complete is false
 * when gaps names anything (the chain's run, paid and admin counts disagree with history); when
 * any history was incomplete, unreadable, or ends more than INGEST_TOLERANCE_LEDGERS before the
 * RPC's newest ledger; or when a payslip could not be matched to its transfer or bound to its
 * transaction.
 */
export interface AuditResult {
  complete: boolean;
  runs: AuditRun[];
  grandTotal: bigint;
  undecryptable: { txHash: string; reason: string }[];
  /** Each place the chain's own counts disagree with history (C48), such as a run the history does not show. */
  gaps: HistoryGap[];
}

export type AuditErrorCode = 'INVALID_INPUT' | 'COMPANY_NOT_FOUND';

// Messages never carry an amount or the auditor secret (threat model C12).
const AUDIT_MESSAGES: Record<AuditErrorCode, string> = {
  INVALID_INPUT: 'The audit settings are invalid: a contract id, the company id or the auditor key.',
  COMPANY_NOT_FOUND: 'This company does not exist on the payroll contract.',
};

export class AuditError extends Error {
  readonly code: AuditErrorCode;

  constructor(code: AuditErrorCode) {
    super(AUDIT_MESSAGES[code]);
    this.name = 'AuditError';
    this.code = code;
  }
}

export type UndecryptableReason =
  | 'amount_out_of_range'
  | 'balance_chain_break'
  | 'no_verified_balance_before'
  | 'undecodable_event'
  /** No source had the payslip's transaction, so its amount could not be bound to it. */
  | 'transaction_unavailable'
  /** The payslip's transfer event does not match its transaction, or that transaction is not its pay call. */
  | 'transaction_mismatch'
  /** The run's on-chain paid_count is below the lines counted for it, so which ones it includes cannot be told. */
  | 'run_count_mismatch';

/**
 * Walks one treasury's history in order and decides, for every event that spends from its
 * balance (outgoing transfers and withdrawals), whether the amount the company's auditor key
 * decrypts can be trusted (threat model C19).
 *
 * The chain: the spendable balance is 0 at registration; public deposits and incoming transfers
 * (their recipient channel, under the same company key) add to the receiving balance; a merge
 * moves receiving into spendable; each spend's sender channel gives the amount and the balance
 * after it. Every spend must satisfy before minus amount equals after.
 *
 * A spend is marked undecryptable when an amount or balance is outside [0, 2^63), when its own
 * event could not be read, when there is no verified balance before it (history that starts
 * after registration, or follows an unreadable event), or when the equation fails. On a failure
 * both ends are marked, the spend and the earlier spend whose balance it was checked against,
 * because shifting one ciphertext's amount up and its balance down by the same value keeps that
 * one event consistent and breaks only the next check.
 *
 * Not covered here: the newest spend's balance is checked by no later spend, and an amount
 * shifted between two spends keeps the chain whole. auditCompany closes both by binding every
 * counted line to its transaction.
 */
function balanceChain(treasury: string, events: HistoryEvent[], secret: bigint): Map<string, { amount: bigint } | { reason: UndecryptableReason }> {
  const verdicts = new Map<string, { amount: bigint } | { reason: UndecryptableReason }>();
  const mark = (id: string, reason: UndecryptableReason) => {
    if (!verdicts.has(id) || 'amount' in (verdicts.get(id) as object)) verdicts.set(id, { reason });
  };
  let spendable: bigint | null = null;
  let receiving: bigint | null = null;
  let lastSpend: string | null = null;

  const spend = (id: string, amount: bigint, after: bigint) => {
    if (!isMoney(amount) || !isMoney(after)) {
      mark(id, 'amount_out_of_range');
      spendable = null;
      lastSpend = null;
      return;
    }
    if (spendable === null) {
      mark(id, 'no_verified_balance_before');
    } else if (spendable - amount !== after) {
      mark(id, 'balance_chain_break');
      if (lastSpend !== null) mark(lastSpend, 'balance_chain_break');
    } else {
      verdicts.set(id, { amount });
    }
    spendable = after;
    lastSpend = id;
  };

  for (const e of events) {
    if (e.kind === 'undecodable') {
      if (e.parties[0] === treasury && (e.name === 'transfer' || e.name === 'withdraw')) mark(e.id, 'undecodable_event');
      spendable = null;
      receiving = null;
      lastSpend = null;
      continue;
    }
    if (e.kind !== 'token') continue;
    const ev = e.event;
    switch (ev.type) {
      case 'register':
        if (ev.account === treasury) {
          spendable = 0n;
          receiving = 0n;
          lastSpend = null;
        }
        break;
      case 'deposit':
        if (ev.to === treasury && receiving !== null) receiving += ev.amount;
        break;
      case 'merge':
        if (ev.account === treasury) {
          spendable = spendable !== null && receiving !== null ? spendable + receiving : null;
          receiving = 0n;
        }
        break;
      case 'withdraw':
        if (ev.from === treasury) spend(e.id, ev.amount, auditWithdraw(secret, ev).senderBalance);
        break;
      case 'transfer': {
        if (ev.from === treasury) {
          const sender = auditTransferSenderChannel(secret, ev);
          spend(e.id, sender.amount, sender.senderBalance);
        }
        if (ev.to === treasury) {
          const credit = auditTransferRecipientChannel(secret, ev).amount;
          receiving = receiving !== null && isMoney(credit) ? receiving + credit : null;
        }
        break;
      }
    }
  }
  return verdicts;
}

const bindingReason = (reason: BindingFailure): UndecryptableReason => (reason === 'transaction_unavailable' ? 'transaction_unavailable' : 'transaction_mismatch');

/** What one payslip candidate adds to the audit: nothing, an incomplete mark, an unbound line, or a counted line. */
type CandidateOutcome =
  | { kind: 'skip' }
  | { kind: 'incomplete' }
  | { kind: 'unbound'; reason: UndecryptableReason }
  | { kind: 'line'; periodLabel: string; amount: bigint };

/**
 * Every amount the company paid in payroll, read with the company's auditor key from the
 * sender-auditor channel of the treasury's transfers. Workers keep their own auditor ids, so
 * the recipient channel of a payment is never decrypted here.
 *
 * The runs are the chain's (threat model C48): every run the company history shows opened is
 * confirmed with get_run and they must number exactly runs_opened (confirmRuns), and the
 * history's admin changes must number exactly admin_changes and lead to the admin get_company
 * names (readCompanyPayslips), so no run and no treasury can be hidden or made up. Each run's
 * counted lines must then equal its on-chain paid_count: fewer means history is missing a
 * payslip; more means paid_count cannot include them all, so none of that run's lines is
 * counted. Every disagreement is listed in gaps and makes the result incomplete. Transfers that
 * are not counted lines, whoever made them, never touch the result beyond the balance chain.
 *
 * A line is counted only when the payslip passes every C18 check (a PayslipIssued event from
 * our payroll contract in a confirmed run, exactly one transfer in the same transaction from the
 * treasury of that moment to that worker, is_paid on chain), its amount passed balanceChain, and
 * its transfer is bound to its transaction by bindTransferToTransaction as our payroll's pay for
 * that company and run. Binding is what catches an amount shifted between two spends, or a
 * forged newest spend, which balanceChain alone cannot see. Every spend balanceChain marks, and
 * every line that does not bind, is listed in undecryptable and excluded from every total; a
 * line that does not bind also makes the result incomplete, as does any event in a treasury's
 * history that could not be read. Direct transfers and withdrawals from the treasury are checked
 * as part of the chain but never counted.
 *
 * @param auditorSecret the secret k whose public key k·H the registry holds under the company's
 *   auditor id. A wrong key is not refused up front: every amount it opens is out of range, so
 *   every spend is listed as undecryptable and every total is zero.
 * @param txSource where each payslip's transaction envelope is read from (createTxSourcePort).
 * @throws AuditError INVALID_INPUT or COMPANY_NOT_FOUND; or the port's or history's own errors.
 */
export async function auditCompany(input: {
  port: ChainPort;
  history: HistorySource;
  contracts: { payroll: string; token: string };
  companyId: bigint;
  auditorSecret: bigint;
  txSource: TxSourcePort;
}): Promise<AuditResult> {
  let contracts: { payroll: string; token: string };
  let companyId: bigint;
  try {
    contracts = { payroll: requireAccount(input.contracts.payroll, ['C']), token: requireAccount(input.contracts.token, ['C']) };
    companyId = requireU64(input.companyId, 'companyId');
  } catch {
    throw new AuditError('INVALID_INPUT');
  }
  const secret = input.auditorSecret;
  if (typeof secret !== 'bigint' || secret <= 0n || secret >= FR_MODULUS) throw new AuditError('INVALID_INPUT');
  if (typeof input.txSource?.transaction !== 'function') throw new AuditError('INVALID_INPUT');
  const { port, history } = input;
  const txSource = oncePerHash(input.txSource);

  let company: Awaited<ReturnType<typeof readCompanyPayslips>>;
  try {
    company = await readCompanyPayslips({ port, history, contracts, companyId });
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new AuditError('COMPANY_NOT_FOUND');
    throw err;
  }
  let complete = company.complete;
  const gaps: HistoryGap[] = [...company.gaps];
  const checks = chainChecks(port, contracts.payroll);
  const confirmed = await confirmRuns(checks, { ...company, companyId });
  gaps.push(...confirmed.gaps);

  const undecryptable: { txHash: string; reason: string }[] = [];
  const histories = new Map<string, { events: HistoryEvent[]; verdicts: ReturnType<typeof balanceChain> }>();
  const historyEnds = [company.ingestedThrough];
  const treasuryReads = await mapInOrder(company.treasuries, (treasury) =>
    fetchAccountHistory({
      port: history.rpc,
      ...(history.archive ? { archive: history.archive } : {}),
      contracts,
      account: treasury,
      fromLedger: history.fromLedger,
    }),
  );
  for (const [i, treasury] of company.treasuries.entries()) {
    const read = treasuryReads[i] as HistoryResult;
    // An event the treasury's history could not read breaks the balance chain behind it, so the totals are not known in full.
    complete &&= read.complete && !read.events.some((e) => e.kind === 'undecodable');
    historyEnds.push(read.ingestedThrough);
    const verdicts = balanceChain(treasury, read.events, secret);
    for (const e of read.events) {
      const verdict = verdicts.get(e.id);
      if (verdict !== undefined && 'reason' in verdict) undecryptable.push({ txHash: e.txHash, reason: verdict.reason });
    }
    histories.set(treasury, { events: read.events, verdicts });
  }

  // Each candidate's reads (is_paid, its transaction) go READ_CONCURRENCY at a time; the results
  // are then counted one by one in candidate order, exactly as they were read in turn before.
  const outcomes = await mapInOrder(company.candidates, async (candidate): Promise<CandidateOutcome> => {
    // A payslip of a run the chain did not confirm is already a gap.
    if (!confirmed.runs.has(candidate.runId)) return { kind: 'skip' };
    const treasuryHistory = histories.get(candidate.treasury);
    if (treasuryHistory === undefined) return { kind: 'incomplete' };
    const found = transferInTx(treasuryHistory.events, candidate.meta.txHash, candidate.treasury, candidate.worker);
    // An unreadable transfer is already listed by balanceChain; a missing one means history is wrong.
    if ('problem' in found) return { kind: found.problem === 'undecodable' ? 'skip' : 'incomplete' };
    if (!(await checks.isPaid(companyId, candidate.runId, candidate.worker))) return { kind: 'skip' };
    const verdict = treasuryHistory.verdicts.get(found.transfer.id);
    if (verdict === undefined || !('amount' in verdict)) return { kind: 'skip' };
    const binding = await bindTransferToTransaction({ txSource, txHash: candidate.meta.txHash, event: found.transfer.event, contracts });
    if (!bindsAsPayslip(binding, candidate)) {
      return { kind: 'unbound', reason: binding.ok ? 'transaction_mismatch' : bindingReason(binding.reason) };
    }
    const periodLabel = await checks.periodLabel(companyId, candidate.runId);
    return periodLabel === null ? { kind: 'incomplete' } : { kind: 'line', periodLabel, amount: verdict.amount };
  });

  const runs = new Map<bigint, AuditRun>();
  for (const [i, candidate] of company.candidates.entries()) {
    const outcome = outcomes[i] as CandidateOutcome;
    if (outcome.kind === 'skip') continue;
    if (outcome.kind === 'incomplete') {
      complete = false;
      continue;
    }
    if (outcome.kind === 'unbound') {
      undecryptable.push({ txHash: candidate.meta.txHash, reason: outcome.reason });
      complete = false;
      continue;
    }
    let run = runs.get(candidate.runId);
    if (run === undefined) {
      run = { runId: candidate.runId, periodLabel: outcome.periodLabel, lines: [], total: 0n };
      runs.set(candidate.runId, run);
    }
    run.lines.push({ worker: candidate.worker, amount: outcome.amount, txHash: candidate.meta.txHash });
    run.total += outcome.amount;
  }

  for (const [runId, onChain] of confirmed.runs) {
    const counted = runs.get(runId);
    const lines = counted?.lines.length ?? 0;
    if (lines !== onChain.paidCount) gaps.push({ reason: 'paid_count_mismatch', companyId, runId, expected: onChain.paidCount, found: lines });
    if (counted !== undefined && lines > onChain.paidCount) {
      for (const l of counted.lines) undecryptable.push({ txHash: l.txHash, reason: 'run_count_mismatch' });
      runs.delete(runId);
    }
  }

  const { latestLedger } = await history.rpc.ledgerWindow();
  if (!historyEnds.every((through) => reachesLedger(through, latestLedger))) complete = false;
  if (gaps.length > 0) complete = false;
  const ordered = [...runs.values()];
  return { complete, runs: ordered, grandTotal: ordered.reduce((sum, run) => sum + run.total, 0n), undecryptable, gaps };
}

/**
 * The audit as CSV: a header, then one row per counted line (run id, period, worker, amount in
 * USDC, transaction hash), with CRLF line ends. Every cell goes through toSafeCsvCell, so a
 * period label an admin wrote on chain cannot run as a spreadsheet formula (threat model C25).
 * Undecryptable transfers are not rows: they are not money.
 */
export function exportAuditCsv(result: AuditResult): string {
  const rows = [['run_id', 'period', 'worker', 'amount_usdc', 'tx_hash']];
  for (const run of result.runs) {
    for (const line of run.lines) rows.push([run.runId.toString(), run.periodLabel, line.worker, formatUsdc(line.amount), line.txHash]);
  }
  return rows.map((row) => row.map(toSafeCsvCell).join(',')).join('\r\n') + '\r\n';
}
