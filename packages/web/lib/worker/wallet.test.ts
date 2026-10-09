// Covers signing a wallet worker in: the wallet is asked twice, in two separate requests, for the
// exact key message, and keys exist only when both signatures are this account's and byte-equal
// (C15, C40). Also that the session never carries its keys into JSON.
// Does NOT cover: a real Freighter prompt (a keypair stands in), or registering the keys on chain.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ContractCallError, deriveFromWalletSignatures, walletKeyMessage } from "@kalypso/core";
import { ed25519 } from "../../../core/node_modules/@noble/curves/ed25519.js";
import type { WalletPort } from "../wallet/port";
import { KEY_DOMAIN, workerConfig } from "./config";
import { WorkerError } from "./errors";
import type { WorkerRuntime } from "./session";
import { connectWallet } from "./wallet";

const config = workerConfig();
const seed = createHash("sha256").update("kalypso worker portal test wallet, testnet only", "utf8").digest();
const keypair = Keypair.fromRawEd25519Seed(seed);
const params = { domain: KEY_DOMAIN, network: "testnet" as const, token: config.contracts.token, account: keypair.publicKey() };

function runtime() {
  const reads: string[] = [];
  const rt = {
    config,
    storage: null,
    port: {
      read: async (_contract: string, method: string) => {
        reads.push(method);
        // AccountNotRegistered: a worker who has not joined anything yet.
        throw new ContractCallError(method, 3501);
      },
    },
  } as unknown as WorkerRuntime;
  return { rt, reads };
}

function walletWith(sign: (message: string, call: number) => Uint8Array, address = keypair.publicKey()) {
  const asked: string[] = [];
  const wallet: WalletPort = {
    kind: "throwaway",
    address,
    signTransaction: async () => {
      throw new Error("not used");
    },
    signMessage: async (message) => {
      asked.push(message);
      return sign(message, asked.length);
    },
  };
  return { wallet, asked };
}

const sep53 = (message: string) => createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message)])).digest();

function littleEndian(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0, v = value; i < length; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/** RFC 8032 with a caller-chosen nonce, as a wallet that randomises against side channels signs: every result is valid. */
function signWithNonce(message: string, nonce: bigint): Uint8Array {
  const L = ed25519.CURVE.n;
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
  const r = nonce % L;
  const R = ed25519.Point.BASE.multiply(r).toRawBytes();
  const digest = createHash("sha512").update(Buffer.concat([R, pointBytes, sep53(message)])).digest();
  let k = 0n;
  for (let i = digest.length - 1; i >= 0; i--) k = (k << 8n) | BigInt(digest[i]!);
  return Buffer.concat([R, littleEndian((r + (k % L) * scalar) % L, 32)]);
}

describe("connectWallet", () => {
  it("asks the wallet twice for the exact key message and derives what core derives", async () => {
    const { rt, reads } = runtime();
    const { wallet, asked } = walletWith((message) => new Uint8Array(keypair.signMessage(message)));
    const { worker } = await connectWallet(rt, wallet);
    expect(asked).toEqual([walletKeyMessage(params), walletKeyMessage(params)]);
    expect(asked[0]).toContain(`Only sign this on https://${KEY_DOMAIN}.`);
    const signature = new Uint8Array(keypair.signMessage(asked[0]!));
    const expected = deriveFromWalletSignatures(signature, signature, params);
    expect(worker.keys.PVK.equals(expected.PVK)).toBe(true);
    expect(worker.keys.Y.equals(expected.Y)).toBe(true);
    expect(worker).toMatchObject({ kind: "wallet", address: keypair.publicKey(), cashOutAddress: keypair.publicKey(), auditorId: null });
    expect(reads).toEqual(["confidential_balance"]);
  });

  it("keeps the keys out of JSON and out of the enumerable fields", async () => {
    const { wallet } = walletWith((message) => new Uint8Array(keypair.signMessage(message)));
    const { worker } = await connectWallet(runtime().rt, wallet);
    expect(Object.keys(worker).sort()).toEqual(["address", "auditorId", "cashOutAddress", "kind"]);
    expect(JSON.parse(JSON.stringify(worker))).toEqual({ kind: "wallet", address: keypair.publicKey(), cashOutAddress: keypair.publicKey(), auditorId: null });
    expect({ ...worker }).not.toHaveProperty("keys");
  });

  it("refuses a wallet that randomises its nonce, before anything is read or registered", async () => {
    const { rt, reads } = runtime();
    const { wallet, asked } = walletWith((message, call) => signWithNonce(message, call === 1 ? 0x1234_5678n : 0x8765_4321n));
    const first = signWithNonce(walletKeyMessage(params), 0x1234_5678n);
    expect(keypair.verifyMessage(walletKeyMessage(params), Buffer.from(first))).toBe(true);
    await expect(connectWallet(rt, wallet)).rejects.toMatchObject({ code: "WALLET_NOT_REPRODUCIBLE" });
    expect(asked).toHaveLength(2);
    expect(reads).toEqual([]);
  });

  it("refuses a second signature made by another key", async () => {
    const other = Keypair.random();
    const { wallet } = walletWith((message, call) => new Uint8Array((call === 1 ? keypair : other).signMessage(message)));
    await expect(connectWallet(runtime().rt, wallet)).rejects.toMatchObject({ code: "WALLET_SIGNATURE_INVALID" });
  });

  it("names a declined prompt and a non-G wallet in plain words", async () => {
    const declined = walletWith(() => {
      throw new Error("User declined access");
    });
    const err = await connectWallet(runtime().rt, declined.wallet).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerError);
    expect(err).toMatchObject({ code: "WALLET_REJECTED", message: "The wallet did not approve the request." });
    const contract = walletWith((m) => new Uint8Array(keypair.signMessage(m)), "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL");
    await expect(connectWallet(runtime().rt, contract.wallet)).rejects.toMatchObject({ code: "WALLET_ADDRESS_INVALID" });
    expect(contract.asked).toEqual([]);
  });
});
