"use client";

import { useEffect, useMemo, useReducer, useState } from "react";
import type { WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import { describeError } from "@/components/app/errors";
import type { ShownError } from "@/components/app/errors";
import { TxLink } from "@/components/app/tx-link";
import { CashOut } from "./cash-out";
import { FinishSetup } from "./finish-setup";
import { InviteStrip } from "./invite-strip";
import { JoinCard } from "./join-card";
import { JoinedLine } from "./joined-line";
import { PayslipsSection } from "./payslips-section";
import { Rise } from "./rise";
import { SessionBar } from "./session-bar";
import { showsFinishSetup, showsPayslips } from "./setup-gate";
import { shownFrom } from "./shown";
import { SignedOut } from "./signed-out";
import { useInvite } from "./use-invite";
import { answered, joinedFrom, usePayslips, viewOf } from "./use-payslips";
import { loadWorker } from "./worker-lib";
import type { WorkerKit } from "./worker-lib";

// The whole worker page. The session lives in this component's state only, so closing the tab
// or pressing Sign out forgets it; the passkey stays with the device and signs in again.
export function WorkerPortal() {
  const [kit, setKit] = useState<WorkerKit | null>(null);
  const [loadError, setLoadError] = useState<ShownError | null>(null);
  const [worker, setWorker] = useState<WorkerSession | null>(null);
  const [justJoined, setJustJoined] = useState<{ label: string; hash: string | null; publiclyReadable: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  // Why the wallet deploy at create stopped, shown on the signed-in screen until setup finishes.
  const [setupFailure, setSetupFailure] = useState<ShownError | null>(null);
  // A join attempt can prove the wallet even when it stops, so the bar is drawn again after each one.
  const [, recheck] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    loadWorker().then(setKit, (err: unknown) => setLoadError(describeError(err)));
  }, []);

  // Read while rendering so a returning worker never sees the join card for a moment. The tick
  // changes after a join, which is when this browser writes the company down.
  const recorded = useMemo(() => (kit && worker ? kit.joinedCompanies(worker.address) : []), [kit, worker, tick]);

  const invite = useInvite(kit);
  const proven = kit !== null && worker !== null && kit.lib.addressProven(worker);
  const onChain = kit !== null && worker !== null && kit.lib.walletOnChain(worker);
  // The payslips are read even while an invite waits, as if its join card were up: that read finds
  // every company the chain confirms, so an invite to one joined on another device never shows the
  // join card. Whether the card shows depends on this read, so the read cannot wait on the card.
  const mayJoin = invite.status === "found";
  const readNeeded =
    kit !== null && worker !== null && showsPayslips({ waitForJoin: false, finishNeeded: showsFinishSetup({ kind: worker.kind, proven, joinShown: mayJoin, invite: invite.status }), onChain });
  const { state, companies } = usePayslips(kit, worker, readNeeded, tick);
  const view = viewOf(state);
  const joinedIds = joinedFrom(recorded, state);
  const joinNeeded = worker !== null && invite.status === "found" && !joinedIds.includes(invite.companyId) && answered(state);
  const finishNeeded = kit !== null && worker !== null && showsFinishSetup({ kind: worker.kind, proven, joinShown: joinNeeded || (invite.status === "found" && !answered(state)), invite: invite.status });
  // A worker who has joined nothing yet has no payslips to show; the page waits for the invite
  // instead of showing an empty account before the join card.
  const waitForJoin = joinedIds.length === 0 && (invite.status === "loading" || joinNeeded);
  const payslipsShown = readNeeded && showsPayslips({ waitForJoin, finishNeeded, onChain });
  const max = view !== null && view.spendable !== undefined && view.receiving !== undefined ? view.spendable + view.receiving : null;

  const signOut = () => {
    setWorker(null);
    setJustJoined(null);
    setSetupFailure(null);
    setTick(0);
  };

  const startOver = (next: WorkerSession, failure?: unknown) => {
    setWorker(next);
    setJustJoined(null);
    setSetupFailure(failure === undefined ? null : shownFrom(failure));
    setTick(0);
  };

  return (
    <div>
      <InviteStrip invite={invite} />

      {worker === null || kit === null ? (
        <>
          {loadError ? (
            <div className="mb-6 max-w-[420px]">
              <ErrorNote error={loadError} />
            </div>
          ) : null}
          <SignedOut kit={kit} onSignedIn={startOver} />
        </>
      ) : (
        <div key={worker.address}>
          <h1 className="sr-only">Your pay</h1>
          <SessionBar address={kit.lib.addressProven(worker) ? worker.address : null} onSignOut={signOut} />

          {justJoined ? (
            <Rise className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1">
              <JoinedLine label={justJoined.label} publiclyReadable={justJoined.publiclyReadable}>
                {justJoined.hash ? <TxLink hash={justJoined.hash} /> : null}
              </JoinedLine>
            </Rise>
          ) : null}

          {finishNeeded ? (
            <FinishSetup
              kit={kit}
              worker={worker}
              reason={setupFailure}
              onDone={() => {
                setSetupFailure(null);
                setTick((n) => n + 1);
              }}
              onNewWorker={startOver}
            />
          ) : null}

          {joinNeeded && invite.status === "found" ? (
            <div className="mt-8">
              <JoinCard
                kit={kit}
                worker={worker}
                companyId={invite.companyId}
                label={invite.label}
                publiclyReadable={invite.publiclyReadable}
                onJoined={(hash) => {
                  setJustJoined({ label: invite.label, hash, publiclyReadable: invite.publiclyReadable });
                  setTick((n) => n + 1);
                }}
                onSettled={recheck}
                onNewWorker={startOver}
              />
            </div>
          ) : null}

          {payslipsShown ? <PayslipsSection state={state} companies={companies} onRetry={() => setTick((n) => n + 1)} /> : null}
          {payslipsShown && view !== null ? <CashOut kit={kit} worker={worker} max={max} onMoved={() => setTick((n) => n + 1)} /> : null}
        </div>
      )}
    </div>
  );
}
