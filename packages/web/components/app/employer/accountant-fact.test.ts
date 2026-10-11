// Covers the dashboard's accountant fact: a company bound to the published demo accountant id gets
// the "Publicly readable" chip in the wait colour with its explaining title, and any other company
// gets the plain id. The id is checked against the console's real registry setting, the one
// company-read's publiclyReadable passes. Does NOT cover the dashboard's own read of the company
// from chain, or how the chip looks in a browser.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { isPublishedDemoAccountant } from "../../../lib/employer/setup";
import { sandboxConfig } from "../../../lib/sandbox/config";
import { renderEnglish, textOf, titlesOf } from "../../../test/i18n";
import { AccountantFact, PUBLIC_ACCOUNTANT_TITLE } from "./accountant-fact";

const publiclyReadable = (auditorId: number) => isPublishedDemoAccountant(sandboxConfig().contracts.auditor, auditorId);

describe("AccountantFact", () => {
  it("flags a company sealed to the published demo accountant id", () => {
    const open = publiclyReadable(5);
    expect(open).toBe(true);
    const markup = renderEnglish(createElement(AccountantFact, { accountantId: 5, publiclyReadable: open }));
    expect(textOf(markup)).toBe("Accountant id 5Publicly readable");
    expect(titlesOf(markup)).toEqual([PUBLIC_ACCOUNTANT_TITLE]);
    expect(markup).toContain("var(--color-wait)");
    expect(PUBLIC_ACCOUNTANT_TITLE).toBe("This company uses the published demo accountant key, so anyone can read its amounts.");
  });

  it("shows only the id for any other accountant", () => {
    const open = publiclyReadable(7);
    expect(open).toBe(false);
    const markup = renderEnglish(createElement(AccountantFact, { accountantId: 7, publiclyReadable: open }));
    expect(textOf(markup)).toBe("Accountant id 7");
    expect(titlesOf(markup)).toEqual([]);
  });
});
