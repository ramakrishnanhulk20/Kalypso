"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CSV_DEFAULT_MAX_BYTES, CSV_DEFAULT_MAX_ROWS, CSV_NAME_MAX_CHARACTERS } from "@kalypso/core";
import { problemsOf } from "@/components/app/errors";
import { SelectField, TextAreaField } from "@/components/app/fields";
import { loadEmployer, useEmployerLib } from "@/components/app/loaders";
import { Block, Panel } from "@/components/app/panel";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { useWallet } from "@/components/app/wallet-session";
import { useProgressText } from "./progress-text";
import { useMoneyLocale } from "@/components/key-lens/ledger-table";
import { readPayrollCsv } from "@/lib/employer/csv";
import { INTL_TAG } from "@/lib/i18n/locales";
import { shortId } from "@/lib/ledger";
import { displayUsdc } from "@/lib/money";
import { ConsoleErrorNote } from "./console-error-note";
import { CsvDrop } from "./csv-drop";
import { RunResult } from "./run-result";

type Problem = { line: number; code: string; sentence: string; amount?: string };

// The importer's DUPLICATE sentence names the earlier line; the number is all another language needs from it.
const EARLIER_LINE = /\b(\d+)\b(?!.*\b\d+\b)/;

export function PayrollPanel({ companyId, refresh }: { companyId: bigint; refresh: () => void }) {
  const t = useTranslations("employer.payroll");
  const csv = useTranslations("errors.csv");
  const locale = useLocale();
  const moneyLocale = useMoneyLocale();
  const wallet = useWallet();
  const lib = useEmployerLib();
  const [now] = useState(() => new Date());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [text, setText] = useState("");
  const [pasting, setPasting] = useState(false);

  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(INTL_TAG[moneyLocale], { month: "long", timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, i) => format.format(new Date(Date.UTC(2000, i, 1))));
  }, [moneyLocale]);

  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const parsed = useMemo(() => (text.trim() === "" ? { rows: [], problems: [] } : readPayrollCsv(text)), [text]);
  const total = parsed.rows.reduce((sum, row) => sum + row.amount, 0n);
  const runLabel = lib?.runPeriod(year, month).label;

  // In English the importer's own sentence; elsewhere the same problem by its code.
  const problemText = (problem: Problem): string => {
    if (locale === "en") return problem.sentence;
    const where = problem.line === 0 ? csv("file") : csv("line", { line: problem.line });
    if (problem.code === "DUPLICATE") {
      const first = EARLIER_LINE.exec(problem.sentence)?.[1];
      return first === undefined ? csv("DUPLICATE_UNKNOWN", { where }) : csv("DUPLICATE", { where, first });
    }
    if (problem.code === "AMOUNT_AMBIGUOUS") {
      return problem.amount === undefined ? csv("OTHER", { where }) : csv("AMOUNT_AMBIGUOUS", { line: problem.line, amount: problem.amount });
    }
    if (!csv.has(problem.code)) return csv("OTHER", { where });
    return csv(problem.code, { where, kb: Math.floor(CSV_DEFAULT_MAX_BYTES / 1024), rows: CSV_DEFAULT_MAX_ROWS, chars: CSV_NAME_MAX_CHARACTERS });
  };

  const progressText = useProgressText();
  const pay = useAction(async (onProgress) => {
    const employer = await loadEmployer();
    try {
      return await employer.runPayroll(wallet, { companyId, year, month, csv: text }, progressText(onProgress));
    } finally {
      // The treasury moves with every payment that landed, even in a run that then stopped.
      refresh();
    }
  });

  useLeaveWarning(pay.running);
  const run = pay.value;
  const refused = pay.cause === undefined ? [] : problemsOf(pay.cause);
  const canPay = parsed.rows.length > 0 && parsed.problems.length === 0;
  const changeCsv = (next: string) => {
    pay.reset();
    setText(next);
  };

  return (
    <Panel eyebrow={t("eyebrow")} title={t("title")}>
      <Block>
        <div className="flex flex-wrap items-end gap-4">
          <SelectField
            label={t("month")}
            value={month}
            disabled={pay.running}
            onChange={(event) => {
              pay.reset();
              setMonth(Number(event.target.value));
            }}
            frameClassName="w-[11rem]"
          >
            {months.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("year")}
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
          <span className="t-label">{t("run")}</span>
          <span className="font-display text-[1.25rem] font-medium text-fg" style={{ fontVariationSettings: '"opsz" 36' }}>
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
          {t("paste")}
        </button>
        {pasting ? (
          <TextAreaField
            label={t("pasteLabel")}
            frameClassName="mt-3"
            rows={6}
            placeholder="address,amount"
            value={text}
            disabled={pay.running}
            onChange={(event) => changeCsv(event.target.value)}
          />
        ) : null}

        {parsed.problems.length > 0 ? (
          <ul role="alert" className="mt-5 space-y-1 font-sans text-[0.9375rem] text-fail">
            {parsed.problems.map((problem, index) => (
              <li key={`${problem.line}/${problem.code}/${index}`}>{problemText(problem)}</li>
            ))}
          </ul>
        ) : null}

        {parsed.rows.length > 0 ? (
          <table className="mt-6 w-full border-collapse" aria-label={t("previewLabel")}>
            <thead>
              <tr className="border-b border-line">
                <th className="t-label px-4 py-3 text-left font-normal">{t("worker")}</th>
                <th className="t-label px-4 py-3 text-right font-normal">{t("amount")}</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row) => (
                <tr key={`${row.line}/${row.address}`} className="border-b border-line">
                  <td className="px-4 py-3 font-mono text-[0.9375rem] text-fg">{shortId(row.address)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-display text-[1.125rem] font-medium" style={{ fontVariationSettings: '"opsz" 36' }}>
                      {displayUsdc(row.amount, moneyLocale)}
                    </span>{" "}
                    <span className="t-label">USDC</span>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="px-4 py-3 font-sans text-base text-fg">{t("total")}</td>
                <td className="px-4 py-3 text-right">
                  <span className="font-display text-[1.25rem] font-semibold text-fg">{displayUsdc(total, moneyLocale)}</span>{" "}
                  <span className="t-label">USDC</span>
                </td>
              </tr>
            </tbody>
          </table>
        ) : null}
      </Block>

      <Block className="mt-10">
        <p className="max-w-[36rem] font-sans text-base text-muted">{t("approveText")}</p>
        <div className="mt-4">
          <StepButton action={pay} disabled={!canPay} onClick={() => void pay.start()}>
            {t("approve")}
          </StepButton>
        </div>

        {pay.lines.length > 0 ? (
          <ol aria-label={t("progressLabel")} className="mt-5 space-y-1 font-sans text-[0.9375rem] text-muted">
            {pay.lines.map((line, index) => (
              <li key={`${index}/${line.sentence}`} className={`flex flex-wrap items-center gap-x-3 ${pay.running && index === pay.lines.length - 1 ? "text-fg" : ""}`}>
                <span>{line.sentence}</span>
                {line.txHash ? <TxLink hash={line.txHash} /> : null}
              </li>
            ))}
          </ol>
        ) : null}

        {pay.error ? <ConsoleErrorNote error={pay.error} /> : null}
        {refused.length > 1 ? (
          <ul className="mt-2 space-y-1 font-sans text-[0.9375rem] text-fail">
            {refused.map((problem) => (
              <li key={`${problem.line}/${problem.sentence}`}>{problemText(problem)}</li>
            ))}
          </ul>
        ) : null}
        {run ? <RunResult run={run} /> : null}
      </Block>
    </Panel>
  );
}
