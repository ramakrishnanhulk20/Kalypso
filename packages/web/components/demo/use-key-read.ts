"use client";

import { useCallback, useRef, useState } from "react";

export type KeyRead<T> = { status: "loading" } | { status: "done"; value: T } | { status: "error"; message: string };

const UNREACHABLE = "Couldn't reach Stellar testnet just now.";

// The engine and core name their plain-English errors; anything else is a network or browser fault.
function describe(err: unknown): string {
  if (err instanceof Error && (err.name === "SandboxError" || err.name === "WorkerViewError")) return err.message;
  return UNREACHABLE;
}

/** One key's read of the finished sandbox. `open` starts it once; `retry` starts it again after a failure. */
export function useKeyRead<T>(load: () => Promise<T>) {
  const [read, setRead] = useState<KeyRead<T> | undefined>(undefined);
  const started = useRef(false);

  const start = useCallback(() => {
    started.current = true;
    setRead({ status: "loading" });
    load().then(
      (value) => setRead({ status: "done", value }),
      (err: unknown) => setRead({ status: "error", message: describe(err) }),
    );
  }, [load]);

  const open = useCallback(() => {
    if (!started.current) start();
  }, [start]);

  return { read, open, retry: start };
}
