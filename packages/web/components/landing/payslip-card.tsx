"use client";

import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { LensRing } from "@/components/key-lens/lens-ring";
import { sealedText } from "@/components/key-lens/ledger-table";
import { SealMark } from "@/components/seal-mark";
import { shortId } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { displayUsdc } from "@/lib/money";
import type { FirstPayment } from "./first-payment";
import { READABLE_BY } from "./run-steps";
import {
  CHAR_COUNT,
  POSES,
  forgetCard,
  measureCard,
  paintPose,
} from "./payslip-paint";
import type { Step } from "./payslip-paint";

const HIDDEN: CSSProperties = { opacity: 0, visibility: "hidden" };
const DISPLAY_36: CSSProperties = { fontVariationSettings: '"opsz" 36' };

const PAYMENT_AT_STEP = [0, 1, 2, 2, 2];

const CHAR_CLASS =
  "font-display text-[1.75rem] font-medium text-paper data-[s=cycle]:font-mono data-[s=cycle]:text-[0.8125rem] data-[s=cycle]:font-normal data-[s=cycle]:text-muted data-[s=hex]:font-mono data-[s=hex]:text-[0.8125rem] data-[s=hex]:font-normal data-[s=hex]:text-faint sm:data-[s=cycle]:text-[0.9375rem] sm:data-[s=hex]:text-[0.9375rem]";

function Bar({ className = "w-28" }: { className?: string }) {
  return <span className={`skeleton-bar block ${className}`} />;
}

function Row({
  label,
  height,
  first,
  children,
}: {
  label: string;
  height: number;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-3 py-[14px] sm:gap-4 ${first ? "" : "border-t border-line"}`}
    >
      <span
        className="t-label flex w-[96px] shrink-0 items-center max-sm:tracking-[0.1em] sm:w-[110px]"
        style={{ minHeight: height }}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1" style={{ minHeight: height }}>
        {children}
      </div>
    </div>
  );
}

// Variants sit in one grid cell. The live card fades between them on the
// timeline; a fixed-step card draws only the one that belongs to its step.
function Swap({
  name,
  items,
  only,
}: {
  name: string;
  items: ReactNode[];
  only?: number;
}) {
  if (only !== undefined) {
    return <div className="flex min-h-6 items-center">{items[only]}</div>;
  }
  return (
    <div data-swap={name} className="grid min-h-6 items-center">
      {items.map((item, index) => (
        <div
          key={index}
          data-i={index}
          className="col-start-1 row-start-1"
          style={index === 0 ? undefined : HIDDEN}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

type PayslipCardProps = {
  first: FirstPayment | null;
  /** A step number draws that step's end state with no motion. Left out, the card starts at step 1 and a timeline drives it. */
  step?: Step;
  /** Called after the card measured itself, so a timeline can paint again. */
  onMeasure?: (card: HTMLElement) => void;
};

export function PayslipCard({ first, step, onMeasure }: PayslipCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const ringPositionRef = useRef<HTMLDivElement>(null);
  const ringBodyRef = useRef<HTMLDivElement>(null);
  const onMeasureRef = useRef(onMeasure);

  const live = step === undefined;
  const at = step ?? 1;
  const showChip = live || at >= 2;
  const showStamp = live || at >= 3;
  const showRing = live || at === 4;
  const showOpened = live || at >= 4;

  useLayoutEffect(() => {
    onMeasureRef.current = onMeasure;
  });

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const sync = () => {
      measureCard(card);
      if (step === undefined) onMeasureRef.current?.(card);
      else paintPose(card, POSES[step]);
    };

    forgetCard(card);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(card);
    return () => observer.disconnect();
  }, [first, step]);

  const txLink = first ? (
    <a
      href={`${EXPLORER_URL}/tx/${first.payment.txHash}`}
      target="_blank"
      rel="noopener"
      aria-label={`Open payment ${shortId(first.payment.txHash)} on Stellar Expert`}
      className="link-draw font-mono text-[0.9375rem]"
    >
      {shortId(first.payment.txHash)}
    </a>
  ) : (
    <Bar />
  );

  const cardStyle = {
    "--ring": "96px",
    "--lens-r": "42px",
    "--lx": "-999px",
    "--ly": "-999px",
    "--lcx": "0px",
    "--lcy": "0px",
    "--lr": "0px",
    boxShadow: "0 30px 80px rgba(0,0,0,0.45)",
  } as CSSProperties;

  return (
    <div
      ref={cardRef}
      data-payslip={live ? "live" : at}
      data-amount={first ? displayUsdc(first.amount) : undefined}
      data-sealed={first ? sealedText(first.payment) : undefined}
      className="relative w-full max-w-[560px] rounded-card border border-line bg-ink-2 p-5 sm:p-7 [&_.lens-ring-pos]:pointer-events-none [&_.lens-ring-pos]:touch-auto [&_[data-lens-ring]_.t-label]:hidden"
      style={cardStyle}
    >
      <Row label="Worker" height={24} first>
        {first ? (
          <span className="font-mono text-[0.9375rem] leading-6 text-paper">
            {shortId(first.payment.worker)}
          </span>
        ) : (
          <div className="flex h-6 items-center">
            <Bar />
          </div>
        )}
      </Row>

      <Row label="Amount" height={36}>
        <div className="relative h-9">
          {first ? (
            <>
              <div
                aria-hidden="true"
                className="absolute inset-0 overflow-hidden whitespace-nowrap leading-9"
              >
                {Array.from({ length: CHAR_COUNT }, (_, index) => (
                  <span
                    key={index}
                    data-char
                    className={CHAR_CLASS}
                    style={DISPLAY_36}
                  />
                ))}
                <span data-part="usdc" className="t-label ml-2">
                  USDC
                </span>
              </div>
              {showOpened ? (
                <div
                  data-part="opened"
                  aria-hidden="true"
                  className="lens-tint absolute -bottom-2 -left-2 -top-2 right-0 flex items-center rounded-[6px] px-2"
                  style={{
                    clipPath: "circle(var(--lr) at var(--lcx) var(--lcy))",
                  }}
                >
                  <span className="whitespace-nowrap leading-9">
                    <span
                      data-part="opened-number"
                      className="font-display text-[1.75rem] font-medium text-paper"
                      style={DISPLAY_36}
                    >
                      {displayUsdc(first.amount)}
                    </span>
                    <span className="t-label ml-2">USDC</span>
                  </span>
                </div>
              ) : null}
              <span data-part="amount-speech" className="sr-only" />
            </>
          ) : (
            <div className="flex h-9 items-center">
              <Bar />
            </div>
          )}
        </div>
        {showChip ? (
          <div className="mt-2 flex">
            <div
              data-part="chip"
              className="inline-flex min-h-6 items-center gap-2 rounded-[6px] bg-ink-3 px-2 py-1"
              style={live ? HIDDEN : undefined}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full bg-seal"
              />
              <span className="t-label leading-[1.35]">
                Zero-knowledge proof attached
              </span>
            </div>
          </div>
        ) : null}
      </Row>

      <Row label="Payment" height={24}>
        <Swap
          name="payment"
          only={live ? undefined : PAYMENT_AT_STEP[at - 1]}
          items={[
            <span key="a" className="font-sans text-[0.9375rem] text-muted">
              not sent yet
            </span>,
            <span key="b" className="font-sans text-[0.9375rem] text-muted">
              being sealed
            </span>,
            txLink,
          ]}
        />
      </Row>

      <Row label="Readable by" height={24}>
        <Swap
          name="readable"
          only={live ? undefined : at - 1}
          items={READABLE_BY.map((text) => (
            <span key={text} className="font-sans text-[0.9375rem] text-paper">
              {text}
            </span>
          ))}
        />
      </Row>

      {showStamp ? (
        <div className="pointer-events-none absolute -top-6 right-1 z-10 flex items-center gap-3">
          <span
            data-part="stamp-label"
            className="t-label"
            style={{
              color: "var(--color-ok)",
              ...(live ? HIDDEN : undefined),
            }}
          >
            Paid
          </span>
          <div
            data-part="stamp-mark"
            style={{
              transform: "rotate(-14deg)",
              ...(live ? HIDDEN : undefined),
            }}
          >
            <SealMark size={64} />
          </div>
        </div>
      ) : null}

      {showRing ? (
        <LensRing
          mode="accountant"
          hidden={false}
          positionRef={ringPositionRef}
          bodyRef={ringBodyRef}
        />
      ) : null}
    </div>
  );
}
