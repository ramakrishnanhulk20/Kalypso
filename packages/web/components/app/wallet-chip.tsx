"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useWalletSession } from "./wallet-session";

const MENU_ITEM =
  "block w-full px-4 py-[0.6rem] text-left font-sans text-[0.9375rem] text-muted transition-colors hover:bg-raised-2 hover:text-fg focus-visible:bg-raised-2 focus-visible:text-fg";

function shorten(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// The connected wallet in the header: a green dot and the address, with a small menu.
export function WalletChip() {
  const t = useTranslations("app");
  const session = useWalletSession();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const address = session?.wallet?.address;

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!session || !address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("walletChip", { short: shorten(address) })}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-button border border-line-strong px-3 py-[0.4rem] transition-colors hover:border-fg hover:bg-raised max-md:px-2"
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
        <span className="font-mono text-[0.8125rem] text-fg max-md:hidden">{shorten(address)}</span>
        <span className="font-mono text-[0.8125rem] text-fg md:hidden">{address.slice(0, 4)}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[11rem] overflow-hidden rounded-button border border-line bg-raised py-1"
          style={{ boxShadow: "var(--shadow-menu)" }}
        >
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => void copy()}>
            {copied ? t("copied") : t("copyAddress")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setOpen(false);
              session.disconnect();
            }}
          >
            {t("disconnect")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
