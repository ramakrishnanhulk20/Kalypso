"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

// The engine can write several sentences a second during the workers step. Each one stays on
// screen at least this long, and the newest waiting one takes over when the hold ends, so the
// line is always readable and never two sentences drawn over each other.
const HOLD_MS = 900;

// Old and new sentence sit in one grid cell, so the crossfade never moves the page. Two lines of
// room keeps the rows below from jumping as the engine's sentences change between one line and two.
export function LiveLine({ text }: { text: string }) {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  const timer = useRef(0);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const wait = Math.max(0, shownAt.current + HOLD_MS - Date.now());
    const show = () => {
      shownAt.current = Date.now();
      setShown(text);
    };
    if (wait === 0 || reduceMotion) show();
    else timer.current = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer.current);
  }, [text, reduceMotion]);

  return (
    <div
      className="grid max-w-[22ch] font-display font-medium text-fg"
      style={{
        fontSize: "clamp(1.75rem, 3.2vw, 2.75rem)",
        fontVariationSettings: '"opsz" 72',
        lineHeight: 1.1,
        letterSpacing: "-0.02em",
        minHeight: "2.2em",
      }}
    >
      {/* Screen readers get one plain sentence at a time; the animated copy is only for the eye. */}
      <p aria-live="polite" className="sr-only">
        {shown}
      </p>
      <AnimatePresence initial={false} mode="wait">
        <motion.p
          key={shown}
          aria-hidden="true"
          className="col-start-1 row-start-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
        >
          {shown}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
