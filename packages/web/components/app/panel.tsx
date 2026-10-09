"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import { PageHeading } from "./page-heading";

const DISPLAY_48 = { fontVariationSettings: '"opsz" 48' } as const;

// One section of a console page: an eyebrow and a heading on the left, the work on the right.
// Below 1024px it is one column.
export function Panel({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-line py-[6vh]">
      <div className="grid grid-cols-1 gap-y-8 lg:grid-cols-12 lg:gap-x-[4vw]">
        <PageHeading
          as="h2"
          titleId={id}
          eyebrow={eyebrow}
          title={title}
          titleClassName="mt-3 font-display text-[1.75rem] font-medium leading-[1.15] text-paper"
          titleStyle={DISPLAY_48}
          className="lg:col-span-4"
        />
        <div className="min-w-0 lg:col-span-8">{children}</div>
      </div>
    </section>
  );
}

// A labelled block inside a panel.
export function Block({ label, children, className = "" }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label ? <p className="t-label mb-3">{label}</p> : null}
      {children}
    </div>
  );
}
