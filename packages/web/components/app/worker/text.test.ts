import { describe, expect, it } from "vitest";
import type { HistoryGap } from "@kalypso/core";
import { cleanChainText, companyIdFromQuery, gapSentences, shortAddress } from "./text";

describe("the company in an invite link", () => {
  it("reads a whole number", () => {
    expect(companyIdFromQuery("?company=12")).toBe(12n);
    expect(companyIdFromQuery("?company=18446744073709551615")).toBe(18446744073709551615n);
  });

  it("ignores a link with no company, a word, a sign, leading zeros or a number past u64", () => {
    for (const search of ["", "?company=", "?company=abc", "?company=-1", "?company=1.5", "?company=007", "?company=18446744073709551616", "?other=12"]) {
      expect(companyIdFromQuery(search)).toBeNull();
    }
  });
});

describe("text that came from the chain", () => {
  it("turns control and direction characters into spaces and collapses runs", () => {
    expect(cleanChainText("Andes\u202EStudio\u0007  Ltd")).toBe("Andes Studio Ltd");
  });

  it("caps the length", () => {
    expect(cleanChainText("x".repeat(500)).length).toBeLessThan(130);
  });
});

describe("addresses", () => {
  it("shortens an address to its first and last four characters", () => {
    expect(shortAddress("GDG33P5FV5F5A2JDU5O2C4SXVBXWVAZRFY2DNVZZKHIKY2DO4R26QSAZ")).toBe("GDG3…QSAZ");
  });
});

describe("history gaps in plain words", () => {
  it("gives one sentence for each gap and none twice", () => {
    const gaps: HistoryGap[] = [
      { reason: "company_count_mismatch", expected: 2, found: 1 },
      { reason: "payslip_missing", companyId: 7n, runId: 202610n },
      { reason: "payslip_missing", companyId: 7n, runId: 202610n },
    ];
    const sentences = gapSentences(gaps);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("The chain lists 2 companies for you, but this device has joined 1.");
    expect(sentences[1]).toContain("run 202610 of company #7");
  });

  it("has a sentence for every reason core can report", () => {
    const every: HistoryGap[] = [
      { reason: "company_count_mismatch", expected: 1, found: 0 },
      { reason: "runs_opened_mismatch", companyId: 1n, expected: 2, found: 1 },
      { reason: "run_not_on_chain", companyId: 1n, runId: 3n },
      { reason: "admin_changes_mismatch", companyId: 1n, expected: 1, found: 0 },
      { reason: "payslip_missing", companyId: 1n, runId: 3n },
      { reason: "ledger_mismatch", companyId: 1n, runId: 3n },
      { reason: "paid_count_mismatch", companyId: 1n, runId: 3n, expected: 2, found: 1 },
    ];
    expect(gapSentences(every)).toHaveLength(every.length);
  });
});
