import { useTranslations } from "next-intl";
import type { KeyMode, ReadPhase } from "@/hooks/use-sealed-payroll";
import type { PlainT } from "@/lib/i18n/types";

// Idle counts as reading: the read starts a moment after the page loads.
export function isLoading(phase: ReadPhase) {
  return phase === "idle" || phase === "history" || phase === "opening";
}

/** The honest sentence for a read in progress. t is the landing.status namespace. */
export function loadingLabel(
  t: PlainT,
  mode: KeyMode,
  phase: ReadPhase,
  done: number,
  total: number,
) {
  if (phase === "opening") {
    return mode === "accountant" ? t("openingAccountant", { done, total }) : t("openingStranger", { done, total });
  }
  return t("reading");
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
  const t = useTranslations("landing.status");
  if (phase === "error") return null;

  if (isLoading(phase)) {
    return (
      <span className="flex max-w-[18rem] items-start gap-2 text-right">
        <span
          aria-hidden="true"
          className="dot-pulse mt-[5px] h-2 w-2 shrink-0 rounded-full bg-wait"
        />
        <span className="t-label text-left text-wait" style={PLAIN_CASE}>
          {label}
        </span>
      </span>
    );
  }

  if (complete) {
    return (
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
        <span className="t-label text-ok">{t("complete")}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2" title={t("incompleteTitle")}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-wait" />
      <span className="t-label text-wait">{t("incomplete")}</span>
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
