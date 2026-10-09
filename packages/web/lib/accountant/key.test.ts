// Covers the accountant's key: derived from two wallet signatures with the auditor registry as the
// token, its public point is k·H (what register_key stores and what core's audit opens with k), it
// differs from the same wallet's treasury key, and its short hex is the first 16 hex characters in
// groups of four. Does NOT cover registration or opening books (the live testnet run does).
import { describe, expect, it } from "vitest";
import { pointToBytes } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
import { auditorPublicKey, kalypsoKeysOf } from "../sandbox/accounts";
import { sandboxConfig } from "../sandbox/config";
import { Keypair } from "../sandbox/sdk";
import { throwawayWallet } from "../wallet/throwaway";
import { accountantSecret, deriveAccountantKey, keyHex, shortKeyHex } from "./key";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("accountant key", () => {
  it("is k·H for the secret the wallet's signatures derive under the registry id", async () => {
    const keypair = Keypair.random();
    const wallet = throwawayWallet(keypair);
    const { secret, point } = await accountantSecret(wallet);
    expect(point.equals(auditorPublicKey(secret))).toBe(true);

    const view = await deriveAccountantKey(wallet);
    expect(view.address).toBe(keypair.publicKey());
    expect(view.keyHex).toBe(hex(pointToBytes(point)));
    expect(view.keyHex).toMatch(/^[0-9a-f]{128}$/);
    expect(view.shortKeyHex).toBe(`${view.keyHex.slice(0, 4)} ${view.keyHex.slice(4, 8)} ${view.keyHex.slice(8, 12)} ${view.keyHex.slice(12, 16)}`);

    const treasury = kalypsoKeysOf(keypair, sandboxConfig());
    expect(secret).not.toBe(treasury.sk);
    expect(point.equals(treasury.Y)).toBe(false);
  });

  it("formats any key the same way on both screens", () => {
    const point = auditorPublicKey(123_456_789n);
    expect(shortKeyHex(point)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(keyHex(point).startsWith(shortKeyHex(point).replaceAll(" ", ""))).toBe(true);
  });
});
