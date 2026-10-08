import { FR_MODULUS } from 'stellar-confidential-token-sdk';
import { auditTransferRecipientChannel, auditTransferSenderChannel, auditWithdraw } from 'stellar-confidential-token-sdk/chain';
import { formatUsdc } from '../amounts.js';
import { toSafeCsvCell } from '../csv.js';
import { PayrollErrorCode, isPayrollError } from '../chain/payroll.js';
import type { ChainPort } from '../chain/ports.js';
import { requireAccount, requireU64 } from '../chain/scval.js';
import type { HistoryEvent } from '../history/decode.js';
import { fetchAccountHistory, type HistorySource } from '../history/events.js';
import { chainChecks, isMoney, readCompanyPayslips, transferInTx } from './company.js';

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
 * only amounts that passed every C19 check. complete is false when any history was incomplete or
 * unreadable, or a payslip could not be matched to its transfer.
 */
export interface AuditResult {
  complete: boolean;
  runs: AuditRun[];
  grandTotal: bigint;
  undecryptable: { txHash: string; reason: string }[];
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

export type UndecryptableReason = 'amount_out_of_range' | 'balance_chain_break' | 'no_verified_balance_before' | 'undecodable_event';

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
 * Not covered: the newest spend's balance is checked by no later spend, so a forged newest
 * event is caught only once another spend follows it.
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

/**
 * Every amount the company paid in payroll, read with the company's auditor key from the
 * sender-auditor channel of the treasury's transfers. Workers keep their own auditor ids, so
 * the recipient channel of a payment is never decrypted here.
 *
 * A line is counted only when the payslip passes every C18 check (a PayslipIssued event from
 * our payroll contract, exactly one transfer in the same transaction from the treasury of that
 * moment to that worker, is_paid on chain) and its amount passed balanceChain. Every spend
 * balanceChain marks is listed in undecryptable and excluded from every total. Direct transfers
 * and withdrawals from the treasury are checked as part of the chain but never counted.
 *
 * @param auditorSecret the secret k whose public key k·H the registry holds under the company's
 *   auditor id. A wrong key is not refused up front: every amount it opens is out of range, so
 *   every spend is listed as undecryptable and every total is zero.
 * @throws AuditError INVALID_INPUT or COMPANY_NOT_FOUND; or the port's or history's own errors.
 */
export async function auditCompany(input: {
  port: ChainPort;
  history: HistorySource;
  contracts: { payroll: string; token: string };
  companyId: bigint;
  auditorSecret: bigint;
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
  const { port, history } = input;

  let company: Awaited<ReturnType<typeof readCompanyPayslips>>;
  try {
    company = await readCompanyPayslips({ port, history, contracts, companyId });
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new AuditError('COMPANY_NOT_FOUND');
    throw err;
  }
  let complete = company.complete;
  const undecryptable: { txHash: string; reason: string }[] = [];
  const histories = new Map<string, { events: HistoryEvent[]; verdicts: ReturnType<typeof balanceChain> }>();
  for (const treasury of company.treasuries) {
    const read = await fetchAccountHistory({
      port: history.rpc,
      ...(history.archive ? { archive: history.archive } : {}),
      contracts,
      account: treasury,
      fromLedger: history.fromLedger,
    });
    complete &&= read.complete;
    const verdicts = balanceChain(treasury, read.events, secret);
    for (const e of read.events) {
      const verdict = verdicts.get(e.id);
      if (verdict !== undefined && 'reason' in verdict) undecryptable.push({ txHash: e.txHash, reason: verdict.reason });
    }
    histories.set(treasury, { events: read.events, verdicts });
  }

  const checks = chainChecks(port, contracts.payroll);
  const runs = new Map<bigint, AuditRun>();
  for (const candidate of company.candidates) {
    const treasuryHistory = histories.get(candidate.treasury);
    if (treasuryHistory === undefined) {
      complete = false;
      continue;
    }
    const found = transferInTx(treasuryHistory.events, candidate.meta.txHash, candidate.treasury, candidate.worker);
    if ('problem' in found) {
      // An unreadable transfer is already listed by balanceChain; a missing one means history is wrong.
      if (found.problem !== 'undecodable') complete = false;
      continue;
    }
    if (!(await checks.isPaid(companyId, candidate.runId, candidate.worker))) continue;
    const verdict = treasuryHistory.verdicts.get(found.transfer.id);
    if (verdict === undefined || !('amount' in verdict)) continue;
    const periodLabel = await checks.periodLabel(companyId, candidate.runId);
    if (periodLabel === null) {
      complete = false;
      continue;
    }
    let run = runs.get(candidate.runId);
    if (run === undefined) {
      run = { runId: candidate.runId, periodLabel, lines: [], total: 0n };
      runs.set(candidate.runId, run);
    }
    run.lines.push({ worker: candidate.worker, amount: verdict.amount, txHash: candidate.meta.txHash });
    run.total += verdict.amount;
  }

  const ordered = [...runs.values()];
  return { complete, runs: ordered, grandTotal: ordered.reduce((sum, run) => sum + run.total, 0n), undecryptable };
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
