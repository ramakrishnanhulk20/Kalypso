"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { SandboxResult } from "@/lib/sandbox/engine";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { loadEngine } from "./engine";
import type { Engine } from "./engine";
import { Intro } from "./intro";
import { FRESH_RUN, reduceRun } from "./run-state";
import { ResultView } from "./result-view";
import { RunView } from "./run-view";
import { readSavedProgress } from "./saved";
import type { Salaries } from "./salary-card";

type View = "boot" | "intro" | "run" | "result";

// Stopping a run on purpose (leaving the page, starting over) is not a failure to show.
function isStopped(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "SandboxResetError");
}

export function DemoApp() {
  const t = useTranslations("sandbox.run");
  const errors = useTranslations("errors.sandbox");
  const locale = useLocale();
  const [view, setView] = useState<View>("boot");
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [run, dispatch] = useReducer(reduceRun, FRESH_RUN);
  const salaries = useRef<Salaries | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  // The engine's own sentence in English; by code in any other language (the engine is not translated).
  const describe = useCallback(
    (err: unknown): { message: string; code: string | null } => {
      if (err instanceof Error && err.name === "SandboxError") {
        const code = (err as { code?: unknown }).code;
        const known = typeof code === "string" ? code : null;
        if (locale !== "en" && known !== null && errors.has(known)) return { message: errors(known), code: known };
        return { message: err.message, code: known };
      }
      return { message: t("unexpected"), code: null };
    },
    [errors, locale, t],
  );

  useEffect(() => {
    mounted.current = true;
    let current = true;
    (async () => {
      try {
        const loaded = await loadEngine();
        const finished = loaded.loadSandbox();
        const saved = finished === null ? await readSavedProgress() : null;
        if (!current) return;
        setEngine(loaded);
        if (finished !== null) {
          setResult(finished);
          setView("result");
          return;
        }
        if (saved !== null) {
          salaries.current = saved.amounts;
          dispatch({ type: "saved", frontier: saved.frontier });
          setView("run");
          return;
        }
      } catch {
        // A save or a chunk that cannot be read leaves the intro; Start reports the real problem if it persists.
      }
      if (current) setView("intro");
    })();
    return () => {
      current = false;
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useLeaveWarning(run.running);

  useEffect(() => {
    if (view !== "boot") window.scrollTo({ top: 0 });
  }, [view]);

  const runWith = useCallback(
    async (amounts: Salaries) => {
      const stop = new AbortController();
      controller.current = stop;
      dispatch({ type: "begin" });
      try {
        const loaded = await loadEngine();
        const finished = await loaded.runSandbox({
          amounts,
          signal: stop.signal,
          onProgress: (progress) => {
            if (mounted.current && !stop.signal.aborted) dispatch({ type: "progress", progress, at: Date.now() });
          },
        });
        if (!mounted.current || stop.signal.aborted) return;
        setEngine(loaded);
        dispatch({ type: "stop" });
        setResult(finished);
        setView("result");
      } catch (err) {
        if (!mounted.current || stop.signal.aborted || isStopped(err)) return;
        const shown = describe(err);
        dispatch({ type: "fail", message: shown.message, code: shown.code });
      }
    },
    [describe],
  );

  const start = useCallback(
    (amounts: Salaries) => {
      salaries.current = amounts;
      setView("run");
      void runWith(amounts);
    },
    [runWith],
  );

  const again = useCallback(() => {
    if (salaries.current) void runWith(salaries.current);
  }, [runWith]);

  const startOver = useCallback(async () => {
    if (!window.confirm(t("confirmStartOver"))) return;
    controller.current?.abort();
    try {
      (await loadEngine()).reset();
    } catch {
      // Nothing was saved that could be forgotten.
    }
    salaries.current = null;
    dispatch({ type: "clear" });
    setResult(null);
    setView("intro");
  }, [t]);

  return (
    <div className="mx-auto w-full max-w-[1240px]" style={{ minHeight: "60vh" }}>
      {view === "intro" ? <Intro onStart={start} /> : null}
      {view === "run" ? <RunView run={run} onResume={again} onTryAgain={again} onStartOver={startOver} /> : null}
      {view === "result" && result && engine ? <ResultView result={result} engine={engine} onStartOver={startOver} /> : null}
    </div>
  );
}
