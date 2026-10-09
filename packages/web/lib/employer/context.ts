import { createCircuitProver, createRpcChainPort, createRpcEventsPort, createTxSourcePort } from "@kalypso/core";
import type { ChainPort, CircuitProverPort, EventsPort, HistorySource, OpeningStore, ProverPort, TxSourcePort } from "@kalypso/core";
import deployment from "../../../contracts/deployments/testnet.json";
import { archiveSource } from "../archive";
import { Networks } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { createLedgerPort, sleep, type LedgerPort } from "../sandbox/accounts";
import { sandboxConfig, type SandboxConfig } from "../sandbox/config";
import { loadCircuits } from "../sandbox/sdk";
import { ConsoleError } from "./errors";
import { browserOpeningStore, browserTextStore, type TextStore } from "./opening-store";

/**
 * Every history read starts at the token's deploy ledger, which is at or before any account's
 * registration and any company's creation, as core's HistorySource asks. Reads stay complete
 * only while the RPC still holds that ledger (about 7 days); after that the archive must be
 * configured here (see the report's follow-ups).
 */
export const HISTORY_FROM_LEDGER: number = deployment.contracts.token.deployTx.ledger;
/** The payroll contract's own deploy ledger: no company_created event can be older. */
export const PAYROLL_FROM_LEDGER: number = deployment.contracts.payroll.deployTx.ledger;

/** One progress message for the screen. The sentence never carries an amount. */
export interface ConsoleProgress {
  sentence: string;
  done: number;
  total: number;
  txHash?: string;
}
export type OnProgress = (p: ConsoleProgress) => void;

export interface ConsoleContext {
  config: SandboxConfig;
  port: ChainPort;
  events: EventsPort;
  txSource: TxSourcePort;
  ledger: LedgerPort;
  history: HistorySource;
  /** This browser's treasury openings and pay in flight (IndexedDB). Opened on first use. */
  store: OpeningStore;
  /** The same IndexedDB store as text, for the console's own records (a deposit in flight). */
  text: TextStore;
  /** The browser prover, started on first use and shared by every proof on this page. */
  prover(): Promise<ProverPort>;
  wait(ms: number): Promise<void>;
}

let live: ConsoleContext | undefined;
let prover: Promise<CircuitProverPort> | undefined;

/**
 * The live testnet context, made once per page. The stack is the one sandboxConfig checks (token,
 * USDC, payroll and registry wired to each other), and it is refused unless it is testnet.
 *
 * @throws ConsoleError NOT_TESTNET; Error from sandboxConfig when the deployment records disagree.
 */
export function consoleContext(): ConsoleContext {
  if (live) return live;
  const config = sandboxConfig();
  if (config.networkPassphrase !== Networks.TESTNET) throw new ConsoleError("NOT_TESTNET");
  const events = createRpcEventsPort({ rpcUrl: config.rpcUrl });
  live = {
    config,
    port: createRpcChainPort({ rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase }),
    events,
    txSource: createTxSourcePort({ rpcUrl: config.rpcUrl, horizonUrl: config.horizonUrl }),
    ledger: createLedgerPort(config),
    history: { rpc: events, ...archiveSource(), fromLedger: HISTORY_FROM_LEDGER },
    store: browserOpeningStore(),
    text: browserTextStore(),
    prover: () => (prover ??= loadCircuits().then(createCircuitProver)),
    wait: sleep,
  };
  return live;
}

/** Releases the prover's bb.js backends. The next proof starts a new one. */
export async function releaseProver(): Promise<void> {
  const held = prover;
  prover = undefined;
  if (held) await held.then((p) => p.destroy()).catch(() => undefined);
}

/** Calls onProgress, ignoring a display callback that throws so a step in flight is never abandoned. */
export function reporter(onProgress: OnProgress | undefined, total: number) {
  let done = 0;
  const send = (sentence: string, txHash?: string) => {
    try {
      onProgress?.(txHash === undefined ? { sentence, done, total } : { sentence, done, total, txHash });
    } catch {
      /* ignored on purpose */
    }
  };
  return {
    say: (sentence: string, txHash?: string) => send(sentence, txHash),
    tick: (sentence: string, txHash?: string) => {
      done = Math.min(total, done + 1);
      send(sentence, txHash);
    },
  };
}
