import { Address, Keypair, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { FeeCapError, MAX_SETUP_FEE_STROOPS, assembleFromSimulation, decodeInvocation, transactionHash } from "@kalypso/core";
import type { InvocationBase, SimResult } from "@kalypso/core";
import { requireFeeXlm } from "./anchor";
import { WorkerError, simulationRefusal } from "./errors";
import { heldBy, type PasskeyHeld, type WorkerRuntime, type WorkerSession } from "./session";
import { waitForRelayHash, type SponsorBody, type SponsorPort } from "./sponsor";

// The all-zero public key, which nobody can sign for. A passkey worker's call is built and
// simulated from it only to learn the host function and the one auth entry; the relayer then
// sends that call from its own account.
const ZERO_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
// About five minutes: long enough for the sponsor's two simulations and the relay, short enough that
// a leaked approval dies quickly. The sponsor refuses more than 1,000 ledgers, Channels fewer than 2.
export const AUTH_LIFETIME_LEDGERS = 60;
// Channels refuses an envelope whose maxTime is more than 60 seconds out (relayer-plugin-channels
// MAX_TIME_BOUND_OFFSET_SECONDS), so a wallet worker's envelope is built for exactly that.
const WALLET_TX_TIMEOUT_SECONDS = 60;
const SEND_MARGIN_SECONDS = 5;
const PASSKEY_TX_TIMEOUT_SECONDS = 300;
const CONFIRM_WAIT_MS = 90_000;

/** One contract call a worker authorises. build returns the unsigned envelope from base, and may prove first. */
export interface WorkerCall {
  contractId: string;
  build(base: InvocationBase): string | Promise<string>;
}

/** A transaction the chain confirmed. returnValue is core's decoded value, read with that call's strict decoder. */
export interface Landed {
  hash: string;
  ledger: number | undefined;
  returnValue: Awaited<ReturnType<WorkerRuntime["port"]["waitFor"]>>["returnValue"];
}

function hostFunctionOf(envelopeXdr: string, networkPassphrase: string): string {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  const op = tx instanceof Transaction ? tx.operations[0] : undefined;
  if (op?.type !== "invokeHostFunction") throw new WorkerError("CHAIN_DISAGREES");
  return op.func.toXDR("base64");
}

function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials | null {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return credentials.address();
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2();
    default:
      return null;
  }
}

async function simulated(rt: WorkerRuntime, unsigned: string) {
  const sim = await rt.port.simulate(unsigned);
  if (!sim.ok) throw simulationRefusal(sim.error);
  return sim;
}

/**
 * The passkey's signature on the one authorisation a simulation asks of this wallet. The simulation
 * must ask for exactly one, from this wallet; the passkey signs it, and the signed entry handed back
 * must cover the same call tree, wallet, nonce and expiry that were asked for (M1b's guards), so a
 * tampered signer can never smuggle in another call.
 */
async function signWalletEntry(session: WorkerSession, held: PasskeyHeld, sim: SimResult): Promise<string> {
  const asked = sim.authXdr ?? [];
  if (asked.length !== 1) throw new WorkerError("CHAIN_DISAGREES");
  const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(asked[0]!, "base64");
  const want = addressCredentials(unsignedEntry);
  if (want === null || Address.fromScAddress(want.address()).toString() !== session.address) throw new WorkerError("CHAIN_DISAGREES");
  const expiration = sim.latestLedger + AUTH_LIFETIME_LEDGERS;
  const signedXdr = await held.signEntry(asked[0]!, expiration);
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(signedXdr, "base64");
  const got = addressCredentials(signed);
  if (
    got === null ||
    !signed.rootInvocation().toXDR().equals(unsignedEntry.rootInvocation().toXDR()) ||
    Address.fromScAddress(got.address()).toString() !== session.address ||
    got.nonce().toString() !== want.nonce().toString() ||
    got.signatureExpirationLedger() !== expiration
  ) {
    throw new WorkerError("PASSKEY_FAILED");
  }
  return signedXdr;
}

/** A passkey wallet's call as the sponsor's { func, auth } body: built from a source nobody holds, the relayer becomes the source. */
async function passkeyBody(rt: WorkerRuntime, session: WorkerSession, call: WorkerCall): Promise<SponsorBody> {
  const held = heldBy(session);
  if (held.kind !== "passkey") throw new WorkerError("NO_SESSION");
  const { networkPassphrase } = rt.config;
  const unsigned = await call.build({
    source: { address: ZERO_SOURCE, sequence: "0" },
    networkPassphrase,
    contractId: call.contractId,
    timeoutSeconds: PASSKEY_TX_TIMEOUT_SECONDS,
  });
  const signedXdr = await signWalletEntry(session, held, await simulated(rt, unsigned));
  return { func: hostFunctionOf(unsigned, networkPassphrase), auth: [signedXdr] };
}

/**
 * A wallet worker's call as the sponsor's { xdr } body: built from the worker's own account,
 * simulated twice so it declares what the sponsor's own simulation will find, assembled under core's
 * setup fee cap (C39), signed by the wallet, and refused unless the signed envelope is the one that
 * was assembled and still has time left to be relayed.
 */
async function walletBody(rt: WorkerRuntime, session: WorkerSession, call: WorkerCall): Promise<SponsorBody> {
  const held = heldBy(session);
  if (held.kind !== "wallet") throw new WorkerError("NO_SESSION");
  const { networkPassphrase } = rt.config;
  let sequence: string;
  try {
    ({ sequence } = await rt.port.sourceAccount(session.address));
  } catch {
    const state = await rt.ledger.classicAccount(session.address);
    throw new WorkerError(state.exists ? "NETWORK" : "WALLET_ACCOUNT_MISSING");
  }
  const unsigned = await call.build({
    source: { address: session.address, sequence },
    networkPassphrase,
    contractId: call.contractId,
    timeoutSeconds: WALLET_TX_TIMEOUT_SECONDS,
  });
  const recorded = await simulated(rt, unsigned);
  let assembled: string;
  try {
    // The first simulation records the authorisation the call needs. Simulating again with it in place
    // runs the way the sponsor's own check does, and costs slightly more (measured: 7,615 more
    // instructions for a token registration). The sponsor refuses an envelope that declares less
    // than its simulation finds, so the limits and fee are taken from the second one.
    const draft = assembleFromSimulation(unsigned, recorded, networkPassphrase, MAX_SETUP_FEE_STROOPS);
    const enforced = await simulated(rt, draft);
    assembled = assembleFromSimulation(
      unsigned,
      { ...recorded, transactionDataXdr: enforced.transactionDataXdr, minResourceFee: enforced.minResourceFee, latestLedger: enforced.latestLedger },
      networkPassphrase,
      MAX_SETUP_FEE_STROOPS,
    );
  } catch (err) {
    throw err instanceof FeeCapError ? new WorkerError("FEE_TOO_HIGH") : err;
  }
  let signed: string;
  try {
    signed = await held.wallet.signTransaction(assembled, networkPassphrase);
  } catch {
    throw new WorkerError("WALLET_REJECTED");
  }
  let maxTime: number;
  try {
    if (transactionHash(signed, networkPassphrase) !== transactionHash(assembled, networkPassphrase)) throw new Error("changed");
    maxTime = decodeInvocation(signed, networkPassphrase).maxTime;
  } catch {
    throw new WorkerError("WALLET_CHANGED_TRANSACTION");
  }
  if (maxTime - SEND_MARGIN_SECONDS <= Math.floor(rt.now() / 1000)) throw new WorkerError("SIGNING_TOO_SLOW");
  return { xdr: signed };
}

/** The sponsor body for one call, signed the way this worker signs. */
export function prepareCall(rt: WorkerRuntime, session: WorkerSession, call: WorkerCall): Promise<SponsorBody> {
  return session.kind === "passkey" ? passkeyBody(rt, session, call) : walletBody(rt, session, call);
}

/**
 * Hands a body to the sponsor and waits for the chain's own answer. The relayer names the hash; RPC
 * then says whether it landed, because the relayer's status is only its word. A relayer could name
 * someone else's successful hash, so every caller re-reads the state its call was meant to change.
 *
 * @param onRelayed called with the relay's id as soon as the sponsor accepts it, and again with the
 *   hash, so a caller can save them before waiting.
 * @throws SponsorError from the sponsor; WorkerError TX_FAILED or TX_PENDING (both carry the hash).
 */
export async function relay(
  rt: WorkerRuntime,
  sponsor: SponsorPort,
  body: SponsorBody,
  onRelayed?: (relayed: { transactionId: string; hash: string | null }) => void,
): Promise<Landed> {
  const { transactionId } = await sponsor.send(body);
  onRelayed?.({ transactionId, hash: null });
  const { hash } = await waitForRelayHash(sponsor, transactionId, { sleep: (ms) => rt.sleep(ms), now: () => rt.now() });
  onRelayed?.({ transactionId, hash });
  return confirm(rt, hash);
}

/** The chain's answer for a relayed hash. @throws WorkerError TX_FAILED, TX_PENDING. */
export async function confirm(rt: WorkerRuntime, hash: string): Promise<Landed> {
  const final = await rt.port.waitFor(hash, CONFIRM_WAIT_MS);
  if (final.status === "SUCCESS") return { hash, ledger: final.ledger, returnValue: final.returnValue };
  throw new WorkerError(final.status === "FAILED" ? "TX_FAILED" : "TX_PENDING", { hash });
}

/** prepareCall then relay. */
export async function sendCall(
  rt: WorkerRuntime,
  session: WorkerSession,
  sponsor: SponsorPort,
  call: WorkerCall,
  onRelayed?: (relayed: { transactionId: string; hash: string | null }) => void,
): Promise<Landed> {
  return relay(rt, sponsor, await prepareCall(rt, session, call), onRelayed);
}

/** The envelope with its contract call carrying exactly this signed authorisation entry. */
function withAuth(envelopeXdr: string, entryXdr: string, networkPassphrase: string): string {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new WorkerError("CHAIN_DISAGREES");
  const envelope = tx.toEnvelope();
  const op = envelope.v1().tx().operations()[0];
  if (op === undefined || op.body().switch().name !== "invokeHostFunction") throw new WorkerError("CHAIN_DISAGREES");
  op.body().invokeHostFunctionOp().auth([xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64")]);
  return envelope.toXDR("base64");
}

/**
 * Sends one call with no sponsor, for when it refuses or cannot be reached: a G account the worker
 * controls is the transaction source and pays the fee. For a passkey worker that is the cash-out
 * account (friendbot funds it on testnet; its PRF-derived key signs the envelope) while the passkey
 * still signs the wallet's own authorisation, under the same guards as a sponsored call. The call is
 * simulated again with that signature in place, so its declared resources cover the wallet's
 * signature check. A wallet worker's own account signs and pays, as it is already the source of
 * every call it makes. Refuses before submitting when the payer cannot cover the fee from XLM
 * above its minimum balance. The chain's answer is read by hash, which this function computed
 * itself; callers still re-read the state the call was meant to change.
 *
 * @throws WorkerError CASHOUT_NO_XLM, FEE_TOO_HIGH, NETWORK, prepareCall's signing errors, TX_FAILED,
 *   TX_PENDING; SubmitRejectedError when the network refused it outright.
 */
export async function sendSelfPaid(rt: WorkerRuntime, session: WorkerSession, call: WorkerCall): Promise<Landed> {
  const held = heldBy(session);
  const { networkPassphrase } = rt.config;
  let payer: string;
  let signed: string;
  if (held.kind === "wallet") {
    payer = session.address;
    signed = ((await walletBody(rt, session, call)) as { xdr: string }).xdr;
  } else {
    payer = session.cashOutAddress;
    const { sequence } = await rt.port.sourceAccount(payer);
    const unsigned = await call.build({ source: { address: payer, sequence }, networkPassphrase, contractId: call.contractId, timeoutSeconds: PASSKEY_TX_TIMEOUT_SECONDS });
    const authorised = withAuth(unsigned, await signWalletEntry(session, held, await simulated(rt, unsigned)), networkPassphrase);
    let assembled: string;
    try {
      assembled = assembleFromSimulation(authorised, await simulated(rt, authorised), networkPassphrase, MAX_SETUP_FEE_STROOPS);
    } catch (err) {
      throw err instanceof FeeCapError ? new WorkerError("FEE_TOO_HIGH") : err;
    }
    const tx = TransactionBuilder.fromXDR(assembled, networkPassphrase) as Transaction;
    tx.sign(Keypair.fromRawEd25519Seed(Buffer.from(held.cashOutSeed)));
    signed = tx.toXDR();
  }
  await requireFeeXlm(rt, payer, BigInt(TransactionBuilder.fromXDR(signed, networkPassphrase).fee));
  const hash = transactionHash(signed, networkPassphrase);
  await rt.port.submit(signed);
  return confirm(rt, hash);
}
