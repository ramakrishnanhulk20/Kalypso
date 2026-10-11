import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { getLocale, getTranslations } from "next-intl/server";
import { SiteNav } from "@/components/site-nav/site-nav";
import { markEnglishOnly } from "@/lib/i18n/docs-tree";
import { docsUiTranslations } from "@/lib/i18n/docs-ui";
import { source } from "@/lib/source";
import { DocsToolbar, NoNavTitle } from "./docs-toolbar";
import { NestedScroll } from "./nested-scroll";

export default async function DocsRootLayout({ children }: { children: ReactNode }) {
  const [locale, docs] = await Promise.all([getLocale(), getTranslations("docs")]);
  const tree = markEnglishOnly(source.getPageTree(locale), locale, docs("englishBadge"));
  return (
    // The theme provider is off: the root layout's provider owns the class on <html>, and a
    // second one would write its own. The i18n provider carries the locale for the search index and
    // the chrome's words; it lists no locales, so Fumadocs draws no switcher of its own. The site bar
    // carries the language and theme switches, so the layout has none of its own links.
    <RootProvider theme={{ enabled: false }} i18n={{ locale, translations: docsUiTranslations(locale) }}>
      <SiteNav />
      <NestedScroll />
      <DocsLayout
        tree={tree}
        containerProps={{ className: "kalypso-docs" }}
        themeSwitch={{ enabled: false }}
        slots={{ header: DocsToolbar, navTitle: NoNavTitle }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
