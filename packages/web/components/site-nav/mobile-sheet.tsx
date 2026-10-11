"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { WalletChip } from "@/components/app/wallet-chip";
import { SealMark } from "@/components/seal-mark";
import { getLenis } from "@/lib/lenis-instance";
import { REPO_URL } from "@/lib/links";
import { NavIcon, PlusMinusIcon } from "./icons";
import { NAV_GROUPS, SANDBOX_PAGE } from "./nav-data";
import type { GroupId } from "./nav-data";

type MobileSheetProps = {
  id: string;
  // True while the sheet fades out: it is still on screen but no longer takes focus or clicks.
  closing?: boolean;
  // The wallet chip did not fit in the bar, so it sits at the top of the sheet instead.
  showChip?: boolean;
  onClose: () => void;
  // A link was followed: the page changes, so the sheet goes away without handing focus back.
  onNavigate: () => void;
};

export function MobileSheet({ id, closing = false, showChip = false, onClose, onNavigate }: MobileSheetProps) {
  const t = useTranslations("siteNav");
  const common = useTranslations("common");
  const pathname = usePathname();
  const [openGroup, setOpenGroup] = useState<GroupId | null>(NAV_GROUPS[0]?.id ?? null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The page behind must not scroll. Lenis keeps scrolling the window by hand even when the body
  // is locked, so it is stopped too, and the sheet itself opts out of Lenis (data-lenis-prevent).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    getLenis()?.stop();
    return () => {
      document.body.style.overflow = previous;
      getLenis()?.start();
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Esc closes. Tab wraps inside the sheet, because aria-modal promises nothing behind it is reachable.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (closing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const stops = Array.from(sheet.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")).filter(
        (stop) => !stop.closest("[inert]"),
      );
      const firstStop = stops[0];
      const lastStop = stops[stops.length - 1];
      if (!firstStop || !lastStop) return;
      const here = document.activeElement;
      const outside = !(here instanceof Node) || !sheet.contains(here);
      if (event.shiftKey && (here === firstStop || outside)) {
        event.preventDefault();
        lastStop.focus();
      } else if (!event.shiftKey && (here === lastStop || outside)) {
        event.preventDefault();
        firstStop.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, closing]);

  return (
    <div
      ref={sheetRef}
      id={id}
      role="dialog"
      aria-modal="true"
      aria-label={t("menu")}
      data-closing={closing}
      inert={closing}
      data-lenis-prevent
      className="site-nav-sheet"
    >
      <div className="site-nav-sheet-top">
        <Link href="/" aria-label={common("home")} onClick={onNavigate} className="logo-link flex items-center gap-[10px]">
          <SealMark size={24} />
          <span className="font-display text-[1.25rem] font-medium text-fg" style={{ fontVariationSettings: '"opsz" 36', letterSpacing: "-0.01em" }}>
            Kalypso
          </span>
        </Link>
        <span className="site-nav-sheet-end">
          {showChip ? <WalletChip /> : null}
          <button ref={closeRef} type="button" className="t-label site-nav-menu-button" onClick={onClose}>
            {t("close")}
          </button>
        </span>
      </div>

      <div className="site-nav-sheet-body">
        {NAV_GROUPS.map((group) => {
          const open = openGroup === group.id;
          const headId = `${id}-head-${group.id}`;
          const bodyId = `${id}-body-${group.id}`;
          return (
            <section key={group.id} className="site-nav-acc">
              <h2 className="m-0">
                <button
                  id={headId}
                  type="button"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  className="font-display site-nav-acc-head"
                  onClick={() => setOpenGroup(open ? null : group.id)}
                >
                  <span>{t(group.id)}</span>
                  <PlusMinusIcon open={open} />
                </button>
              </h2>
              <div id={bodyId} role="region" aria-labelledby={headId} data-open={open} inert={!open} className="site-nav-acc-panel">
                <div className="site-nav-acc-inner">
                  {group.items.map((item) => (
                    <Link key={item.key} href={item.href} prefetch={false} onClick={onNavigate} className="site-nav-row">
                      <span className="site-nav-row-icon">
                        <NavIcon name={item.icon} size={22} />
                      </span>
                      <span className="site-nav-row-text">
                        <span className="font-sans site-nav-row-title">{t(`items.${item.key}.title`)}</span>
                        <span className="font-sans site-nav-row-desc">{t(`items.${item.key}.text`)}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            </section>
          );
        })}

        <div className="site-nav-sheet-foot">
          <Link
            href={SANDBOX_PAGE}
            aria-current={pathname === SANDBOX_PAGE ? "page" : undefined}
            onClick={onNavigate}
            className="btn-seal w-full"
          >
            {t("sandbox")}
          </Link>
          <div className="site-nav-sheet-links">
            <Link href="/docs" onClick={onNavigate} className="link-draw text-[0.9375rem]">
              {t("docs")}
            </Link>
            <a href={REPO_URL} target="_blank" rel="noopener" className="link-draw text-[0.9375rem]">
              {t("source")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
