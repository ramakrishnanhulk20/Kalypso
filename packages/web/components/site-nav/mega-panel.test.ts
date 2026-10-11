// Covers what the desktop panel renders in English: one region named for the group last shown, a
// block per group with its counter, two-line title, hints, the featured card first and four small
// cards after it, every link the data names in order, and only the open group marked active.
// Does NOT cover the cross-fade, the hover states or the keyboard, which need a real browser.
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderEnglish } from "../../test/i18n";
import { MegaPanel } from "./mega-panel";
import { NAV_GROUPS } from "./nav-data";
import type { GroupId } from "./nav-data";

const noop = vi.fn();

function panel(active: GroupId | null, shown: GroupId = "employers") {
  return renderEnglish(
    createElement(MegaPanel, { id: "site-nav-panel", active, shown, swapping: false, onNavigate: noop, onLeaveToTrigger: noop }),
  );
}

const hrefsOf = (markup: string) => [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);

describe("MegaPanel", () => {
  it("is a region named for the group shown, and closed when no group is active", () => {
    const markup = panel(null, "workers");
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="For workers"');
    expect(markup).toContain('data-open="false"');
    expect(panel("workers", "workers")).toContain('data-open="true"');
  });

  it("links every item the data names, group by group, featured card first", () => {
    expect(hrefsOf(panel("employers"))).toEqual(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)));
  });

  it("marks only the active group", () => {
    const markup = panel("accountants", "accountants");
    expect(markup.match(/data-active="true"/g)).toHaveLength(1);
    expect(markup.match(/data-active="false"/g)).toHaveLength(2);
    expect(markup).toMatch(/data-group="accountants" data-active="true"/);
  });

  it("numbers the groups 01 / 03 to 03 / 03", () => {
    const markup = panel("employers");
    for (const counter of ["01 / 03", "02 / 03", "03 / 03"]) expect(markup).toContain(counter);
  });

  it("breaks each title onto two lines: the last word alone on the second", () => {
    const markup = panel("employers");
    expect(markup).toContain('<span class="block">For</span> <span class="block">employers</span>');
    expect(markup).toContain('<span class="block">For</span> <span class="block">accountants</span>');
  });

  it("carries the hints and the Open label on the featured cards", () => {
    const markup = panel("employers");
    expect(markup.match(/Arrows move/g)).toHaveLength(3);
    expect(markup.match(/Esc closes/g)).toHaveLength(3);
    expect(markup.match(/site-nav-open/g)).toHaveLength(3);
  });

  it("gives one featured card and four small cards to each group", () => {
    const markup = panel("employers");
    expect(markup.match(/class="site-nav-featured"/g)).toHaveLength(3);
    expect(markup.match(/class="site-nav-card"/g)).toHaveLength(12);
  });

  it("says the copy word for word", () => {
    const markup = panel("employers");
    expect(markup).toContain("Run payroll in USDC from a spreadsheet. Every amount stays sealed on chain.");
    expect(markup).toContain("Only you and your company&#x27;s accountant can read the amount.");
    expect(markup).toContain("A complete CSV, refused when any payment is missing.");
  });
});
