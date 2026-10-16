// Covers keepOwnBooks against a fake registry and a fake token registration: a treasury not yet
// registered (the first company) registers a fresh id, or reuses an id this browser saw this wallet
// register, with this wallet's key, sending nothing; a treasury already registered (a second
// company) reuses the key number its registration names, never another; a treasury bound to an
// outsider's key number makes own books impossible, refused before any signature; the id of a new
// registration comes only from the confirmed return value; and the owner and key read that follows
// (C43) refuses an id that changed hands or keys between the reads, and an id the network names but
// the registry does not give this wallet. Does NOT cover the send pipeline (sendCall is replaced here),
// setUpCompany, or the live registry (a live testnet run outside this suite covers those).
import { decodeInvocation } from "@kalypso/core";
import type { Point } from "../sandbox/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, xdr } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { pointToBytes } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
import { auditorPublicKey } from "../sandbox/accounts";
import { sandboxConfig } from "../sandbox/config";
import { Keypair } from "../sandbox/sdk";
import { throwawayWallet } from "../wallet/throwaway";

type Send = (p: { what: string; contractId: string; build: (base: unknown) => string | Promise<string> }) => Promise<{ hash: string; returnValue?: xdr.ScVal }>;
const holder = vi.hoisted(() => ({ ctx: undefined as unknown, send: undefined as unknown as Send, bound: null as number | null }));
vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  confidentialBalance: async () => (holder.bound === null ? null : { auditorId: holder.bound }),
}));
vi.mock("../employer/context", async (importOriginal) => ({ ...(await importOriginal<typeof import("../employer/context")>()), consoleContext: () => holder.ctx }));
vi.mock("../employer/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../employer/send")>()),
  sendCall: (_ctx: unknown, _wallet: unknown, p: Parameters<Send>[0]) => holder.send(p),
}));

const { keepOwnBooks, readOwnBooksState } = await import("./own-books");
const { accountantSecret, keyHex, shortKeyHex } = await import("./key");

const config = sandboxConfig();
const HASH = "ab".repeat(32);

/** A registry of id to owner and key. Every read is counted, and `onRead` may change an entry between reads. */
function fakeRegistry() {
  const entries = new Map<number, { owner: string; key: Point }>();
  const reads: string[] = [];
  let onRead: (method: string, id: number) => void = () => undefined;
  const port = {
    async read(contract: string, method: string, args: xdr.ScVal[]) {
      expect(contract).toBe(config.contracts.auditor);
      const id = (args[0] as xdr.ScVal).u32();
      reads.push(`${method} ${id}`);
      const entry = entries.get(id);
      const answer =
        method === "owner_of" && entry
          ? new Address(entry.owner).toScVal()
          : method === "get_key" && entry
            ? xdr.ScVal.scvBytes(Buffer.from(pointToBytes(entry.key)))
            : undefined;
      onRead(method, id);
      if (answer === undefined) throw new Error(`unexpected read ${method} ${id}`);
      return answer;
    },
  };
  return { entries, reads, port, setOnRead: (f: typeof onRead) => (onRead = f) };
}

let wallet: ReturnType<typeof throwawayWallet>;
let point: Point;
let registry: ReturnType<typeof fakeRegistry>;
let sent: string[];

beforeEach(async () => {
  holder.bound = null;
  registry = fakeRegistry();
  sent = [];
  holder.ctx = {
    config,
    port: registry.port,
    ledger: { xlmBalance: async () => 10_000_0000000n, usdcBalance: async () => null },
    wait: async () => undefined,
  };
  wallet = throwawayWallet(Keypair.random());
  point = (await accountantSecret(wallet)).point;
  holder.send = async (p) => {
    const decoded = decodeInvocation(
      await p.build({ source: { address: wallet.address, sequence: "1" }, networkPassphrase: config.networkPassphrase, contractId: p.contractId, timeoutSeconds: 120 }),
      config.networkPassphrase,
    );
    sent.push(`${decoded.method} ${decoded.contractId} owner ${Address.fromScVal(decoded.args[0] as xdr.ScVal).toString()}`);
    registry.entries.set(44, { owner: wallet.address, key: point });
    return { hash: HASH, returnValue: xdr.ScVal.scvU32(44) };
  };
});

describe("keepOwnBooks", () => {
  it("reuses an id this wallet already owns with exactly this key, and sends nothing", async () => {
    registry.entries.set(31, { owner: wallet.address, key: point });
    const own = await keepOwnBooks(wallet, { knownId: 31 });
    expect(own).toEqual({ accountantId: 31, accountant: wallet.address, keyHex: keyHex(point), shortKeyHex: shortKeyHex(point), reused: true });
    expect(sent).toEqual([]);
    expect(registry.reads).toEqual(["owner_of 31", "get_key 31", "owner_of 31", "get_key 31"]);
  });

  it("registers the key with this wallet as owner when no id holds it, and takes the id from the confirmed return value", async () => {
    // The id this browser remembers now belongs to someone else, so it is not reused.
    registry.entries.set(31, { owner: Keypair.random().publicKey(), key: point });
    const own = await keepOwnBooks(wallet, { knownId: 31 });
    expect(sent).toEqual([`register_key ${config.contracts.auditor} owner ${wallet.address}`]);
    expect(own).toEqual({ accountantId: 44, accountant: wallet.address, keyHex: keyHex(point), shortKeyHex: shortKeyHex(point), reused: false, txHash: HASH });

    sent = [];
    const fresh = await keepOwnBooks(wallet);
    expect(fresh.accountantId).toBe(44);
    expect(sent).toHaveLength(1);
  });

  it("refuses an id that changed hands between the reuse check and the owner and key read (C43)", async () => {
    registry.entries.set(31, { owner: wallet.address, key: point });
    let ownerReads = 0;
    registry.setOnRead((method, id) => {
      if (method === "owner_of" && id === 31 && ++ownerReads === 1) registry.entries.set(31, { owner: Keypair.random().publicKey(), key: point });
    });
    await expect(keepOwnBooks(wallet, { knownId: 31 })).rejects.toMatchObject({ name: "ConsoleError", code: "ACCOUNTANT_MISMATCH" });
    expect(sent).toEqual([]);
  });

  it("refuses an id whose key was replaced before the owner and key read (C43)", async () => {
    registry.entries.set(31, { owner: wallet.address, key: point });
    let keyReads = 0;
    registry.setOnRead((method, id) => {
      if (method === "get_key" && id === 31 && ++keyReads === 1) registry.entries.set(31, { owner: wallet.address, key: auditorPublicKey(987_654_321n) });
    });
    await expect(keepOwnBooks(wallet, { knownId: 31 })).rejects.toMatchObject({ name: "ConsoleError", code: "ACCOUNTANT_ID_NOT_YOURS" });
  });

  it("refuses an id the network names after registering when the registry does not give it to this wallet (C43)", async () => {
    holder.send = async () => {
      registry.entries.set(45, { owner: Keypair.random().publicKey(), key: point });
      return { hash: HASH, returnValue: xdr.ScVal.scvU32(45) };
    };
    await expect(keepOwnBooks(wallet)).rejects.toMatchObject({ name: "ConsoleError", code: "NOT_ON_CHAIN" });
  });

  it("refuses a remembered id that is not a u32 before reading or signing anything", async () => {
    const fresh = throwawayWallet(Keypair.random());
    const signMessage = vi.spyOn(fresh, "signMessage");
    await expect(keepOwnBooks(fresh, { knownId: -1 })).rejects.toMatchObject({ code: "ACCOUNTANT_ID_INVALID" });
    expect(signMessage).not.toHaveBeenCalled();
    expect(registry.reads).toEqual([]);
  });

  it("registers a fresh id for the first company, while the treasury is not registered with the token", async () => {
    expect(await readOwnBooksState(wallet)).toEqual({ bound: null, ownable: true });
    const own = await keepOwnBooks(wallet);
    expect(own).toMatchObject({ accountantId: 44, reused: false, txHash: HASH });
    expect(sent).toHaveLength(1);
  });

  it("reuses the key number a second company's treasury is bound to, over any remembered id, sending nothing", async () => {
    registry.entries.set(44, { owner: wallet.address, key: point });
    registry.entries.set(31, { owner: wallet.address, key: point });
    holder.bound = 44;
    expect(await readOwnBooksState(wallet)).toEqual({ bound: 44, ownable: true });
    expect(await keepOwnBooks(wallet)).toMatchObject({ accountantId: 44, reused: true });
    expect(await keepOwnBooks(wallet, { knownId: 31 })).toMatchObject({ accountantId: 44, reused: true });
    expect(sent).toEqual([]);
  });

  it("refuses own books, before any signature, for a treasury bound to an outsider's key number", async () => {
    const fresh = throwawayWallet(Keypair.random());
    const signMessage = vi.spyOn(fresh, "signMessage");
    registry.entries.set(50, { owner: Keypair.random().publicKey(), key: point });
    holder.bound = 50;
    expect(await readOwnBooksState(fresh)).toEqual({ bound: 50, ownable: false });
    await expect(keepOwnBooks(fresh)).rejects.toMatchObject({ name: "ConsoleError", code: "OWN_BOOKS_TAKEN" });
    expect(signMessage).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("refuses own books when the bound key number is this wallet's but holds another key", async () => {
    registry.entries.set(44, { owner: wallet.address, key: auditorPublicKey(123n) });
    holder.bound = 44;
    await expect(keepOwnBooks(wallet)).rejects.toMatchObject({ code: "OWN_BOOKS_TAKEN" });
    expect(sent).toEqual([]);
  });
});
