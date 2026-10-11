// Test-only: renders a component tree to markup inside the English message provider, the way a
// page renders it, so a test can read what a component with useTranslations says.
import { createElement } from "react";
import type { ReactNode } from "react";
// The project does not install react-dom's type package; the tests only need the markup string.
// @ts-expect-error TS7016
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";

export function renderEnglish(node: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: node }));
}

/** The text of rendered markup with the tags stripped and entities read back. */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Every title attribute in the markup. */
export function titlesOf(markup: string): string[] {
  return [...markup.matchAll(/title="([^"]*)"/g)].map((m) => (m[1] ?? "").replace(/&#x27;/g, "'"));
}
