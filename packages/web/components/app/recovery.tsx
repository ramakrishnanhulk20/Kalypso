"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
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

export function expectedText(deviceExpected: bigint | undefined): string {
  return deviceExpected === undefined ? "nothing saved" : `${displayUsdc(deviceExpected)} USDC`;
}

// The two figures are both shown whenever they differ, because a device that expected something
// else means the treasury moved in a way this browser did not record.
export function RebuildResult({ result }: { result: RebuiltTreasury }) {
  return (
    <div role="status" className="font-sans text-[0.9375rem] text-muted">
      <p>
        Rebuilt from chain: <span className="text-paper">{displayUsdc(result.value)} USDC</span>.
      </p>
      {result.matchesDevice ? null : <p className="mt-1">This device expected {expectedText(result.deviceExpected)}.</p>}
    </div>
  );
}
