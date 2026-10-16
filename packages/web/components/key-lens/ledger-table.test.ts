// Covers when a run subtotal or the books' grand total may show a sum: only over a verified complete
// history where every payment opened. An incomplete history or a run where some payments did not
// open shows "Total withheld" in the wait colour with its title, and a key that opened nothing keeps
// the sealed line ("Sealed. This key can't open it."). Does NOT cover the table's layout or how the
// landing lens, /demo and the books pass the complete flag in; a live before and after check
// outside this suite covers those.
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SealedPayment } from "@kalypso/core";
import { renderEnglish, textOf, titlesOf } from "../../test/i18n";

// The test runner has no "@/" alias, so the table's own imports are pointed at the same files.
const screen = vi.hoisted(() => ({ wide: true }));
vi.mock("@/hooks/use-wide-screen", () => ({ useWideScreen: () => screen.wide }));
vi.mock("@/lib/ledger", () => import("../../lib/ledger"));
vi.mock("@/lib/links", () => import("../../lib/links"));
vi.mock("@/lib/money", () => import("../../lib/money"));
vi.mock("@/lib/i18n/locales", () => import("../../lib/i18n/locales"));

const { LedgerTable, WITHHELD_TITLE, WithheldTotal, totalOf } = await import("./ledger-table");
const { paymentKey, shortId } = await import("../../lib/ledger");

const payment = (runId: bigint, n: number, amount: bigint | null): SealedPayment => ({
  runId,
  periodLabel: runId === 1n ? "September 2026" : "October 2026",
  worker: `G${String(n).padStart(55, "A")}`,
  txHash: String(n).padStart(64, "0"),
  sealed: "ab".repeat(32),
  amount,
});

const opened = (payments: SealedPayment[]) => new Map(payments.map((p) => [paymentKey(p), p.amount]));

const run = [payment(2n, 1, 4_200_0000000n), payment(2n, 2, 3_650_0000000n), payment(2n, 3, 5_100_0000000n)];

describe("totalOf", () => {
  it("sums a run only when the history is complete and every payment opened", () => {
    expect(totalOf(run, opened(run), true)).toEqual({ kind: "total", value: 12_950_0000000n });
  });

  it("withholds the total while the history is not verified complete", () => {
    expect(totalOf(run, opened(run), false)).toEqual({ kind: "withheld" });
  });

  it("withholds the total of a run where some payments opened and one did not", () => {
    const partly = [run[0], run[1], payment(2n, 3, null)] as SealedPayment[];
    expect(totalOf(partly, opened(partly), true)).toEqual({ kind: "withheld" });
    expect(totalOf(run, new Map([[paymentKey(run[0] as SealedPayment), 1n]]), true)).toEqual({ kind: "withheld" });
  });

  it("keeps the sealed line for a key that opened nothing, complete or not", () => {
    const stranger = run.map((p) => payment(p.runId, Number(p.txHash), null));
    expect(totalOf(stranger, opened(stranger), true)).toEqual({ kind: "none" });
    expect(totalOf(stranger, opened(stranger), false)).toEqual({ kind: "none" });
  });

  it("withholds the books' grand total when one run is whole and another is not", () => {
    const books = [...run, payment(1n, 4, 9_0000000n), payment(1n, 5, null)];
    expect(totalOf(books, opened(books), true)).toEqual({ kind: "withheld" });
  });
});

describe("WithheldTotal", () => {
  it("says Total withheld in the wait colour and explains why in its title", () => {
    const markup = renderEnglish(createElement(WithheldTotal));
    expect(textOf(markup)).toBe("Total withheld");
    expect(titlesOf(markup)).toEqual([WITHHELD_TITLE]);
    expect(WITHHELD_TITLE).toBe("Some payments could not be read, so no total is shown.");
    expect(markup).toContain("text-wait");
  });
});

describe("LedgerTable transaction links", () => {
  const markup = (wide: boolean, interactive: boolean): string => {
    screen.wide = wide;
    return renderEnglish(
      createElement(LedgerTable, { layer: "sealed", payments: run, amounts: opened(run), complete: true, failed: false, onRetry: () => undefined, interactive }),
    );
  };
  const links = (html: string) => [...html.matchAll(/<a [^>]*href="[^"]*\/tx\/([0-9a-f]{64})"[^>]*>(.*?)<\/a>/g)].map((m) => ({ hash: m[1], text: (m[2] ?? "").replace(/<[^>]*>/g, "") }));

  it("draws one link per payment on a wide screen, showing the short hash", () => {
    const found = links(markup(true, true));
    expect(found.map((l) => l.hash)).toEqual(run.map((p) => p.txHash));
    expect(found.map((l) => l.text)).toEqual(run.map((p) => shortId(p.txHash)));
  });

  it("draws one link per payment on a phone, under the worker", () => {
    const found = links(markup(false, true));
    expect(found.map((l) => l.hash)).toEqual(run.map((p) => p.txHash));
    expect(found.every((l) => l.text.startsWith("tx "))).toBe(true);
  });

  it("draws no link at all for a layer that is only a backdrop", () => {
    expect(links(markup(true, false))).toEqual([]);
    expect(links(markup(false, false))).toEqual([]);
  });
});
