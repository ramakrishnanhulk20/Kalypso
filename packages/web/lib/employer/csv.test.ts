// Covers the payroll file screen's wording: every refusal core's CSV parser makes becomes one plain
// sentence that names its line (or the file), never repeats a cell except the refused "4.200"-shaped
// figure, and the accepted rows are core's own. Does NOT cover the parser's rules themselves (core's
// csv tests do), the payroll panel's rendering, or anything on chain.
import { parsePayrollCsv } from "@kalypso/core";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import fr from "../../messages/fr.json";
import pt from "../../messages/pt.json";
import zh from "../../messages/zh.json";
import { parseAmount } from "../i18n/amount";
import { englishT } from "../i18n/english";
import { Keypair } from "../sandbox/sdk";
import { csvSentence, readPayrollCsv } from "./csv";

const a = Keypair.random().publicKey();
const b = Keypair.random().publicKey();
const secret = Keypair.random().secret();

describe("readPayrollCsv", () => {
  it("passes good rows through exactly as core's parser returns them", () => {
    const text = `address,amount,name\n${a},1250.50,Ana\n${b},980,Ben\n`;
    const { rows, problems } = readPayrollCsv(text);
    expect(problems).toEqual([]);
    expect(rows).toEqual(parsePayrollCsv(text).rows);
    expect(rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it("turns each refused line into a sentence that names the line and never echoes a cell", () => {
    const w = Array.from({ length: 6 }, () => Keypair.random().publicKey());
    const lines = [
      `${a},1250.50`,
      `${a},10`,
      `,10`,
      `${secret},10`,
      `${w[0]},2e4`,
      `${w[1]},1,000`,
      `${w[2]},-5`,
      `${w[3]}`,
      `${w[4]},0`,
      `${w[5]},1.123456789`,
    ];
    const { rows, problems } = readPayrollCsv(lines.join("\n"));
    expect(rows.map((r) => r.line)).toEqual([1]);
    expect(problems.map((p) => [p.line, p.code, p.sentence])).toEqual([
      [2, "DUPLICATE", "Line 2 repeats the address on line 1. List each worker once, with their total for the run."],
      [3, "ADDRESS_EMPTY", "Line 3 has no worker address."],
      [4, "ADDRESS_LOOKS_LIKE_SECRET", "Line 4 has what looks like a secret key (starting with S) instead of an address. Delete it from the file and never share it."],
      [5, "AMOUNT_EXPONENT", "Line 5 has an amount in scientific notation, like 1e3. Write the full number."],
      [6, "AMOUNT_SPLIT", "Line 6 has a name that is only a number, which usually means a comma split the amount. Write the amount without commas."],
      [7, "AMOUNT_NEGATIVE", "Line 7 has a negative amount. Pay amounts must be above zero."],
      [8, "MISSING_COLUMN", "Line 8 needs an address and an amount, separated by a comma (not a semicolon)."],
      [9, "AMOUNT_ZERO", "Line 9 has an amount of zero. Pay amounts must be above zero."],
      [10, "AMOUNT_TOO_MANY_DECIMALS", "Line 10 has an amount with more than 7 decimal places. USDC stops at 0.0000001."],
    ]);
    for (const p of problems) {
      expect(p.sentence).not.toContain(secret);
      for (const address of w) expect(p.sentence).not.toContain(address);
      expect(p.sentence).not.toMatch(/1250|2e4|-5/);
    }
  });

  it("names the whole file when the problem is the file", () => {
    expect(readPayrollCsv("").problems).toEqual([{ line: 0, code: "NO_ROWS", sentence: "The file has no payroll rows. Each row needs a worker's address and an amount." }]);
    expect(readPayrollCsv(`${a},"10\n${b},5`).problems[0]?.sentence).toBe("Line 1 opens a quote mark that is never closed, so the rest of the file cannot be read safely.");
    expect(readPayrollCsv(`${a},10\r${b},5`).problems[0]?.sentence).toBe('Line 1 uses a line break the importer does not accept. Save the file again as "CSV UTF-8".');
  });

  it("keeps core's own message for a code it does not know", () => {
    expect(csvSentence({ line: 4, code: "SOMETHING_NEW", message: "Core's own plain text." })).toBe("Line 4: Core's own plain text.");
  });
});

describe("an amount shaped like 4.200", () => {
  // The Spanish field refuses "4.200" as four thousand two hundred, so the file must not pay 4.2 for it.
  it("is refused by the file just as the Spanish field refuses it", () => {
    expect(parseAmount("4.200", "es")).toBeNull();
    const { rows, problems } = readPayrollCsv(`${a},4.200`);
    expect(rows).toEqual([]);
    expect(problems).toEqual([
      {
        line: 1,
        code: "AMOUNT_AMBIGUOUS",
        amount: "4.200",
        sentence: "Line 1: 4.200 is ambiguous. It could be a decimal or a thousands figure. Write it without a thousands separator, with a dot only for decimals: 4200 or 4.20.",
      },
    ]);
  });

  it.each(["4.200", "1.000", "999.999"])("refuses %j with AMOUNT_AMBIGUOUS and the English file's own sentence", (cell) => {
    const problems = readPayrollCsv(`address,amount\n${a},${cell}`).problems;
    expect(problems.map((p) => [p.line, p.code, p.amount])).toEqual([[2, "AMOUNT_AMBIGUOUS", cell]]);
    expect(problems[0]?.sentence).toBe(englishT("errors.csv")("AMOUNT_AMBIGUOUS", { line: 2, amount: cell }));
  });

  it("accepts every other shape with its exact value", () => {
    const cases: [string, bigint][] = [
      ["4.2", 42_000_000n],
      ["4.20", 42_000_000n],
      ["4.2000", 42_000_000n],
      ["4200", 42_000_000_000n],
      ["1000.5", 10_005_000_000n],
    ];
    const w = cases.map(() => Keypair.random().publicKey());
    const { rows, problems } = readPayrollCsv(cases.map(([cell], i) => `${w[i]},${cell}`).join("\n"));
    expect(problems).toEqual([]);
    expect(rows.map((r) => r.amount)).toEqual(cases.map(([, stroops]) => stroops));
  });

  it.each([
    ["en", en],
    ["es", es],
    ["pt", pt],
    ["fr", fr],
    ["zh", zh],
  ] as const)("reads as a full %s sentence from the values the problem carries, never a raw key", (locale, messages) => {
    const [problem] = readPayrollCsv(`${a},999.999`).problems;
    const t = createTranslator({
      locale,
      messages,
      namespace: "errors.csv",
      onError: (error) => {
        throw error;
      },
    });
    const sentence = t("AMOUNT_AMBIGUOUS", { line: problem?.line ?? 0, amount: problem?.amount ?? "" });
    expect(sentence).toContain("999.999");
    expect(sentence).toContain("4.20");
    expect(sentence).not.toContain("AMOUNT_AMBIGUOUS");
  });
});
