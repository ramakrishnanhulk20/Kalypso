"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { HTML_LANG, LOCALES, LOCALE_COOKIE, LOCALE_NAMES } from "@/lib/i18n/locales";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// A native select, each language named in itself. Choosing one writes the cookie the request
// config reads and refreshes the page in place: the URL never changes, and client state stays,
// so a sandbox run or a payroll run in progress carries on in the new language.
export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("locale");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const change = (next: string) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
    startTransition(() => router.refresh());
  };

  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{t("label")}</span>
      <select className="locale-select" value={locale} aria-busy={pending} onChange={(event) => change(event.target.value)}>
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={HTML_LANG[code]}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
      <svg
        width="10"
        height="10"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted"
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" />
      </svg>
    </label>
  );
}
