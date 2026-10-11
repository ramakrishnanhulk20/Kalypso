import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { DEFAULT_LOCALE, LOCALES } from "./i18n/locales";

// Translated pages sit beside the English ones as page.es.mdx (the dot parser); a page with no
// translation falls back to English. URLs never carry the locale: the cookie decides, like
// everywhere else on the site. The search route reads this same loader, so its index is per locale.
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  i18n: { languages: [...LOCALES], defaultLanguage: DEFAULT_LOCALE, parser: "dot", hideLocale: "always" },
});
