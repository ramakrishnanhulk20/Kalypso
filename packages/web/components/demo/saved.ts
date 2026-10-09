import { indexOfStep } from "./shots";

export interface SavedProgress {
  /** Index of the step the saved sandbox had reached. */
  frontier: number;
  /** Handed back to runSandbox on resume. The engine ignores them for a sandbox already under way. */
  amounts: [bigint, bigint, bigint];
}

// loadSandbox() answers only for a finished sandbox. This reads the same save to find one that
// stopped part-way, and keeps just the step and the salaries: the account keys in it are never held.
export async function readSavedProgress(): Promise<SavedProgress | null> {
  const [{ openSession }, { sandboxConfig }] = await Promise.all([import("@/lib/sandbox/storage"), import("@/lib/sandbox/config")]);
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return null;
  }
  const state = openSession(storage, sandboxConfig().contracts).load();
  if (state === null || state.step === "done") return null;
  return { frontier: indexOfStep(state.step), amounts: [...state.amounts] };
}
