import type { SandboxStep } from "@/lib/sandbox/engine";
import type { PlainT } from "@/lib/i18n/types";

export type StepKey = Exclude<SandboxStep, "done">;

export interface Shot {
  key: StepKey;
  /** Seconds this step took in a measured live run on testnet. Used only for the time-left estimate and the progress line. */
  seconds: number;
}

export const SHOTS: readonly Shot[] = [
  { key: "keys", seconds: 3 },
  { key: "fund", seconds: 7 },
  { key: "usdc", seconds: 38 },
  { key: "accountant", seconds: 9 },
  { key: "treasury", seconds: 25 },
  { key: "company", seconds: 10 },
  { key: "workers", seconds: 51 },
  { key: "deposit", seconds: 22 },
  { key: "run", seconds: 7 },
  { key: "pay", seconds: 38 },
];

export const SHOT_COUNT = SHOTS.length;

// The whole run is the ten step times added up, the same numbers the time-left estimate reads, so
// the progress line reaches its end as the last step finishes.
export const TOTAL_SECONDS = SHOTS.reduce((sum, shot) => sum + shot.seconds, 0);

/** The step's title in the page's language. t is the sandbox.shots namespace. */
export function titleOf(t: PlainT, step: StepKey): string {
  return t(`${step}Title`);
}

export function descriptionOf(t: PlainT, step: StepKey): string {
  return t(`${step}Text`);
}

export function indexOfStep(step: SandboxStep): number {
  return step === "done" ? SHOT_COUNT : SHOTS.findIndex((shot) => shot.key === step);
}
