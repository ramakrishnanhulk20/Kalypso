"use client";

// Development only. wallet-session.tsx loads this behind a NODE_ENV check, so a production build
// has neither this file nor the throwaway wallet it uses. It gives the builder a wallet that
// signs without a browser extension, for live runs and screenshots on testnet.
import { createFriendbot, createLedgerPort, ensureFunded } from "@/lib/sandbox/accounts";
import { sandboxConfig } from "@/lib/sandbox/config";
import { Keypair } from "@/lib/sandbox/sdk";
import type { WalletPort } from "@/lib/wallet/port";
import { throwawayWallet } from "@/lib/wallet/throwaway";

const STORAGE_KEY = "kalypso/dev-wallet/v1";

let preparing: Promise<WalletPort> | undefined;

/**
 * One keypair per tab, kept in sessionStorage so a reload keeps the same wallet. React's
 * development double-run of effects must not ask friendbot twice, so the work is done once.
 */
export function prepareDevWallet(onNote: (note: string) => void): Promise<WalletPort> {
  preparing ??= makeDevWallet(onNote).catch((err: unknown) => {
    preparing = undefined;
    throw err;
  });
  return preparing;
}

async function makeDevWallet(onNote: (note: string) => void): Promise<WalletPort> {
  let secret = window.sessionStorage.getItem(STORAGE_KEY);
  if (secret === null) {
    secret = Keypair.random().secret();
    window.sessionStorage.setItem(STORAGE_KEY, secret);
  }
  const keypair = Keypair.fromSecret(secret);
  const config = sandboxConfig();
  onNote("Asking friendbot for test XLM for the development wallet");
  await ensureFunded(keypair.publicKey(), { ledger: createLedgerPort(config), friendbot: createFriendbot(config) });
  return throwawayWallet(keypair);
}

export function devBadge() {
  return (
    <p className="t-label pointer-events-none fixed bottom-4 left-4 z-50 rounded-button border border-line bg-ink-2 px-2 py-1">
      dev wallet
    </p>
  );
}
