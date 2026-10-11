import { describe, expect, it } from "vitest";
import type { SandboxStep } from "@/lib/sandbox/engine";
import { englishT } from "../../lib/i18n/english";
import { FRESH_RUN, liveSentence, progressFraction, reduceRun, rowStatus, secondsLeft, stepNumber, timeLeftLabel } from "./run-state";
import type { RunAction, RunState } from "./run-state";
import { SHOTS, TOTAL_SECONDS } from "./shots";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const run = englishT("sandbox.run");
const progress = englishT("sandbox.progress");

function play(actions: RunAction[], from: RunState = FRESH_RUN): RunState {
  return actions.reduce(reduceRun, from);
}

function event(step: SandboxStep, at: number, txHash?: string): RunAction {
  return {
    type: "progress",
    at,
    progress: { step, label: `label for ${step}`, done: 0, total: 1, ...(txHash ? { txHash } : {}) },
  };
}

describe("reduceRun", () => {
  it("marks every earlier step done and times the one that just ended", () => {
    const state = play([{ type: "begin" }, event("keys", 1_000), event("fund", 3_000)]);
    expect(state.frontier).toBe(1);
    expect(state.seconds.keys).toBe(2);
    expect(rowStatus(state, 0)).toBe("done");
    expect(rowStatus(state, 1)).toBe("current");
    expect(rowStatus(state, 2)).toBe("waiting");
  });

  it("keeps the engine's own sentence untouched, and its step and counts beside it", () => {
    const state = play([{ type: "begin" }, event("keys", 0)]);
    expect(state.label).toBe("label for keys");
    expect(state.progress).toEqual({ step: "keys", done: 0, total: 1 });
  });

  it("does not move backwards while the engine fast-forwards through finished work", () => {
    const resumed = play([{ type: "saved", frontier: 6 }, { type: "begin" }, event("keys", 0), event("fund", 100), event("usdc", 200)]);
    expect(resumed.frontier).toBe(6);
    expect(rowStatus(resumed, 2)).toBe("done");
    expect(rowStatus(resumed, 6)).toBe("current");
    expect(resumed.seconds.fund).toBeUndefined();
  });

  it("lists each transaction hash once, newest first", () => {
    const state = play([event("fund", 0, HASH_A), event("fund", 10, HASH_B), event("usdc", 20, HASH_A)]);
    expect(state.feed.map((entry) => entry.hash)).toEqual([HASH_B, HASH_A]);
    expect(state.feed.map((entry) => entry.step)).toEqual(["fund", "fund"]);
  });

  it("marks the step the run stopped in, keeps the error's code, and clears both on the next begin", () => {
    const stopped = play([{ type: "begin" }, event("keys", 0), event("fund", 1_000), { type: "fail", message: "No.", code: "SUBMIT_REFUSED" }]);
    expect(rowStatus(stopped, 1)).toBe("failed");
    expect(stopped.error).toBe("No.");
    expect(stopped.errorCode).toBe("SUBMIT_REFUSED");
    expect(stopped.running).toBe(false);
    const again = reduceRun(stopped, { type: "begin" });
    expect(again.error).toBeNull();
    expect(again.errorCode).toBeNull();
    expect(rowStatus(again, 1)).toBe("current");
  });

  it("finishes every step on the done event", () => {
    const state = play([event("keys", 0), event("pay", 5_000), event("done", 9_000)]);
    expect(state.frontier).toBe(SHOTS.length);
    expect(state.seconds.pay).toBe(4);
    expect(progressFraction(state, 9_000)).toBe(1);
  });
});

describe("the live line in each language", () => {
  it("shows the engine's own words in English and a sentence by step elsewhere", () => {
    const state = play([{ type: "begin" }, { type: "progress", at: 0, progress: { step: "workers", label: "Registering worker 2's own key for reading their pay", done: 2, total: 3 } }]);
    expect(liveSentence(state, "en", progress)).toBe("Registering worker 2's own key for reading their pay");
    expect(liveSentence(state, "es", progress)).toBe("Setting up worker 2 of 3: key for reading their pay, token account, invite and acceptance");
    expect(liveSentence(FRESH_RUN, "es", progress)).toBe("");
  });

  it("has a sentence for every step the engine reports", () => {
    for (const step of [...SHOTS.map((shot) => shot.key), "done" as const]) {
      const state = play([{ type: "progress", at: 0, progress: { step, label: "x", done: 0, total: 1 } }]);
      expect(liveSentence(state, "fr", progress)).not.toBe("");
    }
  });
});

describe("time and progress", () => {
  it("uses the live step times, by the step list's own keys", () => {
    const measured = { keys: 3, fund: 7, usdc: 38, accountant: 9, treasury: 25, company: 10, workers: 51, deposit: 22, run: 7, pay: 38 };
    expect(Object.fromEntries(SHOTS.map((shot) => [shot.key, shot.seconds]))).toEqual(measured);
  });

  it("adds up the steps still to go, counting the current one in full", () => {
    expect(secondsLeft(0)).toBe(210);
    expect(secondsLeft(3)).toBe(162);
    expect(secondsLeft(7)).toBe(67);
    expect(secondsLeft(SHOTS.length)).toBe(0);
    expect(secondsLeft(-1)).toBe(210);
  });

  it("rounds minutes left up, and says under a minute below 60 seconds", () => {
    expect(timeLeftLabel(run, 0)).toBe("about 4 min left");
    expect(timeLeftLabel(run, 2)).toBe("about 4 min left");
    expect(timeLeftLabel(run, 3)).toBe("about 3 min left");
    expect(timeLeftLabel(run, 6)).toBe("about 2 min left");
    expect(timeLeftLabel(run, 7)).toBe("about 2 min left");
    expect(timeLeftLabel(run, 8)).toBe("under a minute left");
    expect(timeLeftLabel(run, SHOTS.length)).toBe("under a minute left");
  });

  it("changes when a step finishes, never before", () => {
    const labels = Array.from({ length: SHOTS.length }, (_, frontier) => timeLeftLabel(run, frontier));
    expect(new Set(labels.slice(0, 3)).size).toBe(1);
    expect(labels[3]).not.toBe(labels[2]);
  });

  it("numbers steps from one and never past ten", () => {
    expect(stepNumber(FRESH_RUN)).toBe(1);
    expect(stepNumber({ ...FRESH_RUN, frontier: SHOTS.length })).toBe(SHOTS.length);
  });

  it("takes the whole run from the same step times the estimate uses", () => {
    expect(TOTAL_SECONDS).toBe(210);
    expect(TOTAL_SECONDS).toBe(secondsLeft(0));
  });

  it("counts finished steps plus the elapsed part of the current one over the whole run", () => {
    const running: RunState = { ...FRESH_RUN, frontier: 1, running: true, startedAt: { fund: 0 } };
    expect(progressFraction(running, 4_000)).toBeCloseTo((3 + 4) / TOTAL_SECONDS, 5);
    expect(progressFraction(running, 60_000)).toBeCloseTo((3 + 7) / TOTAL_SECONDS, 5);
  });

  it("reaches the end as the last step takes its typical time", () => {
    const last = SHOTS.length - 1;
    const lastKey = (SHOTS[last] as (typeof SHOTS)[number]).key;
    const finishing: RunState = { ...FRESH_RUN, frontier: last, running: true, startedAt: { [lastKey]: 0 } };
    expect(progressFraction(finishing, 0)).toBeCloseTo((TOTAL_SECONDS - 38) / TOTAL_SECONDS, 5);
    expect(progressFraction(finishing, 38_000)).toBe(1);
    expect(progressFraction(finishing, 90_000)).toBe(1);
  });
});
