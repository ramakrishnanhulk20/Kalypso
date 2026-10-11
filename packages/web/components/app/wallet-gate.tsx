"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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

// A visitor with no wallet still sees something live before the gate: the showcase company's
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

const NEEDS = ["need1", "need2", "need3", "need4", "need5"] as const;

// What a person with no wallet needs and does before the connect button works. Freighter is a
// desktop browser extension, so a phone is sent to the sandbox first instead of into steps it
// cannot finish. The employer also sees what the whole setup asks of them, before they start.
function BeforeYouStart() {
  const t = useTranslations("app");
  const common = useTranslations("common");
  const pathname = usePathname();
  const employer = pathname.startsWith("/employer");
  const link = "link-draw text-[0.9375rem] text-fg";
  return (
    <div className="mt-7 border-t border-line pt-6">
      <p className="t-label">{t("before.label")}</p>
      <p className="mt-4 font-sans text-[0.9375rem] text-fg">{t("before.computer")}</p>
      <div className="mt-4 md:hidden">
        <p className="font-sans text-[0.9375rem] text-muted">{t("before.phone")}</p>
        <Link href="/demo" className="btn-ghost mt-3 w-full">
          {common("openSandbox")}
        </Link>
      </div>
      {employer ? (
        <div className="mt-6">
          <p className="t-label">{t("before.needLabel")}</p>
          <ul className="mt-3 space-y-2 font-sans text-[0.9375rem] text-muted">
            {NEEDS.map((key) => (
              <li key={key} className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-[9px] h-[5px] w-[5px] shrink-0 rounded-full bg-seal" />
                <span>{t(`before.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ol className="mt-6 list-decimal space-y-2 pl-5 font-sans text-[0.9375rem] text-muted">
        <li>
          {t.rich("before.step1", {
            site: (chunks) => (
              <a href="https://www.freighter.app" target="_blank" rel="noopener" className={link}>
                {chunks}
              </a>
            ),
          })}
        </li>
        <li>{t("before.step2")}</li>
        <li>{t("before.step3")}</li>
      </ol>
      {employer ? (
        <p className="mt-4 font-sans text-[0.9375rem] text-muted">
          {t.rich("before.accountantFirst", {
            accountant: (chunks) => (
              <Link href="/accountant" className={link}>
                {chunks}
              </Link>
            ),
            sandbox: (chunks) => (
              <Link href="/demo" className={link}>
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}
    </div>
  );
}

// The site nav links to /employer#test-funds. Before connecting, this block is that target; after,
// the console's TestFundsCard is. The gate and the console never render at the same time.
function TestMoneyNote() {
  const t = useTranslations("app.testMoney");
  const pathname = usePathname();
  const employer = pathname.startsWith("/employer");
  if (!employer && !pathname.startsWith("/accountant")) return null;
  return (
    <div id="test-funds" className="mt-7 border-t border-line pt-6" style={{ scrollMarginTop: 96 }}>
      <p className="t-label">{t("label")}</p>
      <p className="mt-3 font-sans text-[0.9375rem] text-muted">{employer ? t("employer") : t("accountant")}</p>
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
      <BeforeYouStart />
      <TestMoneyNote />
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
