"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import type { ShownError } from "@/components/app/errors";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { NewPayKey } from "./new-pay-key";
import { finishSetupCopy } from "./setup-gate";
import { needsNewPayKey, shownErrors } from "./shown";
import type { WorkerKit } from "./worker-lib";

// The signed-in screen for a passkey worker whose address is not proven, with no invite to join:
// the reason, and a way to run the same deploy and chain checks again. A wallet not on chain yet
// gets Finish setting up. A wallet on chain whose birth is not confirmed gets Check again, with
// the payslips still shown below, and when its birth could not be confirmed, a link to make a new
// pay key instead. A taken address ends here too, with a new pay key as the only way on.
export function FinishSetup({
  kit,
  worker,
  reason,
  onDone,
  onNewWorker,
}: {
  kit: WorkerKit;
  worker: WorkerSession;
  reason: ShownError | null;
  onDone: () => void;
  onNewWorker: (worker: WorkerSession, setupFailure?: unknown) => void;
}) {
  const t = useTranslations("worker.finish");
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const finish = useAction(async (onProgress) => {
    onProgress({ sentence: t("settingUp"), done: 0, total: 1 });
    const done = await shownErrors(() => kit.lib.finishWalletSetup(worker, kit.lib.createHttpSponsor()));
    onDone();
    return done;
  });
  const error = finish.error ?? (finish.state.phase === "idle" ? reason : null);
  const copy = finishSetupCopy({ onChain: kit.lib.walletOnChain(worker), reasonCode: reason?.code }, t);

  return (
    <section aria-label={t("label")} className="mt-8 rounded-card border border-line bg-raised p-6">
      <h2 className="font-display text-[1.5rem] font-medium leading-[1.15] text-fg">{copy.heading}</h2>
      <p className="mt-3 font-sans text-base text-muted">{copy.text}</p>
      {error ? <ErrorNote error={error} /> : null}
      {needsNewPayKey(error) ? (
        <NewPayKey kit={kit} onCreated={onNewWorker} />
      ) : (
        <div className={copy.offerNewKey ? "mt-6 flex flex-col gap-3" : "mt-6"}>
          <StepButton action={finish} className="w-full" onClick={() => void finish.start()}>
            {copy.button}
          </StepButton>
          {copy.offerNewKey ? (
            newKeyOpen ? (
              <NewPayKey kit={kit} onCreated={onNewWorker} />
            ) : (
              <button type="button" className="link-draw self-start py-2 text-[0.9375rem]" onClick={() => setNewKeyOpen(true)}>
                {t("newKeyInstead")}
              </button>
            )
          ) : null}
        </div>
      )}
    </section>
  );
}
