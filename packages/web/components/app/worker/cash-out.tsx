"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import { RowChip } from "@/components/app/row-chip";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { useMoneyLocale } from "@/components/key-lens/ledger-table";
import { editableUsdc } from "@/lib/i18n/amount";
import { AnchorStep } from "./anchor-step";
import { offersSelfPay, readMove } from "./move-amount";
import { shownErrors } from "./shown";
import { shortAddress } from "./text";
import type { WorkerKit } from "./worker-lib";

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-5 border-t border-line py-6">
      <span className="t-label pt-[5px]">{number}</span>
      <div className="min-w-0">
        <h3 className="font-sans text-[1.0625rem] text-fg">{title}</h3>
        <div className="mt-4">{children}</div>
      </div>
    </li>
  );
}

// The amount is read with the one typed-amount parser and repeated back, in a sentence and on the
// button, before the withdraw (C54). "Moved" shows only when the lib has read the new balance from
// chain (C55). When the sponsor refuses, the same amount, offered only while the box still shows
// it, can be moved with the fee paid from the worker's own account; the lib builds that on the same
// balance, so it cannot move pay twice.
function MoveStep({ kit, worker, max, onMoved }: { kit: WorkerKit; worker: WorkerSession; max: bigint | null; onMoved: () => void }) {
  const t = useTranslations("worker.cashOut");
  const errors = useTranslations("errors.worker");
  const locale = useLocale();
  const moneyLocale = useMoneyLocale();
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [text, setText] = useState("");
  const [tried, setTried] = useState<bigint | null>(null);
  const reading = readMove(text, max, moneyLocale, t);
  const { amount } = reading;
  // The lib's own sentence for the code in English; the same code's sentence elsewhere.
  const problem = reading.problem === null ? null : locale === "en" ? new kit.lib.WorkerError(reading.problem).message : errors(reading.problem);

  const move = useAction(async (onProgress, chosen: bigint, payFee: "sponsor" | "self") => {
    onProgress({ sentence: payFee === "self" ? t("movingSelf") : t("moving"), done: 0, total: 1 });
    const moved = await shownErrors(() => kit.lib.withdrawToCashOut(worker, chosen, kit.lib.createHttpSponsor(), { payFee }));
    setText("");
    setTried(null);
    onMoved();
    return moved;
  });
  useLeaveWarning(move.running);

  const start = () => {
    if (amount === null || reading.problem !== null) return;
    setTried(amount);
    void move.start(amount, "sponsor");
  };

  return (
    <div>
      <label htmlFor={inputId} className="font-sans text-base text-fg">
        {t("amount")}
      </label>
      <div className="mt-2 flex items-center gap-4">
        <div className="relative w-full max-w-[240px]">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={text}
            disabled={move.running}
            aria-invalid={problem !== null}
            aria-describedby={problem !== null ? errorId : undefined}
            onChange={(event) => setText(event.target.value)}
            className="w-full rounded-button border border-line-strong bg-raised-2 py-2 pl-3 pr-[3.75rem] text-right font-display text-[1.25rem] text-fg transition-colors hover:border-muted focus:border-fg focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-fg aria-[invalid=true]:border-fail"
          />
          <span aria-hidden="true" className="t-label pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
            USDC
          </span>
        </div>
        {max !== null ? (
          <button type="button" className="link-draw py-2 text-[0.9375rem] disabled:cursor-not-allowed disabled:opacity-40" disabled={move.running} onClick={() => setText(editableUsdc(max, moneyLocale))}>
            {t("max")}
          </button>
        ) : null}
      </div>
      {problem !== null ? (
        <p id={errorId} className="mt-2 font-sans text-[0.875rem] text-fail">
          {problem}
        </p>
      ) : null}
      {reading.confirm !== null ? <p className="mt-3 font-sans text-[0.9375rem] text-fg">{reading.confirm}</p> : null}
      <div className="mt-4">
        <StepButton action={move} disabled={reading.confirm === null} onClick={start}>
          {reading.label}
        </StepButton>
      </div>
      {move.error ? <ErrorNote error={move.error} /> : null}
      {move.error && tried !== null && reading.amount === tried && offersSelfPay(move.error) ? (
        <div className="mt-4">
          <p className="max-w-[36rem] font-sans text-[0.9375rem] text-muted">{t("selfPayNote")}</p>
          <div className="mt-3">
            <StepButton variant="ghost" action={move} onClick={() => void move.start(tried, "self")}>
              {t("payFee")}
            </StepButton>
          </div>
        </div>
      ) : null}
      {move.value ? (
        <p role="status" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[0.9375rem] text-muted">
          <span>{t("moved", { short: shortAddress(worker.cashOutAddress) })}</span>
          {move.value.hash !== null ? <TxLink hash={move.value.hash} /> : null}
        </p>
      ) : null}
    </div>
  );
}

// Two steps: move pay out of the sealed balance into the worker's cash-out account as plain
// USDC, then let the test anchor pay it out. `max` is what the worker can move, or null when
// the balance could not be verified (the lib then checks it itself).
export function CashOut({ kit, worker, max, onMoved }: { kit: WorkerKit; worker: WorkerSession; max: bigint | null; onMoved: () => void }) {
  const t = useTranslations("worker.cashOut");
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-14 border-t border-line pt-10">
      <p className="t-label">{t("label")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id={headingId} className="font-display text-[1.5rem] font-medium leading-[1.15] text-fg">
          {t("title")}
        </h2>
        <RowChip tone="wait">{t("testChip")}</RowChip>
      </div>
      <p className="mt-3 max-w-[36rem] font-sans text-base text-muted">{t("text")}</p>
      <ol className="mt-8 border-b border-line">
        <Step number="01" title={t("step1")}>
          <MoveStep kit={kit} worker={worker} max={max} onMoved={onMoved} />
        </Step>
        <Step number="02" title={t("step2")}>
          <AnchorStep kit={kit} worker={worker} />
        </Step>
      </ol>
    </section>
  );
}
