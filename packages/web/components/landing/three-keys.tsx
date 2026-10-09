"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { SealMark } from "@/components/seal-mark";

const KEY_HOLDERS: {
  name: string;
  note: string;
  text: string;
  cta: string;
  href: string;
  markStyle?: CSSProperties;
}[] = [
  {
    name: "The employer",
    note: "Pays the team",
    text: "Uploads a spreadsheet, approves the run once, and pays everyone in USDC from a treasury that only their own signature can move. Kalypso pays at most once per worker per run, enforced by the contract.",
    cta: "Open the employer console",
    href: "/employer",
  },
  {
    name: "The worker",
    note: "Reads their own pay",
    text: "Joins with an invite, holds a key only they control, and reads their own payslips. Nobody else on the payroll, and nobody on the internet, can see what they earn.",
    cta: "Open your pay",
    href: "/worker",
    markStyle: { filter: "hue-rotate(0)", opacity: 0.85 },
  },
  {
    name: "The accountant",
    note: "Reads the company's books",
    text: "Registers their own key and gives the company its id. That key opens every amount the company paid and nothing a worker received from anyone else.",
    cta: "Open the books",
    href: "/accountant",
  },
];

export function ThreeKeys() {
  return (
    <section className="relative bg-ink" style={{ padding: "18vh 4vw" }}>
      <div className="grid grid-cols-1 lg:grid-cols-12 lg:gap-x-[4vw]">
        <div className="lg:sticky lg:top-[16vh] lg:col-span-5 lg:self-start">
          <p className="t-label">Who sees what</p>
          <h2 className="t-h2 mt-4">Three people. Three keys.</h2>
          <p className="t-lead mt-[22px]">
            Each key opens exactly what its holder should see, and the chain
            enforces it, not a server.
          </p>
        </div>

        <div className="mt-[10vh] lg:col-span-7 lg:mt-0">
          {KEY_HOLDERS.map((holder, index) => (
            <motion.div
              key={holder.name}
              data-rise
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className={`flex gap-6 py-[7vh] ${index === 0 ? "" : "border-t border-line"}`}
            >
              <div className="shrink-0 pt-2" style={holder.markStyle}>
                <SealMark size={40} />
              </div>
              <div className="min-w-0">
                <h3
                  className="font-display text-paper"
                  style={{
                    fontSize: "clamp(2rem, 3.4vw, 3rem)",
                    fontWeight: 500,
                    fontVariationSettings: '"opsz" 96',
                    letterSpacing: "-0.02em",
                    lineHeight: 1.08,
                  }}
                >
                  {holder.name}
                </h3>
                <p className="t-label mt-3">{holder.note}</p>
                <p className="t-lead mt-5">{holder.text}</p>
                <div className="mt-6">
                  <Link href={holder.href} className="link-draw group text-[0.9375rem]">
                    {holder.cta}
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
                  </Link>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
