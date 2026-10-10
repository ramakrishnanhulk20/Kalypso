"use client";

import { useSyncExternalStore } from "react";

// Tailwind's md breakpoint, the width where the ledger gets its Run and Payment columns.
const QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True from the md breakpoint up. The server and the first paint assume a desktop width. */
export function useWideScreen() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
