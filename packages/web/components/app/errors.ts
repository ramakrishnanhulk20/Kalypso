// The lib throws ConsoleError and WalletError. They are matched by name, like the sandbox page does
// for SandboxError, so this file never has to pull the chain code into the page's first load.

const UNEXPECTED =
  "Something unexpected stopped this step. Check your connection and try again; Kalypso carries on from what is on chain.";

/** Which table of translated sentences an error's code belongs to (messages/*.json, "errors"). */
export type ErrorFamily = "console" | "worker" | "sponsor" | "wallet";

export interface ShownError {
  message: string;
  /** The lib's own code when it gave one. */
  code: string | undefined;
  /** The code's family, so another language can look the sentence up by code. */
  family: ErrorFamily | undefined;
  /** For a sentence the page itself wrote: its message key and values, so other languages can say it too. */
  key: string | undefined;
  values: Record<string, string | number> | undefined;
  /** True when rebuilding the treasury from the chain clears it. */
  rebuildable: boolean;
  /** True when this browser's record of a payment in flight is damaged. */
  damaged: boolean;
  /** The error's class name, for the page's data attribute only. */
  kind: string;
}

type ShownMessageOptions = { key?: string; values?: Record<string, string | number> };

/** A sentence the page itself wrote to show as an error, with the message key that says it in any language. */
export class ShownMessage extends Error {
  readonly key: string | undefined;
  readonly values: Record<string, string | number> | undefined;

  constructor(message: string, options: ShownMessageOptions = {}) {
    super(message);
    this.name = "ShownMessage";
    this.key = options.key;
    this.values = options.values;
  }
}

const PLAIN_NAMES = new Set(["ConsoleError", "WalletError", "ShownMessage"]);

const FAMILY_OF_NAME: Record<string, ErrorFamily> = { ConsoleError: "console", WalletError: "wallet" };

// Where the page words a refusal its own way, the page's sentence wins over the lib's.
const OWN_WORDS: Record<string, string> = {
  DEPOSIT_PENDING: "A deposit is still waiting on the network. Try again in a minute.",
};

export function describeError(err: unknown): ShownError {
  if (err instanceof Error && PLAIN_NAMES.has(err.name)) {
    const { code, rebuildable, family, key, values } = err as {
      code?: unknown;
      rebuildable?: unknown;
      family?: unknown;
      key?: unknown;
      values?: unknown;
    };
    const named = typeof family === "string" ? (family as ErrorFamily) : FAMILY_OF_NAME[err.name];
    return {
      message: (typeof code === "string" ? OWN_WORDS[code] : undefined) ?? err.message,
      code: typeof code === "string" ? code : undefined,
      family: named,
      key: typeof key === "string" ? key : undefined,
      values: values && typeof values === "object" ? (values as Record<string, string | number>) : undefined,
      rebuildable: rebuildable === true,
      damaged: code === "RECORD_DAMAGED",
      kind: err.name,
    };
  }
  return {
    message: UNEXPECTED,
    code: undefined,
    family: undefined,
    key: undefined,
    values: undefined,
    rebuildable: false,
    damaged: false,
    kind: err instanceof Error ? err.name : "unknown",
  };
}

type CsvProblemShown = { line: number; code: string; sentence: string; amount?: string };

/** The lib's CSV problems carried by a refused run, or an empty list. amount, when present, must be text. */
export function problemsOf(err: unknown): CsvProblemShown[] {
  const list = err instanceof Error && err.name === "ConsoleError" ? (err as { problems?: unknown }).problems : undefined;
  return Array.isArray(list)
    ? list.filter(
        (p): p is CsvProblemShown =>
          typeof p?.sentence === "string" && typeof p?.code === "string" && (p.amount === undefined || typeof p.amount === "string"),
      )
    : [];
}
