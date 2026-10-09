"use client";

import { isPublishedAuditor } from "./public-chip";
import { cleanChainText } from "./text";

export type WorkerLib = typeof import("@/lib/worker");

/** What the worker screens show about a company, read from the chain. */
export interface CompanyFacts {
  /** Its name as the chain holds it, made safe to show. */
  label: string;
  /** True when it is bound to the published demo accountant id, so anyone can read its amounts (C47). */
  publiclyReadable: boolean;
}

/** What the worker screens need beyond the lib's own actions: reads that need no sign-in. */
export interface WorkerKit {
  lib: WorkerLib;
  /** Needed to read the time window of a payment the lib built. */
  networkPassphrase: string;
  /** The company ids this browser recorded as joined for this worker. */
  joinedCompanies(address: string): bigint[];
  /** A company's name and whether anyone can read its amounts. null when no such company exists. */
  company(companyId: bigint): Promise<CompanyFacts | null>;
}

// The worker code pulls in the Stellar SDK, the passkey kit and the prover and touches browser
// storage, so it loads from the browser only. It starts loading when the page opens, so a tap on
// Sign in finds it ready: some browsers refuse a passkey prompt that comes too long after the tap.
let loading: Promise<WorkerKit> | undefined;

export function loadWorker(): Promise<WorkerKit> {
  loading ??= build().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

async function build(): Promise<WorkerKit> {
  // The lib's own entry first: it puts the Buffer global in place before anything else loads.
  const lib = await import("@/lib/worker");
  const [{ workerConfig }, storage, core] = await Promise.all([import("@/lib/worker/config"), import("@/lib/worker/storage"), import("@kalypso/core")]);
  const config = workerConfig();
  const port = core.createRpcChainPort({ rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase });
  // A company's name and auditor id never change once it exists, so each is read once per page.
  const known = new Map<string, CompanyFacts>();

  return {
    lib,
    networkPassphrase: config.networkPassphrase,
    joinedCompanies: (address) => storage.readWorkerRecord(storage.browserStorage(), address).companyIds,
    async company(companyId) {
      const key = companyId.toString();
      const cached = known.get(key);
      if (cached !== undefined) return cached;
      try {
        const company = await core.getCompany(port, config.contracts.payroll, companyId);
        const facts = {
          label: cleanChainText(company.label) || `Company #${key}`,
          publiclyReadable: isPublishedAuditor(core.PUBLISHED_DEMO_AUDITOR_IDS, config.contracts.auditor, company.auditorId),
        };
        known.set(key, facts);
        return facts;
      } catch (err) {
        if (core.isPayrollError(err, core.PayrollErrorCode.CompanyNotFound)) return null;
        throw lib.toWorkerError(err);
      }
    },
  };
}
