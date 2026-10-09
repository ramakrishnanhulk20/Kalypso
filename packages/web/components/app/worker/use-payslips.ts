"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkerView } from "@kalypso/core";
import type { WorkerSession } from "@/lib/worker";
import type { ShownError } from "@/components/app/errors";
import { shownFrom } from "./shown";
import type { CompanyFacts, WorkerKit } from "./worker-lib";

export type PayslipsState =
  | { phase: "idle" }
  /** answered: an earlier read for this same worker finished, so the chain was already asked which companies they joined. */
  | { phase: "loading"; view: WorkerView | null; answered: boolean }
  | { phase: "done"; view: WorkerView }
  /** Not registered with the token, and in no company on chain: a new account with nothing to read yet. */
  | { phase: "unjoined" }
  | { phase: "failed"; error: ShownError; view: WorkerView | null };

export function viewOf(state: PayslipsState): WorkerView | null {
  return state.phase === "idle" || state.phase === "unjoined" ? null : state.view;
}

/** The state a new read starts in. The last view, and whether a read ever answered, carry over for the same worker only. */
export function loadingFrom(was: PayslipsState, sameWorker: boolean): PayslipsState {
  if (!sameWorker || was.phase === "idle") return { phase: "loading", view: null, answered: false };
  return { phase: "loading", view: viewOf(was), answered: was.phase === "loading" ? was.answered : true };
}

/** What the payslips section says in the unjoined phase. */
export const UNJOINED_TEXT = "No payslips yet. Send your address to your employer. Once they invite you and you join, your payslips appear here.";

/**
 * The state a failed read leaves. loadPayslips says NOT_REGISTERED only for a worker not registered
 * with the token whom the chain lists in no company (lib/worker/payslips.ts), which is the empty
 * state of a new account, not an error.
 */
export function failedFrom(was: PayslipsState, err: unknown): PayslipsState {
  const error = shownFrom(err);
  if (error.code === "NOT_REGISTERED") return { phase: "unjoined" };
  return { phase: "failed", error, view: viewOf(was) };
}

/** True once a read for this worker has finished, so the chain was asked which companies they joined before any join card. */
export function answered(state: PayslipsState): boolean {
  return state.phase === "loading" ? state.answered : state.phase !== "idle";
}

/**
 * The companies this worker joined as far as the page knows: those this browser recorded, then
 * those the latest view confirmed on the roster, which covers every real join the payroll
 * contract's events name for them. Each once, in that order.
 */
export function joinedFrom(recorded: readonly bigint[], state: PayslipsState): bigint[] {
  return [...new Set([...recorded, ...(viewOf(state)?.confirmedCompanyIds ?? [])])];
}

/**
 * Asks for the company of each payslip in `view` and hands every answer to `remember`, "unknown"
 * for one that cannot be read. An answer is kept whatever has been read since, because a company's
 * name and readability do not change with the next read, and a later read that fails must not
 * leave the card waiting for an answer it threw away. It is dropped only when `stillCurrent` says
 * the worker or the kit changed since the question was asked.
 */
export function readCompanies(
  kit: Pick<WorkerKit, "company">,
  view: Pick<WorkerView, "payslips">,
  stillCurrent: () => boolean,
  remember: (companyId: string, facts: CompanyFacts | "unknown") => void,
): void {
  for (const companyId of new Set(view.payslips.map((slip) => slip.companyId))) {
    const keep = (facts: CompanyFacts | "unknown") => {
      if (stillCurrent()) remember(companyId.toString(), facts);
    };
    kit.company(companyId).then(
      (facts) => keep(facts ?? "unknown"),
      () => keep("unknown"),
    );
  }
}

// Reads the worker's payslips and balance whenever `tick` changes. The same worker's last view
// stays on screen while the next one is read, and a slower older read never replaces a newer one. Each payslip's
// company, its name and whether anyone can read its amounts, comes from the chain separately; one
// that cannot be read is marked unknown, never left out, because a missing label would look like
// the safe answer (C47).
export function usePayslips(kit: WorkerKit | null, worker: WorkerSession | null, enabled: boolean, tick: number) {
  const [state, setState] = useState<PayslipsState>({ phase: "idle" });
  const [companies, setCompanies] = useState<ReadonlyMap<string, CompanyFacts | "unknown">>(new Map());
  // React's development double-run of effects must not read the whole history twice.
  const inflight = useRef<{ worker: WorkerSession; tick: number; read: Promise<WorkerView> } | null>(null);
  // Who is signed in now, so a company answer for someone else is dropped (readCompanies).
  const owner = useRef<{ kit: WorkerKit | null; worker: WorkerSession | null }>({ kit, worker });
  // Whose read the state holds, so one worker's view and companies never stand in for the next one's.
  const stateOf = useRef<WorkerSession | null>(null);

  useEffect(() => {
    owner.current = { kit, worker };
  }, [kit, worker]);

  useEffect(() => {
    if (!kit || !worker || !enabled) {
      stateOf.current = null;
      setState({ phase: "idle" });
      return;
    }
    let current = true;
    const sameWorker = stateOf.current === worker;
    stateOf.current = worker;
    setState((was) => loadingFrom(was, sameWorker));
    const same = inflight.current?.worker === worker && inflight.current.tick === tick;
    const read = same && inflight.current ? inflight.current.read : kit.lib.loadPayslips(worker);
    inflight.current = { worker, tick, read };
    const forget = () => {
      if (inflight.current?.read === read) inflight.current = null;
    };
    read.then(forget, forget);
    read.then(
      (view) => {
        if (!current) return;
        setState({ phase: "done", view });
        const stillCurrent = () => owner.current.kit === kit && owner.current.worker === worker;
        readCompanies(kit, view, stillCurrent, (companyId, facts) => setCompanies((all) => new Map(all).set(companyId, facts)));
      },
      (err: unknown) => current && setState((was) => failedFrom(was, err)),
    );
    return () => {
      current = false;
    };
  }, [kit, worker, enabled, tick]);

  return { state, companies };
}
