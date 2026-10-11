import { useLocale, useTranslations } from "next-intl";
import type { PayrollRun } from "@/lib/employer";
import { RowChip } from "@/components/app/row-chip";
import type { ChipTone } from "@/components/app/row-chip";
import { TxLink } from "@/components/app/tx-link";
import { shortId } from "@/lib/ledger";

const TONE: Record<PayrollRun["rows"][number]["status"], ChipTone> = {
  paid: "ok",
  "already-paid": "muted",
  failed: "fail",
};

const HEAD = "t-label px-4 py-3 text-left font-normal";

// What the run did, row by row, straight from the chain's answer. A failed row carries its own
// reason, and the run is called closed only when the chain closed it.
export function RunResult({ run }: { run: PayrollRun }) {
  const t = useTranslations("employer.payroll");
  const errors = useTranslations("errors.run");
  const locale = useLocale();
  const chipText = { paid: t("paid"), "already-paid": t("alreadyPaid"), failed: t("failed") };

  // The lib's sentence in English; by the row's reason, when it names one, elsewhere.
  const failedText = (row: PayrollRun["rows"][number]): string => {
    if (locale === "en") return row.sentence;
    const reason = (row as { reason?: unknown }).reason;
    return typeof reason === "string" && errors.has(reason) ? errors(reason) : errors("failed");
  };

  return (
    <div className="mt-8">
      <table className="w-full border-collapse" aria-label={t("tableLabel", { label: run.label })}>
        <thead>
          <tr className="border-b border-line">
            <th className={HEAD}>{t("worker")}</th>
            <th className={HEAD}>{t("status")}</th>
            <th className={`${HEAD} max-md:hidden`}>{t("payment")}</th>
          </tr>
        </thead>
        <tbody>
          {run.rows.map((row) => (
            <tr key={`${row.line}/${row.address}`} className="border-b border-line align-top">
              <td className="px-4 py-3">
                <span className="font-mono text-[0.9375rem] text-fg">{shortId(row.address)}</span>
                {row.txHash ? (
                  <span className="mt-1 block md:hidden">
                    <TxLink hash={row.txHash} />
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <RowChip tone={TONE[row.status]}>{chipText[row.status]}</RowChip>
                {row.status === "failed" ? <p className="mt-2 max-w-[28rem] font-sans text-[0.875rem] text-fail">{failedText(row)}</p> : null}
              </td>
              <td className="px-4 py-3 max-md:hidden">{row.txHash ? <TxLink hash={row.txHash} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.closed ? (
        <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-base text-fg">
          {t("closed")}
          {run.closeTx ? <TxLink hash={run.closeTx} /> : null}
        </p>
      ) : null}
    </div>
  );
}
