"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";

const noop = () => () => undefined;

function SunIcon() {
  return (
    <svg className="theme-icon-sun" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="3.4" />
      <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="theme-icon-moon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.2 11.1A6.5 6.5 0 0 1 6.9 2.8a6.5 6.5 0 1 0 8.3 8.3Z" />
    </svg>
  );
}

// One button flips light and dark. The icon is picked by CSS from the html class, so the right one
// shows before any script runs; the label waits for the first render in the browser, because the
// server cannot know which theme the visitor has.
export function ThemeToggle({ className = "" }: { className?: string }) {
  const t = useTranslations("theme");
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const dark = mounted ? resolvedTheme === "dark" : null;
  const label = dark === null ? t("switch") : dark ? t("toLight") : t("toDark");

  return (
    <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={() => setTheme(dark ? "light" : "dark")}>
      <SunIcon />
      <MoonIcon />
    </button>
  );
}
