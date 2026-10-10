"use client";

import { useMemo, useState } from "react";
import { ErrorNote } from "@/components/app/error-note";
import { problemsOf } from "@/components/app/errors";
import { SelectField, TextAreaField } from "@/components/app/fields";
import { loadEmployer, useEmployerLib } from "@/components/app/loaders";
import { Block, Panel } from "@/components/app/panel";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { useWallet } from "@/components/app/wallet-session";
import { readPayrollCsv } from "@/lib/employer/csv";
import { shortId } from "@/lib/ledger";
import { displayUsdc } from "@/lib/money";
import { CsvDrop } from "./csv-drop";
import { RunResult } from "./run-result";

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString("en-US", { month: "long" }));

export function PayrollPanel({ companyId, refresh }: { companyId: bigint; refresh: () => void }) {
  const wallet = useWallet();
  const lib = useEmployerLib();
  const [now] = useState(() => new Date());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [csv, setCsv] = useState("");
  const [pasting, setPasting] = useState(false);

  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const parsed = useMemo(() => (csv.trim() === "" ? { rows: [], problems: [] } : readPayrollCsv(csv)), [csv]);
  const total = parsed.rows.reduce((sum, row) => sum + row.amount, 0n);
  const runLabel = lib?.runPeriod(year, month).label;

  const pay = useAction(async (onProgress) => {
    const employer = await loadEmployer();
    try {
      return await employer.runPayroll(wallet, { companyId, year, month, csv }, onProgress);
    } finally {
      // The treasury moves with every payment that landed, even in a run that then stopped.
      refresh();
    }
  });

  useLeaveWarning(pay.running);
  const run = pay.value;
  const refused = pay.cause === undefined ? [] : problemsOf(pay.cause);
  const canPay = parsed.rows.length > 0 && parsed.problems.length === 0;
  const changeCsv = (text: string) => {
    pay.reset();
    setCsv(text);
  };

  return (
    <Panel eyebrow="03" title="Run payroll">
      <Block>
        <div className="flex flex-wrap items-end gap-4">
          <SelectField
            label="Month"
            value={month}
            disabled={pay.running}
            onChange={(event) => {
              pay.reset();
              setMonth(Number(event.target.value));
            }}
            frameClassName="w-[11rem]"
          >
            {MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Year"
            value={year}
            disabled={pay.running}
            onChange={(event) => {
              pay.reset();
              setYear(Number(event.target.value));
            }}
            frameClassName="w-[8rem]"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </SelectField>
        </div>
        <p className="mt-4 flex items-baseline gap-3">
          <span className="t-label">Run</span>
          <span className="font-display text-[1.25rem] font-medium text-paper" style={{ fontVariationSettings: '"opsz" 36' }}>
            {runLabel ?? ""}
          </span>
        </p>
      </Block>

      <Block className="mt-10">
        <CsvDrop disabled={pay.running} onText={changeCsv} />
        <button
          type="button"
          aria-expanded={pasting}
          onClick={() => setPasting((value) => !value)}
          className="link-draw mt-4 text-[0.9375rem]"
        >
          Paste instead
        </button>
        {pasting ? (
          <TextAreaField
            label="Paste the CSV"
            frameClassName="mt-3"
            rows={6}
            placeholder="address,amount"
            value={csv}
            disabled={pay.running}
            onChange={(event) => changeCsv(event.target.value)}
          />
        ) : null}

        {parsed.problems.length > 0 ? (
          <ul role="alert" className="mt-5 space-y-1 font-sans text-[0.9375rem] text-fail">
            {parsed.problems.map((problem, index) => (
              <li key={`${problem.line}/${problem.code}/${index}`}>{problem.sentence}</li>
            ))}
          </ul>
        ) : null}

        {parsed.rows.length > 0 ? (
          <table className="mt-6 w-full border-collapse" aria-label="Payroll preview">
            <thead>
              <tr className="border-b border-line">
                <th className="t-label px-4 py-3 text-left font-normal">Worker</th>
                <th className="t-label px-4 py-3 text-right font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row) => (
                <tr key={`${row.line}/${row.address}`} className="border-b border-line">
                  <td className="px-4 py-3 font-mono text-[0.9375rem] text-paper">{shortId(row.address)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-display text-[1.125rem] font-medium" style={{ fontVariationSettings: '"opsz" 36' }}>
                      {displayUsdc(row.amount)}
                    </span>{" "}
                    <span className="t-label">USDC</span>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-3 font-sans text-base text-paper">Total</td>
                <td className="px-4 py-3 text-right">
                  <span className="font-display text-[1.25rem] font-semibold text-paper">{displayUsdc(total)}</span>{" "}
                  <span className="t-label">USDC</span>
                </td>
              </tr>
            </tbody>
          </table>
        ) : null}
      </Block>

      <Block className="mt-10">
        <p className="max-w-[36rem] font-sans text-base text-muted">
          Freighter asks you to approve each payment transaction; each one pays up to two workers.
        </p>
        <div className="mt-4">
          <StepButton action={pay} disabled={!canPay} onClick={() => void pay.start()}>
            Approve and pay
          </StepButton>
        </div>

        {pay.lines.length > 0 ? (
          <ol aria-label="Progress" className="mt-5 space-y-1 font-sans text-[0.9375rem] text-muted">
            {pay.lines.map((line, index) => (
              <li key={`${index}/${line.sentence}`} className={`flex flex-wrap items-center gap-x-3 ${pay.running && index === pay.lines.length - 1 ? "text-paper" : ""}`}>
                <span>{line.sentence}</span>
                {line.txHash ? <TxLink hash={line.txHash} /> : null}
              </li>
            ))}
          </ol>
        ) : null}

        {pay.error ? <ErrorNote error={pay.error} /> : null}
        {refused.length > 1 ? (
          <ul className="mt-2 space-y-1 font-sans text-[0.9375rem] text-fail">
            {refused.map((problem) => (
              <li key={`${problem.line}/${problem.sentence}`}>{problem.sentence}</li>
            ))}
          </ul>
        ) : null}
        {run ? <RunResult run={run} /> : null}
      </Block>
    </Panel>
  );
}
