import type { PlainT } from "@/lib/i18n/types";
import type { Step } from "./payslip-paint";

export const STEP_NUMBERS: readonly Step[] = [1, 2, 3, 4, 5];

export function stepsFor(t: PlainT): { n: Step; heading: string; text: string }[] {
  return STEP_NUMBERS.map((n) => ({ n, heading: t(`s${n}Heading`), text: t(`s${n}Text`) }));
}

/** Who can read the amount after each step, in the same order as the steps. */
export function readableFor(t: PlainT): string[] {
  return STEP_NUMBERS.map((n) => t(`readable${n}`));
}
