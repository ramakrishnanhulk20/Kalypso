"use client";

import { useState } from "react";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import type { ShownError } from "@/components/app/errors";
import { loadFreighter } from "@/components/app/loaders";
import { PageHeading } from "@/components/app/page-heading";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { CREATING, NewPayKey } from "./new-pay-key";
import { Rise } from "./rise";
import { needsNewPayKey, shownErrors, visibleError } from "./shown";
import type { WorkerKit } from "./worker-lib";

const TITLE_STYLE = { fontVariationSettings: '"opsz" 96' } as const;
const LEAD =
  "Sign in with Face ID, your fingerprint or your device PIN. Your key is made on this device from your passkey, so only you can open your payslips. No app, no seed phrase, no fees.";
const FACTS = [
  "Your employer never sees your key.",
  "Kalypso pays the network fees for you.",
  "Payslips are sealed on Stellar; only your key opens them.",
];
const WAITING = { sentence: "Waiting for your device", done: 0, total: 1 } as const;

// The signed-out page: one calm heading, the sign-in buttons, three facts. A wallet is the
// second way in, tucked under a text link so the passkey stays the obvious choice.
export function SignedOut({ kit, onSignedIn }: { kit: WorkerKit | null; onSignedIn: (worker: WorkerSession, setupFailure?: unknown) => void }) {
  const [walletOpen, setWalletOpen] = useState(false);

  const signIn = useAction(async (onProgress) => {
    if (!kit) throw new Error("The worker code has not loaded.");
    onProgress(WAITING);
    const { worker, setupFailure } = await shownErrors(() => kit.lib.connectPasskeyWorker(kit.lib.createHttpSponsor()));
    onSignedIn(worker, setupFailure);
    return worker;
  });

  const create = useAction(async (onProgress) => {
    if (!kit) throw new Error("The worker code has not loaded.");
    onProgress(CREATING);
    const { worker, setupFailure } = await shownErrors(() => kit.lib.createPasskeyWorker(kit.lib.createHttpSponsor()));
    onSignedIn(worker, setupFailure);
    return worker;
  });

  const wallet = useAction(async () => {
    if (!kit) throw new Error("The worker code has not loaded.");
    const { connectFreighter } = await loadFreighter();
    const connected = await shownErrors(() => connectFreighter());
    const { worker } = await shownErrors(() => kit.lib.connectWalletWorker(connected));
    onSignedIn(worker);
    return worker;
  });

  const actions = [signIn, create, wallet];
  const busy = actions.some((action) => action.running);
  const start = (chosen: (typeof actions)[number], run: () => Promise<unknown>) => {
    for (const other of actions) if (other !== chosen) other.reset();
    void run();
  };

  const error: ShownError | null = visibleError(signIn.error ?? create.error ?? wallet.error);
  const prfMissing = error?.code === "PRF_UNAVAILABLE";
  const freighterMissing = error?.code === "NOT_INSTALLED";

  return (
    <div>
      <PageHeading
        eyebrow="Your pay"
        title="Your pay, sealed for you."
        lead={LEAD}
        titleClassName="mt-4 font-display text-[clamp(2.25rem,7vw,3.5rem)] font-medium leading-[1.05]"
        titleStyle={TITLE_STYLE}
      />

      <div className="mt-9 flex w-full max-w-[420px] flex-col gap-3">
        <StepButton action={signIn} className="w-full" disabled={kit === null || busy} onClick={() => start(signIn, signIn.start)}>
          Sign in with Face ID
        </StepButton>
        <StepButton variant="ghost" action={create} className="w-full" disabled={kit === null || busy} onClick={() => start(create, create.start)}>
          New here? Create your pay key
        </StepButton>
        <button
          type="button"
          className="link-draw self-start text-[0.9375rem]"
          aria-expanded={walletOpen}
          onClick={() => setWalletOpen((open) => !open)}
        >
          Use a wallet instead
        </button>
        {walletOpen ? (
          <Rise>
            <StepButton variant="ghost" action={wallet} className="w-full" disabled={kit === null || busy} onClick={() => start(wallet, wallet.start)}>
              Connect Freighter
            </StepButton>
          </Rise>
        ) : null}
      </div>

      {error ? (
        <div className="max-w-[420px]">
          <ErrorNote error={error} />
          {kit !== null && needsNewPayKey(error) ? <NewPayKey kit={kit} onCreated={onSignedIn} /> : null}
          {prfMissing ? <p role="alert" className="mt-2 font-sans text-[0.9375rem] text-fail">Try Chrome or Safari on a recent phone or laptop, or use a wallet instead.</p> : null}
          {freighterMissing ? (
            <a href="https://www.freighter.app" target="_blank" rel="noopener" className="link-draw mt-3 text-[0.9375rem]">
              Get Freighter
            </a>
          ) : null}
        </div>
      ) : null}

      <ul className="mt-10 space-y-3">
        {FACTS.map((fact) => (
          <li key={fact} className="flex items-start gap-3 font-sans text-[0.9375rem] text-muted">
            <span aria-hidden="true" className="mt-[9px] h-[6px] w-[6px] shrink-0 rounded-full bg-seal" />
            {fact}
          </li>
        ))}
      </ul>
    </div>
  );
}
