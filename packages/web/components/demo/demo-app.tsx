"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { SandboxResult } from "@/lib/sandbox/engine";
import { loadEngine } from "./engine";
import type { Engine } from "./engine";
import { Intro } from "./intro";
import { FRESH_RUN, reduceRun } from "./run-state";
import { ResultView } from "./result-view";
import { RunView } from "./run-view";
import { readSavedProgress } from "./saved";
import type { Salaries } from "./salary-card";

type View = "boot" | "intro" | "run" | "result";

const UNEXPECTED = "Something unexpected stopped the sandbox. Your progress is saved; try again.";
const CONFIRM_START_OVER = "Start over? This sandbox's company stays on testnet, but this browser forgets it.";

function describe(err: unknown): string {
  return err instanceof Error && err.name === "SandboxError" ? err.message : UNEXPECTED;
}

// Stopping a run on purpose (leaving the page, starting over) is not a failure to show.
function isStopped(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "SandboxResetError");
}

export function DemoApp() {
  const [view, setView] = useState<View>("boot");
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [run, dispatch] = useReducer(reduceRun, FRESH_RUN);
  const salaries = useRef<Salaries | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);

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

  const running = run.running;
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  useEffect(() => {
    if (view !== "boot") window.scrollTo({ top: 0 });
  }, [view]);

  const runWith = useCallback(async (amounts: Salaries) => {
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
      dispatch({ type: "fail", message: describe(err) });
    }
  }, []);

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
    if (!window.confirm(CONFIRM_START_OVER)) return;
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
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1240px]" style={{ minHeight: "60vh" }}>
      {view === "intro" ? <Intro onStart={start} /> : null}
      {view === "run" ? <RunView run={run} onResume={again} onTryAgain={again} onStartOver={startOver} /> : null}
      {view === "result" && result && engine ? <ResultView result={result} engine={engine} onStartOver={startOver} /> : null}
    </div>
  );
}
