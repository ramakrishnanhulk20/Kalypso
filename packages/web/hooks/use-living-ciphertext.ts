"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

const HEX_DIGITS = "0123456789abcdef";
const TICK_MS = 140;
const SWAP_MS = 140;

function otherDigit(current: string | undefined) {
  let next = current;
  while (next === current) {
    next = HEX_DIGITS[Math.floor(Math.random() * HEX_DIGITS.length)];
  }
  return next ?? "0";
}

// Every tick, one hex digit in each of two visible sealed cells changes for a
// moment and then returns. It writes text straight into the cells, so React
// never re-renders for it.
export function useLivingCiphertext(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;

    const timers = new Set<number>();

    const tick = () => {
      const visible = Array.from(
        root.querySelectorAll<HTMLElement>("[data-flicker]"),
      ).filter((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      });

      for (let n = 0; n < 2 && visible.length > 0; n += 1) {
        const [cell] = visible.splice(
          Math.floor(Math.random() * visible.length),
          1,
        );
        const original = cell?.dataset.flicker;
        if (!cell || !original) continue;

        // The last character is the ellipsis, which never changes.
        const at = Math.floor(Math.random() * (original.length - 1));
        cell.textContent =
          original.slice(0, at) + otherDigit(original[at]) + original.slice(at + 1);

        const timer = window.setTimeout(() => {
          timers.delete(timer);
          cell.textContent = original;
        }, SWAP_MS);
        timers.add(timer);
      }
    };

    const interval = window.setInterval(tick, TICK_MS);

    return () => {
      window.clearInterval(interval);
      timers.forEach((timer) => window.clearTimeout(timer));
      root.querySelectorAll<HTMLElement>("[data-flicker]").forEach((cell) => {
        const original = cell.dataset.flicker;
        if (original && cell.textContent !== original) {
          cell.textContent = original;
        }
      });
    };
  }, [rootRef, active]);
}
