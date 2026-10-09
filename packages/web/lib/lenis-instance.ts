import type Lenis from "lenis";

// SmoothScroll owns the Lenis instance. Anything that needs to scroll the page
// by hand reads it from here, and gets null when Lenis is not running.
let current: Lenis | null = null;

export function setLenis(next: Lenis | null) {
  current = next;
}

export function getLenis() {
  return current;
}

// With Lenis running the jump is smooth. Without it (reduced motion) the
// browser's own anchor jump does the work.
export function scrollToLens(event: { preventDefault: () => void }) {
  const lenis = getLenis();
  if (!lenis) return;
  event.preventDefault();
  lenis.scrollTo("#lens", { offset: 0, duration: 1.4 });
}
