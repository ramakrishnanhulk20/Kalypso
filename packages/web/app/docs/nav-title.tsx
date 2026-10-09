"use client";

import { SealMark } from "@/components/seal-mark";

// A client component so each place the docs layout shows the title (phone
// header, sidebar) gets its own seal gradient id. Rendered once on the server
// and reused, the copies would share an id and the hidden one would win.
export function NavTitle() {
  return (
    <span className="logo-link inline-flex items-center gap-2.5">
      <SealMark size={22} />
      <span
        className="font-display text-[1.125rem] font-medium text-paper"
        style={{ fontVariationSettings: '"opsz" 36', letterSpacing: "-0.01em" }}
      >
        Kalypso
      </span>
    </span>
  );
}
