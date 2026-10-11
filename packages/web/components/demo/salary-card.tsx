"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/lib/i18n/locales";
import { isLocale } from "@/lib/i18n/locales";
import { editableUsdc, parseAmount } from "@/lib/i18n/amount";
import { displayUsdc } from "@/lib/money";
import { requireSalaries } from "@/lib/sandbox/salaries";

export type Salaries = [bigint, bigint, bigint];

// The default payroll, in stroops: 4,200.00, 3,650.00 and 5,100.00 USDC, written out in the
// page's locale by editableUsdc so the field accepts its own default.
const DEFAULT_STROOPS: Salaries = [42_000_000_000n, 36_500_000_000n, 51_000_000_000n];
const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

// Each field goes through the one strict parser, so "1,5" is refused in English rather than read as
// 15 (and read as one and a half in Spanish), and the total adds up exactly the figures the run will send.
export function readSalaries(texts: readonly string[], locale: Locale = "en"): { values: (bigint | null)[]; amounts: Salaries | null; total: bigint } {
  const values = texts.map((text) => parseAmount(text, locale));
  const [first, second, third] = values;
  const amounts: Salaries | null = values.length === 3 && first != null && second != null && third != null ? [first, second, third] : null;
  const total = values.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  return { values, amounts, total };
}

// The engine's own limit on the three salaries together, so a too-large payroll is refused here
// instead of after the page has already moved on to the run. The engine names it by code.
function limitCode(amounts: Salaries): string | null {
  try {
    requireSalaries(amounts);
    return null;
  } catch (err) {
    return err instanceof Error && err.name === "SandboxError" ? ((err as { code?: string }).code ?? "INVALID_AMOUNTS") : "INVALID_AMOUNTS";
  }
}

export function SalaryCard({ onStart }: { onStart: (amounts: Salaries) => void }) {
  const t = useTranslations("sandbox.card");
  const errors = useTranslations("errors.sandbox");
  const localeTag = useLocale();
  const locale: Locale = isLocale(localeTag) ? localeTag : "en";
  const id = useId();
  const [texts, setTexts] = useState(() => DEFAULT_STROOPS.map((stroops) => editableUsdc(stroops, locale)));

  const { values, amounts, total } = readSalaries(texts, locale);
  const limit = amounts ? limitCode(amounts) : null;
  const invalid = t("invalid", { plain: "4200", grouped: editableUsdc(42_005_000_000n, locale) });

  const change = (index: number, text: string) => setTexts((all) => all.map((old, i) => (i === index ? text : old)));
  const tidy = (index: number) => {
    const value = values[index];
    if (value != null) change(index, editableUsdc(value, locale));
  };

  return (
    <div>
      <div className="rounded-card border border-line bg-raised p-7" style={{ boxShadow: "var(--shadow-card)" }}>
        <p className="t-label">{t("title")}</p>

        <div className="mt-5 flex flex-col gap-4">
          {texts.map((text, index) => {
            const bad = values[index] == null;
            const inputId = `${id}-salary-${index}`;
            const errorId = `${inputId}-error`;
            return (
              <div key={index}>
                <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
                  <label htmlFor={inputId} className="font-sans text-base text-fg">
                    {t("worker", { n: index + 1 })}
                  </label>
                  <div className="relative w-[160px] max-sm:w-full">
                    <input
                      id={inputId}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      value={text}
                      aria-invalid={bad}
                      aria-describedby={bad ? errorId : undefined}
                      onChange={(event) => change(index, event.target.value)}
                      onBlur={() => tidy(index)}
                      className="w-full rounded-button border border-line-strong bg-raised-2 py-2 pl-3 pr-[3.75rem] text-right font-display text-[1.25rem] text-fg transition-colors focus:border-fg focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-fg"
                    />
                    <span aria-hidden="true" className="t-label pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                      USDC
                    </span>
                  </div>
                </div>
                {bad ? (
                  <p id={errorId} className="mt-2 font-sans text-[0.875rem] text-fail sm:text-right">
                    {invalid}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-baseline justify-between border-t border-line pt-[14px]">
          <span className="font-sans text-base text-fg">{t("total")}</span>
          <span className="font-display text-[1.25rem] font-semibold text-fg">{displayUsdc(total, locale)}</span>
        </div>
        {limit ? <p className="mt-2 font-sans text-[0.875rem] text-fail">{errors(limit)}</p> : null}
      </div>

      <button
        type="button"
        className="btn-seal mt-5 w-full"
        disabled={amounts === null || limit !== null}
        onClick={() => {
          if (amounts) onStart(amounts);
        }}
      >
        {t("start")}
      </button>
      <p className="t-label mt-4" style={PLAIN_CASE}>
        {t("takes")}
      </p>
    </div>
  );
}
