"use client";

import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

// Old and new sentence sit in one grid cell, so the crossfade never moves the page. Two lines of
// room keeps the rows below from jumping as the engine's sentences change between one line and two.
export function LiveLine({ text }: { text: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <div
      aria-live="polite"
      className="grid max-w-[22ch] font-display font-medium text-paper"
      style={{
        fontSize: "clamp(1.75rem, 3.2vw, 2.75rem)",
        fontVariationSettings: '"opsz" 72',
        lineHeight: 1.1,
        letterSpacing: "-0.02em",
        minHeight: "2.2em",
      }}
    >
      <AnimatePresence initial={false}>
        <motion.p
          key={text}
          className="col-start-1 row-start-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.35 }}
        >
          {text}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
