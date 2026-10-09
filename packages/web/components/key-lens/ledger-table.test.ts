// Covers when a run subtotal or the books' grand total may show a sum: only over a verified complete
// history where every payment opened. An incomplete history or a run where some payments did not
// open shows "Total withheld" in the wait colour with its title, and a key that opened nothing keeps
// "No key fits". Does NOT cover the table's layout or how the landing lens, /demo and the books pass
// the complete flag in; the live before and after check in scratchpad/rd covers those.
import { isValidElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SealedPayment } from "@kalypso/core";

// The test runner has no "@/" alias, so the table's own imports are pointed at the same files.
vi.mock("@/lib/ledger", () => import("../../lib/ledger"));
vi.mock("@/lib/links", () => import("../../lib/links"));
vi.mock("@/lib/money", () => import("../../lib/money"));

const { WITHHELD_TITLE, WithheldTotal, totalOf } = await import("./ledger-table");
const { paymentKey } = await import("../../lib/ledger");

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

type Seen = { text: string; titles: string[]; colours: string[] };

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

  it("keeps No key fits for a key that opened nothing, complete or not", () => {
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
    const shown = seen(WithheldTotal());
    expect(shown.text).toBe("Total withheld");
    expect(shown.titles).toEqual([WITHHELD_TITLE]);
    expect(WITHHELD_TITLE).toBe("Some payments could not be read, so no total is shown.");
    expect(shown.colours).toEqual(["var(--color-wait)"]);
  });
});
