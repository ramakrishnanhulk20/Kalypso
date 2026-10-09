import { describe, expect, it } from "vitest";
import type { SandboxStep } from "@/lib/sandbox/engine";
import { FRESH_RUN, progressFraction, reduceRun, rowStatus, stepNumber, timeLeftLabel } from "./run-state";
import type { RunAction, RunState } from "./run-state";
import { SHOTS } from "./shots";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

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

  it("keeps the engine's own sentence untouched", () => {
    const state = play([{ type: "begin" }, event("keys", 0)]);
    expect(state.label).toBe("label for keys");
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

  it("marks the step the run stopped in, and clears it on the next begin", () => {
    const stopped = play([{ type: "begin" }, event("keys", 0), event("fund", 1_000), { type: "fail", message: "No." }]);
    expect(rowStatus(stopped, 1)).toBe("failed");
    expect(stopped.error).toBe("No.");
    expect(stopped.running).toBe(false);
    const again = reduceRun(stopped, { type: "begin" });
    expect(again.error).toBeNull();
    expect(rowStatus(again, 1)).toBe("current");
  });

  it("finishes every step on the done event", () => {
    const state = play([event("keys", 0), event("pay", 5_000), event("done", 9_000)]);
    expect(state.frontier).toBe(SHOTS.length);
    expect(state.seconds.pay).toBe(4);
    expect(progressFraction(state, 9_000)).toBe(1);
  });
});

describe("time and progress", () => {
  it("rounds minutes left up from the measured step times", () => {
    expect(timeLeftLabel(0)).toBe("about 3 min left");
    expect(timeLeftLabel(6)).toBe("about 2 min left");
    expect(timeLeftLabel(7)).toBe("under a minute left");
  });

  it("numbers steps from one and never past ten", () => {
    expect(stepNumber(FRESH_RUN)).toBe(1);
    expect(stepNumber({ ...FRESH_RUN, frontier: SHOTS.length })).toBe(SHOTS.length);
  });

  it("counts finished steps plus the elapsed part of the current one over 179 seconds", () => {
    const running: RunState = { ...FRESH_RUN, frontier: 1, running: true, startedAt: { fund: 0 } };
    expect(progressFraction(running, 4_000)).toBeCloseTo((2 + 4) / 179, 5);
    expect(progressFraction(running, 60_000)).toBeCloseTo((2 + 8) / 179, 5);
  });
});
