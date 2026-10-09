import type { SandboxStep } from "@/lib/sandbox/engine";

export type StepKey = Exclude<SandboxStep, "done">;

export interface Shot {
  key: StepKey;
  title: string;
  description: string;
  /** Seconds this step took in a measured live run on testnet. Used only for the time-left estimate and the progress line. */
  seconds: number;
}

export const SHOTS: readonly Shot[] = [
  { key: "keys", title: "Keys", description: "Five accounts are created in this browser.", seconds: 2 },
  { key: "fund", title: "Test money", description: "Friendbot funds all five with test XLM.", seconds: 8 },
  { key: "usdc", title: "USDC", description: "The company buys test USDC on the Stellar exchange.", seconds: 25 },
  { key: "accountant", title: "Accountant", description: "The accountant registers their own key and gets an id.", seconds: 5 },
  { key: "treasury", title: "Treasury", description: "The company's account joins the confidential token under that id.", seconds: 12 },
  { key: "company", title: "Company", description: "The payroll contract creates the company, naming its accountant.", seconds: 7 },
  { key: "workers", title: "Workers", description: "Each worker registers a key, joins the token and accepts the invite.", seconds: 42 },
  { key: "deposit", title: "Funding", description: "USDC moves into the treasury's sealed balance.", seconds: 13 },
  { key: "run", title: "Run", description: "This month's run opens for three workers.", seconds: 9 },
  { key: "pay", title: "Payroll", description: "Each payment is proved in your browser and paid.", seconds: 37 },
];

export const SHOT_COUNT = SHOTS.length;

// The whole measured run, as the design spec gives it. It is longer than the ten step times above added up (160 s).
export const TOTAL_SECONDS = 179;

export function titleOf(step: StepKey): string {
  return SHOTS.find((shot) => shot.key === step)?.title ?? "";
}

export function indexOfStep(step: SandboxStep): number {
  return step === "done" ? SHOT_COUNT : SHOTS.findIndex((shot) => shot.key === step);
}
