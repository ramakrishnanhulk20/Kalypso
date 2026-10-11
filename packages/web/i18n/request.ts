import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, negotiateLocale } from "@/lib/i18n/locales";

// No locale in the URL anywhere: the cookie decides, and a visitor with no cookie gets the best
// match for their browser's languages. Every page already renders per request (app/layout.tsx).
export default getRequestConfig(async () => {
  const [store, requestHeaders] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(store.get(LOCALE_COOKIE)?.value, requestHeaders.get("accept-language"));
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: "UTC",
  };
});
