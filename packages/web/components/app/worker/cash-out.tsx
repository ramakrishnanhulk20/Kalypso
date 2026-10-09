"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { displayUsdc } from "@/lib/money";
import { AnchorStep } from "./anchor-step";
import { offersSelfPay, readMove } from "./move-amount";
import { shownErrors } from "./shown";
import { shortAddress } from "./text";
import type { WorkerKit } from "./worker-lib";

const MOVING = { sentence: "Moving your pay. This can take a minute.", done: 0, total: 1 } as const;
const MOVING_SELF = { sentence: "Moving your pay and paying the network fee yourself", done: 0, total: 1 } as const;
const SELF_PAY_NOTE = "The fee sponsor cannot pay for this move right now. You can pay the small network fee yourself, from your cash-out account's test XLM.";

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-5 border-t border-line py-6">
      <span className="t-label pt-[5px]">{number}</span>
      <div className="min-w-0">
        <h3 className="font-sans text-[1.0625rem] text-paper">{title}</h3>
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
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [text, setText] = useState("");
  const [tried, setTried] = useState<bigint | null>(null);
  const reading = readMove(text, max);
  const { amount } = reading;
  const problem = reading.problem === null ? null : new kit.lib.WorkerError(reading.problem).message;

  const move = useAction(async (onProgress, chosen: bigint, payFee: "sponsor" | "self") => {
    onProgress(payFee === "self" ? MOVING_SELF : MOVING);
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
      <label htmlFor={inputId} className="font-sans text-base text-paper">
        Amount
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
            className="w-full rounded-button border border-line bg-ink-3 py-2 pl-3 pr-[3.75rem] text-right font-display text-[1.25rem] text-paper transition-colors hover:border-[rgba(242,236,230,0.2)] focus:border-[rgba(242,236,230,0.4)] focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-paper aria-[invalid=true]:border-fail"
          />
          <span aria-hidden="true" className="t-label pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
            USDC
          </span>
        </div>
        {max !== null ? (
          <button type="button" className="link-draw text-[0.9375rem] disabled:cursor-not-allowed disabled:opacity-40" disabled={move.running} onClick={() => setText(displayUsdc(max))}>
            Max
          </button>
        ) : null}
      </div>
      {problem !== null ? (
        <p id={errorId} className="mt-2 font-sans text-[0.875rem] text-fail">
          {problem}
        </p>
      ) : null}
      {reading.confirm !== null ? (
        <p className="mt-3 font-sans text-[0.9375rem] text-paper">
          {reading.confirm}
        </p>
      ) : null}
      <div className="mt-4">
        <StepButton action={move} disabled={reading.confirm === null} onClick={start}>
          {reading.label}
        </StepButton>
      </div>
      {move.error ? <ErrorNote error={move.error} /> : null}
      {move.error && tried !== null && reading.amount === tried && offersSelfPay(move.error) ? (
        <div className="mt-4">
          <p className="max-w-[36rem] font-sans text-[0.9375rem] text-muted">{SELF_PAY_NOTE}</p>
          <div className="mt-3">
            <StepButton variant="ghost" action={move} onClick={() => void move.start(tried, "self")}>
              Pay the fee yourself
            </StepButton>
          </div>
        </div>
      ) : null}
      {move.value ? (
        <p role="status" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[0.9375rem] text-muted">
          <span>
            Moved. Your cash-out account <span className="font-mono text-paper">{shortAddress(worker.cashOutAddress)}</span> now holds it as USDC.
          </span>
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
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-14 border-t border-line pt-10">
      <p className="t-label">Cash out</p>
      <h2 id={headingId} className="mt-3 font-display text-[1.5rem] font-medium leading-[1.15] text-paper">
        Move your pay to your bank.
      </h2>
      <p className="mt-3 max-w-[36rem] font-sans text-base text-muted">
        Your pay moves to your cash-out account as plain USDC, then Stellar&apos;s test anchor pays it out. On testnet no real money moves.
      </p>
      <ol className="mt-8 border-b border-line">
        <Step number="01" title="Move to your cash-out account">
          <MoveStep kit={kit} worker={worker} max={max} onMoved={onMoved} />
        </Step>
        <Step number="02" title="Cash out at the anchor">
          <AnchorStep kit={kit} worker={worker} />
        </Step>
      </ol>
    </section>
  );
}
