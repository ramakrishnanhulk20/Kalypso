import {
  AuditError,
  AuditorBindingError,
  PayrollErrorCode,
  auditCompany,
  exportAuditCsv,
  getCompany,
  isPayrollError,
  readSealedPayroll,
  requireAuditorBinding,
} from "@kalypso/core";
import type { AuditResult, Company, HistoryGap, SealedPayroll } from "@kalypso/core";
import { consoleContext, reporter, type ConsoleContext, type OnProgress } from "../employer/context";
import { ConsoleError } from "../employer/errors";
import type { WalletPort } from "../wallet/port";
import { accountantSecret } from "./key";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export interface CompanyBooks extends SealedPayroll {
  label: string;
  accountantId: number;
  /** The company's admin and treasury at this read. */
  treasury: string;
}

/**
 * The company, and this wallet's accountant secret, refused unless the registry, read now, says
 * this wallet owns the company's auditor id and holds this key under it (threat model C47: who can
 * read a company's pay comes from the registry's current owner, never from the accountant
 * recorded at creation).
 */
async function sealedTo(
  ctx: ConsoleContext,
  wallet: WalletPort,
  companyId: unknown,
  beforeSigning: () => void,
): Promise<{ companyId: bigint; company: Company; secret: bigint }> {
  if (typeof companyId !== "bigint" || companyId < 0n || companyId > MAX_U64) throw new ConsoleError("COMPANY_ID_INVALID");
  const { config, port } = ctx;
  let company: Company;
  try {
    company = await getCompany(port, config.contracts.payroll, companyId);
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new ConsoleError("COMPANY_NOT_FOUND");
    throw err;
  }
  beforeSigning();
  const { secret, point } = await accountantSecret(wallet);
  try {
    await requireAuditorBinding(port, config.contracts.auditor, company.auditorId, { owner: wallet.address, key: point });
  } catch (err) {
    if (err instanceof AuditorBindingError) throw new ConsoleError("BOOKS_NOT_YOURS");
    throw err;
  }
  return { companyId, company, secret };
}

/**
 * Opens a company's books with this accountant's own key: every payment's sealed ciphertext
 * beside the amount the key opens, through core's readSealedPayroll, so every C18, C19, C30 and
 * C48 rule applies unchanged and `complete` is core's verdict. Refused before any history is read
 * unless this wallet's key holds the company's auditor id now (C47).
 *
 * @throws ConsoleError COMPANY_ID_INVALID, COMPANY_NOT_FOUND, BOOKS_NOT_YOURS, KEY_NOT_DERIVED; the
 *   wallet's own error; or the network's own errors from the reads.
 */
export async function openBooks(wallet: WalletPort, input: { companyId: bigint }, onProgress?: OnProgress): Promise<CompanyBooks> {
  const ctx = consoleContext();
  const { config, port } = ctx;
  const p = reporter(onProgress, 3);
  const { companyId, company, secret } = await sealedTo(ctx, wallet, input?.companyId, () =>
    p.say("Sign the Kalypso key message twice in your wallet to open the books with your key"),
  );
  p.tick(`Your key holds accountant id ${company.auditorId}, which this company's pay is sealed to`);

  let books: SealedPayroll;
  try {
    books = await readSealedPayroll({
      port,
      history: ctx.history,
      txSource: ctx.txSource,
      contracts: { payroll: config.contracts.payroll, token: config.contracts.token },
      companyId,
      treasury: company.admin,
      auditorSecret: secret,
      onProgress: (step, done, total) => {
        if (step === "history") p.say(total === 0 ? "Reading the company's payroll history" : `Reading the payroll history: ${done} of ${total} payments`);
        else if (step === "opening") p.tick(`Opening ${total} payments with your key`);
        else p.tick(`Opened ${done} of ${total} payments`);
      },
    });
  } catch (err) {
    if (err instanceof AuditError && err.code === "COMPANY_NOT_FOUND") throw new ConsoleError("COMPANY_NOT_FOUND");
    throw err;
  }
  return { ...books, label: company.label, accountantId: company.auditorId, treasury: company.admin };
}

const GAP_WORDS: { [R in HistoryGap["reason"]]: (gap: Extract<HistoryGap, { reason: R }>) => string } = {
  company_count_mismatch: (g) => `the chain counts ${g.expected} companies but the history shows ${g.found}`,
  runs_opened_mismatch: (g) => `the chain says the company opened ${g.expected} runs but the history shows ${g.found}`,
  run_not_on_chain: (g) => `the history shows run ${g.runId}, which the chain says this company never opened`,
  admin_changes_mismatch: (g) => `the chain says the company's admin changed ${g.expected} times but the history shows ${g.found}`,
  payslip_missing: (g) => `run ${g.runId} paid a worker whose payslip could not be checked`,
  ledger_mismatch: (g) => `a payslip in run ${g.runId} is dated at a different ledger from its transaction`,
  paid_count_mismatch: (g) => `the chain says run ${g.runId} paid ${g.expected} workers but ${g.found} payslips passed every check`,
};

const UNDECRYPTABLE_WORDS: Readonly<Record<string, string>> = {
  amount_out_of_range: "a payment does not open with this key into a valid amount",
  balance_chain_break: "the treasury's balance history does not add up",
  no_verified_balance_before: "the history starts after the treasury's registration, so a payment's balance cannot be checked",
  undecodable_event: "an event in the treasury's history could not be read",
  transaction_unavailable: "a payment's transaction could not be fetched",
  transaction_mismatch: "a payment's event does not match its transaction",
  run_count_mismatch: "a run shows more payments than the chain says it paid",
};

/** Why an audit is incomplete, in plain words that name runs and counts, never an amount. */
export function incompleteBooksReason(audit: AuditResult): string {
  const reasons = [
    ...audit.gaps.map((gap) => (GAP_WORDS[gap.reason] as (g: HistoryGap) => string)(gap)),
    ...audit.undecryptable.map((u) => UNDECRYPTABLE_WORDS[u.reason] ?? "a payment could not be checked"),
  ];
  const unique = [...new Set(reasons)];
  if (unique.length === 0) {
    return "The books are incomplete, so nothing was exported: the payroll history could not be read in full, or it is behind the newest ledger. Try again in a minute.";
  }
  const more = unique.length > 3 ? `; and ${unique.length - 3} more` : "";
  return `The books are incomplete, so nothing was exported: ${unique.slice(0, 3).join("; ")}${more}.`;
}

/**
 * The company's books as a CSV file, from core's auditCompany opened with this accountant's own
 * derived key and written by core's exportAuditCsv, so every C18, C19, C30 and C48 rule and the
 * C25 cell rules apply unchanged. The file is named kalypso-{companyId}-{yyyy-mm-dd}.csv by
 * today's UTC date.
 *
 * Refused unless the audit is complete: a file that looks like the whole payroll but is not would
 * be worse than none.
 *
 * @throws ConsoleError BOOKS_INCOMPLETE (the message says why), COMPANY_ID_INVALID,
 *   COMPANY_NOT_FOUND, BOOKS_NOT_YOURS, KEY_NOT_DERIVED; the wallet's own error; or the network's.
 */
export async function exportBooks(wallet: WalletPort, input: { companyId: bigint }): Promise<{ filename: string; csv: string }> {
  const ctx = consoleContext();
  const { config } = ctx;
  const { companyId, secret } = await sealedTo(ctx, wallet, input?.companyId, () => undefined);
  let audit: AuditResult;
  try {
    audit = await auditCompany({
      port: ctx.port,
      history: ctx.history,
      contracts: { payroll: config.contracts.payroll, token: config.contracts.token },
      companyId,
      auditorSecret: secret,
      txSource: ctx.txSource,
    });
  } catch (err) {
    if (err instanceof AuditError && err.code === "COMPANY_NOT_FOUND") throw new ConsoleError("COMPANY_NOT_FOUND");
    throw err;
  }
  if (!audit.complete) throw new ConsoleError("BOOKS_INCOMPLETE", { message: incompleteBooksReason(audit) });
  return { filename: `kalypso-${companyId}-${new Date().toISOString().slice(0, 10)}.csv`, csv: exportAuditCsv(audit) };
}
