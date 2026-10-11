// Covers the faucet signer: it signs a createAccount or a payment of exactly the configured
// amounts, from the faucet alone, on testnet, and refuses every other shape before signing; it
// signs only a fresh Transaction rebuilt from the bytes it was given, so a look-alike object or a
// subclass with its own sign() never reaches the key; the
// USDC it pays derives from the configured SAC id and is Circle's alone; and the signer object
// carries no secret.
// Does NOT cover: whether a payout should be made at all (the handler's limits and checks,
// handler.test.ts), or the network's own rules for applying it (the fake ledger and the live run).
import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Memo, MuxedAccount, Networks, Operation, StrKey, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { CIRCLE_TESTNET_USDC_ISSUER, PayoutRefused, createFaucetSigner, faucetUsdcAsset, type PayoutRules } from "../../src/faucet/signer.ts";
import { USDC } from "../helpers.ts";

const FAUCET = Keypair.random();
const WORKER = Keypair.random().publicKey();
const NOW = new Date("2026-10-11T12:00:00Z");
const MAX_TIME = NOW.getTime() / 1000 + 60;
const usdc = new Asset("USDC", CIRCLE_TESTNET_USDC_ISSUER);
const RULES: PayoutRules = { xlmStroops: 1_000_000_000n, usdcStroops: 1_000_000_000n, usdc };

interface Shape {
  ops?: ReturnType<typeof Operation.payment>[];
  source?: string;
  fee?: string;
  maxTime?: number;
  passphrase?: string;
  memo?: Memo;
  ledgerBounds?: boolean;
}

function build(shape: Shape = {}): Transaction {
  const builder = new TransactionBuilder(new Account(shape.source ?? FAUCET.publicKey(), "41"), {
    fee: shape.fee ?? "10000",
    networkPassphrase: shape.passphrase ?? Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: shape.maxTime ?? MAX_TIME },
    ...(shape.memo ? { memo: shape.memo } : {}),
  });
  for (const op of shape.ops ?? [Operation.payment({ destination: WORKER, asset: Asset.native(), amount: "100" })]) builder.addOperation(op);
  if (shape.ledgerBounds) builder.setLedgerbounds(1, 0);
  return builder.build();
}

describe("the faucet signer", () => {
  const signer = createFaucetSigner(FAUCET.secret(), RULES);

  it("signs a createAccount or a payment of exactly the configured amounts, from the faucet, to a plain G account", () => {
    const cases: Array<[ReturnType<typeof Operation.payment>, object]> = [
      [Operation.createAccount({ destination: WORKER, startingBalance: "100" }), { kind: "create", asset: "xlm" }],
      [Operation.payment({ destination: WORKER, asset: Asset.native(), amount: "100" }), { kind: "payment", asset: "xlm" }],
      [Operation.payment({ destination: WORKER, asset: usdc, amount: "100" }), { kind: "payment", asset: "usdc" }],
    ];
    for (const [op, expected] of cases) {
      const tx = build({ ops: [op] });
      const { tx: signed, payout } = signer.signPayout(tx, NOW);
      expect(payout).toEqual({ ...expected, destination: WORKER, stroops: 1_000_000_000n });
      expect(signed).not.toBe(tx);
      expect(tx.signatures).toHaveLength(0);
      expect(signed.hash().equals(tx.hash())).toBe(true);
      expect(signed.signatures).toHaveLength(1);
      expect(FAUCET.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
    }
  });

  it("refuses, unsigned, every other shape: amount, asset, operation count and source, destination, fee, lifetime, memo, preconditions", () => {
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(WORKER), Buffer.alloc(8, 7)]));
    const pay = (amount: string, asset: Asset = Asset.native(), destination = WORKER) => Operation.payment({ destination, asset, amount });
    const refused: Array<[string, Shape]> = [
      ["one stroop more", { ops: [pay("100.0000001")] }],
      ["a smaller payment", { ops: [pay("99")] }],
      ["a createAccount of another amount", { ops: [Operation.createAccount({ destination: WORKER, startingBalance: "1000" })] }],
      ["USDC of another issuer", { ops: [pay("100", new Asset("USDC", Keypair.random().publicKey()))] }],
      ["another asset", { ops: [pay("100", new Asset("EURC", CIRCLE_TESTNET_USDC_ISSUER))] }],
      ["two payouts", { ops: [pay("100"), pay("100")] }],
      ["an operation with its own source", { ops: [Operation.payment({ destination: WORKER, asset: Asset.native(), amount: "100", source: FAUCET.publicKey() })] }],
      ["another operation", { ops: [Operation.bumpSequence({ bumpTo: "100" }) as ReturnType<typeof Operation.payment>] }],
      ["another source", { source: Keypair.random().publicKey() }],
      ["a muxed destination", { ops: [pay("100", Asset.native(), muxed)] }],
      ["the faucet itself", { ops: [pay("100", Asset.native(), FAUCET.publicKey())] }],
      ["the faucet itself, created", { ops: [Operation.createAccount({ destination: FAUCET.publicKey(), startingBalance: "100" })] }],
      ["a fee over the cap", { fee: "10001" }],
      ["no end time", { maxTime: 0 }],
      ["a 61 s lifetime", { maxTime: MAX_TIME + 1 }],
      ["a memo", { memo: Memo.text("hi") }],
      ["ledger bounds", { ledgerBounds: true }],
      ["mainnet", { passphrase: Networks.PUBLIC }],
    ];
    for (const [label, shape] of refused) {
      const tx = build(shape);
      expect(() => signer.signPayout(tx, NOW), label).toThrow(PayoutRefused);
      expect(tx.signatures, label).toHaveLength(0);
    }
    const fromMuxed = new TransactionBuilder(new MuxedAccount(new Account(FAUCET.publicKey(), "41"), "7"), {
      fee: "10000",
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: MAX_TIME },
    })
      .addOperation(pay("100"))
      .build();
    expect(() => signer.signPayout(fromMuxed, NOW)).toThrow(/muxed source/);
    const inner = build();
    inner.sign(FAUCET);
    const bump = TransactionBuilder.buildFeeBumpTransaction(FAUCET, "20000", inner, Networks.TESTNET);
    expect(() => signer.signPayout(bump as unknown as Transaction, NOW)).toThrow(/not a Transaction/);
    expect(() => signer.signPayout(inner, NOW)).toThrow(/already signed/);
  });

  it("never lets a look-alike near the key: a plain object is refused, and a subclass's own sign() is never called", () => {
    const tx = build();
    const recorded: unknown[] = [];
    const lookalike = { toEnvelope: () => tx.toEnvelope(), networkPassphrase: Networks.TESTNET, source: tx.source, operations: tx.operations, sign: (...keys: unknown[]) => recorded.push(...keys) };
    expect(() => signer.signPayout(lookalike as unknown as Transaction, NOW)).toThrow(/not a Transaction/);

    class Recording extends Transaction {
      readonly signedWith: unknown[] = [];
      override sign(...keypairs: Keypair[]): void {
        this.signedWith.push(...keypairs);
      }
    }
    const subclass = new Recording(tx.toXDR(), Networks.TESTNET);
    const { tx: signed } = signer.signPayout(subclass, NOW);
    expect(signed).not.toBe(subclass);
    expect(signed).not.toBeInstanceOf(Recording);
    expect(FAUCET.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);

    // Its bytes are all the signer reads: an envelope that is not a plain transaction does not rebuild.
    const inner = build();
    inner.sign(Keypair.random());
    const bump = TransactionBuilder.buildFeeBumpTransaction(FAUCET.publicKey(), "20000", inner, Networks.TESTNET);
    class Disguised extends Recording {
      override toEnvelope() {
        return bump.toEnvelope();
      }
    }
    expect(() => signer.signPayout(new Disguised(tx.toXDR(), Networks.TESTNET), NOW)).toThrow(/does not rebuild/);
    expect([recorded, subclass.signedWith]).toEqual([[], []]);
  });

  it("holds the key out of sight: no property, no JSON field, and it refuses a value that is not a secret key", () => {
    expect(Object.keys(signer)).toEqual(["publicKey", "signPayout"]);
    expect(JSON.stringify(signer)).toBe(JSON.stringify({ publicKey: FAUCET.publicKey() }));
    expect(JSON.stringify(signer)).not.toContain(FAUCET.secret());
    // The last of a secret's 56 characters holds only checksum bits, so a different last character
    // always breaks the checksum. Appending a fixed "A" matched the real key whenever it already
    // ended in "A", about one run in 32.
    const secret = FAUCET.secret();
    const brokenChecksum = secret.slice(0, 55) + (secret.endsWith("A") ? "B" : "A");
    expect(brokenChecksum).not.toBe(secret);
    for (const bad of [FAUCET.publicKey(), secret.toLowerCase(), brokenChecksum, ""]) {
      expect(() => createFaucetSigner(bad, RULES), bad.slice(0, 4)).toThrow(PayoutRefused);
    }
  });

  it("derives the USDC it pays from the configured SAC id: Circle's testnet USDC only, and only on testnet", () => {
    expect(faucetUsdcAsset(USDC, Networks.TESTNET)?.equals(usdc)).toBe(true);
    expect(new Asset("USDC", CIRCLE_TESTNET_USDC_ISSUER).contractId(Networks.TESTNET)).toBe(USDC);
    expect(faucetUsdcAsset(new Asset("USDC", Keypair.random().publicKey()).contractId(Networks.TESTNET), Networks.TESTNET)).toBeNull();
    expect(faucetUsdcAsset(usdc.contractId(Networks.PUBLIC), Networks.PUBLIC)).toBeNull();
  });
});
