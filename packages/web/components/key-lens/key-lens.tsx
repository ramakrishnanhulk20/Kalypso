"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import gsap from "gsap";
import type { SealedPayroll } from "@kalypso/core";
import { useLensMotion } from "@/hooks/use-lens-motion";
import { useLivingCiphertext } from "@/hooks/use-living-ciphertext";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  useSealedPayroll,
  useSealedPayrollState,
} from "@/hooks/use-sealed-payroll";
import type { KeyMode } from "@/hooks/use-sealed-payroll";
import { amountsFrom, shortId } from "@/lib/ledger";
import { ATTACK_RUN_URL, EXPLORER_URL } from "@/lib/links";
import { contracts, showcase } from "@/lib/stack";
import { LedgerTable } from "./ledger-table";
import { LensRing } from "./lens-ring";
import {
  LoadingLine,
  ProgressLine,
  StatusChip,
  loadingLabel,
} from "./status";

const KEY_MODES: KeyMode[] = ["accountant", "stranger"];

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;
const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } as const;

export function KeyLens() {
  const t = useTranslations("landing.lens");
  const status = useTranslations("landing.status");
  const sectionRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const ringBodyRef = useRef<HTMLDivElement>(null);
  const entranceStarted = useRef(false);
  const hadRows = useRef(false);

  const [mode, setMode] = useState<KeyMode>("accountant");
  const [openAll, setOpenAll] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const reduceMotion = useReducedMotion();

  const { phase, done, total, payroll, retry } = useSealedPayroll(mode);
  // Whether the history is complete belongs to the history, not to the key, so
  // the chip always reports on the accountant read.
  const accountant = useSealedPayrollState("accountant");

  // The rows are the same for every key, so whichever key has been read first
  // keeps them on screen while the other key is still being tried.
  const [rowsSource, setRowsSource] = useState<SealedPayroll | null>(null);
  useEffect(() => {
    if (payroll) setRowsSource(payroll);
  }, [payroll]);

  const payments = (payroll ?? rowsSource)?.payments ?? null;
  const amounts = useMemo(() => amountsFrom(payroll), [payroll]);
  const failed = phase === "error";
  const label = loadingLabel(status, mode, phase, done, total);
  const chipLabel = loadingLabel(
    status,
    "accountant",
    accountant.phase,
    accountant.done,
    accountant.total,
  );
  const liveMessage = !openAll || !payroll ? "" : mode === "accountant" ? t("liveAll") : t("liveNone", { count: payroll.payments.length });

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const visibility = new IntersectionObserver(
      ([entry]) => setOnScreen(entry?.isIntersecting ?? false),
      { threshold: 0 },
    );
    visibility.observe(section);
    return () => visibility.disconnect();
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    const ringBody = ringBodyRef.current;
    if (!section || !ringBody) return;

    if (reduceMotion) {
      ringBody.style.opacity = "1";
      return;
    }

    let timeline: gsap.core.Timeline | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        entranceStarted.current = true;
        timeline = gsap.timeline();
        section
          .querySelectorAll<HTMLElement>("table[data-layer]")
          .forEach((table) => {
            timeline?.fromTo(
              table.querySelectorAll("[data-ledger-row]"),
              { opacity: 0, y: 16 },
              {
                opacity: 1,
                y: 0,
                duration: 0.6,
                ease: "expo.out",
                stagger: 0.04,
                clearProps: "opacity,transform",
              },
              0,
            );
          });
        timeline.fromTo(
          ringBody,
          { scale: 0.85, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.7, ease: "back.out(1.6)" },
        );
      },
      { rootMargin: "0px 0px -20% 0px", threshold: 0 },
    );
    observer.observe(section);

    return () => {
      observer.disconnect();
      timeline?.kill();
    };
  }, [reduceMotion]);

  // Real rows replace the placeholder rows when the first read lands. They
  // rise in like the placeholders did, but only once the entrance has started.
  useLayoutEffect(() => {
    if (payments === null) {
      hadRows.current = false;
      return;
    }
    if (hadRows.current) return;
    hadRows.current = true;
    const section = sectionRef.current;
    if (!section || reduceMotion || !entranceStarted.current) return;
    section
      .querySelectorAll<HTMLElement>("table[data-layer]")
      .forEach((table) => {
        gsap.fromTo(
          table.querySelectorAll("[data-ledger-row]"),
          { opacity: 0, y: 16 },
          {
            opacity: 1,
            y: 0,
            duration: 0.6,
            ease: "expo.out",
            stagger: 0.04,
            clearProps: "opacity,transform",
          },
        );
      });
  }, [payments, reduceMotion]);

  useLensMotion({
    cardRef,
    fieldRef,
    ringRef,
    running: onScreen && !openAll,
    reduceMotion,
    layoutKey: payments,
  });

  useLivingCiphertext(fieldRef, onScreen && !reduceMotion);

  return (
    <section
      id="lens"
      ref={sectionRef}
      className="relative bg-canvas"
      style={{ padding: "18vh 4vw 16vh" }}
    >
      <div className="relative grid grid-cols-1 lg:grid-cols-12 lg:gap-x-[4vw]">
        <div className="contents lg:sticky lg:top-[14vh] lg:col-span-5 lg:block lg:self-start">
          <div className="order-1">
            <p className="t-label">{t("eyebrow")}</p>
            <h2 className="t-h2 mt-4">{t("title")}</h2>
            <p className="t-lead mt-[22px]">{t("lead")}</p>
          </div>

          <div
            role="radiogroup"
            aria-label={t("keyLabel")}
            className="order-2 mt-8 flex flex-wrap gap-2"
          >
            {KEY_MODES.map((value) => (
              <label key={value} className="relative cursor-pointer">
                <input
                  type="radio"
                  name="lens-key"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  className="peer sr-only"
                />
                <span className="block rounded-button border border-line-strong px-4 py-[0.6rem] font-sans text-[0.9375rem] text-muted transition-colors hover:text-fg peer-checked:border-fg peer-checked:bg-raised-2 peer-checked:text-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-fg">
                  {value === "accountant" ? t("keyAccountant") : t("keyStranger")}
                </span>
              </label>
            ))}
          </div>

          <button
            type="button"
            aria-pressed={openAll}
            onClick={() => setOpenAll((value) => !value)}
            className="link-draw order-3 mt-3 justify-self-start text-[0.9375rem] max-md:order-5"
          >
            <span
              aria-hidden="true"
              className="h-[10px] w-[10px] rounded-full bg-seal"
            />
            {openAll ? t("lensOnly") : t("openAll")}
          </button>

          <p
            className="t-label order-4 mt-7 max-w-[30rem] max-md:order-3"
            style={PLAIN_CASE}
          >
            {t("note")}
          </p>

          <a
            href={ATTACK_RUN_URL}
            target="_blank"
            rel="noopener"
            className="link-draw group order-5 mt-[14px] justify-self-start text-[0.9375rem] max-md:order-4"
          >
            {t("attackLink")}
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="transition-transform duration-200 group-hover:translate-x-[3px]"
            >
              <path d="M2 6h8M6.5 2.5 10 6l-3.5 3.5" />
            </svg>
          </a>
        </div>

        <div className="order-6 min-w-0 max-md:mt-3 md:mt-14 lg:col-span-7 lg:mt-0">
          <div
            ref={cardRef}
            data-open-all={openAll}
            className="ledger-card relative overflow-hidden rounded-card border border-line bg-raised"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <div className="relative flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-[22px] py-[18px]">
              <div>
                <h3
                  className="font-display text-[1.25rem] font-medium"
                  style={DISPLAY_36}
                >
                  {showcase.label}
                </h3>
                <p className="t-label mt-1">
                  {t("company", { id: String(showcase.companyId) })}{" "}
                  <a
                    href={`${EXPLORER_URL}/contract/${contracts.payroll}`}
                    target="_blank"
                    rel="noopener"
                    className="transition-colors hover:text-fg"
                  >
                    {shortId(contracts.payroll)}
                  </a>
                </p>
              </div>
              <StatusChip
                phase={accountant.phase}
                complete={accountant.payroll?.complete ?? false}
                label={chipLabel}
              />
              <ProgressLine phase={phase} done={done} total={total} />
            </div>

            <LoadingLine phase={phase} label={label} />

            <div ref={fieldRef} className="relative">
              <div inert={openAll}>
                <LedgerTable
                  layer="sealed"
                  payments={payments}
                  amounts={amounts}
                  complete={accountant.payroll?.complete ?? false}
                  failed={failed}
                  onRetry={retry}
                  interactive={!openAll}
                />
              </div>

              {payments && !failed ? (
                <div
                  aria-hidden={!openAll}
                  className={`absolute inset-0 z-10 ${openAll ? "" : "pointer-events-none"}`}
                  style={{
                    clipPath: openAll
                      ? "none"
                      : "circle(var(--lens-r) at var(--lx) var(--ly))",
                  }}
                >
                  <LedgerTable
                    layer="revealed"
                    payments={payments}
                    amounts={amounts}
                    complete={accountant.payroll?.complete ?? false}
                    failed={failed}
                    onRetry={retry}
                    interactive={openAll}
                  />
                </div>
              ) : null}

              <LensRing
                mode={mode}
                hidden={openAll}
                positionRef={ringRef}
                bodyRef={ringBodyRef}
              />
            </div>
          </div>
        </div>
      </div>

      <div role="status" className="sr-only">
        {liveMessage}
      </div>
    </section>
  );
}
