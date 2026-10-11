import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import type { PlainT } from "./types";

/**
 * English text outside React, for tests of the pure functions that take a translator. The screens
 * pass useTranslations() instead, so the English file never ships to the browser twice.
 */
export function englishT(namespace: string): PlainT {
  const t = createTranslator({ locale: "en", messages: en, namespace: namespace as never });
  return (key, values) => t(key as never, values as never);
}
