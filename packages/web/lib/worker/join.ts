import {
  ContractCallError,
  PayrollErrorCode,
  buildAcceptInvite,
  buildCheckedRegister,
  buildRegisterKey,
  confidentialBalance,
  getAuditorKey,
  getCompany,
  getOwnerOf,
  isPayrollError,
  randomAuditorSecret,
  readRegisteredAuditorId,
  workerStatus,
} from "@kalypso/core";
import { WorkerError, toWorkerError } from "./errors";
import { setUpWallet } from "./passkey";
import { H, scalarMul, type Point } from "./sdk";
import { confirm, sendCall, type Landed } from "./send";
import { addressProven, heldBy, type WorkerRuntime, type WorkerSession } from "./session";
import type { SponsorPort } from "./sponsor";
import { readWorkerRecord, updateWorkerRecord, withCompany } from "./storage";

export type JoinStep = "invite" | "wallet" | "auditor_key" | "token_account" | "accept";

/** One step of joining, for the screen. label is plain words and never carries an amount. */
export interface JoinProgress {
  step: JoinStep;
  state: "checking" | "sending" | "done" | "skipped";
  label: string;
  txHash?: string;
  /** The worker's own auditor id, shown before they approve the token registration (C10, C33). */
  auditorId?: number;
}

export interface JoinResult {
  companyId: bigint;
  auditorId: number;
  /** Every transaction this call sent, in order. Hashes are public. */
  transactions: string[];
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * The passkey wallet on chain and proven to trust this passkey (setUpWallet, the same deploy and
 * chain read createPasskey runs). New wallets are deployed when the passkey is made; this finishes
 * one saved before that, or whose deploy then was refused.
 */
async function ensureWallet(rt: WorkerRuntime, worker: WorkerSession, sponsor: SponsorPort, report: (p: JoinProgress) => void, sent: string[]): Promise<void> {
  if (heldBy(worker).kind !== "passkey") return;
  report({ step: "wallet", state: "checking", label: "Checking your wallet" });
  let sending = false;
  const { hash } = await setUpWallet(rt, worker, sponsor, () => {
    sending = true;
    report({ step: "wallet", state: "sending", label: "Setting up your wallet" });
  });
  if (hash !== null) sent.push(hash);
  if (sending) report({ step: "wallet", state: "done", label: "Your wallet is ready", ...(hash === null ? {} : { txHash: hash }) });
  else report({ step: "wallet", state: "skipped", label: "Your wallet is already set up" });
}

/** True when the registry says this worker owns the id. An unknown id reads false; an outage throws. */
async function ownsAuditorId(rt: WorkerRuntime, worker: string, id: number): Promise<boolean> {
  try {
    return (await getOwnerOf(rt.port, rt.config.contracts.auditor, id)) === worker;
  } catch (err) {
    if (err instanceof ContractCallError && err.contractCode !== undefined) return false;
    throw err;
  }
}

/** An id a register_key relay handed out, once the chain confirms it. null when that relay never landed. */
async function idFromRelay(rt: WorkerRuntime, sponsor: SponsorPort, relayed: { transactionId: string; hash: string | null }): Promise<number | null> {
  let hash = relayed.hash;
  if (hash === null) {
    try {
      hash = (await sponsor.status(relayed.transactionId)).hash;
    } catch {
      return null;
    }
    if (hash === null) return null;
  }
  let landed: Landed;
  try {
    landed = await confirm(rt, hash);
  } catch (err) {
    if (err instanceof WorkerError && err.code === "TX_FAILED") return null;
    throw err;
  }
  return landed.returnValue === undefined ? null : readRegisteredAuditorId(landed.returnValue);
}

/**
 * The worker's own auditor id and the key under it (C33). The id is only ever the value a confirmed
 * register_key returned (C43): first the one this browser recorded, if the registry still says the
 * worker owns it; then one from a relay that was sent but not yet read back; otherwise a new key is
 * registered. Its secret is drawn with the platform's secure random generator and dropped at once:
 * the worker reads their own pay with their own viewing key, so nobody needs to read what is
 * encrypted to their auditor slot, and the worker, as owner, can rotate in a key of their own later.
 */
async function ownAuditor(
  rt: WorkerRuntime,
  worker: WorkerSession,
  sponsor: SponsorPort,
  report: (p: JoinProgress) => void,
  sent: string[],
): Promise<{ id: number; key: Point }> {
  const record = readWorkerRecord(rt.storage, worker.address);
  const registry = rt.config.contracts.auditor;
  const known = async (id: number | null) => (id !== null && (await ownsAuditorId(rt, worker.address, id)) ? id : null);
  let id = await known(record.auditorId);
  if (id === null && record.auditorKeyRelay !== null) id = await known(await idFromRelay(rt, sponsor, record.auditorKeyRelay));
  if (id !== null) {
    updateWorkerRecord(rt.storage, worker.address, (r) => {
      r.auditorId = id;
      r.auditorKeyRelay = null;
    });
    report({ step: "auditor_key", state: "skipped", label: `Audit key ${id} already belongs to you`, auditorId: id });
    return { id, key: await getAuditorKey(rt.port, registry, id) };
  }
  const key = scalarMul(randomAuditorSecret(), H);
  report({ step: "auditor_key", state: "sending", label: "Creating your own audit key" });
  const landed = await sendCall(
    rt,
    worker,
    sponsor,
    { contractId: registry, build: (base) => buildRegisterKey(base, { owner: worker.address, point: key }) },
    (relayed) => updateWorkerRecord(rt.storage, worker.address, (r) => void (r.auditorKeyRelay = relayed)),
  );
  sent.push(landed.hash);
  if (landed.returnValue === undefined) throw new WorkerError("CHAIN_DISAGREES", { hash: landed.hash });
  // The id is read from the transaction the relayer named, which is only its word: it becomes the
  // worker's own, saved and shown, once the registry says the worker owns it (C33, C43).
  const newId = await known(readRegisteredAuditorId(landed.returnValue));
  if (newId === null) throw new WorkerError("CHAIN_DISAGREES", { hash: landed.hash });
  updateWorkerRecord(rt.storage, worker.address, (r) => {
    r.auditorId = newId;
    r.auditorKeyRelay = null;
  });
  report({ step: "auditor_key", state: "done", label: `Audit key ${newId} belongs to you`, txHash: landed.hash, auditorId: newId });
  return { id: newId, key };
}

/**
 * Registers the worker with the confidential token under their own auditor id, unless the chain
 * shows them registered already. The registration goes through buildCheckedRegister, which reads
 * the id's owner and key from chain and refuses unless they are the worker's (C43).
 */
async function ensureTokenAccount(rt: WorkerRuntime, worker: WorkerSession, sponsor: SponsorPort, report: (p: JoinProgress) => void, sent: string[]): Promise<number> {
  const { token, auditor: registry } = rt.config.contracts;
  report({ step: "token_account", state: "checking", label: "Checking your private account" });
  const existing = await confidentialBalance(rt.port, token, worker.address);
  if (existing !== null) {
    if (!existing.pvk.equals(worker.keys.PVK)) throw new WorkerError("KEYS_MISMATCH");
    report({ step: "token_account", state: "skipped", label: "Your private account is already set up", auditorId: existing.auditorId });
    return existing.auditorId;
  }
  const own = await ownAuditor(rt, worker, sponsor, report, sent);
  report({ step: "token_account", state: "sending", label: "Proving your private account in this browser", auditorId: own.id });
  const proof = await (await rt.prover()).proveRegister(worker.keys);
  report({ step: "token_account", state: "sending", label: "Registering your private account", auditorId: own.id });
  const landed = await sendCall(rt, worker, sponsor, {
    contractId: token,
    build: (base) =>
      buildCheckedRegister(rt.port, base, { account: worker.address, auditorId: own.id, data: proof, registry, auditorOwner: worker.address, auditorKey: own.key }),
  });
  sent.push(landed.hash);
  const after = await confidentialBalance(rt.port, token, worker.address);
  if (after === null || after.auditorId !== own.id || !after.pvk.equals(worker.keys.PVK)) throw new WorkerError("CHAIN_DISAGREES", { hash: landed.hash });
  updateWorkerRecord(rt.storage, worker.address, (r) => {
    if (landed.ledger !== undefined) r.registeredLedger = landed.ledger;
  });
  report({ step: "token_account", state: "done", label: "Your private account is set up", txHash: landed.hash, auditorId: own.id });
  return own.id;
}

/**
 * Joins one company from its invite: deploys a passkey wallet if it is not on chain (also before
 * reporting NOT_INVITED, so the address the screen then shows is proven), gives the worker their
 * own auditor id, registers them with the confidential token, then accepts the invite. Every
 * step reads the chain first and does nothing that is already there, so running it again after a
 * crash, a closed tab or a refused relay picks up where it stopped. The company id is remembered on
 * this browser only once the chain shows the worker active.
 *
 * @throws WorkerError COMPANY_NOT_FOUND, NOT_INVITED, INVITE_WITHDRAWN, BUSY (another tab is joining),
 *   STORAGE_FAILED (joined, but this browser could not save it), or any step's own error; SponsorError.
 */
export async function join(
  rt: WorkerRuntime,
  worker: WorkerSession,
  companyId: bigint,
  sponsor: SponsorPort,
  onProgress?: (p: JoinProgress) => void,
): Promise<JoinResult> {
  if (typeof companyId !== "bigint" || companyId < 0n || companyId > U64_MAX) throw new WorkerError("INVALID_INPUT");
  if (typeof sponsor?.send !== "function" || typeof sponsor.status !== "function") throw new WorkerError("INVALID_INPUT");
  heldBy(worker);
  const report = (p: JoinProgress) => onProgress?.(p);
  const { payroll } = rt.config.contracts;
  return rt.exclusive(`kalypso/worker/v1/join/${worker.address}`, async () => {
    const sent: string[] = [];
    try {
      report({ step: "invite", state: "checking", label: "Checking the invite" });
      try {
        await getCompany(rt.port, payroll, companyId);
      } catch (err) {
        if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new WorkerError("COMPANY_NOT_FOUND");
        throw err;
      }
      const status = await workerStatus(rt.port, payroll, companyId, worker.address);
      if (status === null) {
        // The screen then asks the worker to send their address to the employer, so it is proven
        // first: a passkey session saved before wallets were deployed at creation has not been (C51).
        if (!addressProven(worker)) await ensureWallet(rt, worker, sponsor, report, sent);
        throw new WorkerError("NOT_INVITED");
      }
      if (status === "Removed") throw new WorkerError("INVITE_WITHDRAWN");
      let auditorId: number;
      if (status === "Active") {
        const account = await confidentialBalance(rt.port, rt.config.contracts.token, worker.address);
        if (account === null) throw new WorkerError("CHAIN_DISAGREES");
        auditorId = account.auditorId;
        report({ step: "accept", state: "skipped", label: "You are already part of this company" });
      } else {
        report({ step: "invite", state: "done", label: "The invite is waiting for you" });
        await ensureWallet(rt, worker, sponsor, report, sent);
        auditorId = await ensureTokenAccount(rt, worker, sponsor, report, sent);
        report({ step: "accept", state: "sending", label: "Accepting the invite" });
        const landed = await sendCall(rt, worker, sponsor, { contractId: payroll, build: (base) => buildAcceptInvite(base, { companyId, worker: worker.address }) });
        sent.push(landed.hash);
        if ((await workerStatus(rt.port, payroll, companyId, worker.address)) !== "Active") throw new WorkerError("CHAIN_DISAGREES", { hash: landed.hash });
        report({ step: "accept", state: "done", label: "You joined the company", txHash: landed.hash });
      }
      worker.auditorId = auditorId;
      if (!updateWorkerRecord(rt.storage, worker.address, (r) => withCompany(r, companyId))) throw new WorkerError("STORAGE_FAILED");
      return { companyId, auditorId, transactions: sent };
    } catch (err) {
      throw toWorkerError(err);
    }
  });
}
