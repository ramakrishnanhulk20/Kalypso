"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import gsap from "gsap";

const HIDDEN: CSSProperties = { opacity: 0 };

// Plays the house entrance on the given elements: fade and rise 24px, 0.9s, ease expo.out. Under
// reduced motion nothing runs, and the rule in globals.css shows the end state at once.
function useRise(root: RefObject<HTMLElement | null>, select: (node: HTMLElement) => Element[], stagger: number) {
  useEffect(() => {
    const node = root.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.fromTo(select(node), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.9, ease: "expo.out", stagger, clearProps: "transform" });
    }, node);
    return () => context.revert();
    // The selection is fixed by the component that calls this, so it never needs to re-run.
  }, []);
}

/** One block that fades and rises in when it first appears. */
export function Rise({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useRise(ref, (node) => [node], 0);
  return (
    <div ref={ref} id={id} data-rise className={className} style={HIDDEN}>
      {children}
    </div>
  );
}

/** A list whose direct children each carry data-rise and style opacity 0, entering one after another. */
export function RiseList({ children, className, step = 0.06 }: { children: ReactNode; className?: string; step?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useRise(ref, (node) => Array.from(node.querySelectorAll(":scope > [data-rise]")), step);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

export const RISE_HIDDEN = HIDDEN;
