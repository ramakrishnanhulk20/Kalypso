"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { NightSea } from "@/components/night-sea";
import type { SeaUniforms } from "@/components/night-sea";
import { SealMark } from "@/components/seal-mark";
import { scrollToLens } from "@/lib/lenis-instance";
import { ATTACK_RUN_URL, REPO_URL } from "@/lib/links";

gsap.registerPlugin(ScrollTrigger);

// Entrance targets start invisible in the markup, so the server HTML never
// flashes before the timeline takes over.
const HIDDEN: CSSProperties = { opacity: 0 };

const TITLE = "KALYPSO";
const CREDITS = [
  "Confidential USDC",
  "Zero-knowledge proofs",
  "Stellar testnet",
  "Open source, MIT",
];

const EXPO_OUT = "expo.out";

export function PosterHero() {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const eyebrowRef = useRef<HTMLParagraphElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const uniforms = useRef<SeaUniforms>({ fade: 0, rise: 0, scroll: 0 });

  useEffect(() => {
    const section = sectionRef.current;
    const letters = titleRef.current?.querySelectorAll("[data-letter]");
    if (!section || !letters) return;

    const copyLines = [eyebrowRef.current, headlineRef.current, leadRef.current];
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
      className="relative grid min-h-[100svh] grid-rows-[auto_1fr_auto_auto] overflow-hidden bg-ink"
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
            "linear-gradient(to top, #15100f 0%, rgba(21,16,15,0.85) 18%, rgba(21,16,15,0) 52%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, rgba(21,16,15,0.7) 0%, rgba(21,16,15,0) 28%)",
        }}
      />

      <nav
        ref={navRef}
        aria-label="Primary"
        className="relative z-10 flex items-center justify-between px-[4vw] py-7"
        style={HIDDEN}
      >
        <Link
          href="/"
          aria-label="Kalypso home"
          className="logo-link flex items-center gap-[10px]"
        >
          <SealMark size={28} />
          <span
            className="font-display text-[1.375rem] font-medium text-paper"
            style={{
              fontVariationSettings: '"opsz" 36',
              letterSpacing: "-0.01em",
            }}
          >
            Kalypso
          </span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          <a href="#lens" onClick={scrollToLens} className="link-draw text-[0.9375rem]">
            Try it
          </a>
          <Link href="/demo" className="link-draw text-[0.9375rem]">
            Sandbox
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener"
            className="link-draw text-[0.9375rem]"
          >
            Source
          </a>
          <a
            href={ATTACK_RUN_URL}
            target="_blank"
            rel="noopener"
            className="btn-ghost"
            style={{ padding: "0.5rem 0.9rem", fontSize: "0.875rem" }}
          >
            Read the attack run
          </a>
        </div>

        <a
          href="#lens"
          onClick={scrollToLens}
          className="btn-seal md:hidden"
          style={{ padding: "0.5rem 0.9rem", fontSize: "0.875rem" }}
        >
          Try it
        </a>
      </nav>

      <div
        ref={copyRef}
        className="relative z-10 self-start px-[4vw] pt-[9svh]"
      >
        <div className="max-w-[34rem]">
          <p ref={eyebrowRef} className="t-label" style={HIDDEN}>
            Private payroll on Stellar
          </p>
          <h1
            ref={headlineRef}
            className="mt-[18px] max-w-[16ch] font-display font-normal text-paper"
            style={{
              ...HIDDEN,
              fontSize: "clamp(2rem, min(3.6vw, 6.2svh), 3.25rem)",
              fontVariationSettings: '"opsz" 72, "SOFT" 30',
              letterSpacing: "-0.02em",
              lineHeight: 1.08,
            }}
          >
            Pay your team in USDC. Nobody else can read the salaries.
          </h1>
          <p
            ref={leadRef}
            className="t-lead mt-[18px] max-md:text-[1.0625rem]!"
            style={HIDDEN}
          >
            Every payment is public proof that it happened. The amount is sealed,
            and only each worker and your accountant hold a key that opens it.
          </p>
          <div
            ref={buttonsRef}
            className="mt-[30px] flex flex-wrap gap-3"
            style={HIDDEN}
          >
            <a href="#lens" onClick={scrollToLens} className="btn-seal">
              Try to read the salaries
            </a>
            <a href={REPO_URL} target="_blank" rel="noopener" className="btn-ghost">
              Read the code
            </a>
          </div>
        </div>
      </div>

      <p
        ref={titleRef}
        aria-hidden="true"
        className="t-poster relative z-[5] whitespace-nowrap px-[4vw] text-paper md:pl-[3.2vw] md:pr-[3vw]"
        style={{
          fontSize: "min(17vw, 24svh)",
          textShadow: "0 2px 40px rgba(0,0,0,0.35)",
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
        className="relative z-10 px-[4vw] pb-[4.2svh]"
        style={HIDDEN}
      >
        <div
          className="t-label grid grid-cols-2 gap-x-3 gap-y-2 max-md:text-[0.6875rem]! max-md:tracking-[0.12em]! md:flex md:flex-wrap md:items-center md:gap-x-[22px] md:gap-y-[10px]"
          style={{ color: "var(--color-muted)" }}
        >
          {CREDITS.map((credit, index) => (
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
        <span className="t-label">Scroll</span>
        <span
          className="relative block h-[44px] w-px overflow-hidden"
          style={{ background: "rgba(242,236,230,0.25)" }}
        >
          <span className="scroll-cue-segment absolute left-0 top-0 block h-[14px] w-px bg-paper" />
        </span>
      </div>
    </section>
  );
}
