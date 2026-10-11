"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { WalletChip } from "@/components/app/wallet-chip";
import { useWalletSession } from "@/components/app/wallet-session";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SealMark } from "@/components/seal-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { REPO_URL } from "@/lib/links";

const LINK = "link-draw text-[0.9375rem]";

export function AppHeader() {
  const t = useTranslations("common");
  const pathname = usePathname();
  const onSandbox = pathname === "/demo";
  const onWalletPage = pathname === "/employer" || pathname === "/accountant";
  // At phone width the wordmark, the wallet chip and the two switches fill the bar, so the docs
  // link steps aside while a wallet is connected; the landing page and the gate still carry it.
  const session = useWalletSession();
  const chipShown = onWalletPage && session?.wallet?.address !== undefined;

  return (
    <header
      className="sticky top-0 z-40 flex h-[72px] items-center justify-between gap-4 border-b border-line px-[4vw]"
      style={{
        background: "color-mix(in srgb, var(--color-canvas) 85%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href="/"
          aria-label={t("home")}
          className="logo-link flex items-center gap-[10px]"
        >
          <SealMark size={24} />
          <span
            className="font-display text-[1.25rem] font-medium text-fg"
            style={{
              fontVariationSettings: '"opsz" 36',
              letterSpacing: "-0.01em",
            }}
          >
            Kalypso
          </span>
        </Link>
        <span className="t-label rounded-[6px] border border-line px-2 py-[3px] max-md:hidden">{t("testnet")}</span>
      </div>

      <nav aria-label={t("nav.label")} className="flex items-center gap-x-7 max-md:gap-x-3">
        <Link
          href="/demo"
          aria-current={onSandbox ? "page" : undefined}
          className={`${LINK} max-md:hidden ${onSandbox ? "text-fg" : ""}`}
        >
          {t("nav.sandbox")}
        </Link>
        <Link href="/docs" className={`${LINK} ${chipShown ? "max-md:hidden" : ""}`}>
          <span className="max-md:hidden">{t("nav.docs")}</span>
          <span className="md:hidden">{t("nav.docsShort")}</span>
        </Link>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener"
          className={`${LINK} max-md:hidden`}
        >
          {t("nav.source")}
        </a>
        {onWalletPage ? <WalletChip /> : null}
        <span className="flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
        </span>
      </nav>
    </header>
  );
}
