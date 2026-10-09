// Covers what joining saves and shows: an audit key id is saved and reported as the worker's own
// only once the registry says the worker owns it (C33, C43), a NOT_INVITED answer comes with a
// proven address (C51): a passkey session not yet proven gets its wallet and its birth checked
// first, and a squatted address stays hidden; and a company the chain already lists the worker
// active in is recorded without sending anything, even with the record full.
// Does NOT cover: the sponsored sends themselves (send.test.ts and the live run), the token
// registration and invite acceptance that follow, real chain reads (core is stubbed here), or the
// birth check's own cases (passkey.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Address, Keypair, Operation, TransactionBuilder, hash, xdr } from "@stellar/stellar-sdk";
import { deriveContractAddress } from "passkey-kit";
import * as core from "@kalypso/core";
import type { KalypsoKeys, TxRecord } from "@kalypso/core";
import { workerConfig } from "./config";
import { join, type JoinProgress } from "./join";
import * as send from "./send";
import { addressProven, openSession, type WorkerRuntime } from "./session";
import type { BirthIndexPort, SponsorPort } from "./sponsor";
import { readWorkerRecord, setCompanies, updateWorkerRecord } from "./storage";
import { b64url } from "./webauthn";

vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  getCompany: vi.fn(),
  workerStatus: vi.fn(),
  confidentialBalance: vi.fn(),
  getOwnerOf: vi.fn(),
}));
vi.mock("./send", async (importOriginal) => ({ ...(await importOriginal<typeof import("./send")>()), sendCall: vi.fn() }));

const config = workerConfig();
const HASH = "ab".repeat(32);
const sponsor: SponsorPort = {
  send: async () => {
    throw new Error("the sponsor was used");
  },
  status: async () => {
    throw new Error("the sponsor was used");
  },
};

const KIT_DEPLOYER = Keypair.fromRawEd25519Seed(hash(Buffer.from("kalepail"))).publicKey();

/** A passkey credential, its wallet address, and the transaction that created that wallet the way passkey-kit deploys it. */
function bornWallet() {
  const keyId = new Uint8Array(32).fill(7);
  const publicKey = Uint8Array.of(4, ...new Uint8Array(64).fill(1));
  const address = deriveContractAddress(Buffer.from(keyId), KIT_DEPLOYER, config.networkPassphrase);
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Secp256r1"),
    xdr.ScVal.scvBytes(Buffer.from(keyId)),
    xdr.ScVal.scvBytes(Buffer.from(publicKey)),
    xdr.ScVal.scvVec([xdr.ScVal.scvVoid()]),
    xdr.ScVal.scvVec([xdr.ScVal.scvVoid()]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Persistent")]),
  ]);
  const func = xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: new Address(KIT_DEPLOYER).toScAddress(), salt: hash(Buffer.from(keyId)) }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(config.walletWasmHash, "hex")),
      constructorArgs: [signer, xdr.ScVal.scvBytes(Buffer.alloc(0))],
    }),
  );
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), "1"), { fee: "100", networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(300)
    .build();
  const birth: TxRecord = { envelopeXdr: tx.toXDR(), successful: true, ledger: 9 };
  return { keyId, publicKey, address, birthHash: tx.hash().toString("hex"), birth };
}

function runtime(wallet: { signer: Uint8Array } | null = null, births: Map<string, TxRecord> = new Map()) {
  const store = new Map<string, string>();
  return {
    config,
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    ledger: {
      contractWasm: async () => (wallet === null ? null : config.walletWasmHash),
      walletSigner: async () => (wallet === null ? null : { publicKey: wallet.signer, expiry: null, limited: false, persistent: true }),
    },
    txSource: { transaction: async (h: string) => births.get(h) ?? null },
    port: {},
    prover: async () => {
      throw new Error("stopped after the audit key");
    },
    exclusive: <T>(_name: string, work: () => Promise<T>) => work(),
  } as unknown as WorkerRuntime;
}

function walletWorker() {
  const address = Keypair.random().publicKey();
  const wallet = { kind: "throwaway", address, signMessage: async () => new Uint8Array(64), signTransaction: async (x: string) => x };
  return openSession({ kind: "wallet", address, cashOutAddress: address, keys: {} as KalypsoKeys, auditorId: null }, { kind: "wallet", wallet: wallet as never });
}

function passkeyWorker(wallet: ReturnType<typeof bornWallet>) {
  return openSession(
    { kind: "passkey", address: wallet.address, cashOutAddress: Keypair.random().publicKey(), keys: {} as KalypsoKeys, auditorId: null },
    { kind: "passkey", keyId: b64url(wallet.keyId), publicKey: wallet.publicKey, cashOutSeed: new Uint8Array(32), signEntry: async () => "", deployFunc: null, proven: false, deployed: false },
  );
}

beforeEach(() => {
  vi.mocked(core.getCompany).mockResolvedValue({} as core.Company);
  vi.mocked(core.workerStatus).mockResolvedValue("Invited");
  vi.mocked(core.confidentialBalance).mockResolvedValue(null);
  vi.mocked(send.sendCall).mockResolvedValue({ hash: HASH, ledger: 10, returnValue: xdr.ScVal.scvU32(9) });
});

describe("the worker's own audit key id", () => {
  it("is neither saved nor reported when the registry gives the returned id to someone else", async () => {
    vi.mocked(core.getOwnerOf).mockResolvedValue(Keypair.random().publicKey());
    const rt = runtime();
    const worker = walletWorker();
    const seen: JoinProgress[] = [];
    await expect(join(rt, worker, 3n, sponsor, (p) => seen.push(p))).rejects.toMatchObject({ code: "CHAIN_DISAGREES", hash: HASH });
    expect(readWorkerRecord(rt.storage, worker.address).auditorId).toBeNull();
    expect(seen.some((p) => p.label.includes("belongs to you") || p.auditorId === 9)).toBe(false);
  });

  it("is saved and reported once the registry says the worker owns it", async () => {
    const rt = runtime();
    const worker = walletWorker();
    vi.mocked(core.getOwnerOf).mockResolvedValue(worker.address);
    const seen: JoinProgress[] = [];
    await join(rt, worker, 3n, sponsor, (p) => seen.push(p)).catch(() => undefined);
    expect(readWorkerRecord(rt.storage, worker.address).auditorId).toBe(9);
    expect(seen).toContainEqual(expect.objectContaining({ step: "auditor_key", state: "done", label: "Audit key 9 belongs to you", auditorId: 9 }));
  });
});

describe("not invited", () => {
  it("proves a passkey session's address, its birth included, before saying so, so the screen can show it", async () => {
    vi.mocked(core.workerStatus).mockResolvedValue(null);
    const wallet = bornWallet();
    const worker = passkeyWorker(wallet);
    const index: SponsorPort & BirthIndexPort = { ...sponsor, birth: async () => ({ hash: wallet.birthHash, relayed: [], more: false }), recordBirth: async () => undefined };
    expect(addressProven(worker)).toBe(false);
    await expect(join(runtime({ signer: wallet.publicKey }, new Map([[wallet.birthHash, wallet.birth]])), worker, 3n, index)).rejects.toMatchObject({ code: "NOT_INVITED" });
    expect(addressProven(worker)).toBe(true);
  });

  it("keeps a squatted address hidden: the answer is ADDRESS_TAKEN, never NOT_INVITED", async () => {
    vi.mocked(core.workerStatus).mockResolvedValue(null);
    const worker = passkeyWorker(bornWallet());
    await expect(join(runtime({ signer: Uint8Array.of(4, ...new Uint8Array(64).fill(2)) }), worker, 3n, sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });
});

describe("already a member", () => {
  it("records a company the chain lists this worker active in, and reports joined without sending anything", async () => {
    vi.mocked(core.workerStatus).mockResolvedValue("Active");
    vi.mocked(core.confidentialBalance).mockResolvedValue({ auditorId: 9 } as core.ConfidentialAccountView);
    const sends = vi.mocked(send.sendCall).mock.calls.length;
    const rt = runtime();
    const worker = walletWorker();
    const seen: JoinProgress[] = [];
    expect(await join(rt, worker, 3n, sponsor, (p) => seen.push(p))).toEqual({ companyId: 3n, auditorId: 9, transactions: [] });
    expect(vi.mocked(send.sendCall).mock.calls.length).toBe(sends);
    expect(readWorkerRecord(rt.storage, worker.address).companyIds).toEqual([3n]);
    expect(seen.at(-1)).toMatchObject({ step: "accept", state: "skipped" });
  });

  it("records the joined company even with the record full, dropping the oldest instead", async () => {
    vi.mocked(core.workerStatus).mockResolvedValue("Active");
    vi.mocked(core.confidentialBalance).mockResolvedValue({ auditorId: 9 } as core.ConfidentialAccountView);
    const rt = runtime();
    const worker = walletWorker();
    updateWorkerRecord(rt.storage, worker.address, (r) => setCompanies(r, Array.from({ length: core.MAX_WORKER_COMPANIES }, (_, i) => BigInt(100 + i))));
    await join(rt, worker, 3n, sponsor);
    const ids = readWorkerRecord(rt.storage, worker.address).companyIds;
    expect([ids.length, ids.at(-1), ids.includes(100n)]).toEqual([core.MAX_WORKER_COMPANIES, 3n, false]);
  });
});
