"use client";

import { useSyncExternalStore } from "react";

export type ThemeClass = "light" | "dark";

function readThemeClass(): ThemeClass | null {
  const classes = document.documentElement.classList;
  return classes.contains("dark") ? "dark" : classes.contains("light") ? "light" : null;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

// The class on <html> is what the colour tokens follow, and next-themes writes it in the
// provider's own effect, which React runs after every child's effect. So anything that paints
// from the tokens keys on the class itself, not on the provider's state, or it reads the old theme.
export function useThemeClass(): ThemeClass | null {
  return useSyncExternalStore(subscribe, readThemeClass, () => null);
}
