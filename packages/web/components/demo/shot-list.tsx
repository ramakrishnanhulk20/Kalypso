import { SHOTS } from "./shots";
import { elapsedSeconds, rowStatus } from "./run-state";
import type { RowStatus, RunState } from "./run-state";

function Status({ status, seconds }: { status: RowStatus; seconds: number | undefined }) {
  if (status === "waiting") return <span className="t-label">waiting</span>;
  if (status === "current") {
    return (
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="dot-pulse h-2 w-2 rounded-full bg-seal" />
        <span className="font-mono text-[0.875rem] text-paper">{seconds ?? 0} s</span>
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok" />
        <span className="font-mono text-[0.875rem] text-muted">{seconds === undefined ? "done" : `${seconds} s`}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-fail" />
      <span className="t-label">stopped</span>
    </span>
  );
}

export function ShotList({ run, now }: { run: RunState; now: number }) {
  return (
    <ol aria-label="Sandbox steps">
      {SHOTS.map((shot, index) => {
        const status = rowStatus(run, index);
        const current = status === "current";
        return (
          <li
            key={shot.key}
            aria-current={current ? "step" : undefined}
            className="relative isolate grid grid-cols-[auto_1fr] items-baseline gap-x-5 border-t border-line py-[18px] sm:grid-cols-[auto_1fr_auto]"
          >
            {current ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 -inset-x-3 -z-10"
                style={{ background: "rgba(201,71,58,0.05)", boxShadow: "inset 2px 0 0 var(--color-seal)" }}
              />
            ) : null}
            <span className="t-label">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <p className="font-sans text-[1.0625rem] text-paper">{shot.title}</p>
              <p className="mt-1 font-sans text-[0.9375rem] text-muted">{shot.description}</p>
            </div>
            <div className="flex min-w-[5.5rem] justify-end max-sm:col-start-2 max-sm:mt-2 max-sm:justify-start">
              <Status status={status} seconds={current ? elapsedSeconds(run, index, now) : run.seconds[shot.key]} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
