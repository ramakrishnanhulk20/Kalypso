// Covers the worker side of C47: a company bound to the published demo accountant id in our own
// registry is flagged, by the same id list core refuses runs under, and the chip reads "Publicly
// readable" in the wait colour with its explaining title. Any other id, or the same id in another
// registry, is not flagged. The invite strip and the Joined line carry the chip for such a company
// and only for it, each with the visible sentence under it, and the payslip list says that sentence
// once when any payslip comes from such a company. The payslip chip slot (ReadersChip) shows a
// pulsing placeholder while the company is still being read, "Readers unknown" in the wait colour
// when it could not be read, the public chip for a publicly readable company, and nothing for a
// private one.
// Does NOT cover: the chain read of the company (worker-lib reads it), the hook that marks a failed
// read as unknown (use-payslips), the card layout around the slot, or how the chip looks.
import { createElement, isValidElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { PUBLISHED_DEMO_AUDITOR_IDS } from "@kalypso/core";
import { workerConfig } from "../../../lib/worker/config";
import { renderEnglish, textOf, titlesOf } from "../../../test/i18n";
import { InviteStrip } from "./invite-strip";
import { JoinedLine } from "./joined-line";
import { PUBLIC_NOTE, PUBLIC_TITLE, PublicNote, PubliclyReadable, ReadersChip, UNKNOWN_TITLE, anyPubliclyReadable, isPublishedAuditor } from "./public-chip";

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
    const markup = renderEnglish(createElement(PubliclyReadable));
    expect(textOf(markup)).toBe("Publicly readable");
    expect(titlesOf(markup)).toEqual([PUBLIC_TITLE]);
    expect(PUBLIC_TITLE).toBe("This company uses the published demo accountant key, so anyone can read its amounts.");
    expect(markup).toContain("var(--color-wait)");
  });
});

describe("the readers chip on a payslip", () => {
  const company = (publiclyReadable: boolean) => ({ label: "Andes Studio (demo)", publiclyReadable });

  it("shows a hidden pulsing bar while the company is still being read", () => {
    const bar = ReadersChip({ facts: undefined }) as { type: unknown; props: { className?: string; "aria-hidden"?: string } };
    expect(isValidElement(bar)).toBe(true);
    expect(bar.type).toBe("span");
    expect(bar.props.className).toContain("skeleton-bar");
    expect(bar.props["aria-hidden"]).toBe("true");
    expect(textOf(renderEnglish(bar as ReactNode))).toBe("");
  });

  it("reads Readers unknown in the wait colour, with its title, when the company could not be read", () => {
    const markup = renderEnglish(createElement(ReadersChip, { facts: "unknown" }));
    expect(textOf(markup)).toBe("Readers unknown");
    expect(titlesOf(markup)).toEqual([UNKNOWN_TITLE]);
    expect(UNKNOWN_TITLE).toBe(
      "This company's settings did not load from the chain, so Kalypso cannot say whether anyone else can read this amount. Reload to check again.",
    );
    expect(markup).toContain("var(--color-wait)");
  });

  it("reads Publicly readable for a publicly readable company", () => {
    const markup = renderEnglish(createElement(ReadersChip, { facts: company(true) }));
    expect(textOf(markup)).toBe("Publicly readable");
    expect(titlesOf(markup)).toEqual([PUBLIC_TITLE]);
  });

  it("shows nothing for a private company", () => {
    expect(ReadersChip({ facts: company(false) })).toBeNull();
  });
});

describe("everywhere else a company is shown", () => {
  const found = (publiclyReadable: boolean) => ({ status: "found" as const, companyId: 0n, label: "Andes Studio (demo)", publiclyReadable });

  it("puts the chip on the invite strip only for a publicly readable company", () => {
    expect(renderEnglish(createElement(InviteStrip, { invite: found(true), onRetry: () => undefined }))).toContain("data-public-accountant");
    expect(renderEnglish(createElement(InviteStrip, { invite: found(false), onRetry: () => undefined }))).not.toContain("data-public-accountant");
  });

  it("puts the chip on the Joined line only for a publicly readable company", () => {
    expect(renderEnglish(createElement(JoinedLine, { label: "Andes Studio (demo)", publiclyReadable: true }))).toContain("data-public-accountant");
    expect(renderEnglish(createElement(JoinedLine, { label: "Andes Studio (demo)", publiclyReadable: false }))).not.toContain("data-public-accountant");
  });

  it("writes the reason out under the chip, on the invite strip and the Joined line, and only there", () => {
    expect(PUBLIC_NOTE).toBe("This is Kalypso's public demo company, so anyone can read its amounts.");
    expect(textOf(renderEnglish(createElement(PublicNote)))).toBe(PUBLIC_NOTE);
    expect(textOf(renderEnglish(createElement(InviteStrip, { invite: found(true), onRetry: () => undefined })))).toContain(PUBLIC_NOTE);
    expect(textOf(renderEnglish(createElement(InviteStrip, { invite: found(false), onRetry: () => undefined })))).not.toContain(PUBLIC_NOTE);
    expect(textOf(renderEnglish(createElement(JoinedLine, { label: "Andes Studio (demo)", publiclyReadable: true })))).toContain(PUBLIC_NOTE);
    expect(textOf(renderEnglish(createElement(JoinedLine, { label: "Andes Studio (demo)", publiclyReadable: false })))).not.toContain(PUBLIC_NOTE);
  });

  it("says it once above the payslips when any of them comes from a publicly readable company", () => {
    const companies = new Map<string, { label: string; publiclyReadable: boolean } | "unknown">([
      ["0", { label: "Andes Studio (demo)", publiclyReadable: true }],
      ["7", { label: "Private Co", publiclyReadable: false }],
      ["8", "unknown"],
    ]);
    expect(anyPubliclyReadable(["7", "0", "7"], companies)).toBe(true);
    expect(anyPubliclyReadable(["7", "8", "9"], companies)).toBe(false);
    expect(anyPubliclyReadable([], companies)).toBe(false);
  });
});
