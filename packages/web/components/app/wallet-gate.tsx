"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SealMark } from "@/components/seal-mark";
import { useSealedPayroll } from "@/hooks/use-sealed-payroll";
import { useErrorText } from "@/lib/i18n/errors";
import { showcase } from "@/lib/stack";
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

// A judge with no wallet still sees something live before the gate: the showcase company's
// payroll, read from the chain the way the landing reads it, and the way to the sandbox.
function LiveProof() {
  const t = useTranslations("app");
  const common = useTranslations("common");
  const { phase, payroll } = useSealedPayroll("accountant");
  const runs = new Set(payroll?.payments.map((payment) => payment.runId.toString())).size;
  return (
    <div className="mt-8 border-t border-line pt-6">
      <p className="font-sans text-[0.9375rem] text-muted">
        {common("noWallet")}{" "}
        <Link href="/demo" className="link-draw text-[0.9375rem] text-fg">
          {common("openSandbox")}
        </Link>
      </p>
      {phase === "done" && payroll ? (
        <p role="status" className="t-label mt-4" style={{ textTransform: "none", letterSpacing: "0.04em" }}>
          {t("liveProof", { company: showcase.label, payments: payroll.payments.length, runs })}
        </p>
      ) : null}
    </div>
  );
}

// Shows the connect card until a wallet is connected, then renders its children with that wallet
// in context. Freighter signs every transaction and key message; nothing here ever sees a key.
export function WalletGate({ heading, paragraph, children }: WalletGateProps) {
  const t = useTranslations("app");
  const errorText = useErrorText();
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
    <div className="mx-auto mt-[4vh] w-full max-w-[520px] rounded-card border border-line bg-raised p-9" style={{ boxShadow: "var(--shadow-card)" }}>
      <SealMark size={40} />
      <h1 className="mt-6 font-display text-[1.75rem] font-medium leading-[1.15] text-fg" style={DISPLAY_36}>
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
            {t("connectFreighter")}
          </StepButton>
        </div>
      )}
      {connect.error ? (
        <div role="alert" className="mt-4">
          <p className="font-sans text-[0.9375rem] text-fail">{errorText(connect.error)}</p>
          {notInstalled ? (
            <a href="https://www.freighter.app" target="_blank" rel="noopener" className="link-draw mt-3 text-[0.9375rem]">
              {t("getFreighter")}
            </a>
          ) : null}
        </div>
      ) : null}
      <LiveProof />
    </div>
  );
}
