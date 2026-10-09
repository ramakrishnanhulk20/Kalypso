"use client";

import { loadEmployer } from "./loaders";
import { RebuildResult, useRecovery } from "./recovery";
import { StepButton } from "./step-button";
import { useAction } from "./use-action";
import type { ShownError } from "./errors";

const CONFIRM_CLEAR = "Clear this device's damaged payment record? Saved balances stay; the next step reads the chain again.";

// The error's own message, and the way out when there is one: rebuild the treasury from the chain,
// or clear a damaged record of a payment in flight. Both need the company on screen, so they show
// only inside the dashboard.
export function ErrorNote({ error }: { error: ShownError }) {
  const recovery = useRecovery();

  const rebuild = useAction(async (onProgress) => {
    if (!recovery) throw new Error("No company is open.");
    const lib = await loadEmployer();
    const result = await lib.rebuildTreasury(recovery.wallet, recovery.companyId, onProgress);
    recovery.onRebuilt(result);
    return result;
  });

  const clear = useAction(async () => {
    if (!recovery) throw new Error("No company is open.");
    const lib = await loadEmployer();
    return lib.clearDamagedRecord(recovery.wallet, recovery.companyId);
  });

  const askToClear = () => {
    if (window.confirm(CONFIRM_CLEAR)) void clear.start();
  };

  return (
    <div role="alert" data-error={error.code ?? error.kind} className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-3">
      <p className="max-w-[40rem] font-sans text-[0.9375rem] text-fail">{error.message}</p>

      {recovery && error.rebuildable && rebuild.value === undefined ? (
        <StepButton variant="ghost" action={rebuild} onClick={() => void rebuild.start()}>
          Rebuild from chain
        </StepButton>
      ) : null}
      {recovery && error.damaged && clear.value === undefined ? (
        <StepButton variant="ghost" action={clear} onClick={askToClear}>
          Clear the damaged record
        </StepButton>
      ) : null}

      {rebuild.value ? (
        <div className="basis-full">
          <RebuildResult result={rebuild.value} />
        </div>
      ) : null}
      {clear.value ? (
        <p role="status" className="basis-full font-sans text-[0.9375rem] text-muted">
          {clear.value.cleared ? "Cleared. Try the step again." : "There was nothing to clear."}
        </p>
      ) : null}
      {rebuild.error ? (
        <div className="basis-full">
          <ErrorNote error={rebuild.error} />
        </div>
      ) : null}
      {clear.error ? (
        <div className="basis-full">
          <ErrorNote error={clear.error} />
        </div>
      ) : null}
    </div>
  );
}
