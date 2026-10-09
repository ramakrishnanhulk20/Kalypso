import { ShownMessage, describeError } from "../errors";
import type { ShownError } from "../errors";

/** The portal's own errors carry a code and a finished sentence; this is what a screen needs from one. */
export interface WorkerFailure {
  code: string;
  hash: string | undefined;
}

/**
 * The lib's WorkerError and SponsorError are not names the shared error describer knows, so they
 * are rewrapped as a ShownMessage that keeps their code and transaction hash. Anything else
 * (Freighter's WalletError, an unknown failure) passes through to the describer unchanged.
 */
export function asShown(err: unknown): unknown {
  const name = (err as { name?: unknown } | null)?.name;
  if (name !== "WorkerError" && name !== "SponsorError") return err;
  const { code, message, hash } = err as { code: string; message: string; hash?: string };
  return Object.assign(new ShownMessage(message), { code, hash });
}

/** Runs a step and rewraps whatever it throws, so the shared action hook shows the lib's own sentence. */
export async function shownErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asShown(err);
  }
}

/** A thrown value read as a ShownError, for state that is not kept by the action hook. */
export function shownFrom(err: unknown): ShownError {
  return describeError(asShown(err));
}

export function failureOf(cause: unknown): WorkerFailure | null {
  const { code, hash } = (cause ?? {}) as { code?: unknown; hash?: unknown };
  return typeof code === "string" ? { code, hash: typeof hash === "string" ? hash : undefined } : null;
}

/** A closed or cancelled device prompt is the worker changing their mind, not a fault, so nothing is shown. */
export function visibleError(error: ShownError | null): ShownError | null {
  return error !== null && error.code === "PASSKEY_CANCELLED" ? null : error;
}

/**
 * True when this passkey's address belongs to someone else: a wallet there trusts another key or
 * runs other code. The address stays hidden, and the only way on is a new pay key (C51).
 */
export function needsNewPayKey(error: { code: string | undefined } | null): boolean {
  return error?.code === "ADDRESS_TAKEN" || error?.code === "PASSKEY_NOT_THIS_WALLET";
}
