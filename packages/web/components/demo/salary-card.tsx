"use client";

import { useId, useState } from "react";
import { displayUsdc, parseTypedUsdc } from "@/lib/money";
import { requireSalaries } from "@/lib/sandbox/salaries";

export type Salaries = [bigint, bigint, bigint];

const DEFAULTS = ["4,200.00", "3,650.00", "5,100.00"];
const INVALID = "Enter an amount above zero, like 4200 or 4,200.50.";
const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

// Each field goes through the one strict parser, so "1,5" is refused rather than read as 15, and
// the total adds up exactly the figures the run will send.
export function readSalaries(texts: readonly string[]): { values: (bigint | null)[]; amounts: Salaries | null; total: bigint } {
  const values = texts.map(parseTypedUsdc);
  const [first, second, third] = values;
  const amounts: Salaries | null = values.length === 3 && first != null && second != null && third != null ? [first, second, third] : null;
  const total = values.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  return { values, amounts, total };
}

// The engine's own limit on the three salaries together, so a too-large payroll is refused here
// instead of after the page has already moved on to the run.
function limitMessage(amounts: Salaries): string | null {
  try {
    requireSalaries(amounts);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : null;
  }
}

export function SalaryCard({ onStart }: { onStart: (amounts: Salaries) => void }) {
  const id = useId();
  const [texts, setTexts] = useState(DEFAULTS);

  const { values, amounts, total } = readSalaries(texts);
  const limit = amounts ? limitMessage(amounts) : null;

  const change = (index: number, text: string) => setTexts((all) => all.map((old, i) => (i === index ? text : old)));
  const tidy = (index: number) => {
    const value = values[index];
    if (value != null) change(index, displayUsdc(value));
  };

  return (
    <div>
      <div className="rounded-card border border-line bg-ink-2 p-7" style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.45)" }}>
        <p className="t-label">This month&apos;s payroll</p>

        <div className="mt-5 flex flex-col gap-4">
          {texts.map((text, index) => {
            const bad = values[index] == null;
            const inputId = `${id}-salary-${index}`;
            const errorId = `${inputId}-error`;
            return (
              <div key={index}>
                <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
                  <label htmlFor={inputId} className="font-sans text-base text-paper">
                    Worker {index + 1}
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
                      className="w-full rounded-button border border-line bg-ink-3 py-2 pl-3 pr-[3.75rem] text-right font-display text-[1.25rem] text-paper transition-colors focus:border-[rgba(242,236,230,0.4)] focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-paper"
                    />
                    <span aria-hidden="true" className="t-label pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                      USDC
                    </span>
                  </div>
                </div>
                {bad ? (
                  <p id={errorId} className="mt-2 font-sans text-[0.875rem] text-fail sm:text-right">
                    {INVALID}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-baseline justify-between border-t border-line pt-[14px]">
          <span className="font-sans text-base text-paper">Total</span>
          <span className="font-display text-[1.25rem] font-semibold text-paper">{displayUsdc(total)}</span>
        </div>
        {limit ? <p className="mt-2 font-sans text-[0.875rem] text-fail">{limit}</p> : null}
      </div>

      <button
        type="button"
        className="btn-seal mt-5 w-full"
        disabled={amounts === null || limit !== null}
        onClick={() => {
          if (amounts) onStart(amounts);
        }}
      >
        Start the sandbox
      </button>
      <p className="t-label mt-4" style={PLAIN_CASE}>
        Takes about 3 minutes on a laptop. Slower phones take longer.
      </p>
    </div>
  );
}
