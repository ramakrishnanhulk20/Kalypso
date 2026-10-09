import { deriveFromWalletSignatures, walletKeyMessage } from "@kalypso/core";
import type { KalypsoKeys, SignerPort } from "@kalypso/core";
import type { SandboxConfig } from "./config";
import { Asset, H, Keypair, RpcServer, TransactionBuilder, scalarMul, xdr } from "./sdk";
import type { Point } from "./sdk";
import type { SandboxState } from "./storage";

export const HTTP_TIMEOUT_MS = 10_000;
const FRIENDBOT_TIMEOUT_MS = 30_000;
const FRIENDBOT_TRIES = 5;
const APPEAR_LOOKS = 15;
const APPEAR_WAIT_MS = 2_000;
const TX_HASH = /^[0-9a-f]{64}$/;

export type Role = "employer" | "accountant" | "worker1" | "worker2" | "worker3";
export const ROLES: readonly Role[] = ["employer", "accountant", "worker1", "worker2", "worker3"];

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Five fresh throwaway keypairs, made with the platform's secure random generator. */
export function newSecrets(): SandboxState["secrets"] {
  const fresh = () => Keypair.random().secret();
  return { employer: fresh(), accountant: fresh(), workers: [fresh(), fresh(), fresh()] };
}

export function keypairOf(state: SandboxState, role: Role): Keypair {
  if (role === "employer") return Keypair.fromSecret(state.secrets.employer);
  if (role === "accountant") return Keypair.fromSecret(state.secrets.accountant);
  return Keypair.fromSecret(state.secrets.workers[workerIndex(role)]);
}

export function workerRole(index: number): Role {
  if (index === 0) return "worker1";
  if (index === 1) return "worker2";
  if (index === 2) return "worker3";
  throw new RangeError("worker index must be 0, 1 or 2");
}

export function workerIndex(role: Role): 0 | 1 | 2 {
  if (role === "worker1") return 0;
  if (role === "worker2") return 1;
  if (role === "worker3") return 2;
  throw new RangeError(`${role} is not a worker`);
}

export const addressOf = (state: SandboxState, role: Role) => keypairOf(state, role).publicKey();

/** Signs an envelope with one sandbox key, as a wallet would, and hands the signed envelope back. */
export function signEnvelope(keypair: Keypair, txXdr: string, networkPassphrase: string): string {
  const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
  tx.sign(keypair);
  return tx.toXDR();
}

export function signerOf(keypair: Keypair): SignerPort {
  return {
    address: keypair.publicKey(),
    signTransaction: async (txXdr, networkPassphrase) => signEnvelope(keypair, txXdr, networkPassphrase),
  };
}

const keyCache = new Map<string, KalypsoKeys>();

/**
 * The account's Kalypso keys, derived exactly as the app derives a Freighter user's: two SEP-53
 * signatures of core's key message, which core checks are this account's and byte-equal before
 * it derives anything (C15, C40). ed25519 signs deterministically, so the second signature
 * matches the first for real. Kept in memory for the page's life, never saved.
 */
export function kalypsoKeysOf(keypair: Keypair, config: SandboxConfig): KalypsoKeys {
  const account = keypair.publicKey();
  const cached = keyCache.get(account);
  if (cached) return cached;
  const p = { domain: config.keyDomain, network: "testnet" as const, token: config.contracts.token, account };
  const message = walletKeyMessage(p);
  const sign = () => Uint8Array.from(keypair.signMessage(message));
  const keys = deriveFromWalletSignatures(sign(), sign(), p);
  keyCache.set(account, keys);
  return keys;
}

export function forgetKeys(): void {
  keyCache.clear();
}

/** The public key the auditor registry stores for an auditor secret k: k·H, as the seed computes it. */
export function auditorPublicKey(secret: bigint): Point {
  return scalarMul(secret, H);
}

/** Classic account balances, read from the ledger by RPC. null means the entry does not exist; an outage throws. */
export interface LedgerPort {
  xlmBalance(account: string): Promise<bigint | null>;
  usdcBalance(account: string): Promise<bigint | null>;
}

function withTimeout<T>(what: string, work: Promise<T>, ms = HTTP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds.`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export function createLedgerPort(config: SandboxConfig): LedgerPort {
  const server = new RpcServer(config.rpcUrl);
  const usdc = new Asset("USDC", config.usdc.issuer);
  const entry = async (key: xdr.LedgerKey) => {
    const res = await withTimeout("The Stellar RPC", server.getLedgerEntries(key));
    return res.entries[0]?.val ?? null;
  };
  return {
    async xlmBalance(account) {
      const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrPublicKey() }));
      const found = await entry(key);
      return found ? BigInt(found.account().balance().toString()) : null;
    },
    async usdcBalance(account) {
      const key = xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({ accountId: Keypair.fromPublicKey(account).xdrPublicKey(), asset: usdc.toTrustLineXDRObject() }),
      );
      const found = await entry(key);
      return found ? BigInt(found.trustLine().balance().toString()) : null;
    },
  };
}

/** One friendbot request. Returns the creating transaction's hash when friendbot names one. */
export interface FriendbotPort {
  fund(account: string): Promise<{ ok: boolean; status: number | string; hash?: string }>;
}

export function createFriendbot(config: SandboxConfig): FriendbotPort {
  return {
    async fund(account) {
      let res: Response;
      try {
        res = await fetch(`${config.friendbotUrl}/?addr=${encodeURIComponent(account)}`, {
          signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (err) {
        return { ok: false, status: err instanceof Error ? err.name : "network" };
      }
      if (!res.ok) return { ok: false, status: res.status };
      const body: unknown = await res.json().catch(() => null);
      const hash = typeof body === "object" && body !== null ? (body as { hash?: unknown }).hash : undefined;
      return typeof hash === "string" && TX_HASH.test(hash) ? { ok: true, status: res.status, hash } : { ok: true, status: res.status };
    },
  };
}

export interface FundingDeps {
  ledger: LedgerPort;
  friendbot: FriendbotPort;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Creates the account with friendbot's test XLM unless it already exists, the seed's
 * ensureFunded: up to five tries with growing waits, an existing account counts as funded
 * (friendbot refuses those), and success means the account is readable on the ledger.
 *
 * @returns created false when it existed already; hash is friendbot's transaction when it named one.
 * @throws Error when friendbot refused five times, or said yes but the account never appeared.
 */
export async function ensureFunded(account: string, deps: FundingDeps): Promise<{ created: boolean; hash?: string }> {
  const wait = deps.wait ?? sleep;
  if ((await deps.ledger.xlmBalance(account)) !== null) return { created: false };
  let hash: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const res = await deps.friendbot.fund(account);
    if (res.ok) {
      hash = res.hash;
      break;
    }
    if ((await deps.ledger.xlmBalance(account)) !== null) return { created: true };
    if (attempt === FRIENDBOT_TRIES) throw new Error(`Friendbot refused a sandbox account ${FRIENDBOT_TRIES} times (last answer ${res.status}). Try again in a minute.`);
    await wait(3_000 * attempt);
  }
  for (let look = 0; look < APPEAR_LOOKS; look++) {
    if ((await deps.ledger.xlmBalance(account)) !== null) return hash === undefined ? { created: true } : { created: true, hash };
    await wait(APPEAR_WAIT_MS);
  }
  throw new Error("Friendbot said yes, but a sandbox account did not appear on the ledger.");
}

/**
 * Funds every account at once. Friendbot creates each in its own transaction, so they never
 * compete for a sequence number. onFunded runs as each one is readable on the ledger. Every
 * account is tried even when one fails; the first failure is thrown after all have settled.
 */
export async function fundAll(
  accounts: readonly string[],
  deps: FundingDeps,
  onFunded: (account: string, result: { created: boolean; hash?: string }) => void,
): Promise<void> {
  const settled = await Promise.allSettled(
    accounts.map(async (account) => {
      const result = await ensureFunded(account, deps);
      onFunded(account, result);
    }),
  );
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
}
