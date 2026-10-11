"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { SealMark } from "@/components/seal-mark";

const HOLDERS: { id: "employer" | "worker" | "accountant"; href: string; markStyle?: CSSProperties }[] = [
  { id: "employer", href: "/employer" },
  { id: "worker", href: "/worker", markStyle: { filter: "hue-rotate(0)", opacity: 0.85 } },
  { id: "accountant", href: "/accountant" },
];

export function ThreeKeys() {
  const t = useTranslations("landing.threeKeys");
  return (
    <section className="relative bg-canvas" style={{ padding: "18vh 4vw" }}>
      <div className="grid grid-cols-1 lg:grid-cols-12 lg:gap-x-[4vw]">
        <div className="lg:sticky lg:top-[16vh] lg:col-span-5 lg:self-start">
          <p className="t-label">{t("eyebrow")}</p>
          <h2 className="t-h2 mt-4">{t("title")}</h2>
          <p className="t-lead mt-[22px]">{t("lead")}</p>
        </div>

        <div className="mt-[10vh] lg:col-span-7 lg:mt-0">
          {HOLDERS.map((holder, index) => (
            <motion.div
              key={holder.id}
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
                  className="font-display text-fg"
                  style={{
                    fontSize: "clamp(2rem, 3.4vw, 3rem)",
                    fontWeight: 500,
                    fontVariationSettings: '"opsz" 96',
                    letterSpacing: "-0.02em",
                    lineHeight: 1.08,
                  }}
                >
                  {t(`${holder.id}Name`)}
                </h3>
                <p className="t-label mt-3">{t(`${holder.id}Note`)}</p>
                <p className="t-lead mt-5">{t(`${holder.id}Text`)}</p>
                <div className="mt-6">
                  <Link href={holder.href} className="link-draw group text-[0.9375rem]">
                    {t(`${holder.id}Cta`)}
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
