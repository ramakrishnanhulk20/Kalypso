"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ShownError } from "@/components/app/errors";

type Translator = ReturnType<typeof useTranslations<never>>;

/**
 * The sentence a screen shows for an error. In English it is the lib's own sentence, which can be
 * more specific than the code (core names the line, say). In every other language the sentence is
 * looked up by the error's code and family, never by matching its English text; a code without a
 * translation shows the one plain fallback, so no English ever leaks through.
 */
export function errorMessage(error: ShownError, t: Translator, locale: string): string {
  if (locale === "en") return error.message;
  if (error.key !== undefined && t.has(error.key)) return t(error.key, error.values);
  if (error.family !== undefined && error.code !== undefined) {
    const key = `errors.${error.family}.${error.code}`;
    if (t.has(key)) return t(key, { ...error.values, checkFirst: t("errors.sponsor.checkFirst") });
  }
  return t("errors.unknown");
}

/** errorMessage bound to the page's locale and messages. */
export function useErrorText(): (error: ShownError) => string {
  const t = useTranslations();
  const locale = useLocale();
  return useCallback((error: ShownError) => errorMessage(error, t, locale), [t, locale]);
}
