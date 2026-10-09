"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { WalletPort } from "@/lib/wallet/port";
import { loadEmployer } from "./loaders";

interface Session {
  wallet: WalletPort | null;
  connected(wallet: WalletPort): void;
  /** Forgets the wallet in this tab, and the keys and prover it made. */
  disconnect(): void;
  /** A status line while a development wallet is being made. Always null in a production build. */
  devNote: string | null;
}

const SessionContext = createContext<Session | null>(null);
const WalletContext = createContext<WalletPort | null>(null);

/** The session the page-level provider holds, or null on pages that have none. The header reads this. */
export function useWalletSession(): Session | null {
  return useContext(SessionContext);
}

/** The connected wallet. Only components inside a WalletGate may call this. */
export function useWallet(): WalletPort {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet needs a connected wallet. Render it inside a WalletGate.");
  return wallet;
}

export function WalletProvider({ wallet, children }: { wallet: WalletPort; children: ReactNode }) {
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

// Wraps a whole page, header included, so the header's wallet chip and the gate share one wallet.
export function WalletSession({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<WalletPort | null>(null);
  const [devNote, setDevNote] = useState<string | null>(null);
  const [devExtras, setDevExtras] = useState<ReactNode>(null);

  useEffect(() => {
    // The whole block is a build-time constant: a production build drops it, and with it the
    // development wallet module, so the URL flag does nothing there.
    if (process.env.NODE_ENV !== "production") {
      if (new URLSearchParams(window.location.search).get("wallet") !== "throwaway") return;
      let current = true;
      setDevNote("Preparing a development wallet");
      import("./dev-wallet").then(
        async (dev) => {
          try {
            const made = await dev.prepareDevWallet((note) => current && setDevNote(note));
            if (!current) return;
            setDevExtras(dev.devBadge());
            setDevNote(null);
            setWallet(made);
          } catch (err) {
            if (current) setDevNote(err instanceof Error ? err.message : "The development wallet could not be made.");
          }
        },
        () => current && setDevNote("The development wallet module did not load."),
      );
      return () => {
        current = false;
      };
    }
  }, []);

  const disconnect = useCallback(() => {
    setWallet(null);
    loadEmployer().then(
      (lib) => {
        lib.forgetWalletKeys();
        void lib.releaseProver();
      },
      () => undefined,
    );
  }, []);

  const value = useMemo<Session>(() => ({ wallet, connected: setWallet, disconnect, devNote }), [wallet, disconnect, devNote]);

  return (
    <SessionContext.Provider value={value}>
      {children}
      {devExtras}
    </SessionContext.Provider>
  );
}
