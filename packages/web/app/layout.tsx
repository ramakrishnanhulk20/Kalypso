import type { Metadata, Viewport } from "next";
import { Fraunces } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { ThemeProvider } from "next-themes";
import { Grain } from "@/components/grain";
import { SmoothScroll } from "@/components/smooth-scroll";
import { HTML_LANG, isLocale } from "@/lib/i18n/locales";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
  variable: "--font-display",
});

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations("metadata"), getLocale()]);
  const lang = isLocale(locale) ? HTML_LANG[locale] : "en";
  return {
    title: t("title"),
    description: t("description"),
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: t("title"),
      description: t("description"),
      siteName: "Kalypso",
      type: "website",
      locale: lang.replace("-", "_"),
    },
  };
}

// One colour per scheme for the browser's own chrome. These two literals are the canvas tokens in
// app/globals.css; a meta tag cannot read a CSS variable.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2ece6" },
    { media: "(prefers-color-scheme: dark)", color: "#15100f" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Every page renders per request so Next can stamp each response's CSP nonce (proxy.ts) on
  // its scripts. A page built ahead of time would carry none, and the policy would block it.
  await connection();
  const [locale, requestHeaders] = await Promise.all([getLocale(), headers()]);
  // The theme script runs inline before first paint, so it carries this response's nonce.
  const nonce = /'nonce-([^']+)'/.exec(requestHeaders.get("content-security-policy") ?? "")?.[1];

  return (
    // suppressHydrationWarning: next-themes writes the theme class and color-scheme onto <html>
    // before React hydrates, which React would otherwise report as a mismatch.
    <html
      lang={isLocale(locale) ? HTML_LANG[locale] : "en"}
      suppressHydrationWarning
      className={`${display.variable} ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body>
        <ThemeProvider
          attribute="class"
          themes={["light", "dark"]}
          defaultTheme="system"
          enableSystem
          storageKey="kalypso-theme"
          disableTransitionOnChange
          nonce={nonce}
        >
          <NextIntlClientProvider>
            <SmoothScroll>{children}</SmoothScroll>
          </NextIntlClientProvider>
        </ThemeProvider>
        <Grain />
      </body>
    </html>
  );
}
