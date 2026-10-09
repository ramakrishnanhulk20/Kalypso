"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { archiveSource } from "@/lib/archive";
import {
  createRpcChainPort,
  createRpcEventsPort,
  createTxSourcePort,
  randomAuditorSecret,
  readSealedPayroll,
} from "@kalypso/core";
import type { SealedPayroll } from "@kalypso/core";
import {
  contracts,
  demoAccountantSecret,
  horizonUrl,
  networkPassphrase,
  rpcUrl,
  showcase,
} from "@/lib/stack";

export type KeyMode = "accountant" | "stranger";
export type ReadPhase = "idle" | "history" | "opening" | "done" | "error";

type ReadState = {
  phase: ReadPhase;
  done: number;
  total: number;
  payroll: SealedPayroll | null;
};

const IDLE: ReadState = { phase: "idle", done: 0, total: 0, payroll: null };

// The accountant read waits for the hero entrance so the page is not busy
// decoding events while the title is still rising.
const ACCOUNTANT_DELAY_MS = 1500;

// One read per key for the life of the page. Switching keys back and forth
// never reads the chain twice.
const states: Record<KeyMode, ReadState> = {
  accountant: IDLE,
  stranger: IDLE,
};
const listeners = new Set<() => void>();

function publish(mode: KeyMode, next: ReadState) {
  states[mode] = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let ports: {
  port: ReturnType<typeof createRpcChainPort>;
  events: ReturnType<typeof createRpcEventsPort>;
  txSource: ReturnType<typeof createTxSourcePort>;
} | null = null;

function getPorts() {
  ports ??= {
    port: createRpcChainPort({ rpcUrl, networkPassphrase }),
    events: createRpcEventsPort({ rpcUrl }),
    txSource: createTxSourcePort({ rpcUrl, horizonUrl }),
  };
  return ports;
}

// A key nobody holds, made once per page load and only when someone asks for it.
let strangerSecret: bigint | null = null;

function secretFor(mode: KeyMode): bigint {
  if (mode === "accountant") return demoAccountantSecret;
  strangerSecret ??= randomAuditorSecret();
  return strangerSecret;
}

function startRead(mode: KeyMode) {
  if (states[mode].phase !== "idle") return;
  publish(mode, { phase: "history", done: 0, total: 0, payroll: null });
  const { port, events, txSource } = getPorts();

  readSealedPayroll({
    port,
    history: { rpc: events, ...archiveSource(), fromLedger: showcase.fromLedger },
    txSource,
    contracts,
    companyId: showcase.companyId,
    treasury: showcase.treasury,
    auditorSecret: secretFor(mode),
    onProgress: (step, done, total) => {
      if (step === "done") return;
      publish(mode, { phase: step, done, total, payroll: null });
    },
  })
    .then((payroll) => {
      const opened = payroll.payments.filter((p) => p.amount !== null).length;
      publish(mode, {
        phase: "done",
        done: opened,
        total: payroll.payments.length,
        payroll,
      });
    })
    .catch(() => {
      publish(mode, { phase: "error", done: 0, total: 0, payroll: null });
    });
}

function retryRead(mode: KeyMode) {
  if (states[mode].phase !== "error") return;
  states[mode] = IDLE;
  startRead(mode);
}

let firstMountAt: number | null = null;

// A look at one key's read that never starts it. The status chip uses this to
// follow the accountant read while the stranger's key is chosen.
export function useSealedPayrollState(mode: KeyMode) {
  return useSyncExternalStore(
    subscribe,
    () => states[mode],
    () => IDLE,
  );
}

export function useSealedPayroll(mode: KeyMode) {
  const state = useSyncExternalStore(
    subscribe,
    () => states[mode],
    () => IDLE,
  );

  useEffect(() => {
    firstMountAt ??= performance.now();
    // The status chip follows the accountant read whichever key is chosen, so
    // that read always starts, even if the stranger key is picked first.
    const wait = Math.max(
      0,
      ACCOUNTANT_DELAY_MS - (performance.now() - firstMountAt),
    );
    const timer = window.setTimeout(() => startRead("accountant"), wait);
    if (mode === "stranger") startRead("stranger");
    return () => window.clearTimeout(timer);
  }, [mode]);

  const retry = useCallback(() => retryRead(mode), [mode]);

  return { ...state, retry };
}
