"use client";

import { useCallback, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { motion } from "motion/react";
import { useFirstPayment } from "./first-payment";
import { PayslipCard } from "./payslip-card";
import { POSES, paintPose } from "./payslip-paint";
import type { Pose } from "./payslip-paint";
import { STEPS } from "./run-steps";

gsap.registerPlugin(ScrollTrigger);

const EXPO_OUT = "expo.out";

const HIDDEN: CSSProperties = { opacity: 0, visibility: "hidden" };

// GSAP blends colour strings, so the dot colours are the tokens written out:
// paper at 0.2, --color-seal, and paper at 0.5.
const DOT_UPCOMING = "rgba(242,236,230,0.2)";
const DOT_ACTIVE = "rgb(201,71,58)";
const DOT_PASSED = "rgba(242,236,230,0.5)";

// Seconds on the master timeline at which each step is fully in place. The gap
// before a step is the longest thing that happens in it: the 0.8s scramble, the
// 0.45s stamp, the 0.7s ring slide, the 0.8s sweep.
const STEP_TIME = [0, 0.8, 1.3, 2.0, 2.8];

const STEP_HEADING: CSSProperties = {
  fontSize: "clamp(1.75rem, 3vw, 2.75rem)",
  fontWeight: 500,
  fontVariationSettings: '"opsz" 72',
  letterSpacing: "-0.02em",
  lineHeight: 1.08,
};

const RAIL_GAP = 55;

function buildRun(stage: HTMLElement, card: HTMLElement, pose: Pose) {
  const texts = gsap.utils.toArray<HTMLElement>("[data-step-text]", stage);
  const dots = gsap.utils.toArray<HTMLElement>("[data-dot]", stage);
  const payment = gsap.utils.toArray<HTMLElement>(
    "[data-swap=payment] > [data-i]",
    card,
  );
  const readable = gsap.utils.toArray<HTMLElement>(
    "[data-swap=readable] > [data-i]",
    card,
  );
  const chip = card.querySelector("[data-part=chip]");
  const stampMark = card.querySelector("[data-part=stamp-mark]");
  const stampLabel = card.querySelector("[data-part=stamp-label]");

  const timeline = gsap.timeline({
    paused: true,
    defaults: { ease: "none" },
    onUpdate: () => paintPose(card, pose),
  });

  STEPS.slice(0, -1).forEach((_, index) => {
    const at = STEP_TIME[index] ?? 0;
    const [textOut, textIn] = [texts[index], texts[index + 1]];
    if (textOut && textIn) {
      timeline
        .fromTo(
          textOut,
          { autoAlpha: 1, y: 0 },
          {
            autoAlpha: 0,
            y: -16,
            duration: 0.5,
            ease: EXPO_OUT,
            immediateRender: false,
          },
          at,
        )
        .fromTo(
          textIn,
          { autoAlpha: 0, y: 16 },
          { autoAlpha: 1, y: 0, duration: 0.5, ease: EXPO_OUT },
          at,
        );
    }

    const [readableOut, readableIn] = [readable[index], readable[index + 1]];
    if (readableOut && readableIn) {
      timeline
        .fromTo(
          readableOut,
          { autoAlpha: 1 },
          { autoAlpha: 0, duration: 0.3, immediateRender: false },
          at,
        )
        .fromTo(
          readableIn,
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.3 },
          at,
        );
    }

    const dotOut = dots[index];
    if (dotOut) {
      timeline.fromTo(
        dotOut,
        { backgroundColor: DOT_ACTIVE, scale: 1.5 },
        {
          backgroundColor: DOT_PASSED,
          scale: 1,
          duration: 0.3,
          immediateRender: index === 0,
        },
        at,
      );
    }
    const dotIn = dots[index + 1];
    if (dotIn) {
      timeline.fromTo(
        dotIn,
        { backgroundColor: DOT_UPCOMING, scale: 1 },
        { backgroundColor: DOT_ACTIVE, scale: 1.5, duration: 0.3 },
        at,
      );
    }
  });

  const [paymentA, paymentB, paymentC] = payment;
  if (paymentA && paymentB && paymentC) {
    timeline
      .fromTo(
        paymentA,
        { autoAlpha: 1 },
        { autoAlpha: 0, duration: 0.3, immediateRender: false },
        STEP_TIME[0],
      )
      .fromTo(paymentB, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, STEP_TIME[0])
      .fromTo(
        paymentB,
        { autoAlpha: 1 },
        { autoAlpha: 0, duration: 0.3, immediateRender: false },
        STEP_TIME[1],
      )
      .fromTo(paymentC, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, STEP_TIME[1]);
  }

  if (chip) {
    timeline.fromTo(
      chip,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.4 },
      STEP_TIME[0],
    );
  }

  timeline.fromTo(
    pose,
    { scramble: 0 },
    { scramble: 1, duration: 0.8, immediateRender: false },
    STEP_TIME[0],
  );

  if (stampMark) {
    timeline.fromTo(
      stampMark,
      { autoAlpha: 0, scale: 1.6, rotation: -4 },
      {
        autoAlpha: 1,
        scale: 1,
        rotation: -14,
        duration: 0.45,
        ease: "back.out(2)",
      },
      STEP_TIME[1],
    );
  }
  if (stampLabel) {
    timeline.fromTo(
      stampLabel,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.45 },
      STEP_TIME[1],
    );
  }

  timeline
    .fromTo(
      pose,
      { slide: 0 },
      { slide: 1, duration: 0.7, ease: EXPO_OUT, immediateRender: false },
      STEP_TIME[2],
    )
    .fromTo(
      pose,
      { lens: 0 },
      { lens: 1, duration: 0.3, ease: "power2.out", immediateRender: false },
      STEP_TIME[2],
    )
    .fromTo(
      pose,
      { ring: 0 },
      { ring: 1, duration: 0.3, immediateRender: false },
      STEP_TIME[2],
    )
    .fromTo(
      pose,
      { grow: 0 },
      { grow: 1, duration: 0.8, ease: "expo.inOut", immediateRender: false },
      STEP_TIME[3],
    )
    .fromTo(
      pose,
      { ring: 1 },
      { ring: 0, duration: 0.3, immediateRender: false },
      (STEP_TIME[3] ?? 0) + 0.5,
    );

  return timeline;
}

export function OneRun() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pose = useRef<Pose>({ ...POSES[1] });
  const first = useFirstPayment();

  const repaint = useCallback((card: HTMLElement) => {
    paintPose(card, pose.current);
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage) return;

    const matcher = gsap.matchMedia();
    matcher.add(
      "(min-width: 1024px) and (prefers-reduced-motion: no-preference)",
      () => {
        const card = stage.querySelector<HTMLElement>("[data-payslip=live]");
        if (!card) return;

        const current = pose.current;
        Object.assign(current, POSES[1]);
        const timeline = buildRun(stage, card, current);
        paintPose(card, current);

        // The timeline plays at normal speed toward the step the scroll is in,
        // forward or backward, so every step also runs in reverse.
        let index = 0;
        let driver: gsap.core.Tween | undefined;
        const goTo = (next: number) => {
          if (next === index) return;
          index = next;
          const target = STEP_TIME[next] ?? 0;
          driver?.kill();
          driver = timeline.tweenTo(target, {
            duration: Math.abs(target - timeline.time()),
            ease: "none",
          });
        };

        const progress = { value: 0 };
        gsap.to(progress, {
          value: 1,
          ease: "none",
          scrollTrigger: {
            trigger: stage,
            start: "top top",
            end: "+=400%",
            pin: true,
            scrub: 0.5,
            anticipatePin: 1,
            invalidateOnRefresh: true,
          },
          onUpdate: () =>
            goTo(
              Math.min(
                STEPS.length - 1,
                Math.floor(progress.value * STEPS.length),
              ),
            ),
        });
      },
    );

    // The pin position is measured once. When something above it changes
    // height, such as the lens swapping its placeholder rows for real ones,
    // the measurement has to be taken again.
    let timer = 0;
    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ScrollTrigger.refresh(), 150);
    });
    for (
      let above = section.previousElementSibling;
      above;
      above = above.previousElementSibling
    ) {
      resizeObserver.observe(above);
    }

    return () => {
      window.clearTimeout(timer);
      resizeObserver.disconnect();
      matcher.revert();
    };
  }, []);

  return (
    <section ref={sectionRef} className="relative bg-ink">
      <div style={{ padding: "16vh 4vw 0" }}>
        <p className="t-label">How it works</p>
        <h2 className="t-h2 mt-4">One salary, start to finish.</h2>
      </div>

      <div
        ref={stageRef}
        className="hidden h-[100svh] overflow-hidden px-[4vw] motion-safe:lg:grid motion-safe:lg:grid-cols-12 motion-safe:lg:items-center motion-safe:lg:gap-x-[4vw]"
      >
        <div className="col-span-5 flex min-w-0 items-center">
          <div
            aria-hidden="true"
            className="relative h-[220px] w-14 shrink-0"
          >
            <span
              className="absolute left-[3.5px] top-0 h-full w-px"
              style={{ background: "rgba(242,236,230,0.12)" }}
            />
            {STEPS.map((step, index) => (
              <div
                key={step.n}
                className="absolute left-0 flex -translate-y-1/2 items-center gap-3"
                style={{ top: index * RAIL_GAP }}
              >
                <span
                  data-dot
                  className="block h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: index === 0 ? DOT_ACTIVE : DOT_UPCOMING,
                    transform: index === 0 ? "scale(1.5)" : undefined,
                  }}
                />
                <span className="t-label leading-none">{`0${step.n}`}</span>
              </div>
            ))}
          </div>

          <div className="ml-8 grid min-w-0 flex-1">
            {STEPS.map((step, index) => (
              <div
                key={step.n}
                data-step-text
                className="col-start-1 row-start-1"
                style={index === 0 ? undefined : HIDDEN}
              >
                <p className="t-label">Step {step.n}</p>
                <h3 className="mt-3 font-display text-paper" style={STEP_HEADING}>
                  {step.heading}
                </h3>
                <p className="t-lead mt-5 max-w-[30rem]">{step.text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="col-span-7 col-start-6 flex min-w-0 justify-center">
          <PayslipCard first={first} onMeasure={repaint} />
        </div>
      </div>

      <div className="flex flex-col gap-[18vh] px-[4vw] pb-[12vh] pt-[10vh] motion-safe:lg:hidden">
        {STEPS.map((step) => (
          <motion.article
            key={step.n}
            data-rise
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className="t-label">Step {step.n}</p>
            <h3 className="mt-3 font-display text-paper" style={STEP_HEADING}>
              {step.heading}
            </h3>
            <p className="t-lead mt-5 max-w-[30rem]">{step.text}</p>
            <div className="mt-9">
              <PayslipCard first={first} step={step.n} />
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
