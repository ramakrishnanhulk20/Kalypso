"use client";

import { useTranslations } from "next-intl";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { shownErrors, visibleError } from "./shown";
import type { WorkerKit } from "./worker-lib";

// The way on when this passkey's address belongs to someone else. A new passkey has a new address,
// and its wallet is deployed and read back trusting it before the session is handed over.
export function NewPayKey({ kit, onCreated }: { kit: WorkerKit; onCreated: (worker: WorkerSession, setupFailure?: unknown) => void }) {
  const t = useTranslations("worker");
  const create = useAction(async (onProgress) => {
    onProgress({ sentence: t("signedOut.creating"), done: 0, total: 1 });
    const { worker, setupFailure } = await shownErrors(() => kit.lib.createPasskeyWorker(kit.lib.createHttpSponsor()));
    onCreated(worker, setupFailure);
    return worker;
  });
  const error = visibleError(create.error);

  return (
    <div className="mt-4">
      <StepButton action={create} onClick={() => void create.start()}>
        {t("newKey")}
      </StepButton>
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}
