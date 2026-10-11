"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { NightSea } from "@/components/night-sea";
import type { SeaUniforms } from "@/components/night-sea";
import { SiteNav } from "@/components/site-nav/site-nav";
import { getLenis, scrollToLens } from "@/lib/lenis-instance";

gsap.registerPlugin(ScrollTrigger);

// Lenis runs only when motion is allowed, so with it the jump glides on the page's own scroll.
// Without it the browser scrolls: smoothly, or at once for a reader who asked for less motion.
function seeItWork(event: MouseEvent<HTMLAnchorElement>) {
  if (getLenis()) {
    scrollToLens(event);
    return;
  }
  const lens = document.getElementById("lens");
  if (!lens) return;
  event.preventDefault();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  lens.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth", block: "start" });
}

// Entrance targets start invisible in the markup, so the server HTML never
// flashes before the timeline takes over.
const HIDDEN: CSSProperties = { opacity: 0 };

// The poster title is the brand, so it stays KALYPSO in every language.
const TITLE = "KALYPSO";

const EXPO_OUT = "expo.out";

export function PosterHero() {
  const t = useTranslations("landing.hero");
  const sectionRef = useRef<HTMLElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const eyebrowRef = useRef<HTMLParagraphElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const usdcRef = useRef<HTMLParagraphElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const seeRef = useRef<HTMLAnchorElement>(null);
  const testRef = useRef<HTMLParagraphElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const uniforms = useRef<SeaUniforms>({ fade: 0, rise: 0, scroll: 0 });

  const credits = [t("credit1"), t("credit2"), t("credit3"), t("credit4")];

  useEffect(() => {
    const section = sectionRef.current;
    const letters = titleRef.current?.querySelectorAll("[data-letter]");
    if (!section || !letters) return;

    const copyLines = [eyebrowRef.current, headlineRef.current, leadRef.current, usdcRef.current];
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const context = gsap.context(() => {
      if (reduceMotion) {
        uniforms.current = { fade: 1, rise: 1, scroll: 0 };
        gsap.set(
          [
            navRef.current,
            ...letters,
            ...copyLines,
            buttonsRef.current,
            seeRef.current,
            testRef.current,
            scrimRef.current,
            creditsRef.current,
            cueRef.current,
          ],
          { opacity: 1, y: 0, filter: "none" },
        );
        return;
      }

      uniforms.current = { fade: 0, rise: 0, scroll: 0 };
      gsap.set(letters, { y: 60, filter: "blur(8px)" });
      gsap.set([...copyLines, buttonsRef.current], { y: 24 });

      gsap
        .timeline()
        .to(uniforms.current, { fade: 1, duration: 1.6, ease: "power2.out" }, 0)
        .to(uniforms.current, { rise: 1, duration: 2.4, ease: EXPO_OUT }, 0.2)
        .to(navRef.current, { opacity: 1, duration: 0.8 }, 0.3)
        .to(
          letters,
          {
            y: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 1.1,
            ease: EXPO_OUT,
            stagger: 0.06,
            clearProps: "filter",
          },
          0.5,
        )
        .to(scrimRef.current, { opacity: 1, duration: 0.9, ease: EXPO_OUT }, 1.0)
        .to(
          copyLines,
          { y: 0, opacity: 1, duration: 0.9, ease: EXPO_OUT, stagger: 0.08 },
          1.0,
        )
        .to(
          buttonsRef.current,
          { y: 0, opacity: 1, duration: 0.9, ease: EXPO_OUT },
          1.25,
        )
        .to([seeRef.current, testRef.current], { opacity: 1, duration: 0.9, ease: EXPO_OUT }, 1.33)
        .to([creditsRef.current, cueRef.current], { opacity: 1, duration: 0.8 }, 1.5);

      gsap
        .timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: section,
            start: "top top",
            end: "bottom top",
            scrub: 0.6,
            invalidateOnRefresh: true,
            onUpdate: (self) => {
              uniforms.current.scroll = self.progress;
            },
          },
        })
        .to(canvasWrapRef.current, { yPercent: 30 }, 0)
        .to(
          titleRef.current,
          { y: () => -window.innerHeight * 0.12, opacity: 0.2 },
          0,
        )
        .to(copyRef.current, { opacity: 0, y: -40, duration: 0.5 }, 0);
    }, section);

    return () => context.revert();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative grid min-h-[100svh] grid-rows-[auto_1fr_auto_auto] overflow-hidden bg-canvas"
    >
      <div ref={canvasWrapRef} className="absolute inset-0">
        {/* SWAP: hero scene. Replace with a film still or loop when Ram provides one; keep the scrim and grain. */}
        <NightSea uniforms={uniforms} />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to top, var(--color-canvas) 0%, color-mix(in srgb, var(--color-canvas) 85%, transparent) 18%, transparent 52%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, color-mix(in srgb, var(--color-canvas) 70%, transparent) 0%, transparent 28%)",
        }}
      />

      {/* The bar floats over the hero, so this empty row keeps the copy where it sat below the old nav. */}
      <SiteNav overHero hiddenAtStart headerRef={navRef} />
      <div aria-hidden="true" className="h-[72px]" />

      <div
        ref={copyRef}
        className="relative z-10 self-start px-[4vw] pt-[9svh]"
      >
        <div className="relative max-w-[34rem]">
          {/* On a phone the copy sits over the sun, so it gets a soft backing there; wider screens put the sun beside it. */}
          <div
            ref={scrimRef}
            aria-hidden="true"
            data-hero-scrim
            className="pointer-events-none absolute -inset-x-6 -inset-y-5 -z-10 md:hidden"
            style={{ ...HIDDEN, background: "color-mix(in srgb, var(--color-canvas) 70%, transparent)", filter: "blur(24px)" }}
          />
          <p ref={eyebrowRef} className="t-label" style={HIDDEN}>
            {t("eyebrow")}
          </p>
          <h1
            ref={headlineRef}
            className="mt-[18px] max-w-[16ch] font-display font-normal text-fg [overflow-wrap:anywhere]"
            style={{
              ...HIDDEN,
              fontSize: "clamp(2rem, min(3.6vw, 6.2svh), 3.25rem)",
              fontVariationSettings: '"opsz" 72, "SOFT" 30',
              letterSpacing: "-0.02em",
              lineHeight: 1.08,
            }}
          >
            {t("title")}
          </h1>
          <p
            ref={leadRef}
            className="t-lead mt-[18px] max-md:text-[1.0625rem]!"
            style={HIDDEN}
          >
            {t("lead")}
          </p>
          <p
            ref={usdcRef}
            className="mt-3 font-sans text-[0.9375rem] text-muted"
            style={HIDDEN}
          >
            {t("usdc")}
          </p>
          <div
            ref={buttonsRef}
            className="mt-[30px] flex flex-col gap-3 md:flex-row md:flex-wrap"
            style={HIDDEN}
          >
            <Link href="/employer" className="btn-seal">
              {t("ctaPay")}
            </Link>
            <a ref={seeRef} href="#lens" onClick={seeItWork} className="btn-ghost" style={HIDDEN}>
              {t("ctaSee")}
            </a>
          </div>
          <p ref={testRef} className="mt-4 font-sans text-[0.875rem] text-muted" style={HIDDEN}>
            {t("testNote")}
          </p>
        </div>
      </div>

      <p
        ref={titleRef}
        aria-hidden="true"
        className="t-poster relative z-[5] whitespace-nowrap px-[4vw] text-fg md:pl-[3.2vw] md:pr-[3vw]"
        style={{
          fontSize: "min(17vw, 24svh)",
          textShadow: "var(--shadow-title)",
        }}
      >
        {TITLE.split("").map((letter, index) => (
          <span
            key={index}
            data-letter
            className="inline-block"
            style={HIDDEN}
          >
            {letter}
          </span>
        ))}
      </p>

      <div
        ref={creditsRef}
        className="relative z-10 px-[4vw] pb-[4.2svh] max-md:pt-[14px]"
        style={HIDDEN}
      >
        <div className="t-label grid grid-cols-2 gap-x-3 gap-y-2 text-muted max-md:text-[0.6875rem]! max-md:tracking-[0.12em]! md:flex md:flex-wrap md:items-center md:gap-x-[22px] md:gap-y-[10px]">
          {credits.map((credit, index) => (
            <span key={credit} className="flex items-center gap-[22px]">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className="inline-block h-[3px] w-[3px] rounded-full bg-seal max-md:hidden"
                />
              ) : null}
              {credit}
            </span>
          ))}
        </div>
      </div>

      <div
        ref={cueRef}
        aria-hidden="true"
        className="absolute bottom-[4.2svh] right-[4vw] z-10 hidden flex-col items-center gap-2 md:flex"
        style={HIDDEN}
      >
        <span className="t-label">{t("scroll")}</span>
        <span
          className="relative block h-[44px] w-px overflow-hidden"
          style={{ background: "color-mix(in srgb, var(--color-fg) 25%, transparent)" }}
        >
          <span className="scroll-cue-segment absolute left-0 top-0 block h-[14px] w-px bg-fg" />
        </span>
      </div>
    </section>
  );
}
