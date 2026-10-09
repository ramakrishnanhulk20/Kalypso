"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./errors";
import type { ShownError } from "./errors";

/** One progress message from the lib. The sentence never carries an amount. */
export interface Progress {
  sentence: string;
  done: number;
  total: number;
  txHash?: string;
}

export type ActionState<T> =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; value: T }
  | { phase: "failed"; error: ShownError; cause: unknown };

const DONE_FLASH_MS = 1200;

/**
 * Runs one async step for a button: pending (with the lib's latest progress sentence), success
 * (a 1.2 second "done" flash while the result stays) and failure (the error to show under it).
 * The step is never started twice at once.
 */
export function useAction<A extends unknown[], T>(work: (onProgress: (p: Progress) => void, ...args: A) => Promise<T>) {
  const [state, setState] = useState<ActionState<T>>({ phase: "idle" });
  const [lines, setLines] = useState<Progress[]>([]);
  const [flash, setFlash] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(work);
  latest.current = work;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(flashTimer.current);
    };
  }, []);

  const start = useCallback(async (...args: A): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    clearTimeout(flashTimer.current);
    setFlash(false);
    setLines([]);
    setState({ phase: "running" });
    try {
      const value = await latest.current((p) => {
        if (!alive.current) return;
        setLines((all) => (all[all.length - 1]?.sentence === p.sentence && all[all.length - 1]?.txHash === p.txHash ? all : [...all, p]));
      }, ...args);
      if (alive.current) {
        setState({ phase: "done", value });
        setFlash(true);
        flashTimer.current = setTimeout(() => setFlash(false), DONE_FLASH_MS);
      }
      return value;
    } catch (cause) {
      if (alive.current) setState({ phase: "failed", error: describeError(cause), cause });
      return undefined;
    } finally {
      running.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    if (running.current) return;
    clearTimeout(flashTimer.current);
    setFlash(false);
    setLines([]);
    setState({ phase: "idle" });
  }, []);

  return {
    state,
    lines,
    flash,
    running: state.phase === "running",
    progress: state.phase === "running" ? lines[lines.length - 1]?.sentence : undefined,
    error: state.phase === "failed" ? state.error : null,
    cause: state.phase === "failed" ? state.cause : undefined,
    value: state.phase === "done" ? state.value : undefined,
    start,
    reset,
  };
}

export type Action<A extends unknown[], T> = ReturnType<typeof useAction<A, T>>;
export type ButtonAction = Pick<Action<never[], unknown>, "running" | "progress" | "flash">;
