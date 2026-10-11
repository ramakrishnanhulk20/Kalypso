"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent, RefObject } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { WalletChip } from "@/components/app/wallet-chip";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SealMark } from "@/components/seal-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ChevronIcon, MenuLinesIcon, SealPlusIcon } from "./icons";
import { MegaPanel } from "./mega-panel";
import { MobileSheet } from "./mobile-sheet";
import {
  DESKTOP_MIN_WIDTH,
  NAV_GROUPS,
  SANDBOX_PAGE,
  SHEET_EXIT_MS,
  isPastTop,
  isSolidBar,
  pickDrops,
  showsWalletChip,
} from "./nav-data";
import type { GroupId } from "./nav-data";

const PANEL_ID = "site-nav-panel";
const SHEET_ID = "site-nav-sheet";
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 200;

// Gives up parts in DROP_ORDER until nothing runs past the bar's right edge. The result sits on the
// header as data-drop, and the CSS does the hiding. Returns what was given up.
function fitBar(header: HTMLElement, nav: HTMLElement) {
  const drops = pickDrops((tried) => {
    header.dataset.drop = tried.join(" ");
    return nav.scrollWidth <= nav.clientWidth + 1;
  });
  header.dataset.drop = drops.join(" ");
  return drops;
}

type SheetState = "closed" | "open" | "closing";

type SiteNavProps = {
  // On the home page the bar floats over the hero: transparent and borderless within the first
  // 24px of scroll, then the standard bar.
  overHero?: boolean;
  // The bar's element, for a page that fades it in with its own timeline.
  headerRef?: RefObject<HTMLElement | null>;
  // Starts invisible, for the same reason: the page's timeline brings it in.
  hiddenAtStart?: boolean;
};

export function SiteNav({ overHero = false, headerRef: outerHeaderRef, hiddenAtStart = false }: SiteNavProps) {
  const t = useTranslations("siteNav");
  const common = useTranslations("common");
  const locale = useLocale();
  const pathname = usePathname();
  const onWalletPage = showsWalletChip(pathname);
  const [active, setActive] = useState<GroupId | null>(null);
  const [shown, setShown] = useState<GroupId>(NAV_GROUPS[0]?.id ?? "employers");
  const [swapping, setSwapping] = useState(false);
  const [sheet, setSheet] = useState<SheetState>("closed");
  const [pastTop, setPastTop] = useState(false);
  const [chipDropped, setChipDropped] = useState(false);
  const reduceMotion = useReducedMotion();

  const activeRef = useRef<GroupId | null>(null);
  const sheetRef = useRef<SheetState>("closed");
  const sheetTimer = useRef<number | undefined>(undefined);
  const ownHeaderRef = useRef<HTMLElement>(null);
  const headerRef = outerHeaderRef ?? ownHeaderRef;
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const triggerRefs = useRef(new Map<GroupId, HTMLButtonElement>());
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  // One place changes the open group, so the ref the timers read and the state the page draws agree.
  const show = useCallback((next: GroupId | null) => {
    setSwapping(next !== null && activeRef.current !== null && activeRef.current !== next);
    activeRef.current = next;
    setActive(next);
    if (next !== null) setShown(next);
  }, []);

  const closePanel = useCallback(() => {
    clearTimers();
    show(null);
  }, [clearTimers, show]);

  const setSheetState = useCallback((next: SheetState) => {
    sheetRef.current = next;
    setSheet(next);
  }, []);

  const openSheet = useCallback(() => {
    window.clearTimeout(sheetTimer.current);
    setSheetState("open");
  }, [setSheetState]);

  // The sheet fades out for SHEET_EXIT_MS and is then removed; with reduced motion it goes at once.
  // Focus goes back to the Menu button the moment closing starts, when the visitor closed it there.
  const closeSheet = useCallback(
    (returnFocus: boolean) => {
      if (sheetRef.current !== "open") return;
      if (returnFocus) menuRef.current?.focus();
      window.clearTimeout(sheetTimer.current);
      if (reduceMotion) {
        setSheetState("closed");
        return;
      }
      setSheetState("closing");
      sheetTimer.current = window.setTimeout(() => setSheetState("closed"), SHEET_EXIT_MS);
    },
    [reduceMotion, setSheetState],
  );

  const closeSheetWithFocus = useCallback(() => closeSheet(true), [closeSheet]);
  const leaveSheet = useCallback(() => closeSheet(false), [closeSheet]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(sheetTimer.current);
    },
    [],
  );

  // Words change width with the language, so the fit is redone when the locale changes, when the
  // window is resized and once the fonts have loaded.
  useLayoutEffect(() => {
    const header = headerRef.current;
    const nav = navRef.current;
    if (!header || !nav) return;
    const fit = () => setChipDropped(fitBar(header, nav).includes("chip"));
    fit();
    // The right-hand group is watched too: the wallet chip joins it a while after the page loads.
    const observer = new ResizeObserver(fit);
    observer.observe(header);
    const end = header.querySelector(".site-nav-end");
    if (end) observer.observe(end);
    void document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [locale, headerRef]);

  useLayoutEffect(() => {
    if (!overHero) return;
    const update = () => setPastTop(isPastTop(window.scrollY));
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [overHero]);

  useEffect(() => {
    if (active === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const id = activeRef.current;
      closePanel();
      if (id !== null && headerRef.current?.contains(document.activeElement)) triggerRefs.current.get(id)?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, closePanel, headerRef]);

  // Crossing the desktop width in either direction ends whichever menu no longer fits.
  useEffect(() => {
    const wide = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const onChange = () => {
      if (wide.matches) {
        window.clearTimeout(sheetTimer.current);
        setSheetState("closed");
      } else closePanel();
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [closePanel, setSheetState]);

  const onTriggerClick = (id: GroupId) => {
    clearTimers();
    show(activeRef.current === id ? null : id);
  };

  const onTriggerPointerEnter = (event: PointerEvent<HTMLButtonElement>, id: GroupId) => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    if (activeRef.current === id) return;
    openTimer.current = window.setTimeout(() => show(id), OPEN_DELAY_MS);
  };

  const onTriggerPointerLeave = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(openTimer.current);
  };

  // From the open trigger, Tab goes straight into its panel, so the cards come right after it.
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: GroupId) => {
    if (event.key !== "Tab" || event.shiftKey || activeRef.current !== id) return;
    const first = headerRef.current?.querySelector<HTMLElement>(`[data-group="${id}"] [data-nav-card]`);
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const onHeaderPointerEnter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(closeTimer.current);
  };

  const onHeaderPointerLeave = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (activeRef.current !== null) closeTimer.current = window.setTimeout(() => show(null), CLOSE_DELAY_MS);
  };

  // Tabbing away from the bar and its panel closes the panel. A click on empty panel space also
  // blurs with no new target, and that must not close it.
  const onHeaderBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (activeRef.current !== null && next instanceof Node && !event.currentTarget.contains(next)) closePanel();
  };

  return (
    <>
      <header
        ref={headerRef}
        data-over-hero={overHero}
        data-solid={isSolidBar({ overHero, pastTop, menuOpen: active !== null || sheet !== "closed" })}
        className="site-nav-bar sticky top-0 z-40 flex h-[72px] items-center justify-between gap-4 border-b border-line px-[4vw]"
        style={hiddenAtStart ? { opacity: 0 } : undefined}
        onPointerEnter={onHeaderPointerEnter}
        onPointerLeave={onHeaderPointerLeave}
        onBlur={onHeaderBlur}
      >
        {/* A phone bar is a few pixels short of room for the badge, so the brand's gap tightens there. */}
        <div className="site-nav-brand max-[479px]:gap-1!">
          <Link href="/" aria-label={common("home")} className="logo-link flex items-center gap-[10px] max-[479px]:gap-[6px]">
            <SealMark size={24} />
            <span
              className="font-display text-[1.25rem] font-medium text-fg"
              style={{ fontVariationSettings: '"opsz" 36', letterSpacing: "-0.01em" }}
            >
              Kalypso
            </span>
          </Link>
          <span className="t-label site-nav-badge rounded-[6px] border border-line px-2 py-[3px] max-[479px]:px-[3px] max-[479px]:tracking-[0.02em]">
            <span className="max-[479px]:hidden">{common("testnet")}</span>
            <span className="min-[480px]:hidden">{common("testShort")}</span>
          </span>
        </div>

        <nav ref={navRef} aria-label={common("nav.label")} className="site-nav-nav">
          <div className="site-nav-triggers">
            {NAV_GROUPS.map((group) => (
              <button
                key={group.id}
                ref={(node) => {
                  if (node) triggerRefs.current.set(group.id, node);
                  else triggerRefs.current.delete(group.id);
                }}
                type="button"
                aria-expanded={active === group.id}
                aria-controls={PANEL_ID}
                className="font-sans site-nav-trigger"
                onClick={() => onTriggerClick(group.id)}
                onPointerEnter={(event) => onTriggerPointerEnter(event, group.id)}
                onPointerLeave={onTriggerPointerLeave}
                onKeyDown={(event) => onTriggerKeyDown(event, group.id)}
              >
                {t(group.id)}
                <ChevronIcon className="site-nav-chevron" />
              </button>
            ))}
          </div>

          <MegaPanel
            id={PANEL_ID}
            active={active}
            shown={shown}
            swapping={swapping}
            onNavigate={closePanel}
            onLeaveToTrigger={(id) => triggerRefs.current.get(id)?.focus()}
          />

          <div className="site-nav-end">
            <Link href="/docs" className="link-draw site-nav-desktop-only site-nav-docs text-[0.9375rem]">
              {t("docs")}
            </Link>
            <Link
              href={SANDBOX_PAGE}
              aria-current={pathname === SANDBOX_PAGE ? "page" : undefined}
              className="t-label site-nav-try site-nav-desktop-only"
            >
              <SealPlusIcon />
              {t("sandbox")}
            </Link>
            {onWalletPage ? (
              <span className="site-nav-chip">
                <WalletChip />
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <LocaleSwitcher />
              <ThemeToggle />
            </span>
            <button
              ref={menuRef}
              type="button"
              aria-expanded={sheet === "open"}
              aria-controls={SHEET_ID}
              aria-haspopup="dialog"
              aria-label={t("menu")}
              className="t-label site-nav-menu-button site-nav-mobile-only max-[479px]:px-2!"
              onClick={openSheet}
            >
              <MenuLinesIcon />
              <span className="site-nav-menu-label">{t("menu")}</span>
            </button>
          </div>
        </nav>
      </header>

      <div className="site-nav-overlay" data-open={active !== null} aria-hidden="true" onClick={closePanel} />

      {sheet !== "closed" ? <MobileSheet
          id={SHEET_ID}
          closing={sheet === "closing"}
          showChip={onWalletPage && chipDropped}
          onClose={closeSheetWithFocus}
          onNavigate={leaveSheet}
        /> : null}
    </>
  );
}
