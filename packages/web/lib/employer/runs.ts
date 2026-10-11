import { PayrollErrorCode, buildCloseRun, buildOpenRun, executeRun, getRun, isPaid, isPayrollError } from "@kalypso/core";
import type { Company, CsvRow, RowFailureReason, Run, RunReport } from "@kalypso/core";
import { periodId } from "../sandbox/engine";
import type { WalletPort } from "../wallet/port";
import { consoleContext, reporter, type ConsoleContext, type OnProgress } from "./context";
import { fromCoreError } from "./core-errors";
import { readPayrollCsv } from "./csv";
import { ConsoleError } from "./errors";
import { adminCompany } from "./company";
import { walletKeys } from "./keys";
import { withWalletLock } from "./lock";
import { confirmOnChain, sendCall } from "./send";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

// A Record, so the compiler refuses a reason core adds that this list does not name.
const FAILURE_REASONS: Record<RowFailureReason, true> = {
  PROOF_FAILED: true,
  SIMULATION_FAILED: true,
  FEE_TOO_HIGH: true,
  SUBMIT_REFUSED: true,
  TRANSACTION_FAILED: true,
  TRANSACTION_EXPIRED: true,
  RUN_STOPPED: true,
};

/** Why a row did not go through. The screen shows errors.run.<reason> in the page's language. */
export const ROW_FAILURE_REASONS = Object.keys(FAILURE_REASONS) as RowFailureReason[];

export interface RunPeriod {
  /** 202610 for October 2026: the seed's year-and-month run id. */
  runId: bigint;
  /** "October 2026". */
  label: string;
}

export interface PayrollRow {
  line: number;
  address: string;
  status: "paid" | "already-paid" | "failed";
  txHash?: string;
  /** For a failed row, why: one of ROW_FAILURE_REASONS. */
  reason?: RowFailureReason;
}

export interface PayrollRun {
  companyId: bigint;
  runId: bigint;
  label: string;
  rows: PayrollRow[];
  /** The pay transactions that landed during this call, in order. */
  transactions: string[];
  /** True once the run is closed on chain, which happens only when every row is paid. */
  closed: boolean;
  openTx?: string;
  closeTx?: string;
}

/**
 * The run id and label for a month: the id as the seed builds it (year then two-digit month, so
 * October 2026 is 202610) and the label as the payroll shows it ("October 2026").
 *
 * @throws ConsoleError PERIOD_INVALID unless year is 1000 to 9999 and month 1 to 12.
 */
export function runPeriod(year: number, month: number): RunPeriod {
  if (!Number.isInteger(year) || year < 1000 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ConsoleError("PERIOD_INVALID");
  }
  return { runId: periodId(new Date(Date.UTC(year, month - 1, 1))), label: `${MONTHS[month - 1]} ${year}` };
}

async function runOrNull(ctx: ConsoleContext, companyId: bigint, runId: bigint): Promise<Run | null> {
  try {
    return await getRun(ctx.port, ctx.config.contracts.payroll, companyId, runId);
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.RunNotFound)) return null;
    throw err;
  }
}

// Paid flags are read this many at a time: a 500-row file must not fire 500 reads at once at a
// public RPC.
const READS_AT_ONCE = 8;

async function paidFlags(ctx: ConsoleContext, companyId: bigint, runId: bigint, rows: CsvRow[]): Promise<boolean[]> {
  const flags: boolean[] = [];
  for (let i = 0; i < rows.length; i += READS_AT_ONCE) {
    const chunk = rows.slice(i, i + READS_AT_ONCE);
    flags.push(...(await Promise.all(chunk.map((row) => isPaid(ctx.port, ctx.config.contracts.payroll, companyId, runId, row.address)))));
  }
  return flags;
}

function csvRows(text: string): CsvRow[] {
  if (typeof text !== "string") throw new ConsoleError("CSV_INVALID");
  const { rows, problems } = readPayrollCsv(text);
  const first = problems[0];
  if (first !== undefined) {
    const more = problems.length > 1 ? ` ${problems.length - 1} more ${problems.length === 2 ? "line has a problem" : "lines have problems"}.` : "";
    throw new ConsoleError("CSV_INVALID", { message: `${first.sentence}${more}`, line: first.line, problems });
  }
  return rows;
}

/**
 * Opens the month's run for the CSV's row count unless the chain already has it. An existing run
 * must have the same label and expected count, so a different file never pays into it.
 */
async function openRun(ctx: ConsoleContext, wallet: WalletPort, company: Company, companyId: bigint, period: RunPeriod, expectedCount: number) {
  const existing = await runOrNull(ctx, companyId, period.runId);
  if (existing !== null) {
    if (existing.periodLabel !== period.label || existing.expectedCount !== expectedCount) throw new ConsoleError("RUN_MISMATCH");
    return { run: existing, openTx: undefined };
  }
  if (expectedCount > company.activeWorkers) throw new ConsoleError("NOT_ENOUGH_WORKERS");
  const sent = await sendCall(ctx, wallet, {
    what: "open_run",
    contractId: ctx.config.contracts.payroll,
    build: (base) => buildOpenRun(base, { companyId, runId: period.runId, periodLabel: period.label, expectedCount }),
  });
  const seen: { run: Run | null } = { run: null };
  await confirmOnChain(ctx, `The ${period.label} run`, async () => (seen.run = await runOrNull(ctx, companyId, period.runId)) !== null);
  if (seen.run === null) throw new ConsoleError("NOT_ON_CHAIN");
  return { run: seen.run, openTx: sent.hash };
}

function rowsOf(report: RunReport): PayrollRow[] {
  return report.rows.map((row) => {
    const out: PayrollRow = { line: row.line, address: row.address, status: row.status };
    if (row.status === "failed") out.reason = row.reason ?? "RUN_STOPPED";
    if (row.txHash !== undefined) out.txHash = row.txHash;
    return out;
  });
}

/**
 * Pays one month's payroll from a spreadsheet, signed by the admin wallet, which also pays every
 * fee:
 *
 * 1. The CSV goes through core's parser as is; any problem stops here with every line's sentence.
 * 2. The month's run is opened (run id from year and month, label like "October 2026", expected
 *    count the CSV's row count) unless the chain already has it with the same label and count.
 * 3. core's executeRun pays the rows with the wallet as signer, this browser's openings, the
 *    browser prover and keys from two wallet signatures: one transaction in flight at a time,
 *    rows already paid skipped, every proof checked against its CSV amount (C13, C14, C29).
 *    When every row already reads paid on chain, the engine is not called at all.
 * 4. close_run only when every row reads paid on chain.
 *
 * Calling it again with the same file resumes from the chain; nobody is paid twice.
 *
 * @throws ConsoleError CSV_INVALID (problems holds every line), PERIOD_INVALID,
 *   COMPANY_ID_INVALID, COMPANY_NOT_FOUND, NOT_ADMIN, RUN_MISMATCH, RUN_CLOSED,
 *   NOT_ENOUGH_WORKERS, RUN_REFUSED (core's preflight, naming the line), NEEDS_REBUILD
 *   (rebuildable: offer rebuildTreasury), PAYMENT_PENDING, RECORD_DAMAGED, AMOUNT_MISMATCH,
 *   PAID_ELSEWHERE, WALLET_CHANGED_TRANSACTION, TREASURY_KEYS_MISMATCH, TREASURY_NOT_REGISTERED,
 *   KEY_NOT_DERIVED, BUSY, NOT_ON_CHAIN or any sendCall code; the wallet's own error.
 */
export async function runPayroll(
  wallet: WalletPort,
  input: { companyId: bigint; year: number; month: number; csv: string },
  onProgress?: OnProgress,
): Promise<PayrollRun> {
  const rows = csvRows(input.csv);
  const period = runPeriod(input.year, input.month);
  const ctx = consoleContext();
  const { config } = ctx;
  const { companyId } = input;

  return withWalletLock(wallet.address, async () => {
    const company = await adminCompany(ctx, wallet, companyId);
    const p = reporter(onProgress, rows.length + 2);
    const result: PayrollRun = { companyId, runId: period.runId, label: period.label, rows: [], transactions: [], closed: false };

    p.say("keys_treasury");
    const keys = await walletKeys(wallet, { domain: config.keyDomain, token: config.contracts.token });

    const run = { label: period.label };
    p.say("run_opening", run);
    const opened = await openRun(ctx, wallet, company, companyId, period, rows.length);
    if (opened.openTx !== undefined) result.openTx = opened.openTx;
    const allPaid = (await paidFlags(ctx, companyId, period.runId, rows)).every(Boolean);
    const alreadyPaid = (): PayrollRow[] => rows.map((row) => ({ line: row.line, address: row.address, status: "already-paid" }));
    if (opened.run.status === "Closed") {
      if (!allPaid) throw new ConsoleError("RUN_CLOSED");
      result.rows = alreadyPaid();
      result.closed = true;
      p.tick("run_already_closed", run);
      return result;
    }
    p.tick("run_open", run, opened.openTx);

    const position = new Map(rows.map((row, i) => [row.line, i + 1]));
    const at = (line: number) => ({ n: position.get(line) ?? "?", total: rows.length, line });
    // Every row paid while the run is still open (the close was lost): closing needs no proof and
    // no saved opening, so the engine is not asked and a new device needs no rebuild for it.
    if (allPaid) {
      result.rows = alreadyPaid();
      for (const row of rows) p.tick("pay_already_paid", at(row.line));
    } else {
      let report: RunReport;
      try {
        report = await executeRun({
          port: ctx.port,
          signer: wallet,
          store: ctx.store,
          networkPassphrase: config.networkPassphrase,
          contracts: config.contracts,
          companyId,
          runId: period.runId,
          rows,
          keys,
          prover: await ctx.prover(),
          onProgress: ({ row, status }) => {
            if (status === "proving") p.say("pay_proving", at(row));
            else if (status === "submitted") p.say("pay_submitted", at(row));
            else if (status === "paid") p.tick("pay_landed", at(row));
            else if (status === "already-paid") p.tick("pay_already_paid", at(row));
            else p.say("pay_failed", at(row));
          },
        });
      } catch (err) {
        throw fromCoreError(err);
      }
      result.rows = rowsOf(report);
      result.transactions = [...report.transactions];
    }
    if (result.rows.some((row) => row.status === "failed")) {
      p.say("run_stays_open", run);
      return result;
    }

    const now = await runOrNull(ctx, companyId, period.runId);
    if (now?.status === "Open") {
      p.say("run_closing", run);
      const sent = await sendCall(ctx, wallet, {
        what: "close_run",
        contractId: config.contracts.payroll,
        build: (base) => buildCloseRun(base, { companyId, runId: period.runId }),
      });
      result.closeTx = sent.hash;
      await confirmOnChain(ctx, `Closing the ${period.label} run`, async () => (await runOrNull(ctx, companyId, period.runId))?.status === "Closed");
    }
    result.closed = true;
    p.tick("run_closed", run, result.closeTx);
    return result;
  });
}
