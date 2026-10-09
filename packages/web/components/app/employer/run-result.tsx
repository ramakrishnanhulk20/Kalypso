import type { PayrollRun } from "@/lib/employer";
import { RowChip } from "@/components/app/row-chip";
import type { ChipTone } from "@/components/app/row-chip";
import { TxLink } from "@/components/app/tx-link";
import { shortId } from "@/lib/ledger";

const CHIP: Record<PayrollRun["rows"][number]["status"], { tone: ChipTone; text: string }> = {
  paid: { tone: "ok", text: "paid" },
  "already-paid": { tone: "muted", text: "already paid" },
  failed: { tone: "fail", text: "failed" },
};

const HEAD = "t-label px-4 py-3 text-left font-normal";

// What the run did, row by row, straight from the chain's answer. A failed row carries its own
// reason, and the run is called closed only when the chain closed it.
export function RunResult({ run }: { run: PayrollRun }) {
  return (
    <div className="mt-8">
      <table className="w-full border-collapse" aria-label={`${run.label} payments`}>
        <thead>
          <tr className="border-b border-line">
            <th className={HEAD}>Worker</th>
            <th className={HEAD}>Status</th>
            <th className={`${HEAD} max-md:hidden`}>Payment</th>
          </tr>
        </thead>
        <tbody>
          {run.rows.map((row) => (
            <tr key={`${row.line}/${row.address}`} className="border-b border-line align-top">
              <td className="px-4 py-3">
                <span className="font-mono text-[0.9375rem] text-paper">{shortId(row.address)}</span>
                {row.txHash ? (
                  <span className="mt-1 block md:hidden">
                    <TxLink hash={row.txHash} />
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <RowChip tone={CHIP[row.status].tone}>{CHIP[row.status].text}</RowChip>
                {row.status === "failed" ? <p className="mt-2 max-w-[28rem] font-sans text-[0.875rem] text-fail">{row.sentence}</p> : null}
              </td>
              <td className="px-4 py-3 max-md:hidden">{row.txHash ? <TxLink hash={row.txHash} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.closed ? (
        <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-base text-paper">
          Run closed
          {run.closeTx ? <TxLink hash={run.closeTx} /> : null}
        </p>
      ) : null}
    </div>
  );
}
