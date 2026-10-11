// Covers what the phone sheet renders in English: a modal dialog named Menu, a Close button, three
// accordion sections with only the first open (the others inert so their links cannot be tabbed
// to), five rows each, and the sandbox button, Docs and Source at the bottom.
// While it fades out it is marked closing and inert. Does NOT cover opening and closing, the scroll
// lock or the focus trap, which need a real browser.
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderEnglish } from "../../test/i18n";
import { MobileSheet } from "./mobile-sheet";
import { NAV_GROUPS } from "./nav-data";

const noop = vi.fn();
const markup = renderEnglish(createElement(MobileSheet, { id: "site-nav-sheet", onClose: noop, onNavigate: noop }));

describe("MobileSheet", () => {
  it("is a modal dialog named Menu with a Close button", () => {
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Menu"');
    expect(markup).toMatch(/<button[^>]*>Close<\/button>/);
  });

  it("has the three sections, the first open and the others shut", () => {
    const heads = [...markup.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*><span>([^<]*)<\/span>/g)].map((m) => [m[2], m[1]]);
    expect(heads).toEqual([
      ["For employers", "true"],
      ["For workers", "false"],
      ["For accountants", "false"],
    ]);
  });

  it("makes the shut sections inert", () => {
    expect(markup.match(/\binert=""/g)).toHaveLength(2);
  });

  it("lists five rows per section with the data's links", () => {
    const rows = [...markup.matchAll(/<a\b[^>]*class="site-nav-row"[^>]*href="([^"]*)"|<a\b[^>]*href="([^"]*)"[^>]*class="site-nav-row"/g)].map((m) => m[1] ?? m[2]);
    expect(rows).toEqual(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)));
  });

  it("ends with the sandbox button, Docs and Source", () => {
    expect(markup).toMatch(/<a[^>]*class="btn-seal w-full"[^>]*>Try the sandbox<\/a>/);
    expect(markup).toContain('href="/demo"');
    expect(markup).toContain('href="/docs"');
    expect(markup).toContain("Docs");
    expect(markup).toContain("Source");
  });

  it("is not marked closing or inert while it is open", () => {
    const dialogTag = /<div[^>]*role="dialog"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(dialogTag).toContain('data-closing="false"');
    expect(dialogTag).not.toContain("inert");
  });

  it("is marked closing and inert while it fades out", () => {
    const fading = renderEnglish(createElement(MobileSheet, { id: "site-nav-sheet", closing: true, onClose: noop, onNavigate: noop }));
    expect(fading).toMatch(/<div[^>]*role="dialog"[^>]*data-closing="true"[^>]*inert=""/);
  });

  it("draws the plus and minus as lines, with no dash character", () => {
    expect(markup).toContain("site-nav-plusminus-stem");
    expect(markup).not.toContain(String.fromCharCode(0x2212));
    expect(markup).not.toContain(String.fromCharCode(0x2014));
  });
});
