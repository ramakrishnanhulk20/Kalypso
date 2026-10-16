// Covers the dashboard balance for a treasury this browser has no saved opening for: it reads as
// empty, at zero, only when both on-chain commitments are the zero opening's and the token history,
// read in full and reaching the newest ledger, holds exactly this treasury's own registration. An
// empty history (an archive that stops before the registration), one behind the chain, one that
// cannot be read or is partial, a registration of another account, a second event, a commitment
// that says something is there, or a saved opening that does not open the chain all stay "needs a
// rebuild", as before. Does NOT cover core's opening checks themselves
// (loadTreasuryOpening and the history reader are replaced here) or the live chain (a live check
// outside this suite reads one never-funded and one funded treasury).
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as realCore from "@kalypso/core";
import { sandboxConfig } from "../sandbox/config";
import { Keypair } from "../sandbox/sdk";
import { throwawayWallet } from "../wallet/throwaway";
import type { ConsoleProgress } from "./progress";

const holder = vi.hoisted(() => ({
  ctx: undefined as unknown,
  load: undefined as unknown as () => Promise<unknown>,
  account: undefined as unknown as () => Promise<unknown>,
  history: undefined as unknown as () => Promise<unknown>,
}));
vi.mock("./context", async (importOriginal) => ({ ...(await importOriginal<typeof import("./context")>()), consoleContext: () => holder.ctx }));
vi.mock("./company", () => ({ adminCompany: async () => ({}) }));
vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  loadTreasuryOpening: () => holder.load(),
  confidentialBalance: () => holder.account(),
  fetchAccountHistory: () => holder.history(),
}));

const { treasuryBalance } = await import("./balance");

const config = sandboxConfig();
const commitment = (v: bigint) => realCore.readSavedOpening(realCore.toSavedOpening(v, 0n))!.commitment;
const ZERO = commitment(0n);
const LATEST = 5_200_000;
const event = (type: string, account?: string) => ({ kind: "token", event: { type, account } });
const NO_SAVED = () => Promise.reject(new realCore.HistoryIncompleteError("NO_SAVED_OPENING"));

let wallet: ReturnType<typeof throwawayWallet>;
let historyReads: number;
beforeEach(() => {
  wallet = throwawayWallet(Keypair.random());
  historyReads = 0;
  holder.ctx = { config, port: {}, store: { get: async () => undefined }, history: { rpc: { ledgerWindow: async () => ({ oldestLedger: 1, latestLedger: LATEST }) }, fromLedger: 1 } };
  holder.load = NO_SAVED;
  holder.account = async () => ({ auditorId: 7, spendable: ZERO, receiving: ZERO, pvk: ZERO });
  holder.history = async () => {
    historyReads++;
    return { complete: true, events: [event("register", wallet.address)], ingestedThrough: LATEST, source: "archive" };
  };
});

describe("treasuryBalance for a treasury with no saved opening", () => {
  it("reads a treasury that never had a deposit as empty, at zero, with nothing to rebuild", async () => {
    const seen: ConsoleProgress[] = [];
    await expect(treasuryBalance(wallet, 3n, (p) => seen.push(p))).resolves.toEqual({ value: 0n, source: "empty" });
    expect(seen.map((p) => p.step)).toEqual(["balance_checking", "balance_empty"]);
  });

  it("still needs a rebuild when the history cannot be read, or is not complete", async () => {
    holder.history = () => Promise.reject(new Error("archive and RPC both down"));
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ name: "ConsoleError", code: "NEEDS_REBUILD", rebuildable: true });
    holder.history = async () => ({ complete: false, events: [event("register", wallet.address)], ingestedThrough: LATEST, source: "rpc" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
  });

  it("still needs a rebuild when the chain says something is there that the history did not show", async () => {
    holder.account = async () => ({ auditorId: 7, spendable: ZERO, receiving: commitment(500n), pvk: ZERO });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
    holder.account = async () => ({ auditorId: 7, spendable: commitment(500n), receiving: ZERO, pvk: ZERO });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
  });

  it("still needs a rebuild when the history holds anything but the registration", async () => {
    holder.history = async () => ({ complete: true, events: [event("register", wallet.address), event("deposit"), event("merge")], ingestedThrough: LATEST, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
    holder.history = async () => ({ complete: true, events: [event("register", wallet.address), event("register", wallet.address)], ingestedThrough: LATEST, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
  });

  it("still needs a rebuild for an archive that stops before the registration and so holds no events (the review's repro)", async () => {
    holder.history = async () => ({ complete: true, events: [], ingestedThrough: 5_100_000, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
    holder.history = async () => ({ complete: true, events: [], ingestedThrough: LATEST, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
  });

  it("still needs a rebuild when the history stops more than core's tolerance behind the newest ledger", async () => {
    holder.history = async () => ({ complete: true, events: [event("register", wallet.address)], ingestedThrough: LATEST - 13, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
    holder.history = async () => ({ complete: true, events: [event("register", wallet.address)], ingestedThrough: LATEST - 12, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).resolves.toEqual({ value: 0n, source: "empty" });
  });

  it("still needs a rebuild when the one registration is another account's", async () => {
    holder.history = async () => ({ complete: true, events: [event("register", Keypair.random().publicKey())], ingestedThrough: LATEST, source: "archive" });
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
  });

  it("never treats a saved opening that does not open the chain as empty", async () => {
    holder.load = () => Promise.reject(new realCore.HistoryIncompleteError("DOES_NOT_OPEN"));
    await expect(treasuryBalance(wallet, 3n)).rejects.toMatchObject({ code: "NEEDS_REBUILD" });
    expect(historyReads).toBe(0);
  });
});
