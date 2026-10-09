"use client";

import { useEffect } from "react";
import { getLenis } from "@/lib/lenis-instance";

// Lenis takes over the wheel even above an inner scroll box. The docs have
// several (the sidebar, code blocks, wide tables, the search results), so the
// page lets those scroll themselves while a docs page is open.
export function NestedScroll() {
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    let attached: ReturnType<typeof getLenis> = null;

    // SmoothScroll creates Lenis in its own effect, which runs after this one,
    // so the first few frames may still find nothing.
    const attach = () => {
      attached = getLenis();
      if (attached) {
        attached.options.allowNestedScroll = true;
        return;
      }
      tries += 1;
      if (tries < 120) frame = requestAnimationFrame(attach);
    };
    attach();

    return () => {
      cancelAnimationFrame(frame);
      if (attached) attached.options.allowNestedScroll = false;
    };
  }, []);

  return null;
}
