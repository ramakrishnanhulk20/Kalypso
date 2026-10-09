import type { HistoryGap } from "@kalypso/core";

const U64_DECIMAL = /^(0|[1-9]\d{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const MAX_LABEL_CHARS = 120;

/** The company id an invite link carries, or null when the link has none or it is not a u64. */
export function companyIdFromQuery(search: string): bigint | null {
  const raw = new URLSearchParams(search).get("company");
  if (raw === null || !U64_DECIMAL.test(raw)) return null;
  const id = BigInt(raw);
  return id <= U64_MAX ? id : null;
}

/**
 * Text that came from the chain (a company name, a pay period) made safe to show: control and
 * formatting characters, which can reorder text on screen, become spaces, runs of space collapse,
 * and the length is capped.
 */
export function cleanChainText(value: string): string {
  const chars = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim());
  return chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS).join("").trimEnd()}...` : chars.join("");
}

/** The first 4 and last 4 characters of an address. */
export function shortAddress(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

const GAP_SENTENCES: { [R in HistoryGap["reason"]]: (gap: Extract<HistoryGap, { reason: R }>) => string } = {
  company_count_mismatch: (g) => `The chain lists ${g.expected} ${g.expected === 1 ? "company" : "companies"} for you, but this device has joined ${g.found}.`,
  runs_opened_mismatch: (g) => `The chain says company #${g.companyId} opened ${g.expected} pay ${g.expected === 1 ? "run" : "runs"}, but ${g.found} could be read.`,
  run_not_on_chain: (g) => `The history shows a pay run ${g.runId} for company #${g.companyId} that the chain says it never opened.`,
  admin_changes_mismatch: (g) => `The chain's record of who runs company #${g.companyId} does not match the history that was read.`,
  payslip_missing: (g) => `A payslip from run ${g.runId} of company #${g.companyId} could not be checked, so it is not listed.`,
  ledger_mismatch: (g) => `A payslip from run ${g.runId} of company #${g.companyId} is dated differently from its transaction, so it is not listed.`,
  paid_count_mismatch: (g) => `The chain says run ${g.runId} of company #${g.companyId} paid ${g.expected} ${g.expected === 1 ? "worker" : "workers"}, but ${g.found} payslips passed every check.`,
};

/** One plain sentence for each place the chain's counts and the history disagree. Never carries an amount. */
export function gapSentences(gaps: readonly HistoryGap[]): string[] {
  const sentences = gaps.map((gap) => (GAP_SENTENCES[gap.reason] as (g: HistoryGap) => string)(gap));
  return [...new Set(sentences)];
}
