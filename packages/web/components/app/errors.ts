// The lib throws ConsoleError and WalletError. They are matched by name, like the sandbox page does
// for SandboxError, so this file never has to pull the chain code into the page's first load.

const UNEXPECTED =
  "Something unexpected stopped this step. Check your connection and try again; Kalypso carries on from what is on chain.";

export interface ShownError {
  message: string;
  /** The lib's own code when it gave one. */
  code: string | undefined;
  /** True when rebuilding the treasury from the chain clears it. */
  rebuildable: boolean;
  /** True when this browser's record of a payment in flight is damaged. */
  damaged: boolean;
  /** The error's class name, for the page's data attribute only. */
  kind: string;
}

/** A sentence the page itself wrote to show as an error. */
export class ShownMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShownMessage";
  }
}

const PLAIN_NAMES = new Set(["ConsoleError", "WalletError", "ShownMessage"]);

// Where the page words a refusal its own way, the page's sentence wins over the lib's.
const OWN_WORDS: Record<string, string> = {
  DEPOSIT_PENDING: "A deposit is still waiting on the network. Try again in a minute.",
};

export function describeError(err: unknown): ShownError {
  if (err instanceof Error && PLAIN_NAMES.has(err.name)) {
    const { code, rebuildable } = err as { code?: unknown; rebuildable?: unknown };
    return {
      message: (typeof code === "string" ? OWN_WORDS[code] : undefined) ?? err.message,
      code: typeof code === "string" ? code : undefined,
      rebuildable: rebuildable === true,
      damaged: code === "RECORD_DAMAGED",
      kind: err.name,
    };
  }
  return { message: UNEXPECTED, code: undefined, rebuildable: false, damaged: false, kind: err instanceof Error ? err.name : "unknown" };
}

/** The lib's CSV problems carried by a refused run, or an empty list. */
export function problemsOf(err: unknown): { line: number; sentence: string }[] {
  const list = err instanceof Error && err.name === "ConsoleError" ? (err as { problems?: unknown }).problems : undefined;
  return Array.isArray(list) ? list.filter((p): p is { line: number; sentence: string } => typeof p?.sentence === "string") : [];
}
