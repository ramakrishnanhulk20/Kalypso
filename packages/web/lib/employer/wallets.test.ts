// Covers the two WalletPort adapters: Freighter against a mocked @stellar/freighter-api (network
// refusal before and after connecting, signature refusal, a changed transaction, the success
// path for messages and transactions), and the throwaway wallet's SEP-53 signatures feeding core's
// key derivation. Does NOT cover the real Freighter extension, its popups or its version quirks
// (it cannot run headless), or anything on the network.
import { deriveFromWalletSignatures, walletKeyMessage } from "@kalypso/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Networks } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
import { kalypsoKeysOf } from "../sandbox/accounts";
import { sandboxConfig } from "../sandbox/config";
import { Account, Keypair, Operation, TransactionBuilder } from "../sandbox/sdk";
import { WalletError, connectFreighter, signatureBytesOf } from "../wallet/freighter";
import { throwawayWallet } from "../wallet/throwaway";

const api = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getNetworkDetails: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock("@stellar/freighter-api", () => api);

const config = sandboxConfig();
const user = Keypair.random();
const PUBLIC = "Public Global Stellar Network ; September 2015";

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const keyMessage = (account: string) => walletKeyMessage({ domain: config.keyDomain, network: "testnet", token: config.contracts.token, account });

function onNetwork(passphrase: string) {
  api.getNetworkDetails.mockResolvedValue({ network: "X", networkUrl: "https://example.org", networkPassphrase: passphrase });
}

function unsignedTx(source: string): string {
  return new TransactionBuilder(new Account(source, "41"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "42" }))
    .setTimeout(60)
    .build()
    .toXDR();
}

function signedBy(keypair: Keypair, txXdr: string): string {
  const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET);
  tx.sign(keypair);
  return tx.toXDR();
}

beforeEach(() => {
  vi.resetAllMocks();
  api.isConnected.mockResolvedValue({ isConnected: true });
  api.requestAccess.mockResolvedValue({ address: user.publicKey() });
  onNetwork(Networks.TESTNET);
});

describe("connectFreighter", () => {
  it("refuses a wallet on another network with the exact sentence", async () => {
    onNetwork(PUBLIC);
    const refused = connectFreighter();
    await expect(refused).rejects.toBeInstanceOf(WalletError);
    await expect(refused).rejects.toMatchObject({ code: "WRONG_NETWORK", message: "Switch Freighter to Testnet, then try again." });
  });

  it("refuses to sign once the person has switched Freighter off testnet", async () => {
    const wallet = await connectFreighter();
    onNetwork(PUBLIC);
    await expect(wallet.signMessage(keyMessage(user.publicKey()))).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    await expect(wallet.signTransaction(unsignedTx(user.publicKey()), Networks.TESTNET)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(api.signMessage).not.toHaveBeenCalled();
    expect(api.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the extension is missing or shares no account", async () => {
    api.isConnected.mockResolvedValueOnce({ isConnected: false });
    await expect(connectFreighter()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    api.requestAccess.mockResolvedValueOnce({ address: "", error: { code: -4, message: "The user rejected this request." } });
    await expect(connectFreighter()).rejects.toMatchObject({ code: "ACCESS_REFUSED" });
  });

  it("refuses a message signature that does not verify for this account and text", async () => {
    const wallet = await connectFreighter();
    const message = keyMessage(user.publicKey());
    const stranger = Keypair.random();
    api.signMessage.mockResolvedValueOnce({ signedMessage: base64(stranger.signMessage(message)), signerAddress: "" });
    await expect(wallet.signMessage(message)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    api.signMessage.mockResolvedValueOnce({ signedMessage: base64(user.signMessage(`${message} `)), signerAddress: user.publicKey() });
    await expect(wallet.signMessage(message)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    api.signMessage.mockResolvedValueOnce({ signedMessage: base64(user.signMessage(message)), signerAddress: stranger.publicKey() });
    await expect(wallet.signMessage(message)).rejects.toMatchObject({ code: "WRONG_SIGNER" });
  });

  it("returns the verified 64 bytes, from base64 or raw bytes, and core derives a key from two of them", async () => {
    const wallet = await connectFreighter();
    expect(wallet.kind).toBe("freighter");
    expect(wallet.address).toBe(user.publicKey());
    const message = keyMessage(user.publicKey());
    const real = Uint8Array.from(user.signMessage(message));
    api.signMessage.mockResolvedValueOnce({ signedMessage: base64(real), signerAddress: user.publicKey() });
    api.signMessage.mockResolvedValueOnce({ signedMessage: Uint8Array.from(real), signerAddress: user.publicKey() });
    const first = await wallet.signMessage(message);
    const second = await wallet.signMessage(message);
    expect(first).toEqual(real);
    expect(second).toEqual(real);
    expect(api.signMessage).toHaveBeenCalledWith(message, { networkPassphrase: Networks.TESTNET, address: user.publicKey() });
    const keys = deriveFromWalletSignatures(first, second, { domain: config.keyDomain, network: "testnet", token: config.contracts.token, account: user.publicKey() });
    expect(keys.PVK.equals(kalypsoKeysOf(user, config).PVK)).toBe(true);
  });

  it("hands back a transaction only when it is the same one, signed by this account", async () => {
    const wallet = await connectFreighter();
    const unsigned = unsignedTx(user.publicKey());
    const good = signedBy(user, unsigned);
    api.signTransaction.mockResolvedValueOnce({ signedTxXdr: good, signerAddress: user.publicKey() });
    await expect(wallet.signTransaction(unsigned, Networks.TESTNET)).resolves.toBe(good);

    api.signTransaction.mockResolvedValueOnce({ signedTxXdr: signedBy(user, unsignedTx(Keypair.random().publicKey())), signerAddress: user.publicKey() });
    await expect(wallet.signTransaction(unsigned, Networks.TESTNET)).rejects.toMatchObject({ code: "CHANGED_TRANSACTION" });
    api.signTransaction.mockResolvedValueOnce({ signedTxXdr: signedBy(Keypair.random(), unsigned), signerAddress: "" });
    await expect(wallet.signTransaction(unsigned, Networks.TESTNET)).rejects.toMatchObject({ code: "CHANGED_TRANSACTION" });
    api.signTransaction.mockResolvedValueOnce({ signedTxXdr: "", signerAddress: "", error: { code: -4, message: "rejected" } });
    await expect(wallet.signTransaction(unsigned, Networks.TESTNET)).rejects.toMatchObject({ code: "SIGN_REFUSED" });
    await expect(wallet.signTransaction(unsigned, PUBLIC)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
  });
});

describe("signatureBytesOf", () => {
  it("reads base64, hex, bytes and JSON-carried bytes, and nothing that is not 64 bytes", () => {
    const sig = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
    const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(signatureBytesOf(base64(sig))).toEqual(sig);
    expect(signatureBytesOf(hex)).toEqual(sig);
    expect(signatureBytesOf({ type: "Buffer", data: [...sig] })).toEqual(sig);
    expect(signatureBytesOf(base64(sig.slice(1)))).toBeNull();
    expect(signatureBytesOf("not base64!")).toBeNull();
    expect(signatureBytesOf({ type: "Buffer", data: [...sig.slice(1), 256] })).toBeNull();
    expect(signatureBytesOf(null)).toBeNull();
  });
});

describe("throwawayWallet", () => {
  it("signs SEP-53 messages that core verifies and derives the same key Freighter would", async () => {
    const keypair = Keypair.random();
    const wallet = throwawayWallet(keypair);
    expect(wallet.kind).toBe("throwaway");
    const p = { domain: config.keyDomain, network: "testnet" as const, token: config.contracts.token, account: keypair.publicKey() };
    const message = walletKeyMessage(p);
    const first = await wallet.signMessage(message);
    const second = await wallet.signMessage(message);
    expect(first).toHaveLength(64);
    expect(Keypair.fromPublicKey(keypair.publicKey()).verifyMessage(message, first as unknown as Parameters<Keypair["verifyMessage"]>[1])).toBe(true);
    const keys = deriveFromWalletSignatures(first, second, p);
    expect(keys.PVK.equals(kalypsoKeysOf(keypair, config).PVK)).toBe(true);
    expect(() => deriveFromWalletSignatures(first, second, { ...p, account: Keypair.random().publicKey() })).toThrow(/not a valid signature/);
  });

  it("signs transactions with its own key", async () => {
    const keypair = Keypair.random();
    const signed = await throwawayWallet(keypair).signTransaction(unsignedTx(keypair.publicKey()), Networks.TESTNET);
    const tx = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
    expect(tx.signatures.some((s) => keypair.verify(tx.hash(), s.signature()))).toBe(true);
  });
});
