"use client";

import type { CSSProperties } from "react";
import type { SealedPayment } from "@kalypso/core";
import { LedgerTable } from "@/components/key-lens/ledger-table";
import { LoadingLine, ProgressLine, StatusChip } from "@/components/key-lens/status";
import { shortId } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { contracts } from "@/lib/stack";
import type { ReadPhase } from "@/hooks/use-sealed-payroll";

const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } satisfies CSSProperties;

type PayrollCardProps = {
  title: string;
  companyId: bigint;
  /** What the accountant's read says about the history, whichever key is shown. */
  chip: { phase: ReadPhase; complete: boolean };
  /** The honest sentence while the chosen key is being tried. Null once it has answered. */
  opening: string | null;
  payments: SealedPayment[] | null;
  amounts: Map<string, bigint | null> | null;
  failed: boolean;
  onRetry: () => void;
};

const CHIP_LABEL = "Reading sealed payments from Stellar testnet";

// The landing's ledger card with the lens taken away: the revealed layer sits over the sealed one,
// unclipped, so the key's answer is the whole table. The revealed layer sets the height, because
// its subtotal can take two lines on a phone and the sealed one then sits behind it.
export function PayrollCard({ title, companyId, chip, opening, payments, amounts, failed, onRetry }: PayrollCardProps) {
  const loading = opening !== null;
  const revealed = payments !== null && !failed;
  return (
    <div
      data-open-all="true"
      className="ledger-card relative overflow-hidden rounded-card border border-line bg-ink-2"
      style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.45)" }}
    >
      <div className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-[22px] py-[18px]">
        <div>
          <h3 className="font-display text-[1.25rem] font-medium" style={DISPLAY_36}>
            {title}
          </h3>
          <p className="t-label mt-1">
            Company {String(companyId)} · Payroll{" "}
            <a
              href={`${EXPLORER_URL}/contract/${contracts.payroll}`}
              target="_blank"
              rel="noopener"
              className="transition-colors hover:text-paper"
            >
              {shortId(contracts.payroll)}
            </a>
          </p>
        </div>
        <StatusChip phase={chip.phase} complete={chip.complete} label={CHIP_LABEL} />
        <ProgressLine phase={loading ? "history" : "done"} done={0} total={0} />
      </div>

      <LoadingLine phase={loading ? "history" : "done"} label={opening ?? ""} />

      <div className="relative">
        <div inert={revealed} className={revealed ? "absolute inset-0" : undefined}>
          <LedgerTable layer="sealed" payments={payments} amounts={amounts} complete={chip.complete} failed={failed} onRetry={onRetry} interactive={!revealed} />
        </div>
        {revealed ? (
          <div className="relative z-10">
            <LedgerTable layer="revealed" payments={payments} amounts={amounts} complete={chip.complete} failed={failed} onRetry={onRetry} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
