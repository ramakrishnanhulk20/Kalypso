// Covers the arrow-key map between the five cards of a group (every key from every card, edges
// stop, the featured card fills the left column), that each group's data is whole (five items,
// every title and sentence present in the English file, every icon drawn, every link a site path),
// the order the bar gives up parts when it is too full, and that the CSS uses the same 1280px
// breakpoint and the same drop names as the code.
// Does NOT cover focus moving in a real browser, whether the bar really fits at a given width, or
// the panel's look; the browser walk in scratchpad/web-lens/w8-walk.mjs does.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { renderEnglish } from "../../test/i18n";
import { NavIcon } from "./icons";
import {
  CARDS_PER_GROUP,
  DESKTOP_MIN_WIDTH,
  DROP_ORDER,
  NAV_GROUPS,
  OVER_HERO_SOLID_AFTER_PX,
  SHEET_EXIT_MS,
  isArrowKey,
  isPastTop,
  isSolidBar,
  nextCard,
  pickDrops,
  showsWalletChip,
} from "./nav-data";

const CSS = readFileSync(path.join(import.meta.dirname, "../../app/globals.css"), "utf8");
const NAV_CSS = CSS.slice(CSS.indexOf("The role menus (components/site-nav)"));

describe("nextCard", () => {
  // The grid:  0 1 2
  //            0 3 4
  it.each([
    ["ArrowRight", [1, 2, 2, 4, 4]],
    ["ArrowLeft", [0, 0, 1, 0, 3]],
    ["ArrowDown", [0, 3, 4, 3, 4]],
    ["ArrowUp", [0, 1, 2, 1, 2]],
  ])("%s leads to %j from cards 0 to 4", (key, expected) => {
    expect([0, 1, 2, 3, 4].map((index) => nextCard(index, key))).toEqual(expected);
  });

  it("walks the featured card out through the top row and back", () => {
    expect(nextCard(0, "ArrowRight")).toBe(1);
    expect(nextCard(1, "ArrowLeft")).toBe(0);
    expect(nextCard(3, "ArrowLeft")).toBe(0);
  });

  it("leaves the focus where it is for any other key", () => {
    for (const key of ["Tab", "Enter", "Home", "a", ""]) expect(nextCard(2, key)).toBe(2);
  });

  it("never leaves the five cards", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
      for (let index = 0; index < CARDS_PER_GROUP; index++) {
        const next = nextCard(index, key);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(CARDS_PER_GROUP);
      }
    }
  });

  it("names exactly the four arrows", () => {
    expect(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].every(isArrowKey)).toBe(true);
    expect(isArrowKey("Enter")).toBe(false);
  });
});

describe("NAV_GROUPS", () => {
  const items = NAV_GROUPS.flatMap((group) => group.items);
  const siteNav = en.siteNav as unknown as { items: Record<string, { title: string; text: string }> } & Record<string, unknown>;

  it("has the employer, worker and accountant groups, five items each", () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual(["employers", "workers", "accountants"]);
    for (const group of NAV_GROUPS) expect(group.items).toHaveLength(CARDS_PER_GROUP);
  });

  it("has a title and a sentence in the English file for every item and a name for every group", () => {
    for (const item of items) {
      expect(siteNav.items[item.key]?.title, item.key).toBeTruthy();
      expect(siteNav.items[item.key]?.text, item.key).toBeTruthy();
    }
    for (const group of NAV_GROUPS) expect(typeof siteNav[group.id]).toBe("string");
  });

  it("uses each item key once", () => {
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(Object.keys(siteNav.items).sort()).toEqual(items.map((item) => item.key).sort());
  });

  it("points every item at a path on this site", () => {
    for (const item of items) expect(item.href, item.key).toMatch(/^\/[a-z0-9/#-]*$/);
  });

  it("draws every icon it names", () => {
    for (const item of items) {
      const drawing = renderEnglish(createElement(NavIcon, { name: item.icon, size: 20 }));
      expect(drawing, item.icon).toMatch(/<(path|circle|ellipse)/);
    }
  });
});

describe("pickDrops", () => {
  it("gives up nothing when the bar fits as it is", () => {
    expect(pickDrops(() => true)).toEqual([]);
  });

  it("gives up the Menu word, the Docs link, the chip's long address, the chip, and the Testnet badge last", () => {
    expect(pickDrops((drops) => drops.includes("menu"))).toEqual(["menu"]);
    expect(pickDrops((drops) => drops.includes("docs"))).toEqual(["menu", "docs"]);
    expect(pickDrops((drops) => drops.includes("short"))).toEqual(["menu", "docs", "short"]);
    expect(pickDrops((drops) => drops.includes("chip"))).toEqual(["menu", "docs", "short", "chip"]);
    expect(pickDrops((drops) => drops.includes("badge"))).toEqual(["menu", "docs", "short", "chip", "badge"]);
  });

  it("keeps the Testnet badge while giving up the Menu word is enough, as on a 375px phone", () => {
    const phone = (drops: readonly string[]) => drops.includes("menu");
    expect(pickDrops(phone)).not.toContain("badge");
    expect(pickDrops(phone)).toEqual(["menu"]);
  });

  it("gives up everything when nothing is enough", () => {
    expect(pickDrops(() => false)).toEqual([...DROP_ORDER]);
  });

  it("asks about each step once, from nothing upward", () => {
    const asked: string[] = [];
    pickDrops((drops) => {
      asked.push(drops.join("+"));
      return false;
    });
    expect(asked).toEqual(["", "menu", "menu+docs", "menu+docs+short", "menu+docs+short+chip", "menu+docs+short+chip+badge"]);
  });

  it("never gives up a trigger or the Try button", () => {
    expect([...DROP_ORDER]).toEqual(["menu", "docs", "short", "chip", "badge"]);
  });
});

describe("the bar's breakpoint and drop names in the CSS", () => {
  it("starts the full bar at 1280px", () => {
    expect(DESKTOP_MIN_WIDTH).toBe(1280);
    expect(NAV_CSS).toContain(`@media (min-width: ${DESKTOP_MIN_WIDTH}px)`);
    expect(NAV_CSS).toContain(`@media (max-width: ${DESKTOP_MIN_WIDTH - 1}px)`);
    expect(NAV_CSS).not.toMatch(/(min|max)-width: 10(23|24)px/);
  });

  it("hides exactly the parts DROP_ORDER names", () => {
    const named = new Set([...NAV_CSS.matchAll(/data-drop~="(\w+)"/g)].map((match) => match[1]));
    expect([...named].sort()).toEqual([...DROP_ORDER].sort());
  });

  it("fades the sheet out in the time the code waits before removing it", () => {
    expect(SHEET_EXIT_MS).toBe(180);
    expect(NAV_CSS).toContain(`animation: site-nav-sheet-out ${SHEET_EXIT_MS}ms`);
  });
});

describe("what the bar says", () => {
  it("has no tagline and still names Docs and Source for the sheet", () => {
    const names = en.siteNav as unknown as Record<string, unknown>;
    expect(names.tagline).toBeUndefined();
    expect(typeof names.docs).toBe("string");
    expect(typeof names.source).toBe("string");
  });

  it("sends the books card to the key lens section's real id", () => {
    expect(NAV_GROUPS.flatMap((group) => group.items).find((item) => item.key === "realBooks")?.href).toBe("/#lens");
  });
});

describe("the wallet chip and the floating bar", () => {
  it("shows the chip on the employer and accountant pages only", () => {
    expect(showsWalletChip("/employer")).toBe(true);
    expect(showsWalletChip("/accountant")).toBe(true);
    for (const other of ["/", "/demo", "/worker", "/docs", "/employer/x", null]) expect(showsWalletChip(other)).toBe(false);
  });

  it("moves the chip to the sheet only below the desktop width", () => {
    const mobile = NAV_CSS.slice(NAV_CSS.indexOf(`@media (max-width: ${DESKTOP_MIN_WIDTH - 1}px)`));
    const rule = '.site-nav-bar[data-drop~="chip"] .site-nav-chip {\n    display: none;';
    expect(mobile).toContain(rule);
    expect(NAV_CSS.slice(0, NAV_CSS.indexOf(`@media (max-width: ${DESKTOP_MIN_WIDTH - 1}px)`))).not.toContain(rule);
  });

  it("calls the bar bare only within 24px of the top", () => {
    expect(OVER_HERO_SOLID_AFTER_PX).toBe(24);
    expect(isPastTop(0)).toBe(false);
    expect(isPastTop(24)).toBe(false);
    expect(isPastTop(25)).toBe(true);
  });

  it("makes the bar standard everywhere except bare at the top of the home page", () => {
    expect(isSolidBar({ overHero: false, pastTop: false, menuOpen: false })).toBe(true);
    expect(isSolidBar({ overHero: true, pastTop: false, menuOpen: false })).toBe(false);
    expect(isSolidBar({ overHero: true, pastTop: true, menuOpen: false })).toBe(true);
    expect(isSolidBar({ overHero: true, pastTop: false, menuOpen: true })).toBe(true);
  });

  it("changes the bar over 200ms and goes bare with no background, border or blur", () => {
    const ruleOf = (selector: string) => {
      const start = NAV_CSS.indexOf(`${selector} {`);
      return start < 0 ? "" : NAV_CSS.slice(start, NAV_CSS.indexOf("}", start));
    };
    const bar = ruleOf(".site-nav-bar");
    expect(bar).toContain("background-color 200ms");
    expect(bar).toContain("border-color 200ms");
    expect(bar).toContain("backdrop-filter 200ms");
    const bare = ruleOf('.site-nav-bar[data-over-hero="true"][data-solid="false"]');
    expect(bare).toContain("background-color: transparent");
    expect(bare).toContain("border-bottom-color: transparent");
    expect(bare).toContain("backdrop-filter: none");
  });
});
