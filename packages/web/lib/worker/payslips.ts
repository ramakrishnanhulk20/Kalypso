import { MAX_WORKER_COMPANIES, PayrollErrorCode, discoverWorkerCompanies, getCompany, getMembershipsOf, isPayrollError, loadWorkerView } from "@kalypso/core";
import type { HistorySource, WorkerView } from "@kalypso/core";
import type { SponsorError } from "./sponsor";
import { WorkerError, toWorkerError } from "./errors";
import { heldBy, type WorkerRuntime, type WorkerSession } from "./session";
import { emptyRecord, readWorkerRecord, setCompanies, updateWorkerRecord, type WorkerRecord } from "./storage";

/**
 * The first ledger this worker's history has to be read from: the earliest of their token
 * registration and the creation of every company they joined, never before the token existed.
 * A company is always created before its worker registers to join it, so its creation ledger is a
 * safe start even on a browser that never saw the registration. With nothing recorded, the read
 * starts at the token's deploy, which RPC's window may no longer reach: core then reports the view
 * incomplete rather than guessing.
 */
export async function historyStart(rt: WorkerRuntime, record: WorkerRecord): Promise<number> {
  const starts: number[] = record.registeredLedger === null ? [] : [record.registeredLedger];
  for (const companyId of record.companyIds) {
    try {
      starts.push((await getCompany(rt.port, rt.config.contracts.payroll, companyId)).createdLedger);
    } catch (err) {
      if (!isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw err;
    }
  }
  const earliest = starts.length === 0 ? rt.config.tokenDeployLedger : Math.min(...starts);
  return Math.max(rt.config.tokenDeployLedger, earliest);
}

export function historyFrom(rt: WorkerRuntime, fromLedger: number): HistorySource {
  return { rpc: rt.events, ...(rt.archive ? { archive: rt.archive } : {}), fromLedger };
}

/**
 * The companies one view reads: those this browser recorded that the join events no longer name
 * (older than the read reaches, or hidden), then every one the join events name, in ledger order.
 * Only the newest MAX_WORKER_COMPANIES are read; the view's company count shows any left out.
 */
function companiesToRead(recorded: readonly bigint[], found: readonly bigint[]): bigint[] {
  const named = new Set(found);
  return [...recorded.filter((id) => !named.has(id)), ...found].slice(-MAX_WORKER_COMPANIES);
}

/**
 * The record keeps exactly the companies the view confirmed on the roster (C52), so a company id a
 * join event named but the roster refused is never stored. A company a join recorded while the
 * view was read stays too: join records one only once the chain shows the worker active there.
 */
function keepConfirmed(rt: WorkerRuntime, address: string, before: readonly bigint[], confirmed: readonly bigint[]): void {
  const now = readWorkerRecord(rt.storage, address).companyIds;
  const kept = emptyRecord();
  setCompanies(kept, [...confirmed, ...now.filter((id) => !before.includes(id) && !confirmed.includes(id))]);
  if (kept.companyIds.length === now.length && kept.companyIds.every((id, i) => id === now[i])) return;
  updateWorkerRecord(rt.storage, address, (r) => void (r.companyIds = kept.companyIds));
}

/**
 * NOT_REGISTERED stays itself only for a worker the chain lists in no company: the screen shows
 * that as an account with nothing yet, not as an error. Joining needs a token registration, so the
 * same answer for a worker the chain counts as a member means two chain reads disagree.
 */
async function unjoinedOrError(rt: WorkerRuntime, worker: WorkerSession, err: WorkerError | SponsorError): Promise<WorkerError | SponsorError> {
  if (!(err instanceof WorkerError) || err.code !== "NOT_REGISTERED") return err;
  try {
    return (await getMembershipsOf(rt.port, rt.config.contracts.payroll, worker.address)) === 0 ? err : new WorkerError("CHAIN_DISAGREES");
  } catch (readErr) {
    return toWorkerError(readErr);
  }
}

/**
 * The worker's payslips and verified balances for every company they joined, exactly as core's
 * loadWorkerView builds them: each payslip passed every C18 check and is bound to its own
 * transaction, balances appear only when they open the chain (C16), and the view is complete only
 * when memberships_of and each company's run count agree with what was found (C48).
 *
 * The companies read are those this browser recorded and those the payroll contract's own join
 * events name for this worker, read from the token's deploy ledger, so a new device or a cleared
 * browser finds them too. The join events only say where to look: afterwards the record holds
 * exactly the companies the view confirmed on the roster, so a forged join is read and dropped,
 * never stored, and a company whose join was hidden still shows as a company_count_mismatch gap.
 * A refused write changes nothing, since the next read finds the companies on chain again.
 *
 * @throws WorkerError NOT_REGISTERED only for a worker not registered with the token whom the chain
 *   lists in no company; KEYS_MISMATCH, NETWORK, CHAIN_DISAGREES and the like otherwise, the same
 *   for a failed join-event read as for a failed view read.
 */
export async function payslips(rt: WorkerRuntime, worker: WorkerSession): Promise<WorkerView> {
  heldBy(worker);
  const contracts = { payroll: rt.config.contracts.payroll, token: rt.config.contracts.token };
  try {
    const found = await discoverWorkerCompanies({ history: historyFrom(rt, rt.config.tokenDeployLedger), contracts, worker: worker.address });
    const record = readWorkerRecord(rt.storage, worker.address);
    const companyIds = companiesToRead(record.companyIds, found.companyIds);
    const view = await loadWorkerView({
      port: rt.port,
      history: historyFrom(rt, await historyStart(rt, { ...record, companyIds })),
      contracts,
      worker: worker.address,
      keys: worker.keys,
      companyIds,
      txSource: rt.txSource,
    });
    keepConfirmed(rt, worker.address, record.companyIds, view.confirmedCompanyIds);
    return view;
  } catch (err) {
    throw await unjoinedOrError(rt, worker, toWorkerError(err));
  }
}
