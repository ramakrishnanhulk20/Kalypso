import type { SealedPayment, SealedPayroll } from "@kalypso/core";

// First six characters, an ellipsis, the last four: CBUIUW…7XVZ
export function shortId(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function paymentKey(payment: SealedPayment): string {
  return `${payment.runId}/${payment.worker}/${payment.txHash}`;
}

export type LedgerRow =
  | { kind: "payment"; id: string; index: number; payment: SealedPayment }
  | {
      kind: "subtotal";
      id: string;
      index: number;
      runId: bigint;
      periodLabel: string;
      payments: SealedPayment[];
    };

// Payments arrive newest run first, so each run is one unbroken stretch.
// A subtotal row closes every stretch.
export function buildLedgerRows(payments: SealedPayment[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let stretch: SealedPayment[] = [];

  const closeStretch = () => {
    const last = stretch[stretch.length - 1];
    if (!last) return;
    rows.push({
      kind: "subtotal",
      id: `subtotal/${last.runId}`,
      index: rows.length,
      runId: last.runId,
      periodLabel: last.periodLabel,
      payments: stretch,
    });
    stretch = [];
  };

  for (const payment of payments) {
    if (stretch.length > 0 && stretch[0]?.runId !== payment.runId) closeStretch();
    rows.push({
      kind: "payment",
      id: paymentKey(payment),
      index: rows.length,
      payment,
    });
    stretch.push(payment);
  }
  closeStretch();
  return rows;
}

// What one key opened, keyed by payment. Null until that key's read is done.
export function amountsFrom(
  payroll: SealedPayroll | null,
): Map<string, bigint | null> | null {
  if (!payroll) return null;
  return new Map(payroll.payments.map((p) => [paymentKey(p), p.amount]));
}
