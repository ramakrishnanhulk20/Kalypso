"use client";

import { useId, useState } from "react";
import type { JoinProgress, JoinStep, WorkerSession } from "@/lib/worker";
import { CopyButton } from "@/components/app/copy-button";
import { ErrorNote } from "@/components/app/error-note";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { NewPayKey } from "./new-pay-key";
import { PubliclyReadable } from "./public-chip";
import { needsNewPayKey, shownErrors } from "./shown";
import type { WorkerKit } from "./worker-lib";

interface Row {
  step: JoinStep;
  state: JoinProgress["state"];
  label: string;
}

// A step keeps its place in the list the first time it is reported, whatever it reports next.
function withProgress(rows: Row[], p: JoinProgress): Row[] {
  const row: Row = { step: p.step, state: p.state, label: p.label };
  return rows.some((r) => r.step === p.step) ? rows.map((r) => (r.step === p.step ? row : r)) : [...rows, row];
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-ok)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-[5px] shrink-0">
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
    </svg>
  );
}

// One step is the one being worked on; a step that began earlier and is waiting on a smaller step
// inside it shows as waiting, so only one spinner turns at a time.
function StepRow({ row, current, stopped }: { row: Row; current: boolean; stopped: boolean }) {
  const working = row.state === "checking" || row.state === "sending";
  return (
    <li className="flex items-start gap-3 font-sans text-[0.9375rem]" aria-current={working && current && !stopped ? "step" : undefined}>
      {!working ? (
        <Check />
      ) : stopped ? (
        <span aria-hidden="true" className="mt-[9px] h-2 w-2 shrink-0 rounded-full bg-fail" />
      ) : current ? (
        <span aria-hidden="true" className="spinner mt-[5px]" />
      ) : (
        <span aria-hidden="true" className="mt-[5px] h-[14px] w-[14px] shrink-0 rounded-full border border-faint" />
      )}
      <span className={working && current && !stopped ? "text-paper" : "text-muted"}>{row.label}</span>
    </li>
  );
}

// The invite in the link, ready to accept. Joining sets up the worker's wallet, audit key and
// private account and then accepts the invite, all paid for by the fee sponsor. onSettled runs
// after every attempt, since one may have proven the wallet even when it stopped. A worker whose
// address turns out to be taken gets a new pay key, handed up through onNewWorker.
export function JoinCard({
  kit,
  worker,
  companyId,
  label,
  publiclyReadable,
  onJoined,
  onSettled,
  onNewWorker,
}: {
  kit: WorkerKit;
  worker: WorkerSession;
  companyId: bigint;
  label: string;
  /** The company is bound to the published demo accountant id, so anyone can read its amounts (C47). */
  publiclyReadable: boolean;
  onJoined: (acceptHash: string | null) => void;
  onSettled: () => void;
  onNewWorker: (worker: WorkerSession, setupFailure?: unknown) => void;
}) {
  const headingId = useId();
  const [rows, setRows] = useState<Row[]>([]);
  const [latest, setLatest] = useState<JoinStep | null>(null);

  const join = useAction(async (onProgress) => {
    setRows([]);
    let acceptHash: string | null = null;
    try {
      const result = await shownErrors(() =>
        kit.lib.joinCompany(worker, companyId, kit.lib.createHttpSponsor(), (p) => {
          setRows((all) => withProgress(all, p));
          setLatest(p.step);
          if (p.step === "accept" && p.state === "done" && p.txHash !== undefined) acceptHash = p.txHash;
          onProgress({ sentence: p.label, done: 0, total: 1, ...(p.txHash === undefined ? {} : { txHash: p.txHash }) });
        }),
      );
      onJoined(acceptHash);
      return result;
    } finally {
      onSettled();
    }
  });
  useLeaveWarning(join.running);

  return (
    <section aria-labelledby={headingId} className="rounded-card border border-line bg-ink-2 p-6">
      <h2 id={headingId} className="break-words font-display text-[1.5rem] font-medium leading-[1.15] text-paper">
        Join {label}
      </h2>
      {publiclyReadable ? (
        <div className="mt-3">
          <PubliclyReadable />
        </div>
      ) : null}
      <p className="mt-3 font-sans text-base text-muted">
        Kalypso will set up your private pay account and accept the invite. It takes about a minute, and it costs you nothing.
      </p>
      <div className="mt-6">
        <StepButton action={join} className="w-full" onClick={() => void join.start()}>
          Join {label}
        </StepButton>
      </div>

      {rows.length > 0 ? (
        <ol aria-label="Joining steps" className="mt-5 space-y-3">
          {rows.map((row) => (
            <StepRow key={row.step} row={row} current={row.step === latest} stopped={join.error !== null} />
          ))}
        </ol>
      ) : null}

      {join.error ? (
        <>
          <ErrorNote error={join.error} />
          {needsNewPayKey(join.error) ? <NewPayKey kit={kit} onCreated={onNewWorker} /> : null}
          {join.error.code === "NOT_INVITED" && kit.lib.addressProven(worker) ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <p role="alert" className="min-w-0 font-sans text-[0.9375rem] text-fail">
                Ask your employer to invite this address: <span className="break-all font-mono text-paper">{worker.address}</span>
              </p>
              <CopyButton text={worker.address} what="your address" />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
