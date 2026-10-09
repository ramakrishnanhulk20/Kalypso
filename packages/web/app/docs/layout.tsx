import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { REPO_URL } from "@/lib/links";
import { source } from "@/lib/source";
import { NavTitle } from "./nav-title";
import { NestedScroll } from "./nested-scroll";

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme provider is off: it writes its class onto <html>, which would
    // leak the docs theme into the landing after a client-side navigation.
    <RootProvider theme={{ enabled: false }}>
      <NestedScroll />
      <DocsLayout
        tree={source.getPageTree()}
        containerProps={{ className: "kalypso-docs dark" }}
        themeSwitch={{ enabled: false }}
        nav={{ title: <NavTitle />, url: "/" }}
        links={[
          { text: "Sandbox", url: "/demo" },
          { text: "Source", url: REPO_URL, external: true },
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
