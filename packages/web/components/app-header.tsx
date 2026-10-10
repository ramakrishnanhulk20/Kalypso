"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletChip } from "@/components/app/wallet-chip";
import { SealMark } from "@/components/seal-mark";
import { REPO_URL } from "@/lib/links";

const LINK = "link-draw text-[0.9375rem]";

export function AppHeader() {
  const pathname = usePathname();
  const onSandbox = pathname === "/demo";
  const onWalletPage = pathname === "/employer" || pathname === "/accountant";

  return (
    <header
      className="sticky top-0 z-40 flex h-[72px] items-center justify-between border-b border-line px-[4vw]"
      style={{
        background: "rgba(21,16,15,0.85)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <Link
        href="/"
        aria-label="Kalypso home"
        className="logo-link flex items-center gap-[10px]"
      >
        <SealMark size={24} />
        <span
          className="font-display text-[1.25rem] font-medium text-paper"
          style={{
            fontVariationSettings: '"opsz" 36',
            letterSpacing: "-0.01em",
          }}
        >
          Kalypso
        </span>
      </Link>

      <nav aria-label="Primary" className="flex items-center gap-7">
        <Link
          href="/demo"
          aria-current={onSandbox ? "page" : undefined}
          className={`${LINK} max-md:hidden ${onSandbox ? "text-paper" : ""}`}
        >
          Sandbox
        </Link>
        <Link href="/docs" className={LINK}>
          Docs
        </Link>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener"
          className={`${LINK} max-md:hidden`}
        >
          Source
        </a>
        {onWalletPage ? <WalletChip /> : null}
      </nav>
    </header>
  );
}
