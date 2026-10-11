"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useMoneyLocale } from "@/components/key-lens/ledger-table";
import type { Locale } from "@/lib/i18n/locales";
import type { PlainT } from "@/lib/i18n/types";
import { displayUsdc } from "@/lib/money";
import type { WalletPort } from "@/lib/wallet/port";
import type { RebuiltTreasury } from "@/lib/employer";

/** What an error note needs to offer a way out: the company on screen and what to do after a rebuild. */
export interface Recovery {
  wallet: WalletPort;
  companyId: bigint;
  /** Called once a rebuild has finished, so the balance on screen is read again and the result stays visible. */
  onRebuilt: (result: RebuiltTreasury) => void;
}

const RecoveryContext = createContext<Recovery | null>(null);

export function RecoveryProvider({ value, children }: { value: Recovery; children: ReactNode }) {
  return <RecoveryContext.Provider value={value}>{children}</RecoveryContext.Provider>;
}

export function useRecovery(): Recovery | null {
  return useContext(RecoveryContext);
}

/** "nothing saved" or the figure this device had saved. t is the app namespace. */
export function expectedText(deviceExpected: bigint | undefined, locale: Locale, t: PlainT): string {
  return deviceExpected === undefined ? t("nothingSaved") : `${displayUsdc(deviceExpected, locale)} USDC`;
}

// The two figures are both shown whenever they differ, because a device that expected something
// else means the treasury moved in a way this browser did not record.
export function RebuildResult({ result }: { result: RebuiltTreasury }) {
  const t = useTranslations("app");
  const locale = useMoneyLocale();
  return (
    <div role="status" className="font-sans text-[0.9375rem] text-muted">
      <p>{t("rebuilt", { amount: displayUsdc(result.value, locale) })}</p>
      {result.matchesDevice ? null : <p className="mt-1">{t("deviceExpected", { expected: expectedText(result.deviceExpected, locale, t) })}</p>}
    </div>
  );
}
