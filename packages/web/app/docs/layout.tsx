import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { getLocale, getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { markEnglishOnly } from "@/lib/i18n/docs-tree";
import { docsUiTranslations } from "@/lib/i18n/docs-ui";
import { REPO_URL } from "@/lib/links";
import { source } from "@/lib/source";
import { NavTitle } from "./nav-title";
import { NestedScroll } from "./nested-scroll";

export default async function DocsRootLayout({ children }: { children: ReactNode }) {
  const [locale, nav, docs] = await Promise.all([getLocale(), getTranslations("common.nav"), getTranslations("docs")]);
  const tree = markEnglishOnly(source.getPageTree(locale), locale, docs("englishBadge"));
  return (
    // The theme provider is off: the root layout's provider owns the class on <html>, and a
    // second one would write its own. The docs toggle drives that same provider. The i18n
    // provider carries the locale for the search index and the chrome's words; it lists no
    // locales, so Fumadocs draws no switcher of its own next to ours.
    <RootProvider theme={{ enabled: false }} i18n={{ locale, translations: docsUiTranslations(locale) }}>
      <NestedScroll />
      <DocsLayout
        tree={tree}
        containerProps={{ className: "kalypso-docs" }}
        themeSwitch={{ enabled: false }}
        nav={{ title: <NavTitle />, url: "/" }}
        links={[
          { text: nav("sandbox"), url: "/demo" },
          { text: nav("source"), url: REPO_URL, external: true },
          {
            type: "custom",
            secondary: true,
            children: (
              <span className="flex items-center gap-1">
                <LocaleSwitcher />
                <ThemeToggle />
              </span>
            ),
          },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
