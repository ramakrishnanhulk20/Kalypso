// Covers the dashboard's accountant fact: a company bound to the published demo accountant id gets
// the "Publicly readable" chip in the wait colour with its explaining title, and any other company
// gets the plain id. The id is checked against the console's real registry setting, the one
// company-read's publiclyReadable passes. Does NOT cover the dashboard's own read of the company
// from chain, or how the chip looks in a browser.
import { isValidElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { isPublishedDemoAccountant } from "../../../lib/employer/setup";
import { sandboxConfig } from "../../../lib/sandbox/config";
import { AccountantFact, PUBLIC_ACCOUNTANT_TITLE } from "./accountant-fact";

const publiclyReadable = (auditorId: number) => isPublishedDemoAccountant(sandboxConfig().contracts.auditor, auditorId);

type Seen = { text: string; titles: string[]; colours: string[] };

// The web package has no DOM renderer types, so this walks the element tree itself, calling each
// function component, and keeps the text, every title and every colour it finds.
function seen(node: ReactNode, into: Seen = { text: "", titles: [], colours: [] }): Seen {
  if (typeof node === "string" || typeof node === "number") into.text += String(node);
  else if (Array.isArray(node)) node.forEach((child: ReactNode) => seen(child, into));
  else if (isValidElement<{ children?: ReactNode; title?: string; style?: { color?: string } }>(node)) {
    const { props, type } = node;
    if (typeof type === "function") return seen((type as (p: unknown) => ReactNode)(props), into);
    if (props.title) into.titles.push(props.title);
    if (props.style?.color) into.colours.push(props.style.color);
    seen(props.children, into);
  }
  return into;
}

describe("AccountantFact", () => {
  it("flags a company sealed to the published demo accountant id", () => {
    const open = publiclyReadable(5);
    expect(open).toBe(true);
    const shown = seen(AccountantFact({ accountantId: 5, publiclyReadable: open }));
    expect(shown.text).toBe("Accountant id 5Publicly readable");
    expect(shown.titles).toEqual([PUBLIC_ACCOUNTANT_TITLE]);
    expect(shown.colours).toEqual(["var(--color-wait)"]);
    expect(PUBLIC_ACCOUNTANT_TITLE).toBe("This company uses the published demo accountant key, so anyone can read its amounts.");
  });

  it("shows only the id for any other accountant", () => {
    const open = publiclyReadable(7);
    expect(open).toBe(false);
    const shown = seen(AccountantFact({ accountantId: 7, publiclyReadable: open }));
    expect(shown.text).toBe("Accountant id 7");
    expect(shown.titles).toEqual([]);
  });
});
