import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { SealedPayment } from "@kalypso/core";
import { useWideScreen } from "@/hooks/use-wide-screen";
import { buildLedgerRows, paymentKey, shortId } from "@/lib/ledger";
import type { LedgerRow } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { displayUsdc } from "@/lib/money";

export type LedgerLayer = "sealed" | "revealed";

type LedgerTableProps = {
  layer: LedgerLayer;
  /** The rows every key sees. Null until the first read has finished. */
  payments: SealedPayment[] | null;
  /** What the chosen key opened. Null while that key's read is still running. */
  amounts: Map<string, bigint | null> | null;
  /** The read's complete flag. While it is false no run shows a total, only "Total withheld". */
  complete: boolean;
  failed: boolean;
  onRetry: () => void;
  /** The revealed layer draws links as plain text, except when it is the visible table (open every amount). */
  interactive?: boolean;
};

const SKELETON_ROWS = 6;
const SKELETON_WIDTHS = ["70%", "60%", "60%", "80%"];
const SEALED_CHARACTERS = 20;

const CELL = "px-[22px] py-[14px] leading-6";
const HEAD_CELL = "t-label px-[22px] py-3 text-left font-normal";
const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } satisfies CSSProperties;

export const WITHHELD_TITLE = "Some payments could not be read, so no total is shown.";

export function sealedText(payment: SealedPayment): string {
  return `${payment.sealed.slice(0, SEALED_CHARACTERS)}…`;
}

export type TotalState =
  | { kind: "none" }
  | { kind: "withheld" }
  | { kind: "total"; value: bigint };

/**
 * What a total over these payments may show. A key that opened none of them shows "No key fits".
 * A sum over a history that is not verified complete, or over payments of which only some opened,
 * would pass for the whole figure while it is not, so it is withheld.
 */
export function totalOf(
  payments: SealedPayment[],
  amounts: Map<string, bigint | null>,
  complete: boolean,
): TotalState {
  let sum = 0n;
  let opened = 0;
  for (const payment of payments) {
    const amount = amounts.get(paymentKey(payment));
    if (amount !== null && amount !== undefined) {
      sum += amount;
      opened++;
    }
  }
  if (opened === 0) return { kind: "none" };
  if (!complete || opened < payments.length) return { kind: "withheld" };
  return { kind: "total", value: sum };
}

export function NoKeyFits() {
  return (
    <span className="font-mono text-[0.875rem] text-fail">No key fits</span>
  );
}

export function WithheldTotal() {
  return (
    <span
      className="font-mono text-[0.875rem] md:whitespace-nowrap"
      style={{ color: "var(--color-wait)" }}
      title={WITHHELD_TITLE}
    >
      Total withheld
    </span>
  );
}

function PendingBar() {
  return <span className="skeleton-bar ml-auto block w-24" />;
}

function SkeletonRows() {
  return Array.from({ length: SKELETON_ROWS }, (_, index) => (
    <tr
      key={index}
      data-ledger-row={index}
      data-payment-row
      className="border-t border-line"
    >
      {SKELETON_WIDTHS.map((width, column) => {
        const hiddenOnPhone = column === 0 || column === 2;
        return (
          <td
            key={column}
            className={`${CELL} ${hiddenOnPhone ? "max-md:hidden" : ""} ${column === 3 ? "text-right" : ""}`}
          >
            <div
              className={`flex h-6 items-center ${column === 3 ? "justify-end" : ""}`}
            >
              <span className="skeleton-bar" style={{ width }} />
            </div>
          </td>
        );
      })}
    </tr>
  ));
}

function TxLink({
  interactive,
  txHash,
  children,
  className,
}: {
  interactive: boolean;
  txHash: string;
  children: ReactNode;
  className: string;
}) {
  if (!interactive) return <span className={className}>{children}</span>;
  return (
    <a
      href={`${EXPLORER_URL}/tx/${txHash}`}
      target="_blank"
      rel="noopener"
      aria-label={`Open payment ${shortId(txHash)} on Stellar Expert`}
      className={`${className} transition-colors hover:text-paper`}
    >
      {children}
    </a>
  );
}

function PaymentRow({
  row,
  layer,
  amounts,
  interactive,
  wide,
}: {
  row: Extract<LedgerRow, { kind: "payment" }>;
  layer: LedgerLayer;
  amounts: Map<string, bigint | null> | null;
  interactive: boolean;
  /** From the md breakpoint up the transaction sits in its own column, below it under the worker. */
  wide: boolean;
}) {
  const { payment } = row;
  const lens = layer === "revealed";
  const amount = amounts?.get(row.id) ?? null;

  let amountCell: ReactNode;
  if (!lens) {
    amountCell = (
      <span
        className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.875rem] text-faint"
        data-flicker={sealedText(payment)}
      >
        {sealedText(payment)}
      </span>
    );
  } else if (amounts === null) {
    amountCell = <PendingBar />;
  } else if (amount === null) {
    amountCell = <NoKeyFits />;
  } else {
    amountCell = (
      <>
        <span
          className="whitespace-nowrap font-display text-[1.125rem] font-medium leading-none"
          style={DISPLAY_36}
        >
          {displayUsdc(amount)}
        </span>{" "}
        <span className="t-label leading-none">USDC</span>
      </>
    );
  }

  return (
    <tr
      data-ledger-row={row.index}
      data-payment-row
      className={`border-t border-line ${lens ? "lens-tint" : ""}`}
    >
      <td className={`${CELL} max-md:hidden`}>
        <span className="whitespace-nowrap font-sans text-[0.9375rem] text-muted">
          {payment.periodLabel}
        </span>
      </td>
      <td className={CELL}>
        <span className="whitespace-nowrap font-mono text-[0.875rem] text-paper">
          {shortId(payment.worker)}
        </span>
        {wide ? null : (
          <span className="t-label block">
            <TxLink
              interactive={interactive}
              txHash={payment.txHash}
              className="underline decoration-line underline-offset-2"
            >
              tx {payment.txHash.slice(0, 4)}…{payment.txHash.slice(-4)}
            </TxLink>
          </span>
        )}
      </td>
      <td className={`${CELL} max-md:hidden`}>
        {wide ? (
          <TxLink
            interactive={interactive}
            txHash={payment.txHash}
            className="whitespace-nowrap font-mono text-[0.875rem] text-muted"
          >
            {shortId(payment.txHash)}
          </TxLink>
        ) : null}
      </td>
      <td className={`${CELL} text-right`}>{amountCell}</td>
    </tr>
  );
}

function SubtotalRow({
  row,
  layer,
  amounts,
  complete,
}: {
  row: Extract<LedgerRow, { kind: "subtotal" }>;
  layer: LedgerLayer;
  amounts: Map<string, bigint | null> | null;
  complete: boolean;
}) {
  const lens = layer === "revealed";
  const label = `${row.periodLabel} total`;

  let amountCell: ReactNode;
  if (!lens) {
    amountCell = (
      <span className="font-mono text-[0.875rem] text-faint">sealed</span>
    );
  } else if (amounts === null) {
    amountCell = <PendingBar />;
  } else {
    const total = totalOf(row.payments, amounts, complete);
    amountCell =
      total.kind === "none" ? (
        <NoKeyFits />
      ) : total.kind === "withheld" ? (
        <WithheldTotal />
      ) : (
        <span className="font-display text-[1rem] font-semibold leading-none text-seal-hi max-md:leading-[1.35] md:whitespace-nowrap">
          Total <span className="max-md:block">{displayUsdc(total.value)} USDC</span>
        </span>
      );
  }

  return (
    <tr
      data-ledger-row={row.index}
      className={`border-t border-line ${lens ? "lens-tint-subtotal" : ""}`}
      style={lens ? undefined : { background: "rgba(242,236,230,0.02)" }}
    >
      <td className={`${CELL} max-md:hidden`}>
        <span className="t-label whitespace-nowrap">{label}</span>
      </td>
      <td className={CELL}>
        <span className="t-label md:hidden">{label}</span>
      </td>
      <td className={`${CELL} max-md:hidden`} />
      <td className={`${CELL} text-right max-md:pl-2`}>{amountCell}</td>
    </tr>
  );
}

// One component draws both layers, so the sealed table and the revealed one
// can never drift apart: same columns, same rows, same heights.
export function LedgerTable({
  layer,
  payments,
  amounts,
  complete,
  failed,
  onRetry,
  interactive = true,
}: LedgerTableProps) {
  const lens = layer === "revealed";
  const wide = useWideScreen();
  const rows = useMemo(
    () => (payments ? buildLedgerRows(payments) : null),
    [payments],
  );

  if (lens && (failed || rows === null)) return null;

  return (
    <>
      <table
        className="w-full border-collapse"
        style={{ tableLayout: "fixed" }}
        data-layer={layer}
        aria-label="Payments"
      >
        <thead>
          <tr className={lens ? "lens-tint" : undefined}>
            <th className={`${HEAD_CELL} w-[22%] max-md:hidden`}>Run</th>
            <th className={`${HEAD_CELL} w-[26%] max-md:w-[58%]`}>Worker</th>
            <th className={`${HEAD_CELL} w-[22%] max-md:hidden`}>Payment</th>
            <th className={`${HEAD_CELL} w-[30%] text-right max-md:w-[42%]`}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {failed ? null : rows === null ? (
            <SkeletonRows />
          ) : (
            rows.map((row) =>
              row.kind === "payment" ? (
                <PaymentRow
                  key={row.id}
                  row={row}
                  layer={layer}
                  amounts={amounts}
                  interactive={interactive}
                  wide={wide}
                />
              ) : (
                <SubtotalRow
                  key={row.id}
                  row={row}
                  layer={layer}
                  amounts={amounts}
                  complete={complete}
                />
              ),
            )
          )}
        </tbody>
      </table>
      {failed && !lens ? (
        <div className="flex min-h-[318px] flex-col items-center justify-center gap-4 border-t border-line px-[22px] py-10 text-center">
          <p className="font-sans text-muted">
            Couldn&apos;t reach Stellar testnet just now.
          </p>
          <button type="button" className="btn-ghost" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </>
  );
}
