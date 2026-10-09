"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useWalletSession } from "./wallet-session";

const MENU_ITEM =
  "block w-full px-4 py-[0.6rem] text-left font-sans text-[0.9375rem] text-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:bg-ink-3 focus-visible:text-paper";

function shorten(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// The connected wallet in the header: a green dot and the address, with a small menu.
export function WalletChip() {
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
        aria-label={`Connected wallet ${shorten(address)}`}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-button border border-line px-3 py-[0.4rem] transition-colors hover:border-[rgba(242,236,230,0.28)] hover:bg-ink-2"
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
        <span className="font-mono text-[0.8125rem] text-paper">{shorten(address)}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[11rem] overflow-hidden rounded-button border border-line bg-ink-2 py-1"
          style={{ boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}
        >
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy address"}
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
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
