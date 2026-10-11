import { Asset, Keypair, Networks, StrKey, Transaction, xdr } from "@stellar/stellar-sdk";

/** Circle's testnet USDC issuer, the classic asset behind the default USDC_SAC_ID. */
export const CIRCLE_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** The most the faucet bids on one payout. Testnet charges 100 stroops outside surge pricing. */
export const FAUCET_MAX_FEE_STROOPS = 10_000n;

/** A payout that has not reached a ledger within this many seconds can never land. */
export const FAUCET_TX_LIFETIME_SECONDS = 60;

/**
 * The classic USDC the faucet pays, derived from the configured SAC id: Circle's testnet USDC,
 * and only when its token contract on this network is exactly `sacId`. Null for any other id or
 * network, which stops a faucet from starting against a token it does not know.
 */
export function faucetUsdcAsset(sacId: string, passphrase: string): Asset | null {
  if (passphrase !== Networks.TESTNET) return null;
  const asset = new Asset("USDC", CIRCLE_TESTNET_USDC_ISSUER);
  return asset.contractId(passphrase) === sacId ? asset : null;
}

export interface PayoutRules {
  readonly xlmStroops: bigint;
  readonly usdcStroops: bigint;
  readonly usdc: Asset;
}

export interface Payout {
  readonly kind: "create" | "payment";
  readonly destination: string;
  readonly asset: "xlm" | "usdc";
  readonly stroops: bigint;
}

/**
 * The faucet key, behind one method. It holds the key in a closure, never as a property, so the
 * config object it sits on can be logged or serialised without it, and it signs nothing but a
 * payout that payoutOf accepts.
 */
export interface FaucetSigner {
  readonly publicKey: string;
  /**
   * Takes a real Transaction instance, rebuilds a fresh one from its envelope XDR on testnet,
   * checks that copy with payoutOf and signs and returns only the copy. The object passed in is
   * read for its bytes and nothing else: its own methods never get near the key. Throws
   * PayoutRefused for anything else.
   */
  signPayout(tx: Transaction, now: Date): { tx: Transaction; payout: Payout };
}

export class PayoutRefused extends Error {
  constructor(reason: string) {
    super("faucet refused to sign: " + reason);
    this.name = "PayoutRefused";
  }
}

/** True for an S... secret key in its one canonical spelling. */
export function isFaucetSecret(value: string): boolean {
  if (!StrKey.isValidEd25519SecretSeed(value)) return false;
  return StrKey.encodeEd25519SecretSeed(StrKey.decodeEd25519SecretSeed(value)) === value;
}

export function createFaucetSigner(secret: string, rules: PayoutRules): FaucetSigner {
  if (!isFaucetSecret(secret)) throw new PayoutRefused("not a secret key");
  const keypair = Keypair.fromSecret(secret);
  const publicKey = keypair.publicKey();
  return Object.freeze({
    publicKey,
    signPayout(tx: Transaction, now: Date): { tx: Transaction; payout: Payout } {
      if (!(tx instanceof Transaction)) throw new PayoutRefused("not a Transaction");
      // The copy is always rebuilt for testnet, so its signature is only ever good there; one the
      // caller built for another network is refused rather than quietly moved.
      if (tx.networkPassphrase !== Networks.TESTNET) throw new PayoutRefused("not testnet");
      let fresh: Transaction;
      try {
        fresh = new Transaction(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
      } catch {
        throw new PayoutRefused("envelope does not rebuild");
      }
      // A payout this server builds carries no signature yet; one that does was made elsewhere.
      if (fresh.signatures.length !== 0) throw new PayoutRefused("already signed");
      const payout = payoutOf(fresh, publicKey, rules, now);
      if (typeof payout === "string") throw new PayoutRefused(payout);
      fresh.sign(keypair);
      return { tx: fresh, payout };
    },
  });
}

const int64 = (value: xdr.Int64): bigint => BigInt(value.toString());

/**
 * The payout `tx` makes, or the reason it is not one. A payout is a testnet transaction whose
 * only source is the faucet, with no memo, a fee of at most FAUCET_MAX_FEE_STROOPS, time bounds
 * that end within FAUCET_TX_LIFETIME_SECONDS of `now` and no other precondition, and exactly one
 * operation with no source of its own: a createAccount of the XLM amount, or a payment of the XLM
 * amount in native or the USDC amount in `rules.usdc`, to a plain G account that is not the
 * faucet. Every value is read from the envelope's own XDR, the bytes that get signed.
 *
 * Does not cover who the destination is or how often it is paid: the handler's limits do that.
 */
export function payoutOf(tx: Transaction, faucet: string, rules: PayoutRules, now: Date): Payout | string {
  if (tx.networkPassphrase !== Networks.TESTNET) return "not testnet";
  const envelope = tx.toEnvelope();
  if (envelope.switch().name !== "envelopeTypeTx") return "not a plain transaction";
  const body = envelope.v1().tx();
  if (body.sourceAccount().switch().name !== "keyTypeEd25519") return "muxed source";
  if (StrKey.encodeEd25519PublicKey(body.sourceAccount().ed25519()) !== faucet) return "source is not the faucet";
  if (body.memo().switch().name !== "memoNone") return "carries a memo";
  if (BigInt(body.fee()) > FAUCET_MAX_FEE_STROOPS) return "fee over the cap";
  const cond = body.cond();
  if (cond.switch().name !== "precondTime") return "preconditions other than time bounds";
  const bounds = cond.timeBounds();
  const maxTime = BigInt(bounds.maxTime().toString());
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (maxTime === 0n || maxTime > nowSeconds + BigInt(FAUCET_TX_LIFETIME_SECONDS)) return "lives too long";
  const ops = body.operations();
  if (ops.length !== 1) return "not exactly one operation";
  const op = ops[0]!;
  if (op.sourceAccount()) return "operation has its own source";

  const opBody = op.body();
  if (opBody.switch().name === "createAccount") {
    const create = opBody.createAccountOp();
    const destination = StrKey.encodeEd25519PublicKey(create.destination().ed25519());
    if (destination === faucet) return "pays the faucet";
    if (int64(create.startingBalance()) !== rules.xlmStroops) return "not the XLM amount";
    return { kind: "create", destination, asset: "xlm", stroops: rules.xlmStroops };
  }
  if (opBody.switch().name !== "payment") return "not a createAccount or a payment";
  const payment = opBody.paymentOp();
  if (payment.destination().switch().name !== "keyTypeEd25519") return "muxed destination";
  const destination = StrKey.encodeEd25519PublicKey(payment.destination().ed25519());
  if (destination === faucet) return "pays the faucet";
  const amount = int64(payment.amount());
  const asset = Asset.fromOperation(payment.asset());
  if (asset.isNative()) {
    return amount === rules.xlmStroops ? { kind: "payment", destination, asset: "xlm", stroops: amount } : "not the XLM amount";
  }
  if (!asset.equals(rules.usdc)) return "not the faucet's USDC";
  return amount === rules.usdcStroops ? { kind: "payment", destination, asset: "usdc", stroops: amount } : "not the USDC amount";
}
