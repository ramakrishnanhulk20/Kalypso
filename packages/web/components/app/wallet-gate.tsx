"use client";

import type { ReactNode } from "react";
import { SealMark } from "@/components/seal-mark";
import { loadFreighter } from "./loaders";
import { StepButton } from "./step-button";
import { useAction } from "./use-action";
import { WalletProvider, useWalletSession } from "./wallet-session";

const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } as const;

type WalletGateProps = {
  heading: string;
  paragraph: string;
  children: ReactNode;
};

// Shows the connect card until a wallet is connected, then renders its children with that wallet
// in context. Freighter signs every transaction and key message; nothing here ever sees a key.
export function WalletGate({ heading, paragraph, children }: WalletGateProps) {
  const session = useWalletSession();
  const connect = useAction(async () => {
    const { connectFreighter } = await loadFreighter();
    const wallet = await connectFreighter();
    session?.connected(wallet);
    return wallet;
  });

  if (session?.wallet) return <WalletProvider wallet={session.wallet}>{children}</WalletProvider>;

  const notInstalled = connect.error?.code === "NOT_INSTALLED";
  return (
    <div className="mx-auto mt-[4vh] w-full max-w-[520px] rounded-card border border-line bg-ink-2 p-9" style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.45)" }}>
      <SealMark size={40} />
      <h1 className="mt-6 font-display text-[1.75rem] font-medium leading-[1.15] text-paper" style={DISPLAY_36}>
        {heading}
      </h1>
      <p className="mt-3 font-sans text-base text-muted">{paragraph}</p>
      {session?.devNote ? (
        <p role="status" className="t-label mt-7" style={{ textTransform: "none", letterSpacing: "0.04em" }}>
          {session.devNote}
        </p>
      ) : (
        <div className="mt-7">
          <StepButton action={connect} onClick={() => void connect.start()}>
            Connect Freighter
          </StepButton>
        </div>
      )}
      {connect.error ? (
        <div role="alert" className="mt-4">
          <p className="font-sans text-[0.9375rem] text-fail">{connect.error.message}</p>
          {notInstalled ? (
            <a href="https://www.freighter.app" target="_blank" rel="noopener" className="link-draw mt-3 text-[0.9375rem]">
              Get Freighter
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
