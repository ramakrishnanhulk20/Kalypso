export type ChipTone = "ok" | "wait" | "muted" | "fail";

const COLOUR: Record<ChipTone, string> = {
  ok: "var(--color-ok)",
  wait: "var(--color-wait)",
  muted: "var(--color-muted)",
  fail: "var(--color-fail)",
};

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

// The same dot and label as the ledger card's status chip, for one row of a list.
export function RowChip({ tone, children }: { tone: ChipTone; children: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: COLOUR[tone] }} />
      <span className="t-label" style={{ ...PLAIN_CASE, color: COLOUR[tone] }}>
        {children}
      </span>
    </span>
  );
}
