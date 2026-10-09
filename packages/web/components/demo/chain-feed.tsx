"use client";

import { useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { shortId } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import type { FeedEntry } from "./run-state";
import { titleOf } from "./shots";

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

function Entry({ entry }: { entry: FeedEntry }) {
  const ref = useRef<HTMLLIElement>(null);
  const reduceMotion = useReducedMotion();

  // Runs once, when the entry first appears: a stamp landing on the page. Without motion it only fades.
  useLayoutEffect(() => {
    const item = ref.current;
    if (!item) return;
    const tween = gsap.fromTo(
      item,
      reduceMotion ? { opacity: 0 } : { scale: 1.06, opacity: 0 },
      { scale: 1, opacity: 1, duration: 0.4, ease: reduceMotion ? "none" : "back.out(1.6)", clearProps: "transform,opacity" },
    );
    return () => {
      tween.kill();
    };
    // Deliberately empty: a later change of the motion setting must not replay an entry that already landed.
  }, []);

  return (
    <li ref={ref} className="border-t border-line py-3">
      <a
        href={`${EXPLORER_URL}/tx/${entry.hash}`}
        target="_blank"
        rel="noopener"
        aria-label={`Open transaction ${shortId(entry.hash)} on Stellar Expert`}
        className="link-draw font-mono text-[0.875rem]"
      >
        {shortId(entry.hash)}
      </a>
      <p className="t-label mt-1" style={PLAIN_CASE}>
        {titleOf(entry.step)}
      </p>
    </li>
  );
}

export function ChainFeed({ entries }: { entries: FeedEntry[] }) {
  return (
    <aside aria-label="On chain">
      <h2 className="t-label">On chain</h2>
      <div data-lenis-prevent className="mt-4 md:max-h-[60vh] md:overflow-auto">
        {entries.length === 0 ? (
          <p className="t-label border-t border-line pt-3">Transactions appear here as they land.</p>
        ) : (
          <ol>
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
