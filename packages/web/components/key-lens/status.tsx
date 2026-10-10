import type { KeyMode, ReadPhase } from "@/hooks/use-sealed-payroll";

const INCOMPLETE_TITLE =
  "The chain's own counts disagree with the history read, so some payments may be missing here.";

// Idle counts as reading: the read starts a moment after the page loads.
export function isLoading(phase: ReadPhase) {
  return phase === "idle" || phase === "history" || phase === "opening";
}

export function loadingLabel(
  mode: KeyMode,
  phase: ReadPhase,
  done: number,
  total: number,
) {
  if (phase === "opening") {
    return mode === "accountant"
      ? `Opening them with the demo key, in your browser · ${done} of ${total}`
      : `Trying a random key on ${total} payments · ${done} of ${total}`;
  }
  return "Reading sealed payments from Stellar testnet";
}

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

export function StatusChip({
  phase,
  complete,
  label,
}: {
  phase: ReadPhase;
  complete: boolean;
  label: string;
}) {
  if (phase === "error") return null;

  if (isLoading(phase)) {
    return (
      <span className="flex max-w-[18rem] items-start gap-2 text-right">
        <span
          aria-hidden="true"
          className="dot-pulse mt-[5px] h-2 w-2 shrink-0 rounded-full bg-wait"
        />
        <span className="t-label text-left" style={{ ...PLAIN_CASE, color: "var(--color-wait)" }}>
          {label}
        </span>
      </span>
    );
  }

  if (complete) {
    return (
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
        <span className="t-label" style={{ color: "var(--color-ok)" }}>
          Verified complete
        </span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2" title={INCOMPLETE_TITLE}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-wait" />
      <span className="t-label" style={{ color: "var(--color-wait)" }}>
        History incomplete
      </span>
    </span>
  );
}

// A 1px line on the header's bottom edge: a sweeping segment while the
// history is read, a filling bar while the payments open.
export function ProgressLine({
  phase,
  done,
  total,
}: {
  phase: ReadPhase;
  done: number;
  total: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 -bottom-px h-px overflow-hidden"
      style={{
        opacity: isLoading(phase) ? 1 : 0,
        transition: "opacity 300ms ease-out",
      }}
    >
      {phase === "opening" ? (
        <div
          className="h-full bg-seal"
          style={{
            width: `${total > 0 ? (done / total) * 100 : 0}%`,
            transition: "width 200ms ease-out",
          }}
        />
      ) : (
        <div className="progress-sweep h-full bg-seal" />
      )}
    </div>
  );
}

export function LoadingLine({
  phase,
  label,
}: {
  phase: ReadPhase;
  label: string;
}) {
  return (
    <div className="load-line">
      <p role="status" className="t-label px-[22px] py-[10px]" style={PLAIN_CASE}>
        {isLoading(phase) ? label : ""}
      </p>
    </div>
  );
}
