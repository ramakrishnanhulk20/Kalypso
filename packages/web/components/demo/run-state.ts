import type { SandboxProgress } from "@/lib/sandbox/engine";
import { SHOTS, SHOT_COUNT, TOTAL_SECONDS, indexOfStep } from "./shots";
import type { StepKey } from "./shots";

export interface FeedEntry {
  id: number;
  hash: string;
  step: StepKey;
}

export interface RunState {
  /** Index of the first step not yet known to be done. SHOT_COUNT once everything is done. */
  frontier: number;
  /** The engine's own sentence for the screen, exactly as written. Null until the first one arrives. */
  label: string | null;
  lastStep: StepKey | null;
  startedAt: Partial<Record<StepKey, number>>;
  /** Whole seconds each step took in this tab. A step finished before a reload has none. */
  seconds: Partial<Record<StepKey, number>>;
  /** Newest first. */
  feed: FeedEntry[];
  nextId: number;
  running: boolean;
  failedStep: StepKey | null;
  error: string | null;
}

export const FRESH_RUN: RunState = {
  frontier: 0,
  label: null,
  lastStep: null,
  startedAt: {},
  seconds: {},
  feed: [],
  nextId: 1,
  running: false,
  failedStep: null,
  error: null,
};

export type RunAction =
  | { type: "saved"; frontier: number }
  | { type: "begin" }
  | { type: "progress"; progress: SandboxProgress; at: number }
  | { type: "fail"; message: string }
  | { type: "stop" }
  | { type: "clear" };

function stepAt(index: number): StepKey {
  return (SHOTS[Math.min(Math.max(index, 0), SHOT_COUNT - 1)] as (typeof SHOTS)[number]).key;
}

export function reduceRun(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "saved":
      return { ...FRESH_RUN, frontier: action.frontier };
    case "begin":
      return { ...state, running: true, error: null, failedStep: null, lastStep: null };
    case "stop":
      return { ...state, running: false };
    case "clear":
      return FRESH_RUN;
    case "fail":
      return { ...state, running: false, error: action.message, failedStep: state.lastStep ?? stepAt(state.frontier) };
    case "progress": {
      const { progress, at } = action;
      const step = progress.step === "done" ? null : progress.step;
      const index = indexOfStep(progress.step);
      let { frontier, startedAt, seconds } = state;

      // A step before the frontier is the engine fast-forwarding through work an earlier run finished.
      if (index >= frontier) {
        startedAt = { ...startedAt };
        seconds = { ...seconds };
        for (let i = frontier; i < index; i++) {
          const key = stepAt(i);
          const began = startedAt[key];
          if (began !== undefined) seconds[key] = Math.round((at - began) / 1000);
        }
        frontier = index;
        if (step !== null) startedAt[step] ??= at;
      }

      const hash = progress.txHash;
      let feed = state.feed;
      let nextId = state.nextId;
      if (step !== null && hash !== undefined && !feed.some((entry) => entry.hash === hash)) {
        feed = [{ id: nextId, hash, step }, ...feed];
        nextId += 1;
      }

      return { ...state, frontier, label: progress.label, lastStep: step, startedAt, seconds, feed, nextId };
    }
  }
}

export type RowStatus = "waiting" | "current" | "done" | "failed";

export function rowStatus(state: RunState, index: number): RowStatus {
  if (state.failedStep === stepAt(index)) return "failed";
  if (index < state.frontier) return "done";
  if (index === state.frontier && state.running) return "current";
  return "waiting";
}

export function elapsedSeconds(state: RunState, index: number, now: number): number {
  const began = state.startedAt[stepAt(index)];
  return began === undefined ? 0 : Math.max(0, Math.floor((now - began) / 1000));
}

/** The place in the run, one-based, for "Step 3 of 10". */
export function stepNumber(state: RunState): number {
  return Math.min(state.frontier, SHOT_COUNT - 1) + 1;
}

/** Typical seconds still to go when `frontier` is the first step not done: every step from there on, in full. */
export function secondsLeft(frontier: number): number {
  return SHOTS.slice(Math.max(frontier, 0)).reduce((sum, shot) => sum + shot.seconds, 0);
}

export function timeLeftLabel(frontier: number): string {
  const left = secondsLeft(frontier);
  return left < 60 ? "under a minute left" : `about ${Math.ceil(left / 60)} min left`;
}

/** 0 to 1: the measured time of the finished steps plus how far into the current one, over the whole measured run. */
export function progressFraction(state: RunState, now: number): number {
  if (state.frontier >= SHOT_COUNT) return 1;
  const finished = SHOTS.slice(0, state.frontier).reduce((sum, shot) => sum + shot.seconds, 0);
  const current = (SHOTS[state.frontier] as (typeof SHOTS)[number]).seconds;
  const into = state.running ? Math.min(current, Math.max(0, (now - (state.startedAt[stepAt(state.frontier)] ?? now)) / 1000)) : 0;
  return Math.min(1, (finished + into) / TOTAL_SECONDS);
}
