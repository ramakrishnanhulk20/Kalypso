// First, so the Buffer global sdk.ts installs exists before any module that reads it loads.
import "./sdk";
import { Address, Asset, Keypair, StellarToml, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { createCircuitProver, createRpcChainPort, createRpcEventsPort, createTxSourcePort } from "@kalypso/core";
import type { ArchiveConfig, ChainPort, EventsPort, KalypsoKeys, Opening, ProverPort, TxSourcePort } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { workerConfig, type WorkerConfig } from "./config";
import { WorkerError } from "./errors";
import { loadCircuits, type Point } from "./sdk";
import { browserStorage, type KeyValueStorage } from "./storage";
import type { WebAuthnEnv } from "./webauthn";

/**
 * A signed-in worker. keys never leave this object: the property is not enumerable and toJSON
 * leaves it out, so JSON, structured clones and spreads carry only the public fields.
 */
export interface WorkerSession {
  readonly kind: "passkey" | "wallet";
  /** The account that is paid: the passkey wallet's C address, or the wallet's G address. */
  readonly address: string;
  /** The plain G account withdrawals go to and the anchor sees. */
  readonly cashOutAddress: string;
  readonly keys: KalypsoKeys;
  /** The worker's own auditor id once known; joinCompany sets it. */
  auditorId: number | null;
}

export interface PasskeyHeld {
  kind: "passkey";
  keyId: string;
  publicKey: Uint8Array;
  /** The cash-out account's ed25519 seed, from the same PRF output as the keys. */
  cashOutSeed: Uint8Array;
  /** Signs one Soroban auth entry (base64) for the wallet with the passkey, returning it signed. */
  signEntry(entryXdr: string, expirationLedger: number): Promise<string>;
  /** The wallet's deploy call while the wallet is not on chain yet, null once it is or when this browser never had it. */
  deployFunc: string | null;
  /**
   * True once this session has seen the wallet on chain running the pinned code and trusting this
   * passkey (whoever created it). The payslips and cash-out need only that and the keys, so they
   * open before the address is proven; the address and joining still wait for proven.
   */
  deployed: boolean;
  /**
   * True once this session has read from chain that the wallet exists, runs the pinned code and
   * lists this credential with this passkey's key. Until then its address is never shown, copied or
   * handed on (C51): anyone holding the credential id can deploy at that address first.
   */
  proven: boolean;
}

export interface WalletHeld {
  kind: "wallet";
  wallet: WalletPort;
}

/** A SEP-10 login at the anchor, kept in memory only. */
export interface AnchorLogin {
  token: string;
  expiresAt: number;
  transferServer: string;
}

/**
 * A withdraw handed to a sender and not yet seen landing, kept in memory so a retry can tell
 * whether it landed after all, and if not, build on the same balance.
 */
export interface PendingWithdraw {
  amount: bigint;
  /** The spendable opening every proof for it was built on. */
  basis: Opening;
  /** The spendable commitment each of those proofs leaves; the chain showing any one means it moved. */
  next: Point[];
}

type Held = (PasskeyHeld | WalletHeld) & { anchor?: AnchorLogin; withdrawal?: PendingWithdraw };

const held = new WeakMap<WorkerSession, Held>();

export function openSession(
  fields: { kind: "passkey" | "wallet"; address: string; cashOutAddress: string; keys: KalypsoKeys; auditorId: number | null },
  secret: PasskeyHeld | WalletHeld,
): WorkerSession {
  const session = {} as WorkerSession;
  Object.defineProperties(session, {
    kind: { value: fields.kind, enumerable: true },
    address: { value: fields.address, enumerable: true },
    cashOutAddress: { value: fields.cashOutAddress, enumerable: true },
    auditorId: { value: fields.auditorId, enumerable: true, writable: true },
    keys: { value: fields.keys, enumerable: false },
    toJSON: {
      value: () => ({ kind: session.kind, address: session.address, cashOutAddress: session.cashOutAddress, auditorId: session.auditorId }),
      enumerable: false,
    },
  });
  held.set(session, secret);
  return session;
}

/** What only this module tree holds for a session. @throws WorkerError NO_SESSION for an object this portal did not make. */
export function heldBy(session: WorkerSession): Held {
  const found = typeof session === "object" && session !== null ? held.get(session) : undefined;
  if (found === undefined) throw new WorkerError("NO_SESSION");
  return found;
}

/**
 * Whether the worker's address may be shown, copied or handed to anyone (C51): a wallet worker's
 * own G account always, since their wallet proved it holds that key; a passkey wallet only once
 * this session has read from chain that it exists and trusts this passkey. False for an object
 * this portal did not make.
 */
export function addressProven(session: WorkerSession): boolean {
  const found = typeof session === "object" && session !== null ? held.get(session) : undefined;
  return found !== undefined && (found.kind === "wallet" || found.proven);
}

/** The passkey signer a wallet holds for one credential id, as the wallet code reads it. */
export interface LiveSigner {
  /** The P-256 public key the wallet trusts for this credential. */
  publicKey: Uint8Array;
  /** The UNIX second the signer stops working, or null when it never expires. */
  expiry: number | null;
  /** True when the signer may only act within limits, so it is not the wallet's full owner. */
  limited: boolean;
  /** True when the entry in force is stored persistent, so it cannot lapse with no call made. */
  persistent: boolean;
}

/** Whether the worker's wallet is on chain: always for a wallet worker, for a passkey worker once this session saw it there. False for an object this portal did not make. */
export function walletOnChain(session: WorkerSession): boolean {
  const found = typeof session === "object" && session !== null ? held.get(session) : undefined;
  return found !== undefined && (found.kind === "wallet" || found.deployed);
}

/** Classic ledger facts the portal reads, behind one port so tests need no network. */
export interface LedgerReader {
  /** The wasm hash (lower-case hex) a contract instance runs, or null when there is no instance or it is not wasm. */
  contractWasm(contractId: string): Promise<string | null>;
  /** Whether a G account exists and whether it holds a USDC trustline. */
  classicAccount(account: string): Promise<{ exists: boolean; usdcTrustline: boolean }>;
  /** The Secp256r1 signer a passkey wallet holds for this credential id, or null when it holds none or one in another shape. */
  walletSigner(contractId: string, keyId: Uint8Array): Promise<LiveSigner | null>;
}

export interface WorkerRuntime {
  config: WorkerConfig;
  port: ChainPort;
  events: EventsPort;
  txSource: TxSourcePort;
  ledger: LedgerReader;
  storage: KeyValueStorage | null;
  prover(): Promise<ProverPort>;
  webauthn(): WebAuthnEnv;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Where history comes from beyond RPC's window, when this page can reach our archive. */
  archive?: ArchiveConfig;
  /** The anchor's stellar.toml, parsed. */
  resolveToml(homeDomain: string): Promise<Record<string, unknown>>;
  /** Runs work holding a lock no other tab of this site holds, or throws WorkerError BUSY. */
  exclusive<T>(name: string, work: () => Promise<T>): Promise<T>;
}

const READ_TIMEOUT_MS = 10_000;

/** Bounds a network read the SDK leaves unbounded. @throws WorkerError NETWORK after 10 s. */
export function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkerError("NETWORK")), READ_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function rpcLedger(config: WorkerConfig): LedgerReader {
  const server = new rpc.Server(config.rpcUrl);
  const usdc = new Asset("USDC", config.usdc.issuer);
  return {
    async contractWasm(contractId) {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contractId).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const { entries } = await withTimeout(server.getLedgerEntries(key));
      const entry = entries[0];
      if (entry === undefined) return null;
      const executable = entry.val.contractData().val().instance().executable();
      return executable.switch().name === "contractExecutableWasm" ? executable.wasmHash().toString("hex") : null;
    },
    async classicAccount(account) {
      const accountId = Keypair.fromPublicKey(account).xdrPublicKey();
      const accountKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
      const lineKey = xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset: usdc.toTrustLineXDRObject() }));
      const { entries } = await withTimeout(server.getLedgerEntries(accountKey, lineKey));
      const kinds = entries.map((e) => e.val.switch().name);
      return { exists: kinds.includes("account"), usdcTrustline: kinds.includes("trustline") };
    },
    async walletSigner(contractId, keyId) {
      // get_signer's SignerVal carries no storage field: durability is the ledger entry's own. So the
      // entry is read the way passkey-kit's getSigner (kit/wallet-ops.js) reads it, both durabilities
      // in one call, and a temporary entry wins because the wallet code looks there first.
      const signerKey = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Secp256r1"), xdr.ScVal.scvBytes(Buffer.from(keyId))]);
      const keyIn = (durability: xdr.ContractDataDurability) =>
        xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contractId).toScAddress(), key: signerKey, durability }));
      const { entries } = await withTimeout(server.getLedgerEntries(keyIn(xdr.ContractDataDurability.temporary()), keyIn(xdr.ContractDataDurability.persistent())));
      const data = entries.map((e) => e.val.contractData());
      const inForce = data.find((d) => d.durability().name === "temporary") ?? data.find((d) => d.durability().name === "persistent");
      return inForce === undefined ? null : readSignerVal(inForce.val(), inForce.durability().name === "persistent");
    },
  };
}

function oneItem(value: xdr.ScVal | undefined): xdr.ScVal | null {
  const items = value?.switch().name === "scvVec" ? (value.vec() ?? []) : [];
  return items.length === 1 ? items[0]! : null;
}

/**
 * The wallet's stored SignerVal::Secp256r1(public_key, SignerExpiration, SignerLimits), read strictly:
 * a vec of the tag, the key bytes, a one-item vec holding void or a u64, and a one-item vec holding
 * void (no limits) or anything else (limited). Any other shape reads as null, so a signer this code
 * cannot read is never taken for the worker's.
 */
export function readSignerVal(value: xdr.ScVal, persistent: boolean): LiveSigner | null {
  const items = value.switch().name === "scvVec" ? (value.vec() ?? []) : [];
  const [tag, key] = items;
  if (items.length !== 4 || tag?.switch().name !== "scvSymbol" || tag.sym().toString() !== "Secp256r1" || key?.switch().name !== "scvBytes") return null;
  const expiry = oneItem(items[2]);
  const limits = oneItem(items[3]);
  if (expiry === null || limits === null) return null;
  const never = expiry.switch().name === "scvVoid";
  if (!never && expiry.switch().name !== "scvU64") return null;
  return {
    publicKey: new Uint8Array(key.bytes()),
    expiry: never ? null : Number(scValToNative(expiry) as bigint),
    limited: limits.switch().name !== "scvVoid",
    persistent,
  };
}

function browserWebAuthn(): WebAuthnEnv {
  if (typeof navigator === "undefined" || !navigator.credentials || typeof location === "undefined" || typeof PublicKeyCredential === "undefined") {
    throw new WorkerError("PASSKEY_UNSUPPORTED");
  }
  // The Signal API is new (Chrome 132, Safari 26), so each method is used only where it exists.
  const signals = PublicKeyCredential as unknown as {
    signalCurrentUserDetails?: (o: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
    signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
  };
  return {
    credentials: navigator.credentials,
    rpId: location.hostname,
    origin: location.origin,
    ...(signals.signalCurrentUserDetails ? { signalUserDetails: (o) => signals.signalCurrentUserDetails!.call(PublicKeyCredential, o) } : {}),
    ...(signals.signalUnknownCredential ? { signalUnknownCredential: (o) => signals.signalUnknownCredential!.call(PublicKeyCredential, o) } : {}),
  };
}

async function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return work();
  return locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock === null) throw new WorkerError("BUSY");
    return work();
  });
}

let built: WorkerRuntime | undefined;

/** The live runtime: testnet RPC, Horizon, this browser's storage, passkeys and prover. */
export function runtime(): WorkerRuntime {
  if (built) return built;
  const config = workerConfig();
  let prover: Promise<ProverPort> | undefined;
  const https = typeof location !== "undefined" && location.protocol === "https:";
  built = {
    config,
    port: createRpcChainPort({ rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase }),
    events: createRpcEventsPort({ rpcUrl: config.rpcUrl }),
    txSource: createTxSourcePort({ rpcUrl: config.rpcUrl, horizonUrl: config.horizonUrl }),
    ledger: rpcLedger(config),
    storage: browserStorage(),
    prover() {
      prover ??= loadCircuits().then(createCircuitProver);
      // A failed download is not kept, so the next action tries again.
      prover.catch(() => {
        prover = undefined;
      });
      return prover;
    },
    webauthn: browserWebAuthn,
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    // Our archive lives on this app's own server. Core takes it only over https, and falls back to
    // RPC's window when it does not answer, so an archive that is not deployed yet costs one refusal.
    ...(https ? { archive: { baseUrl: `${location.origin}/api/archive` } } : {}),
    resolveToml: (homeDomain) => StellarToml.Resolver.resolve(homeDomain, { timeout: READ_TIMEOUT_MS }) as Promise<Record<string, unknown>>,
    exclusive,
  };
  return built;
}
