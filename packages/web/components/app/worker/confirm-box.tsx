import type { ReactNode } from "react";
import type { AnchorPayment } from "@/lib/worker";
import { displayUsdc } from "@/lib/money";
import { shortAddress } from "./text";

const AMOUNT_STYLE = { fontVariationSettings: '"opsz" 144', lineHeight: 1, letterSpacing: "-0.02em" } as const;

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-[10px]">
      <span className="t-label">{name}</span>
      <span className="min-w-0 break-all text-right">{children}</span>
    </div>
  );
}

function Usdc({ stroops }: { stroops: bigint }) {
  return (
    <>
      <span className="font-sans text-[0.9375rem] text-paper">{displayUsdc(stroops)}</span> <span className="t-label">USDC</span>
    </>
  );
}

// What the anchor asked to be paid, read from its own authenticated record. The fee and what the
// worker receives come from the same record, and a row shows only once the anchor has set it.
export function ConfirmBox({ payment, fee, receive, children }: { payment: AnchorPayment; fee: bigint | null; receive: bigint | null; children: ReactNode }) {
  return (
    <div className="mt-5 rounded-button bg-ink-3 p-4" role="group" aria-label="The payment the anchor asks for">
      <p className="t-label">The anchor asks for</p>
      <p className="mt-3 flex items-baseline gap-3">
        <span className="font-display text-[2rem] font-medium text-paper" style={AMOUNT_STYLE}>
          {displayUsdc(payment.amount)}
        </span>
        <span className="t-label">USDC</span>
      </p>
      <div className="mt-4">
        <Row name="To">
          <span className="font-mono text-[0.9375rem] text-paper">{shortAddress(payment.destination)}</span>
        </Row>
        {payment.memo === null ? null : (
          <Row name="Memo">
            <span className="font-mono text-[0.9375rem] text-paper">{payment.memo.value}</span>
          </Row>
        )}
        {fee === null ? null : (
          <Row name="Anchor fee">
            <Usdc stroops={fee} />
          </Row>
        )}
        {receive === null ? null : (
          <Row name="You receive">
            <Usdc stroops={receive} />
          </Row>
        )}
      </div>
      <p className="mt-4 font-sans text-[0.9375rem] text-muted">These come from the anchor&apos;s own record. Check the amount before you approve.</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}
