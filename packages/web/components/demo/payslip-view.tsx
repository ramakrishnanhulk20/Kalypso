"use client";

import type { ReactNode } from "react";
import type { WorkerView } from "@kalypso/core";
import { StatusChip } from "@/components/key-lens/status";
import { shortId } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { displayUsdc } from "@/lib/money";
import type { KeyRead } from "./use-key-read";

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;
const AMOUNT_STYLE = {
  fontSize: "clamp(2.5rem, 5vw, 4rem)",
  fontVariationSettings: '"opsz" 144',
  lineHeight: 1,
  letterSpacing: "-0.02em",
} as const;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      className="w-full max-w-[560px] rounded-card border border-line bg-ink-2 p-7"
      style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.45)" }}
    >
      {children}
    </div>
  );
}

function Line({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line py-[14px]">
      <span className="t-label">{name}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function Skeleton() {
  return (
    <Frame>
      <span className="skeleton-bar block w-32" />
      <span className="skeleton-bar mt-6 block h-[2.5rem] w-48" />
      <div className="mt-6">
        {["Company", "Paid in", "Balance", "Opened with"].map((name) => (
          <Line key={name} name={name}>
            <span className="skeleton-bar ml-auto block w-24" />
          </Line>
        ))}
      </div>
    </Frame>
  );
}

type PayslipViewProps = {
  /** One-based, as the judge sees it. */
  worker: number;
  companyLabel: string;
  runId: bigint;
  read: KeyRead<WorkerView> | undefined;
  opening: string;
  onRetry: () => void;
};

export function PayslipView({ worker, companyLabel, runId, read, opening, onRetry }: PayslipViewProps) {
  if (read === undefined || read.status === "loading") {
    return (
      <div>
        <div role="status" className="mb-4">
          <StatusChip phase="history" complete={false} label={opening} />
        </div>
        <Skeleton />
      </div>
    );
  }

  if (read.status === "error") {
    return (
      <Frame>
        <p className="font-sans text-base text-muted">{read.message}</p>
        <button type="button" className="btn-ghost mt-4" onClick={onRetry}>
          Try again
        </button>
      </Frame>
    );
  }

  const view = read.value;
  const payslip = view.payslips.find((slip) => slip.runId === runId) ?? view.payslips[0];
  const verified = view.spendable !== undefined || view.receiving !== undefined;
  const balance = (view.spendable ?? 0n) + (view.receiving ?? 0n);

  return (
    <div>
      <Frame>
        {payslip ? (
          <>
            <p className="t-label">Payslip · {payslip.periodLabel}</p>
            <p className="mt-4 flex items-baseline gap-3">
              <span className="font-display font-medium text-paper" style={AMOUNT_STYLE}>
                {displayUsdc(payslip.amount)}
              </span>
              <span className="t-label">USDC</span>
            </p>
            <div className="mt-6">
              <Line name="Company">
                <span className="font-sans text-[0.9375rem] text-paper">{companyLabel}</span>
              </Line>
              <Line name="Paid in">
                <a
                  href={`${EXPLORER_URL}/tx/${payslip.txHash}`}
                  target="_blank"
                  rel="noopener"
                  aria-label={`Open payment ${shortId(payslip.txHash)} on Stellar Expert`}
                  className="link-draw font-mono text-[0.9375rem]"
                >
                  {shortId(payslip.txHash)}
                </a>
              </Line>
              <Line name="Balance">
                {verified ? (
                  <>
                    <span className="font-sans text-[0.9375rem] text-paper">{displayUsdc(balance)}</span>{" "}
                    <span className="t-label">USDC</span>
                  </>
                ) : (
                  <span className="font-sans text-[0.9375rem] text-muted">Not verified</span>
                )}
              </Line>
              <Line name="Opened with">
                <span className="font-sans text-[0.9375rem] text-paper">Worker {worker}&apos;s own key</span>
              </Line>
            </div>
          </>
        ) : (
          <>
            <p className="font-sans text-base text-muted">No payslip showed up in this worker&apos;s history.</p>
            <button type="button" className="btn-ghost mt-4" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </Frame>

      {view.complete ? null : (
        <div className="mt-4">
          <StatusChip phase="done" complete={false} label="" />
        </div>
      )}
      <p className="t-label mt-4 max-w-[560px]" style={{ ...PLAIN_CASE, color: "var(--color-muted)" }}>
        The other workers&apos; amounts are not in this view: this key cannot open them.
      </p>
    </div>
  );
}
