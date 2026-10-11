import type { ReactNode } from "react";

// Every item icon is a line drawing on a 24 grid: stroke 1.5, round caps, no fill, the colour of
// the surrounding text. Each is named for the idea it stands for, not for the page it sits on.
export type NavIconName =
  | "wax-seal-check"
  | "building"
  | "coins"
  | "flask"
  | "book"
  | "face"
  | "link"
  | "bank"
  | "fingerprint"
  | "eye"
  | "open-ledger"
  | "key"
  | "file-with-arrow"
  | "lens"
  | "shield";

const DRAWINGS: Record<NavIconName, ReactNode> = {
  "wax-seal-check": (
    <>
      <path d="M20 12A3.4 3.4 0 0 1 17.66 17.66A3.4 3.4 0 0 1 12 20A3.4 3.4 0 0 1 6.34 17.66A3.4 3.4 0 0 1 4 12A3.4 3.4 0 0 1 6.34 6.34A3.4 3.4 0 0 1 12 4A3.4 3.4 0 0 1 17.66 6.34A3.4 3.4 0 0 1 20 12Z" />
      <path d="M8.6 12.3 11 14.7l4.5-5" />
    </>
  ),
  building: (
    <>
      <path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h7A1.5 1.5 0 0 1 15 4.5V21" />
      <path d="M15 9.5h3.5A1.5 1.5 0 0 1 20 11v10" />
      <path d="M3 21h18" />
      <path d="M8.5 7h3M8.5 11h3M8.5 15h3" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
      <path d="M5 6.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5" />
      <path d="M5 11.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3h5" />
      <path d="M10.5 3v6L5 18.5A2 2 0 0 0 6.7 21.5h10.6A2 2 0 0 0 19 18.5L13.5 9V3" />
      <path d="M7.6 15h8.8" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5C10.3 5.2 8 4.7 4.5 4.7v13c3.5 0 5.8.5 7.5 1.8 1.7-1.3 4-1.8 7.5-1.8v-13C16 4.7 13.7 5.2 12 6.5Z" />
      <path d="M12 6.5v13" />
    </>
  ),
  face: (
    <>
      <path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8" />
      <path d="M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8" />
      <path d="M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16" />
      <path d="M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16" />
      <path d="M9 9.5v1.5M15 9.5v1.5" />
      <path d="M12 9.5v3.2h-1" />
      <path d="M9 15.2c.9 1 1.9 1.5 3 1.5s2.1-.5 3-1.5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </>
  ),
  bank: (
    <>
      <path d="M3.5 9.5 12 4l8.5 5.5Z" />
      <path d="M6.5 12.5v5M10 12.5v5M14 12.5v5M17.5 12.5v5" />
      <path d="M4 20h16" />
    </>
  ),
  fingerprint: (
    <>
      <path d="M4.5 9A8.5 8.5 0 0 1 12 3.5a8.5 8.5 0 0 1 7.5 5.5" />
      <path d="M6 12.5V11a6 6 0 0 1 12 0v1" />
      <path d="M9 18.5c.7-1.5 1-3.3 1-5.5V11a2 2 0 0 1 4 0v2c0 2.2.5 4 1.3 5.5" />
      <path d="M12 13c0 2.6-.5 5-1.6 7" />
      <path d="M6 15.5c-.2 1.3-.6 2.5-1.2 3.5" />
      <path d="M18 14.5c.2 1.6.6 3 1.3 4.2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "open-ledger": (
    <>
      <path d="M3.5 5.5h8.5v14H3.5ZM12 5.5h8.5v14H12Z" />
      <path d="M6 9.5h4M6 12.5h4M6 15.5h4M14.5 9.5h4M14.5 12.5h4M14.5 15.5h4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="4" />
      <path d="M10.9 12.6 20 3.5" />
      <path d="M17 6.5 19.5 9M14.5 9l2 2" />
    </>
  ),
  "file-with-arrow": (
    <>
      <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7Z" />
      <path d="M14 3v4h4" />
      <path d="M12 11v6M9.5 14.8l2.5 2.5 2.5-2.5" />
    </>
  ),
  lens: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.3 15.3 21 21" />
      <path d="M8 9.2a3 3 0 0 1 2.5-2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
};

export function NavIcon({ name, size }: { name: NavIconName; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="site-nav-icon"
    >
      {DRAWINGS[name]}
    </svg>
  );
}

// The small marks the bar and the cards draw. Each viewBox matches its pixel size, so a stroke of
// 1.5 is 1.5 pixels on screen.
const SMALL = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: "false",
} as const;

export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={className} {...SMALL}>
      <path d="M1.5 3.5 5 7l3.5-3.5" />
    </svg>
  );
}

export function SealPlusIcon({ className }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={className} style={{ color: "var(--color-seal)" }} {...SMALL}>
      <path d="M5 1v8M1 5h8" />
    </svg>
  );
}

export function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={className} {...SMALL}>
      <path d="M2 7h10M8 3l4 4-4 4" />
    </svg>
  );
}

export function MenuLinesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...SMALL}>
      <path d="M3 6h12M3 12h12" />
    </svg>
  );
}

// A plus whose upright stroke shrinks away, leaving a drawn minus. Nothing here is a dash character.
export function PlusMinusIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" data-open={open} className="site-nav-plusminus" {...SMALL}>
      <path d="M3 9h12" />
      <path d="M9 3v12" className="site-nav-plusminus-stem" />
    </svg>
  );
}
