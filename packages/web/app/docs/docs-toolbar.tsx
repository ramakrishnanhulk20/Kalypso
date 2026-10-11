"use client";

import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";

// The site bar (SiteNav) is the docs' top bar, so Fumadocs' own one is replaced. On a phone the
// sidebar and the search live behind this slim strip under the site bar; from the md width up the
// sidebar is on screen with its own search, and the strip is hidden.
export function DocsToolbar() {
  const { slots } = useDocsLayout();
  const SidebarTrigger = slots.sidebar.trigger;
  const Search = slots.searchTrigger ? slots.searchTrigger.sm : null;

  return (
    <div id="nd-subnav" className="kalypso-docs-toolbar">
      {Search ? <Search hideIfDisabled className="p-2" /> : null}
      <SidebarTrigger className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "p-2" })}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
          <path d="M7 3.5v11" />
        </svg>
      </SidebarTrigger>
    </div>
  );
}

// Fumadocs shows the site name at the top of its sidebar; the site bar already says it.
export function NoNavTitle() {
  return null;
}
