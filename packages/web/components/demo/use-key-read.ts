"use client";

import { useCallback, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

export type KeyRead<T> = { status: "loading" } | { status: "done"; value: T } | { status: "error"; message: string };

/** One key's read of the finished sandbox. `open` starts it once; `retry` starts it again after a failure. */
export function useKeyRead<T>(load: () => Promise<T>) {
  const locale = useLocale();
  const t = useTranslations();
  const [read, setRead] = useState<KeyRead<T> | undefined>(undefined);
  const started = useRef(false);

  // The engine and core name their plain-English errors by code; anything else is a network or
  // browser fault. Another language says the engine's sentence by its code.
  const describe = useCallback(
    (err: unknown): string => {
      if (err instanceof Error && (err.name === "SandboxError" || err.name === "WorkerViewError")) {
        const code = (err as { code?: unknown }).code;
        if (locale !== "en" && typeof code === "string" && t.has(`errors.sandbox.${code}`)) return t(`errors.sandbox.${code}`);
        return locale === "en" ? err.message : t("errors.unknown");
      }
      return t("landing.ledger.unreachable");
    },
    [locale, t],
  );

  const start = useCallback(() => {
    started.current = true;
    setRead({ status: "loading" });
    load().then(
      (value) => setRead({ status: "done", value }),
      (err: unknown) => setRead({ status: "error", message: describe(err) }),
    );
  }, [load, describe]);

  const open = useCallback(() => {
    if (!started.current) start();
  }, [start]);

  return { read, open, retry: start };
}
