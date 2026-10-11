export const LOCALES = ["en", "es", "pt", "fr", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** What <html lang> says for each locale. */
export const HTML_LANG: Record<Locale, string> = { en: "en", es: "es", pt: "pt-BR", fr: "fr", zh: "zh-CN" };

/** Each language named in itself, for the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", es: "Español", pt: "Português", fr: "Français", zh: "中文" };

/**
 * The tag Intl formats numbers and dates with. Latin digits everywhere, because a figure a wallet
 * shows must read the same on every device. Spanish follows Chile's conventions (a comma for the
 * decimals, a dot between thousands), which the rest of Latin America also reads without trouble.
 */
export const INTL_TAG: Record<Locale, string> = {
  en: "en-US-u-nu-latn",
  es: "es-CL-u-nu-latn",
  pt: "pt-BR-u-nu-latn",
  fr: "fr-FR-u-nu-latn",
  zh: "zh-CN-u-nu-latn",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The first of our locales a language tag belongs to: es-419 and es-CL are Spanish, pt-PT is Portuguese, zh-Hant is Chinese. */
function localeOfTag(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split("-")[0] ?? "";
  return isLocale(primary) ? primary : null;
}

/**
 * The locale for a request: the cookie when it names one of ours, otherwise the best match in the
 * Accept-Language header by its q weights, otherwise English.
 */
export function negotiateLocale(cookie: string | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookie)) return cookie;
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag, q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.tag.trim() !== "" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of ranked) {
    const locale = localeOfTag(entry.tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}
