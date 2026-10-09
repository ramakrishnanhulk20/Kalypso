// Covers exportBooks: it audits with the accountant's own derived key, writes the file with core's
// exportAuditCsv (so C25's formula guard still applies), names it kalypso-{companyId}-{yyyy-mm-dd}.csv,
// and refuses an incomplete audit with the reasons in plain words and no amount. Also refuses a
// wallet whose key does not hold the company's auditor id. Does NOT cover core's audit rules
// (auditCompany is replaced by a fake answer here) or the live chain (the live check covers that).
import type { AuditResult } from "@kalypso/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, xdr } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { pointToBytes } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
import { sandboxConfig } from "../sandbox/config";
import { Keypair } from "../sandbox/sdk";
import type { Point } from "../sandbox/sdk";
import { throwawayWallet } from "../wallet/throwaway";

const holder = vi.hoisted(() => ({ ctx: undefined as unknown, audit: undefined as unknown, secrets: [] as bigint[] }));
vi.mock("../employer/context", async (importOriginal) => ({ ...(await importOriginal<typeof import("../employer/context")>()), consoleContext: () => holder.ctx }));
vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  auditCompany: async (input: { auditorSecret: bigint }) => {
    holder.secrets.push(input.auditorSecret);
    return holder.audit;
  },
}));

const { exportBooks, incompleteBooksReason } = await import("./books");
const { accountantSecret } = await import("./key");

const config = sandboxConfig();
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(Object.entries(fields).map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })));

function chainWithAuditor(owner: string, key: Point) {
  return {
    async read(_contract: string, method: string) {
      if (method === "get_company") {
        return struct({
          admin: new Address(Keypair.random().publicKey()).toScVal(),
          accountant: new Address(owner).toScVal(),
          auditor_id: xdr.ScVal.scvU32(42),
          label: xdr.ScVal.scvString("Test Co"),
          created_ledger: xdr.ScVal.scvU32(1),
          active_workers: xdr.ScVal.scvU32(2),
          roster_len: xdr.ScVal.scvU32(2),
          runs_opened: xdr.ScVal.scvU32(1),
          admin_changes: xdr.ScVal.scvU32(0),
        });
      }
      if (method === "owner_of") return new Address(owner).toScVal();
      if (method === "get_key") return xdr.ScVal.scvBytes(Buffer.from(pointToBytes(key)));
      throw new Error(`unexpected read ${method}`);
    },
  };
}

const worker = Keypair.random().publicKey();
const complete: AuditResult = {
  complete: true,
  runs: [{ runId: 202610n, periodLabel: "=HYPERLINK(\"http://x\")", lines: [{ worker, amount: 1_255_000_000n, txHash: "ab".repeat(32) }], total: 1_255_000_000n }],
  grandTotal: 1_255_000_000n,
  undecryptable: [],
  gaps: [],
};

let accountant: ReturnType<typeof throwawayWallet>;
beforeEach(async () => {
  holder.ctx = { config, port: undefined, history: undefined, txSource: undefined };
  accountant = throwawayWallet(Keypair.random());
  const { point } = await accountantSecret(accountant);
  holder.ctx = { config, port: chainWithAuditor(accountant.address, point), history: {}, txSource: {} };
  holder.secrets = [];
});

describe("exportBooks", () => {
  it("audits with the accountant's derived key and writes core's CSV under a dated name", async () => {
    holder.audit = complete;
    const { filename, csv } = await exportBooks(accountant, { companyId: 9n });
    expect(filename).toBe(`kalypso-9-${new Date().toISOString().slice(0, 10)}.csv`);
    expect(holder.secrets).toEqual([(await accountantSecret(accountant)).secret]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("run_id,period,worker,amount_usdc,tx_hash");
    expect(lines[1]).toBe(`202610,"'=HYPERLINK(""http://x"")",${worker},125.5,${"ab".repeat(32)}`);
  });

  it("refuses an incomplete audit and says why in plain words, with no amount", async () => {
    holder.audit = {
      ...complete,
      complete: false,
      gaps: [{ reason: "paid_count_mismatch", companyId: 9n, runId: 202610n, expected: 2, found: 1 }],
      undecryptable: [{ txHash: "cd".repeat(32), reason: "transaction_unavailable" }],
    } satisfies AuditResult;
    const refused = exportBooks(accountant, { companyId: 9n });
    await expect(refused).rejects.toMatchObject({ code: "BOOKS_INCOMPLETE" });
    const message = await refused.catch((e: Error) => e.message);
    expect(message).toBe(
      "The books are incomplete, so nothing was exported: the chain says run 202610 paid 2 workers but 1 payslips passed every check; a payment's transaction could not be fetched.",
    );
    expect(message).not.toMatch(/125|1255/);
  });

  it("names a history that is only behind when the audit gives no other reason", () => {
    expect(incompleteBooksReason({ ...complete, complete: false })).toMatch(/could not be read in full, or it is behind the newest ledger/);
  });

  it("refuses a wallet whose key does not hold the company's auditor id, before auditing", async () => {
    const stranger = throwawayWallet(Keypair.random());
    await expect(exportBooks(stranger, { companyId: 9n })).rejects.toMatchObject({ code: "BOOKS_NOT_YOURS" });
    expect(holder.secrets).toEqual([]);
  });
});
