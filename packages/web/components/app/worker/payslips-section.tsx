"use client";

import type { ReactNode } from "react";
import type { Payslip, WorkerView } from "@kalypso/core";
import { ErrorNote } from "@/components/app/error-note";
import { TxLink } from "@/components/app/tx-link";
import { StatusChip } from "@/components/key-lens/status";
import { displayUsdc } from "@/lib/money";
import { ReadersChip } from "./public-chip";
import { RISE_HIDDEN, RiseList } from "./rise";
import { cleanChainText, gapSentences } from "./text";
import type { PayslipsState } from "./use-payslips";
import { UNJOINED_TEXT, viewOf } from "./use-payslips";
import type { CompanyFacts } from "./worker-lib";

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;
const BALANCE_STYLE = {
  fontSize: "clamp(2.5rem, 9vw, 4rem)",
  fontVariationSettings: '"opsz" 144',
  lineHeight: 1,
  letterSpacing: "-0.02em",
} as const;
const AMOUNT_STYLE = { fontVariationSettings: '"opsz" 144', lineHeight: 1, letterSpacing: "-0.02em" } as const;

// Newest pay first: the later the payment's ledger, the higher it sits.
function newestFirst(slips: readonly Payslip[]): Payslip[] {
  return [...slips].sort((a, b) => b.ledger - a.ledger || (a.runId === b.runId ? 0 : b.runId > a.runId ? 1 : -1));
}

function Line({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line py-3">
      <span className="t-label">{name}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-card border border-line bg-ink-2 p-5" aria-hidden="true">
      <span className="skeleton-bar block w-40" />
      <span className="skeleton-bar mt-5 block h-8 w-36" />
      <div className="mt-5">
        {["Paid in", "Company"].map((name) => (
          <Line key={name} name={name}>
            <span className="skeleton-bar ml-auto block w-24" />
          </Line>
        ))}
      </div>
    </div>
  );
}

function PayslipCard({ slip, facts }: { slip: Payslip; facts: CompanyFacts | "unknown" | undefined }) {
  const period = cleanChainText(slip.periodLabel);
  const company = facts === undefined || facts === "unknown" ? undefined : facts.label;
  return (
    <article data-rise style={RISE_HIDDEN} className="rounded-card border border-line bg-ink-2 p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="t-label break-words">{company === undefined ? period : `${period} · ${company}`}</p>
        <ReadersChip facts={facts} />
      </div>
      <p className="mt-3 flex items-baseline gap-3">
        <span className="font-display text-[2rem] font-medium text-paper" style={AMOUNT_STYLE}>
          {displayUsdc(slip.amount)}
        </span>
        <span className="t-label">USDC</span>
      </p>
      <div className="mt-4">
        <Line name="Paid in">
          <TxLink hash={slip.txHash} />
        </Line>
        <Line name="Company">
          <span className="break-words font-sans text-[0.9375rem] text-paper">{company === undefined ? `#${slip.companyId}` : `${company} · #${slip.companyId}`}</span>
        </Line>
      </div>
    </article>
  );
}

function Balance({ view, loading }: { view: WorkerView | null; loading: boolean }) {
  const total = view !== null && view.spendable !== undefined && view.receiving !== undefined ? view.spendable + view.receiving : null;
  return (
    <div>
      <p className="t-label">Your balance</p>
      {view === null && loading ? (
        <span className="skeleton-bar mt-4 block h-10 w-56" />
      ) : total !== null ? (
        <p className="mt-3 flex flex-wrap items-baseline gap-3" aria-busy={loading} style={{ opacity: loading ? 0.5 : 1, transition: "opacity 180ms ease-out" }}>
          <span className="font-display font-medium text-paper" style={BALANCE_STYLE}>
            {displayUsdc(total)}
          </span>
          <span className="t-label">USDC</span>
        </p>
      ) : (
        <p className="mt-3 font-sans text-base text-muted">Not verified</p>
      )}
      <p className="t-label mt-3" style={{ ...PLAIN_CASE, color: "var(--color-muted)" }}>
        Sealed on chain. Opened on this device with your key.
      </p>
      {view !== null && !view.complete ? (
        <div role="status" className="mt-4">
          <StatusChip phase="done" complete={false} label="" />
          <ul className="mt-3 space-y-2">
            {gapSentences(view.gaps).map((sentence) => (
              <li key={sentence} className="font-sans text-[0.9375rem] text-muted">
                {sentence}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// The balance and the payslips, all opened in this browser with the worker's own key.
export function PayslipsSection({ state, companies, onRetry }: { state: PayslipsState; companies: ReadonlyMap<string, CompanyFacts | "unknown">; onRetry: () => void }) {
  const view = viewOf(state);
  const loading = state.phase === "loading";
  const slips = view === null ? [] : newestFirst(view.payslips);

  return (
    <section aria-label="Your payslips" className="mt-10">
      {view !== null || loading ? <Balance view={view} loading={loading} /> : null}

      <div className="mt-10">
        {loading && view === null ? (
          <div>
            <p role="status" className="t-label mb-4" style={PLAIN_CASE}>
              Opening your payslips with your key
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          </div>
        ) : null}

        {state.phase === "failed" ? (
          <div>
            <ErrorNote error={state.error} />
            <button type="button" className="btn-ghost mt-4" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}

        {view !== null && slips.length > 0 ? (
          <RiseList key={slips.map((slip) => slip.txHash).join()} className="grid gap-4 lg:grid-cols-2">
            {slips.map((slip) => (
              <PayslipCard key={`${slip.companyId}/${slip.runId}/${slip.txHash}`} slip={slip} facts={companies.get(slip.companyId.toString())} />
            ))}
          </RiseList>
        ) : null}

        {view !== null && slips.length === 0 && state.phase !== "failed" ? (
          <p className="font-sans text-base text-muted">
            {view.complete
              ? "No payslips yet. They appear here after your employer runs payroll."
              : "No payslips found so far. Part of your history could not be read, so some may be missing; reload to look again."}
          </p>
        ) : null}

        {state.phase === "unjoined" ? (
          <p className="font-sans text-base text-muted">{UNJOINED_TEXT}</p>
        ) : null}
      </div>
    </section>
  );
}
