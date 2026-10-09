import { AddressError, buildInviteWorker, parseAccount, workerStatus } from "@kalypso/core";
import type { WorkerStatus } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { adminCompany } from "./company";
import { consoleContext, reporter, type OnProgress } from "./context";
import { ConsoleError } from "./errors";
import { withWalletLock } from "./lock";
import { confirmOnChain, sendCall } from "./send";

/** One call invites at most this many: each is its own transaction, sent one after another. */
export const MAX_INVITES = 50;

export interface InviteResult {
  address: string;
  /** invited: this call sent the invite. already-invited and active: the chain already had them. */
  status: "invited" | "already-invited" | "active";
  txHash?: string;
}

function requireWorkers(workers: unknown, admin: string): string[] {
  if (!Array.isArray(workers) || workers.length === 0 || workers.length > MAX_INVITES) {
    throw new ConsoleError("WORKERS_INVALID", { message: `List 1 to ${MAX_INVITES} worker addresses.` });
  }
  const seen = new Map<string, number>();
  return workers.map((value, i) => {
    let address: string;
    try {
      address = parseAccount(value as string).address;
    } catch (err) {
      if (!(err instanceof AddressError)) throw err;
      throw new ConsoleError("WORKERS_INVALID", { message: `Worker ${i + 1}: ${err.message}`, line: i + 1 });
    }
    if (address === admin) throw new ConsoleError("WORKERS_INVALID", { message: `Worker ${i + 1} is the company's own wallet, which cannot be a worker.`, line: i + 1 });
    const first = seen.get(address);
    if (first !== undefined) throw new ConsoleError("WORKERS_INVALID", { message: `Worker ${i + 1} is the same address as worker ${first}. List each worker once.`, line: i + 1 });
    seen.set(address, i + 1);
    return address;
  });
}

/**
 * Invites workers to the company, one invite_worker each, signed by the admin wallet. A worker the
 * chain already shows as invited or active is skipped, and a removed worker is invited again, so
 * calling it twice sends nothing new. Workers then accept from their own wallet; an invite needs
 * no token registration, accepting does.
 *
 * @throws ConsoleError COMPANY_ID_INVALID, COMPANY_NOT_FOUND, NOT_ADMIN, WORKERS_INVALID (the line
 *   is the worker's position in the list), BUSY, NOT_ON_CHAIN or any sendCall code; the wallet's own error.
 */
export async function inviteWorkers(
  wallet: WalletPort,
  input: { companyId: bigint; workers: string[] },
  onProgress?: OnProgress,
): Promise<InviteResult[]> {
  const ctx = consoleContext();
  const payroll = ctx.config.contracts.payroll;
  return withWalletLock(wallet.address, async () => {
    const company = await adminCompany(ctx, wallet, input.companyId);
    const workers = requireWorkers(input.workers, company.admin);
    const { companyId } = input;
    const p = reporter(onProgress, workers.length);
    const status = (worker: string): Promise<WorkerStatus | null> => workerStatus(ctx.port, payroll, companyId, worker);
    const results: InviteResult[] = [];
    for (const [i, worker] of workers.entries()) {
      const n = `${i + 1} of ${workers.length}`;
      const now = await status(worker);
      if (now === "Active" || now === "Invited") {
        results.push({ address: worker, status: now === "Active" ? "active" : "already-invited" });
        p.tick(now === "Active" ? `Worker ${n} is already in the company` : `Worker ${n} is already invited`);
        continue;
      }
      p.say(`Inviting worker ${n}`);
      const sent = await sendCall(ctx, wallet, {
        what: "invite_worker",
        contractId: payroll,
        build: (base) => buildInviteWorker(base, { companyId, worker }),
      });
      await confirmOnChain(ctx, `Worker ${n}'s invite`, async () => {
        const after = await status(worker);
        return after === "Invited" || after === "Active";
      });
      results.push({ address: worker, status: "invited", txHash: sent.hash });
      p.tick(`Worker ${n} is invited`, sent.hash);
    }
    return results;
  });
}
