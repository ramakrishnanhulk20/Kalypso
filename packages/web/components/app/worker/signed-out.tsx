"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import type { ShownError } from "@/components/app/errors";
import { loadFreighter } from "@/components/app/loaders";
import { PageHeading } from "@/components/app/page-heading";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { NewPayKey } from "./new-pay-key";
import { Rise } from "./rise";
import { needsNewPayKey, shownErrors, visibleError } from "./shown";
import type { WorkerKit } from "./worker-lib";

const TITLE_STYLE = { fontVariationSettings: '"opsz" 96' } as const;

// The signed-out page: one calm heading, the sign-in buttons, three facts. A wallet is the
// second way in, tucked under a text link so the passkey stays the obvious choice.
export function SignedOut({ kit, onSignedIn }: { kit: WorkerKit | null; onSignedIn: (worker: WorkerSession, setupFailure?: unknown) => void }) {
  const t = useTranslations("worker.signedOut");
  const app = useTranslations("app");
  const [walletOpen, setWalletOpen] = useState(false);

  const signIn = useAction(async (onProgress) => {
    if (!kit) throw new Error(t("notLoaded"));
    onProgress({ sentence: t("waiting"), done: 0, total: 1 });
    const { worker, setupFailure } = await shownErrors(() => kit.lib.connectPasskeyWorker(kit.lib.createHttpSponsor()));
    onSignedIn(worker, setupFailure);
    return worker;
  });

  const create = useAction(async (onProgress) => {
    if (!kit) throw new Error(t("notLoaded"));
    onProgress({ sentence: t("creating"), done: 0, total: 1 });
    const { worker, setupFailure } = await shownErrors(() => kit.lib.createPasskeyWorker(kit.lib.createHttpSponsor()));
    onSignedIn(worker, setupFailure);
    return worker;
  });

  const wallet = useAction(async () => {
    if (!kit) throw new Error(t("notLoaded"));
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
  const facts = [t("fact1"), t("fact2"), t("fact3")];

  return (
    <div>
      <PageHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        lead={t("lead")}
        titleClassName="mt-4 font-display text-[clamp(2.25rem,7vw,3.5rem)] font-medium leading-[1.05]"
        titleStyle={TITLE_STYLE}
      />

      <p className="mt-7 max-w-[34rem] font-sans text-[0.9375rem] text-muted">{t("invite")}</p>

      <div className="mt-6 flex w-full max-w-[420px] flex-col gap-3">
        <StepButton action={create} className="w-full" disabled={kit === null || busy} onClick={() => start(create, create.start)}>
          {t("create")}
        </StepButton>
        <p className="font-sans text-[0.875rem] text-muted">{t("passkeyNote")}</p>
        <p className="t-label mt-3">{t("haveKey")}</p>
        <StepButton variant="ghost" action={signIn} className="w-full" disabled={kit === null || busy} onClick={() => start(signIn, signIn.start)}>
          {t("signIn")}
        </StepButton>
        <button
          type="button"
          className="link-draw self-start py-2 text-[0.9375rem]"
          aria-expanded={walletOpen}
          onClick={() => setWalletOpen((open) => !open)}
        >
          {t("useWallet")}
        </button>
        {walletOpen ? (
          <Rise>
            <StepButton variant="ghost" action={wallet} className="w-full" disabled={kit === null || busy} onClick={() => start(wallet, wallet.start)}>
              {app("connectFreighter")}
            </StepButton>
          </Rise>
        ) : null}
        <p className="font-sans text-[0.875rem] text-muted">{t("devices")}</p>
      </div>

      {error ? (
        <div className="max-w-[420px]">
          <ErrorNote error={error} />
          {kit !== null && needsNewPayKey(error) ? <NewPayKey kit={kit} onCreated={onSignedIn} /> : null}
          {prfMissing ? <p role="alert" className="mt-2 font-sans text-[0.9375rem] text-fail">{t("prfHint")}</p> : null}
          {freighterMissing ? (
            <a href="https://www.freighter.app" target="_blank" rel="noopener" className="link-draw mt-3 text-[0.9375rem]">
              {app("getFreighter")}
            </a>
          ) : null}
        </div>
      ) : null}

      <section aria-label={t("lostLabel")} className="mt-8 max-w-[420px]">
        <p className="t-label">{t("lostLabel")}</p>
        <p className="mt-2 font-sans text-[0.9375rem] text-muted">{t("lostText")}</p>
      </section>

      <ul className="mt-10 space-y-3">
        {facts.map((fact) => (
          <li key={fact} className="flex items-start gap-3 font-sans text-[0.9375rem] text-muted">
            <span aria-hidden="true" className="mt-[9px] h-[6px] w-[6px] shrink-0 rounded-full bg-seal" />
            {fact}
          </li>
        ))}
      </ul>
    </div>
  );
}
