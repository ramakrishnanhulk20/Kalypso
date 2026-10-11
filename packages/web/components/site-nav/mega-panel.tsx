"use client";

import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SealMark } from "@/components/seal-mark";
import { ArrowIcon, NavIcon, SealPlusIcon } from "./icons";
import { NAV_GROUPS, isArrowKey, nextCard } from "./nav-data";
import type { GroupId, NavGroup } from "./nav-data";

type MegaPanelProps = {
  id: string;
  // The group whose content is showing, or null while the panel is closed.
  active: GroupId | null;
  // The group that was showing last: it keeps the panel's name while the panel fades out.
  shown: GroupId;
  // True when the panel was already open and the visitor moved to another group.
  swapping: boolean;
  onNavigate: () => void;
  onLeaveToTrigger: (id: GroupId) => void;
};

// The big title may run into the gap beside its column but must stop short of the divider, 316px
// from the column's left edge. A long word in another language is scaled down until it fits.
const TITLE_ROOM_PX = 316;

function fitTitle(title: HTMLElement) {
  let scale = 1;
  // Glyph widths do not follow the font size exactly (Fraunces changes shape with size), so the
  // scale is corrected up to three times.
  for (let pass = 0; pass < 3; pass++) {
    title.style.setProperty("--site-nav-title-scale", String(scale));
    const widest = Math.max(0, ...Array.from(title.children, (line) => (line as HTMLElement).offsetWidth));
    if (widest <= TITLE_ROOM_PX) return;
    scale *= TITLE_ROOM_PX / widest;
  }
  title.style.setProperty("--site-nav-title-scale", String(scale));
}

// "For employers" breaks as "For" / "employers": the last word drops to the second line.
function splitTitle(title: string): [string, string | null] {
  const cut = title.lastIndexOf(" ");
  return cut === -1 ? [title, null] : [title.slice(0, cut), title.slice(cut + 1)];
}

export function MegaPanel({ id, active, shown, swapping, onNavigate, onLeaveToTrigger }: MegaPanelProps) {
  const t = useTranslations("siteNav");

  return (
    <div
      id={id}
      role="region"
      aria-label={t(shown)}
      data-open={active !== null}
      data-swap={swapping}
      data-lenis-prevent
      className="site-nav-panel"
    >
      <div className="site-nav-stack">
        {NAV_GROUPS.map((group, index) => (
          <PanelGroup
            key={group.id}
            group={group}
            position={index + 1}
            visible={active === group.id}
            onNavigate={onNavigate}
            onLeaveToTrigger={onLeaveToTrigger}
          />
        ))}
      </div>
    </div>
  );
}

type PanelGroupProps = {
  group: NavGroup;
  position: number;
  visible: boolean;
  onNavigate: () => void;
  onLeaveToTrigger: (id: GroupId) => void;
};

function PanelGroup({ group, position, visible, onNavigate, onLeaveToTrigger }: PanelGroupProps) {
  const t = useTranslations("siteNav");
  const name = t(group.id);
  const [first, rest] = splitTitle(name);
  const [featured, ...small] = group.items;
  const groupRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The title is measured again when the language changes, when the window is resized and once the
  // display font has loaded.
  useLayoutEffect(() => {
    const block = groupRef.current;
    const title = titleRef.current;
    if (!block || !title) return;
    const fit = () => fitTitle(title);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(block);
    void document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [name]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-nav-card]"));
    const at = cards.findIndex((card) => card === event.target);
    if (at === -1) return;
    if (event.key === "Tab" && event.shiftKey && at === 0) {
      event.preventDefault();
      onLeaveToTrigger(group.id);
      return;
    }
    if (!isArrowKey(event.key)) return;
    event.preventDefault();
    cards[nextCard(at, event.key)]?.focus();
  };

  return (
    <div ref={groupRef} data-group={group.id} data-active={visible} className="site-nav-group" onKeyDown={onKeyDown}>
      <div className="site-nav-lead">
        <p className="t-label site-nav-counter">
          <SealPlusIcon />
          <span>
            {String(position).padStart(2, "0")} / {String(NAV_GROUPS.length).padStart(2, "0")}
          </span>
        </p>
        <h2 ref={titleRef} className="font-display site-nav-title">
          <span className="block">{first}</span>
          {rest === null ? null : (
            <>
              {" "}
              <span className="block">{rest}</span>
            </>
          )}
        </h2>
        <p className="t-label site-nav-hint">
          <span className="block">{t("hintArrows")}</span> <span className="block">{t("hintEsc")}</span>
        </p>
      </div>

      <div className="site-nav-divider" aria-hidden="true" />

      <div className="site-nav-cards">
        <Link href={featured.href} prefetch={false} data-nav-card onClick={onNavigate} className="site-nav-featured">
          <span className="site-nav-iconbox">
            <NavIcon name={featured.icon} size={20} />
          </span>
          <span className="site-nav-featured-body">
            <span className="font-display site-nav-featured-title">{t(`items.${featured.key}.title`)}</span>
            <span className="font-sans site-nav-featured-text">{t(`items.${featured.key}.text`)}</span>
            <span className="t-label site-nav-open">
              {t("open")}
              <ArrowIcon />
            </span>
          </span>
          {/* The wax seal watermark is part of the card's look, not content. */}
          <span className="site-nav-watermark" aria-hidden="true">
            <SealMark size={260} />
          </span>
        </Link>

        {small.map((item) => (
          <Link key={item.key} href={item.href} prefetch={false} data-nav-card onClick={onNavigate} className="site-nav-card">
            <span className="site-nav-card-icon">
              <NavIcon name={item.icon} size={22} />
            </span>
            <span className="site-nav-card-body">
              <span className="font-sans site-nav-card-title">{t(`items.${item.key}.title`)}</span>
              <span className="font-sans site-nav-card-text">{t(`items.${item.key}.text`)}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
