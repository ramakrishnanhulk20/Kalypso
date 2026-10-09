// Covers the worker side of C47: a company bound to the published demo accountant id in our own
// registry is flagged, by the same id list core refuses runs under, and the chip reads "Publicly
// readable" in the wait colour with its explaining title. Any other id, or the same id in another
// registry, is not flagged. The invite strip and the Joined line carry the chip for such a company
// and only for it. The payslip chip slot (ReadersChip) shows a pulsing placeholder while the company
// is still being read, "Readers unknown" in the wait colour when it could not be read, the public
// chip for a publicly readable company, and nothing for a private one.
// Does NOT cover: the chain read of the company (worker-lib reads it), the hook that marks a failed
// read as unknown (use-payslips), the card layout around the slot, or how the chip looks.
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { PUBLISHED_DEMO_AUDITOR_IDS } from "@kalypso/core";
import { workerConfig } from "../../../lib/worker/config";
import { InviteStrip } from "./invite-strip";
import { JoinedLine } from "./joined-line";
import { PUBLIC_TITLE, PubliclyReadable, ReadersChip, UNKNOWN_TITLE, isPublishedAuditor } from "./public-chip";

type Seen = { text: string; titles: string[]; colours: string[] };

// Walks the element tree, calling each function component, and keeps text, titles and colours.
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

describe("the Publicly readable chip", () => {
  const registry = workerConfig().contracts.auditor;

  it("flags the published demo accountant id in our registry, and nothing else", () => {
    const published = PUBLISHED_DEMO_AUDITOR_IDS[registry] ?? [];
    expect(published.length).toBeGreaterThan(0);
    for (const id of published) expect(isPublishedAuditor(PUBLISHED_DEMO_AUDITOR_IDS, registry, id)).toBe(true);
    expect(isPublishedAuditor(PUBLISHED_DEMO_AUDITOR_IDS, registry, 7)).toBe(false);
    expect(isPublishedAuditor(PUBLISHED_DEMO_AUDITOR_IDS, "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE", published[0]!)).toBe(false);
  });

  it("reads Publicly readable in the wait colour, with the explaining title", () => {
    const shown = seen(PubliclyReadable());
    expect(shown.text).toBe("Publicly readable");
    expect(shown.titles).toEqual([PUBLIC_TITLE]);
    expect(PUBLIC_TITLE).toBe("This company uses the published demo accountant key, so anyone can read its amounts.");
    expect(shown.colours).toEqual(["var(--color-wait)"]);
  });
});

describe("the readers chip on a payslip", () => {
  const company = (publiclyReadable: boolean) => ({ label: "Andes Studio (demo)", publiclyReadable });

  it("shows a hidden pulsing bar while the company is still being read", () => {
    const bar = ReadersChip({ facts: undefined }) as ReactElement<{ className?: string; "aria-hidden"?: string }>;
    expect(isValidElement(bar)).toBe(true);
    expect(bar.type).toBe("span");
    expect(bar.props.className).toContain("skeleton-bar");
    expect(bar.props["aria-hidden"]).toBe("true");
    expect(seen(bar).text).toBe("");
  });

  it("reads Readers unknown in the wait colour, with its title, when the company could not be read", () => {
    const shown = seen(ReadersChip({ facts: "unknown" }));
    expect(shown.text).toBe("Readers unknown");
    expect(shown.titles).toEqual([UNKNOWN_TITLE]);
    expect(UNKNOWN_TITLE).toBe(
      "This company's settings did not load from the chain, so Kalypso cannot say whether anyone else can read this amount. Reload to check again.",
    );
    expect(shown.colours).toEqual(["var(--color-wait)"]);
  });

  it("reads Publicly readable for a publicly readable company", () => {
    const shown = seen(ReadersChip({ facts: company(true) }));
    expect(shown.text).toBe("Publicly readable");
    expect(shown.titles).toEqual([PUBLIC_TITLE]);
  });

  it("shows nothing for a private company", () => {
    expect(ReadersChip({ facts: company(false) })).toBeNull();
  });
});

// The element types in a tree, without calling any component.
function types(node: ReactNode, into: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((child: ReactNode) => types(child, into));
  else if (isValidElement<{ children?: ReactNode }>(node)) {
    into.push(node.type);
    types(node.props.children, into);
  }
  return into;
}

describe("everywhere else a company is shown", () => {
  const found = (publiclyReadable: boolean) => ({ status: "found" as const, companyId: 0n, label: "Andes Studio (demo)", publiclyReadable });

  it("puts the chip on the invite strip only for a publicly readable company", () => {
    expect(types(InviteStrip({ invite: found(true) }))).toContain(PubliclyReadable);
    expect(types(InviteStrip({ invite: found(false) }))).not.toContain(PubliclyReadable);
  });

  it("puts the chip on the Joined line only for a publicly readable company", () => {
    expect(types(JoinedLine({ label: "Andes Studio (demo)", publiclyReadable: true }))).toContain(PubliclyReadable);
    expect(types(JoinedLine({ label: "Andes Studio (demo)", publiclyReadable: false }))).not.toContain(PubliclyReadable);
  });
});
