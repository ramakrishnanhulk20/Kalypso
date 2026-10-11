import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { AnchorPayment } from "@/lib/worker";
import { useMoneyLocale } from "@/components/key-lens/ledger-table";
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
  const locale = useMoneyLocale();
  return (
    <>
      <span className="font-sans text-[0.9375rem] text-fg">{displayUsdc(stroops, locale)}</span> <span className="t-label">USDC</span>
    </>
  );
}

// What the anchor asked to be paid, read from its own authenticated record. The fee and what the
// worker receives come from the same record, and a row shows only once the anchor has set it.
export function ConfirmBox({ payment, fee, receive, children }: { payment: AnchorPayment; fee: bigint | null; receive: bigint | null; children: ReactNode }) {
  const t = useTranslations("worker.confirm");
  const locale = useMoneyLocale();
  return (
    <div className="mt-5 rounded-button bg-raised-2 p-4" role="group" aria-label={t("label")}>
      <p className="t-label">{t("title")}</p>
      <p className="mt-3 flex items-baseline gap-3">
        <span className="font-display text-[2rem] font-medium text-fg" style={AMOUNT_STYLE}>
          {displayUsdc(payment.amount, locale)}
        </span>
        <span className="t-label">USDC</span>
      </p>
      <div className="mt-4">
        <Row name={t("to")}>
          <span className="font-mono text-[0.9375rem] text-fg">{shortAddress(payment.destination)}</span>
        </Row>
        {payment.memo === null ? null : (
          <Row name={t("memo")}>
            <span className="font-mono text-[0.9375rem] text-fg">{payment.memo.value}</span>
          </Row>
        )}
        {fee === null ? null : (
          <Row name={t("fee")}>
            <Usdc stroops={fee} />
          </Row>
        )}
        {receive === null ? null : (
          <Row name={t("receive")}>
            <Usdc stroops={receive} />
          </Row>
        )}
      </div>
      <p className="mt-4 font-sans text-[0.9375rem] text-muted">{t("note")}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}
