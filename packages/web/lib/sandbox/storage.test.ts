// Covers the saved sandbox: the JSON round trip, refusal of damaged or tampered saves, the stack
// check, reset stopping a run's saves, and core's OpeningStore kept inside the state.
// Does NOT cover: real browser localStorage quotas or private-mode refusals (a map stands in), or
// whether core accepts the openings stored here (core checks those against the chain itself).
import { describe, expect, it } from "vitest";
import { sandboxConfig } from "./config";
import { depositFor, totalOf } from "./salaries";
import { Keypair } from "./sdk";
import {
  STORAGE_KEY,
  SandboxResetError,
  clearSandbox,
  openSession,
  openingStoreOf,
  parseState,
  serializeState,
  type KeyValueStorage,
  type SandboxState,
} from "./storage";

function memory(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

function sample(): SandboxState {
  const amounts: [bigint, bigint, bigint] = [42_000_000_000n, 36_500_000_000n, 51_000_000_000n];
  return {
    stack: { ...sandboxConfig().contracts },
    step: "workers",
    fromLedger: 5_100_000,
    runId: 202610n,
    amounts,
    deposit: depositFor(totalOf(amounts)),
    secrets: { employer: Keypair.random().secret(), accountant: Keypair.random().secret(), workers: [Keypair.random().secret(), Keypair.random().secret(), Keypair.random().secret()] },
    auditorSecrets: { accountant: 12_345_678_901_234_567_890n, workers: [11n, 22n, 33n] },
    auditorIds: { accountant: 41, workers: [42, null, 44] },
    companyId: 9n,
    txs: { "accountant register_key": { hash: "a".repeat(64), landed: true, ledger: 5_100_010 }, create_company: { hash: "b".repeat(64), landed: false, validUntil: 1_800_000_000 } },
    openings: { "kalypso/v1/opening/x": { v: "100", r: "0", commitment: "c".repeat(128) }, "kalypso/v1/attempts/x": ["k1"] },
    payTxHashes: ["d".repeat(64)],
  };
}

const edit = (state: SandboxState, change: (raw: Record<string, unknown>) => void) => {
  const raw = JSON.parse(serializeState(state)) as Record<string, unknown>;
  change(raw);
  return JSON.stringify(raw);
};

describe("saved sandbox state", () => {
  it("reads back exactly what it wrote, bigints included", () => {
    const state = sample();
    const text = serializeState(state);
    expect(text).not.toMatch(/\d+n\b/);
    expect(parseState(text)).toEqual(state);
  });

  it("starts a new sandbox from anything malformed", () => {
    const state = sample();
    const damaged = [
      "",
      "not json",
      "null",
      "[]",
      edit(state, (r) => (r.version = 2)),
      edit(state, (r) => delete r.secrets),
      edit(state, (r) => ((r.secrets as Record<string, unknown>).employer = "SNOTASECRET")),
      edit(state, (r) => (r.amounts = ["0", "1", "2"])),
      edit(state, (r) => (r.amounts = ["-5", "1", "2"])),
      edit(state, (r) => (r.amounts = ["1.5", "1", "2"])),
      edit(state, (r) => (r.amounts = [1, 2, 3])),
      edit(state, (r) => (r.amounts = ["1", "2"])),
      edit(state, (r) => (r.deposit = "1")),
      edit(state, (r) => (r.fromLedger = 0)),
      edit(state, (r) => (r.step = "launch")),
      edit(state, (r) => ((r.auditorSecrets as Record<string, unknown>).accountant = "0")),
      edit(state, (r) => ((r.auditorIds as Record<string, unknown>).accountant = -1)),
      edit(state, (r) => ((r.secrets as Record<string, unknown>).accountant = (r.secrets as Record<string, unknown>).employer)),
      edit(state, (r) => (r.txs = { x: { hash: "nothex", landed: true } })),
      edit(state, (r) => (r.txs = { x: { hash: "e".repeat(64), landed: false } })),
      edit(state, (r) => (r.openings = { k: { nested: { deep: 1 } } })),
      edit(state, (r) => (r.payTxHashes = ["f".repeat(63)])),
      edit(state, (r) => ((r.stack as Record<string, unknown>).token = "GABC")),
    ];
    for (const text of damaged) expect(parseState(text)).toBeNull();
  });

  it("does not resume a sandbox saved on another stack", () => {
    const storage = memory();
    const state = sample();
    openSession(storage, state.stack).save(state);
    expect(openSession(storage, state.stack).load()).toEqual(state);
    expect(openSession(storage, { ...state.stack, payroll: state.stack.token }).load()).toBeNull();
  });

  it("reset removes the save and stops an older run from writing it back", () => {
    const storage = memory();
    const state = sample();
    const running = openSession(storage, state.stack);
    running.save(state);
    clearSandbox(storage);
    expect(storage.map.has(STORAGE_KEY)).toBe(false);
    expect(() => running.save(state)).toThrow(SandboxResetError);
    expect(storage.map.has(STORAGE_KEY)).toBe(false);
    openSession(storage, state.stack).save(state);
    expect(storage.map.has(STORAGE_KEY)).toBe(true);
  });

  it("keeps core's openings in the state and saves on every write", async () => {
    const state = sample();
    let saves = 0;
    const store = openingStoreOf(state, () => saves++);
    const opening = { v: "7", r: "3", commitment: "0".repeat(128) };
    await store.put("kalypso/v1/opening/y", opening);
    opening.v = "8";
    expect(await store.get("kalypso/v1/opening/y")).toEqual({ v: "7", r: "3", commitment: "0".repeat(128) });
    await store.delete("kalypso/v1/opening/y");
    await store.delete("kalypso/v1/opening/missing");
    expect(await store.get("kalypso/v1/opening/y")).toBeUndefined();
    expect(await store.get("toString")).toBeUndefined();
    expect(saves).toBe(2);
  });
});
