// Covers the dashboard and recovery paths against a fake chain: treasuryBalance shows only an
// opening that opens the chain and says whether a rebuild made it, and never rebuilds or prompts;
// clearDamagedRecord removes only a damaged pay-in-flight record and no opening; fundTreasury
// saves a deposit's hash before submitting and settles it first next time, so a crash mid-send
// never deposits twice. Does NOT cover the real network, real proofs, or the rebuild from chain
// history (stubbed here; core's tests and the live run cover it).
import {
  SubmitRejectedError,
  attemptsKey,
  decodeInvocation,
  inFlightKey,
  readSavedOpening,
  toSavedOpening,
  transactionHash,
  treasuryOpeningKey,
} from "@kalypso/core";
import type { ChainPort } from "@kalypso/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, SorobanDataBuilder, xdr } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { pointToBytes } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
import { auditorPublicKey } from "../sandbox/accounts";
import { sandboxConfig } from "../sandbox/config";
import { Keypair, commit } from "../sandbox/sdk";
import type { Point } from "../sandbox/sdk";
import { throwawayWallet } from "../wallet/throwaway";
import type { ConsoleContext } from "./context";
import { depositRecordKey, parseDepositRecord } from "./deposit-record";
import { ConsoleError } from "./errors";
import { openingStoreOver, type TextStore } from "./opening-store";

const holder = vi.hoisted(() => ({ ctx: undefined as unknown }));
vi.mock("./context", async (importOriginal) => ({ ...(await importOriginal<typeof import("./context")>()), consoleContext: () => holder.ctx }));
const rebuilt = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./rebuild", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild")>()),
  rebuildFromChain: async () => {
    rebuilt.calls++;
    return { value: 1n, deviceExpected: undefined, matchesDevice: false };
  },
}));

const { treasuryBalance } = await import("./balance");
const { fundTreasury } = await import("./funding");
const { clearDamagedRecord, rebuiltMarkerKey } = await import("./rebuild");

const config = sandboxConfig();
const token = config.contracts.token;
const COMPANY = 9n;
const MAX_TIME_FAR = 4_000_000_000;

const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(Object.entries(fields).map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })));
const bytes = (point: Point) => xdr.ScVal.scvBytes(Buffer.from(pointToBytes(point)));

function memoryText(): TextStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}

/**
 * A chain with one company whose admin is `admin`, a registered treasury whose spendable balance
 * is commit(spendable), and a script for what the network answers about each transaction hash.
 */
function fakeChain(admin: string) {
  const text = memoryText();
  const state = { spendable: { v: 0n, r: 0n }, submitted: [] as { method: string; hash: string; recordAtSubmit: string | undefined }[] };
  const answers = new Map<string, Awaited<ReturnType<ChainPort["waitFor"]>> | Error>();
  const script = { submit: "ok" as "ok" | "refuse" | "lose-reply", waitAfterSubmit: undefined as Error | undefined };
  const port: ChainPort = {
    async read(_contract, method) {
      if (method === "get_company") {
        return struct({
          admin: new Address(admin).toScVal(),
          accountant: new Address(Keypair.random().publicKey()).toScVal(),
          auditor_id: xdr.ScVal.scvU32(7),
          label: xdr.ScVal.scvString("Test Co"),
          created_ledger: xdr.ScVal.scvU32(1),
          active_workers: xdr.ScVal.scvU32(2),
          roster_len: xdr.ScVal.scvU32(2),
          runs_opened: xdr.ScVal.scvU32(0),
          admin_changes: xdr.ScVal.scvU32(0),
        });
      }
      if (method === "confidential_balance") {
        return struct({
          auditor_id: xdr.ScVal.scvU32(7),
          receiving_commitment: bytes(commit(0n, 0n)),
          spendable_commitment: bytes(commit(state.spendable.v, state.spendable.r)),
          spending_public_key: bytes(auditorPublicKey(11n)),
          viewing_public_key: bytes(auditorPublicKey(12n)),
        });
      }
      throw new Error(`unexpected read ${method}`);
    },
    async simulate() {
      return { ok: true, minResourceFee: "1000", transactionDataXdr: new SorobanDataBuilder().build().toXDR("base64"), authXdr: [], latestLedger: 100 };
    },
    async submit(signed) {
      const hash = transactionHash(signed, config.networkPassphrase);
      const { method } = decodeInvocation(signed, config.networkPassphrase);
      state.submitted.push({ method, hash, recordAtSubmit: text.map.get(depositRecordKey(admin)) });
      if (script.submit === "refuse") throw new SubmitRejectedError("ERROR", "txBadSeq");
      if (script.submit === "lose-reply") throw new Error("the reply was lost");
      return { hash };
    },
    async waitFor(hash) {
      const answer = answers.get(hash);
      if (answer instanceof Error) throw answer;
      if (answer) return answer;
      if (state.submitted.some((s) => s.hash === hash)) {
        if (script.waitAfterSubmit) throw script.waitAfterSubmit;
        return { status: "SUCCESS", ledger: 101 };
      }
      return { status: "NOT_FOUND", closeTime: 1_000 };
    },
    async sourceAccount() {
      return { sequence: String(100 + state.submitted.length) };
    },
    async latestLedger() {
      return { sequence: 101, closeTime: 1_900_000_000 };
    },
  };
  const ctx = {
    config,
    port,
    events: undefined as never,
    txSource: undefined as never,
    ledger: { xlmBalance: async () => 10_000_0000000n, usdcBalance: async () => 1_000_0000000n },
    history: undefined as never,
    store: openingStoreOver(text),
    text,
    prover: async () => {
      throw new Error("no proofs here");
    },
    wait: async () => undefined,
  } satisfies ConsoleContext;
  return { ctx, text, state, answers, script };
}

let employer: Keypair;
let chain: ReturnType<typeof fakeChain>;
beforeEach(() => {
  employer = Keypair.random();
  chain = fakeChain(employer.publicKey());
  holder.ctx = chain.ctx;
  rebuilt.calls = 0;
});

describe("treasuryBalance", () => {
  it("shows the saved opening that opens the chain, and says when the last rebuild made it", async () => {
    chain.state.spendable = { v: 4_600_000_000n, r: 99n };
    const opening = toSavedOpening(4_600_000_000n, 99n);
    await chain.ctx.store.put(treasuryOpeningKey(token, employer.publicKey()), opening);
    const wallet = throwawayWallet(employer);
    const signMessage = vi.spyOn(wallet, "signMessage");
    await expect(treasuryBalance(wallet, COMPANY)).resolves.toEqual({ value: 4_600_000_000n, source: "saved" });
    await chain.ctx.store.put(rebuiltMarkerKey(token, employer.publicKey()), opening);
    await expect(treasuryBalance(wallet, COMPANY)).resolves.toEqual({ value: 4_600_000_000n, source: "rebuilt" });
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("finds a landed pay's opening through the attempts list without writing anything", async () => {
    chain.state.spendable = { v: 300n, r: 5n };
    const batchKey = `kalypso/v1/batch/${config.contracts.payroll}/9/202610/${Keypair.random().publicKey()}/${"cd".repeat(32)}`;
    await chain.ctx.store.put(treasuryOpeningKey(token, employer.publicKey()), toSavedOpening(500n, 1n));
    await chain.ctx.store.put(batchKey, toSavedOpening(300n, 5n));
    await chain.ctx.store.put(attemptsKey(token, employer.publicKey()), [batchKey]);
    const before = new Map(chain.text.map);
    await expect(treasuryBalance(throwawayWallet(employer), COMPANY)).resolves.toEqual({ value: 300n, source: "saved" });
    expect(chain.text.map).toEqual(before);
  });

  it("refuses with a rebuildable error when nothing saved opens the chain, and never rebuilds", async () => {
    chain.state.spendable = { v: 700n, r: 3n };
    const none = treasuryBalance(throwawayWallet(employer), COMPANY);
    await expect(none).rejects.toBeInstanceOf(ConsoleError);
    await expect(none).rejects.toMatchObject({ code: "NEEDS_REBUILD", rebuildable: true });
    await chain.ctx.store.put(treasuryOpeningKey(token, employer.publicKey()), toSavedOpening(701n, 3n));
    await expect(treasuryBalance(throwawayWallet(employer), COMPANY)).rejects.toMatchObject({ code: "NEEDS_REBUILD", rebuildable: true });
    expect(rebuilt.calls).toBe(0);
    expect(readSavedOpening(await chain.ctx.store.get(treasuryOpeningKey(token, employer.publicKey())))?.v).toBe(701n);
  });

  it("refuses a wallet that is not the company's admin", async () => {
    await expect(treasuryBalance(throwawayWallet(Keypair.random()), COMPANY)).rejects.toMatchObject({ code: "NOT_ADMIN" });
  });
});

describe("clearDamagedRecord", () => {
  const recordKey = () => inFlightKey(token, employer.publicKey());

  it("removes a damaged record and leaves every opening and the attempts list", async () => {
    const opening = toSavedOpening(9n, 9n);
    await chain.ctx.store.put(treasuryOpeningKey(token, employer.publicKey()), opening);
    await chain.ctx.store.put(attemptsKey(token, employer.publicKey()), ["kalypso/v1/batch/x"]);
    chain.text.map.set(recordKey(), JSON.stringify({ hash: "not-a-hash", maxTime: 5, batchKey: "x" }));
    await expect(clearDamagedRecord(throwawayWallet(employer), COMPANY)).resolves.toEqual({ cleared: true });
    expect(chain.text.map.has(recordKey())).toBe(false);
    expect(await chain.ctx.store.get(treasuryOpeningKey(token, employer.publicKey()))).toEqual(opening);
    expect(await chain.ctx.store.get(attemptsKey(token, employer.publicKey()))).toEqual(["kalypso/v1/batch/x"]);
  });

  it("removes text that is not even a record, and says when there was nothing", async () => {
    chain.text.map.set(recordKey(), "{broken");
    await expect(clearDamagedRecord(throwawayWallet(employer), COMPANY)).resolves.toEqual({ cleared: true });
    await expect(clearDamagedRecord(throwawayWallet(employer), COMPANY)).resolves.toEqual({ cleared: false });
  });

  it("refuses to clear a record that reads fine, because that pay may still land", async () => {
    const hash = "ab".repeat(32);
    const good = { hash, maxTime: 1_900_000_000, batchKey: `kalypso/v1/batch/${config.contracts.payroll}/9/202610/${employer.publicKey()}/${hash}` };
    await chain.ctx.store.put(recordKey(), good);
    await expect(clearDamagedRecord(throwawayWallet(employer), COMPANY)).rejects.toMatchObject({ code: "RECORD_NOT_DAMAGED" });
    expect(await chain.ctx.store.get(recordKey())).toEqual(good);
  });
});

describe("fundTreasury deposit retry safety", () => {
  const deposits = () => chain.state.submitted.filter((s) => s.method === "deposit");
  const merges = () => chain.state.submitted.filter((s) => s.method === "merge");
  const savedRecord = () => parseDepositRecord(chain.text.map.get(depositRecordKey(employer.publicKey())));

  it("saves the deposit's hash and amount before submitting it, and clears it after the merge", async () => {
    const result = await fundTreasury(throwawayWallet(employer), { amount: 4_600_000_000n });
    expect(deposits()).toHaveLength(1);
    const atSubmit = parseDepositRecord(deposits()[0]?.recordAtSubmit);
    expect(atSubmit).toMatchObject({ hash: deposits()[0]?.hash, amount: 4_600_000_000n });
    expect(JSON.parse(deposits()[0]?.recordAtSubmit as string).amount).toBe("4600000000");
    expect(merges()).toHaveLength(1);
    expect(savedRecord()).toBeUndefined();
    expect(result).toMatchObject({ resumed: false, deposited: 4_600_000_000n, depositTx: deposits()[0]?.hash });
  });

  it("never deposits twice after a crash mid-send: the next call finds the deposit landed and only merges", async () => {
    chain.script.submit = "lose-reply";
    chain.script.waitAfterSubmit = new Error("the tab closed while waiting");
    await expect(fundTreasury(throwawayWallet(employer), { amount: 4_600_000_000n })).rejects.toThrow(/tab closed/);
    expect(deposits()).toHaveLength(1);
    const first = savedRecord();
    expect(first?.hash).toBe(deposits()[0]?.hash);

    chain.script.submit = "ok";
    chain.script.waitAfterSubmit = undefined;
    chain.answers.set(first?.hash as string, { status: "SUCCESS", ledger: 101 });
    const result = await fundTreasury(throwawayWallet(employer), { amount: 9_999_000_000n });
    expect(deposits()).toHaveLength(1);
    expect(merges()).toHaveLength(1);
    expect(result).toMatchObject({ resumed: true, deposited: 4_600_000_000n, depositTx: first?.hash });
    expect(savedRecord()).toBeUndefined();
  });

  it("clears a saved deposit that failed on chain, or expired by chain time, and sends a new one", async () => {
    for (const answer of [{ status: "FAILED" as const, ledger: 90 }, { status: "NOT_FOUND" as const, closeTime: 2_000_000_000 }]) {
      chain = fakeChain(employer.publicKey());
      holder.ctx = chain.ctx;
      const old = "ef".repeat(32);
      chain.text.map.set(depositRecordKey(employer.publicKey()), JSON.stringify({ hash: old, amount: "100", maxTime: 1_700_000_000 }));
      chain.answers.set(old, answer);
      const result = await fundTreasury(throwawayWallet(employer), { amount: 250n });
      expect(deposits()).toHaveLength(1);
      expect(deposits()[0]?.hash).not.toBe(old);
      expect(result).toMatchObject({ resumed: false, deposited: 250n });
    }
  });

  it("stops with DEPOSIT_PENDING while the saved deposit can still land, and sends nothing", async () => {
    const pending = "12".repeat(32);
    chain.text.map.set(depositRecordKey(employer.publicKey()), JSON.stringify({ hash: pending, amount: "100", maxTime: MAX_TIME_FAR }));
    chain.answers.set(pending, { status: "NOT_FOUND", closeTime: 1_900_000_000 });
    await expect(fundTreasury(throwawayWallet(employer), { amount: 250n })).rejects.toMatchObject({ code: "DEPOSIT_PENDING" });
    expect(chain.state.submitted).toHaveLength(0);
    expect(savedRecord()?.hash).toBe(pending);
  });

  it("clears the record when the network refuses the deposit outright", async () => {
    chain.script.submit = "refuse";
    await expect(fundTreasury(throwawayWallet(employer), { amount: 250n })).rejects.toMatchObject({ code: "SUBMIT_REFUSED" });
    expect(deposits()).toHaveLength(1);
    expect(savedRecord()).toBeUndefined();
  });
});
