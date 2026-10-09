// Covers the salary checks a judge's input meets before anything is sent, the deposit margin, and
// the coverage check before the deposit. Does NOT cover what the DEX quotes or whether friendbot
// XLM can buy the deposit (dex.ts measures that live), or core's own refusals inside executeRun.
import { MAX_STROOPS } from "@kalypso/core";
import { describe, expect, it } from "vitest";
import { SandboxError } from "./errors";
import { depositFor, requireCovered, requireSalaries, totalOf } from "./salaries";

const USDC = 10_000_000n;

describe("salaries", () => {
  it("takes three salaries above zero", () => {
    expect(requireSalaries([4_200n * USDC, 3_650n * USDC, 5_100n * USDC])).toEqual([4_200n * USDC, 3_650n * USDC, 5_100n * USDC]);
    expect(requireSalaries([1n, 1n, 1n])).toEqual([1n, 1n, 1n]);
  });

  it("refuses a zero, negative or non-bigint salary, naming the worker and never the amount", () => {
    const cases: [unknown, string][] = [
      [[0n, 1n, 1n], "Worker 1"],
      [[1n, -4n, 1n], "Worker 2"],
      [[1n, 1n, 4200], "Worker 3"],
      [[1n, 1n, "4200"], "Worker 3"],
    ];
    for (const [amounts, who] of cases) {
      try {
        requireSalaries(amounts);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxError);
        expect((err as SandboxError).code).toBe("INVALID_AMOUNTS");
        expect((err as SandboxError).message).toContain(who);
        expect((err as SandboxError).message).not.toMatch(/\d{2,}/);
      }
    }
  });

  it("refuses anything but exactly three salaries", () => {
    for (const amounts of [[], [1n, 1n], [1n, 1n, 1n, 1n], null, undefined, "1,1,1"]) {
      expect(() => requireSalaries(amounts)).toThrow(SandboxError);
    }
  });

  it("refuses salaries whose deposit the token could not hold", () => {
    expect(() => requireSalaries([MAX_STROOPS / 3n, MAX_STROOPS / 3n, MAX_STROOPS / 3n])).toThrow(SandboxError);
  });

  it("deposits the total plus 2 percent, rounded up to the stroop", () => {
    expect(depositFor(totalOf([4_200n * USDC, 3_650n * USDC, 5_100n * USDC]))).toBe(13_209n * USDC);
    expect(depositFor(100n)).toBe(102n);
    expect(depositFor(101n)).toBe(104n);
    expect(depositFor(1n)).toBe(2n);
  });

  it("refuses a deposit below the payroll it must cover", () => {
    const total = totalOf([3n, 4n, 5n]);
    expect(() => requireCovered(total, depositFor(total))).not.toThrow();
    expect(() => requireCovered(total, total)).not.toThrow();
    expect(() => requireCovered(total, total - 1n)).toThrow(SandboxError);
  });
});
