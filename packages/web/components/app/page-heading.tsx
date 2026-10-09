"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import gsap from "gsap";

type PageHeadingProps = {
  eyebrow: ReactNode;
  title: ReactNode;
  /** The third line. Leave it out for a heading with only an eyebrow and a title. */
  lead?: ReactNode;
  /** h1 for a page, h2 for a panel. */
  as?: "h1" | "h2";
  titleId?: string;
  titleClassName?: string;
  titleStyle?: CSSProperties;
  leadClassName?: string;
  className?: string;
};

const HIDDEN: CSSProperties = { opacity: 0 };

// The house entrance for a heading: the eyebrow, the title and the lead fade and rise 24px, 0.9s,
// ease expo.out, 0.08s apart. A heading mounts again on each state change of its page, so it plays
// again then. The rule in globals.css shows the end state at once under reduced motion.
export function PageHeading({
  eyebrow,
  title,
  lead,
  as: Title = "h1",
  titleId,
  titleClassName = "t-h2 mt-4",
  titleStyle,
  leadClassName = "t-lead mt-[22px]",
  className,
}: PageHeadingProps) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = root.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.fromTo(
        node.querySelectorAll("[data-rise]"),
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.9, ease: "expo.out", stagger: 0.08, clearProps: "transform" },
      );
    }, node);
    return () => context.revert();
  }, []);

  return (
    <div ref={root} className={className}>
      <p data-rise className="t-label" style={HIDDEN}>
        {eyebrow}
      </p>
      <Title id={titleId} data-rise className={titleClassName} style={{ ...HIDDEN, ...titleStyle }}>
        {title}
      </Title>
      {lead === undefined ? null : typeof lead === "string" ? (
        <p data-rise className={leadClassName} style={HIDDEN}>
          {lead}
        </p>
      ) : (
        <div data-rise className={leadClassName} style={HIDDEN}>
          {lead}
        </div>
      )}
    </div>
  );
}
