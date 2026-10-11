import type { ReactNode } from "react";
import type * as PageTree from "fumadocs-core/page-tree";
import { source } from "@/lib/source";
import { DEFAULT_LOCALE } from "./locales";

type Node = PageTree.Root["children"][number];

const DOCS_PREFIX = "/docs";

/**
 * True when the page at these slugs has no translation in `locale` and shows the English one
 * instead. The loader stamps every page with the locale it was asked for, fallback or not, so the
 * tell is the file: a translation is its own file (contracts.fr.mdx), a fallback is the English one.
 */
export function isEnglishOnly(slugs: string[] | undefined, locale: string): boolean {
  if (locale === DEFAULT_LOCALE) return false;
  const page = source.getPage(slugs, locale);
  const english = source.getPage(slugs, DEFAULT_LOCALE);
  return page !== undefined && english !== undefined && page.path === english.path;
}

function slugsOf(url: string): string[] {
  return url.slice(DOCS_PREFIX.length).split("/").filter(Boolean);
}

// Walks the sidebar tree and adds a small badge to every page that only exists in English, so a
// reader in another language knows before they click.
export function markEnglishOnly(root: PageTree.Root, locale: string, badge: ReactNode): PageTree.Root {
  const mark = (name: ReactNode): ReactNode => (
    <span className="inline-flex items-center gap-2">
      {name}
      <span className="t-label rounded-[4px] border border-line px-1 py-px text-[0.625rem] tracking-[0.12em]">{badge}</span>
    </span>
  );
  const englishOnly = (url: string) => isEnglishOnly(slugsOf(url), locale);

  const visit = (node: Node): Node => {
    if (node.type === "page") return englishOnly(node.url) ? { ...node, name: mark(node.name) } : node;
    if (node.type === "folder") {
      return {
        ...node,
        index: node.index && englishOnly(node.index.url) ? { ...node.index, name: mark(node.index.name) } : node.index,
        children: node.children.map(visit),
      };
    }
    return node;
  };

  return { ...root, children: root.children.map(visit) };
}
