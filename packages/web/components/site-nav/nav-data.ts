import type { NavIconName } from "./icons";

export type GroupId = "employers" | "workers" | "accountants";

// The key under siteNav.items; the title and the text of the item sit under it.
export type ItemKey =
  | "payTeam"
  | "setUpCompany"
  | "testFunds"
  | "tryNoWallet"
  | "howPayrollWorks"
  | "getYourPay"
  | "joinCompany"
  | "cashOut"
  | "yourPasskey"
  | "whoSeesPay"
  | "openBooks"
  | "registerKey"
  | "exportTax"
  | "realBooks"
  | "security";

export type NavItem = { key: ItemKey; href: string; icon: NavIconName };

export type NavGroup = {
  id: GroupId;
  // The first item is the featured card; the other four are the small cards in reading order.
  items: readonly [NavItem, NavItem, NavItem, NavItem, NavItem];
};

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "employers",
    items: [
      { key: "payTeam", href: "/employer", icon: "wax-seal-check" },
      { key: "setUpCompany", href: "/docs/guides/employer", icon: "building" },
      { key: "testFunds", href: "/employer#test-funds", icon: "coins" },
      { key: "tryNoWallet", href: "/demo", icon: "flask" },
      { key: "howPayrollWorks", href: "/docs/how-it-works", icon: "book" },
    ],
  },
  {
    id: "workers",
    items: [
      { key: "getYourPay", href: "/worker", icon: "face" },
      { key: "joinCompany", href: "/docs/guides/worker", icon: "link" },
      { key: "cashOut", href: "/docs/guides/worker", icon: "bank" },
      { key: "yourPasskey", href: "/docs/guides/worker", icon: "fingerprint" },
      { key: "whoSeesPay", href: "/docs/faq", icon: "eye" },
    ],
  },
  {
    id: "accountants",
    items: [
      { key: "openBooks", href: "/accountant", icon: "open-ledger" },
      { key: "registerKey", href: "/docs/guides/accountant", icon: "key" },
      { key: "exportTax", href: "/docs/guides/accountant", icon: "file-with-arrow" },
      { key: "realBooks", href: "/#lens", icon: "lens" },
      { key: "security", href: "/docs/security/overview", icon: "shield" },
    ],
  },
];

export const CARDS_PER_GROUP = 5;

export type ArrowKey = "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp";

export function isArrowKey(key: string): key is ArrowKey {
  return key === "ArrowRight" || key === "ArrowLeft" || key === "ArrowDown" || key === "ArrowUp";
}

// Where each arrow leads from each card. The cards sit in a grid of three columns and two rows:
//   0 1 2
//   0 3 4
// Card 0 is the featured card and fills the left column, so Down and Up leave it where it is.
// Every edge stops: the focus never wraps round to the far side.
const MOVES: Record<ArrowKey, readonly number[]> = {
  ArrowRight: [1, 2, 2, 4, 4],
  ArrowLeft: [0, 0, 1, 0, 3],
  ArrowDown: [0, 3, 4, 3, 4],
  ArrowUp: [0, 1, 2, 1, 2],
};

/** The card that should take focus when `key` is pressed on card `index`. Any other key keeps `index`. */
export function nextCard(index: number, key: string): number {
  if (!isArrowKey(key)) return index;
  return MOVES[key][index] ?? index;
}

// The full bar with its three menus starts at this width, in pixels. Below it the bar shows the
// Menu button and the phone sheet. The CSS carries the same number in its media queries, and a
// test keeps the two equal.
export const DESKTOP_MIN_WIDTH = 1280;

// What the bar gives up when its parts do not fit, in this order: the word on the Menu button (the
// icon stays, and its aria-label still names it), then the Docs link, then the wallet chip's long
// address (it shows four characters instead), then, below the desktop width only, the chip itself
// (it moves to the top of the open sheet), and the Testnet badge last, because on a phone it is the
// only sign on screen that the money is not real. A trigger and the Try button are never given up.
// On a page with no wallet chip the chip steps change nothing, and on a desktop bar the Menu step
// and the move to the sheet change nothing.
export const DROP_ORDER = ["menu", "docs", "short", "chip", "badge"] as const;

export type Drop = (typeof DROP_ORDER)[number];

/**
 * The fewest parts to give up, in DROP_ORDER, for which `fits` says the bar fits. When even
 * giving up every part is not enough, all of them are given up.
 */
export function pickDrops(fits: (drops: readonly Drop[]) => boolean): readonly Drop[] {
  for (let count = 0; count <= DROP_ORDER.length; count++) {
    const drops = DROP_ORDER.slice(0, count);
    if (fits(drops)) return drops;
  }
  return DROP_ORDER;
}

// How long the phone sheet takes to fade out, in milliseconds. Under reduced motion it goes at once.
export const SHEET_EXIT_MS = 180;

// The pages where a connected wallet shows as a chip in the bar, and the page the Try button is on.
export const WALLET_PAGES: readonly string[] = ["/employer", "/accountant"];
export const SANDBOX_PAGE = "/demo";

export function showsWalletChip(pathname: string | null): boolean {
  return pathname !== null && WALLET_PAGES.includes(pathname);
}

// On the home page the bar floats over the hero until the page has moved this far, in pixels.
export const OVER_HERO_SOLID_AFTER_PX = 24;

export function isPastTop(scrollY: number): boolean {
  return scrollY > OVER_HERO_SOLID_AFTER_PX;
}

/** Whether the bar is the standard bar. Only the floating home bar is ever anything else, and an open menu makes it standard. */
export function isSolidBar({ overHero, pastTop, menuOpen }: { overHero: boolean; pastTop: boolean; menuOpen: boolean }): boolean {
  return !overHero || pastTop || menuOpen;
}
