import { requireAccount } from '../chain/scval.js';
import { fetchWorkerPayrollHistory, type HistorySource } from '../history/events.js';

/** What accept_invite emits (packages/contracts/payroll/src/events.rs WorkerJoined, snake case). */
const WORKER_JOINED = 'worker_joined';

/**
 * The companies `worker` joined, read from our payroll contract's own WorkerJoined events: the
 * distinct company ids of every join that names exactly this worker, in ledger order. A company
 * the worker later left or was removed from stays listed, because memberships_of counts joins.
 *
 * This is where to look, never whether the list is whole. complete only says the read covered
 * every ledger from history.fromLedger with nothing unreadable; loadWorkerView still confirms
 * each company on its roster and compares the count with memberships_of (threat model C48).
 *
 * @throws AddressError for a bad worker or contract id, RangeError for a bad fromLedger,
 *   TypeError for a bad archive URL, or the RPC's own error when no source can be read.
 */
export async function discoverWorkerCompanies(input: {
  history: HistorySource;
  contracts: { payroll: string; token: string };
  worker: string;
}): Promise<{ companyIds: bigint[]; complete: boolean }> {
  const worker = requireAccount(input.worker, ['G', 'C']);
  const { history } = input;
  const result = await fetchWorkerPayrollHistory({
    port: history.rpc,
    ...(history.archive ? { archive: history.archive } : {}),
    contracts: input.contracts,
    worker,
    fromLedger: history.fromLedger,
  });
  const seen = new Set<bigint>();
  for (const event of result.events) {
    if (event.kind !== 'ignored' || event.contract !== 'payroll' || event.name !== WORKER_JOINED || event.companyId === undefined) continue;
    // A join's one address topic is the worker who accepted, so a second address means it is not one.
    if (event.parties.length !== 1 || event.parties[0] !== worker) continue;
    seen.add(event.companyId);
  }
  return { companyIds: [...seen], complete: result.complete };
}
