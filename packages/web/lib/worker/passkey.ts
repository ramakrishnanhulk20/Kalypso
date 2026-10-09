// Before passkey-kit, so the Buffer global it reads at load time exists.
import "./sdk";
import { PasskeyClient, PasskeyKit, PasskeySigner, deriveContractAddress } from "passkey-kit";
import { Address, FeeBumpTransaction, Keypair, StrKey, Transaction, TransactionBuilder, authorizeEntry, hash, xdr } from "@stellar/stellar-sdk";
import { PrfUnavailableError, confidentialBalance, deriveFromPrf, parseAccount, prfEvalSalt, requirePrfOutput, type TxRecord } from "@kalypso/core";
import type { WorkerConfig } from "./config";
import { WorkerError, toWorkerError } from "./errors";
import { AUTH_LIFETIME_LEDGERS, relay } from "./send";
import { heldBy, openSession, type PasskeyHeld, type WorkerRuntime, type WorkerSession } from "./session";
import { SponsorError, type BirthIndexPort, type SponsorPort } from "./sponsor";
import { readWorkerRecord, updateWorkerRecord } from "./storage";
import { b64url, createCeremonies, fromB64url, getAssertion, verifyAssertion, type Ceremonies, type WebAuthnEnv } from "./webauthn";

const APP_NAME = "Kalypso";

/** The name the passkey manager shows once the wallet address is known. A middle dot, never a dash. */
export function passkeyDisplayName(walletAddress: string): string {
  return `Kalypso · ${walletAddress.slice(0, 4)}`;
}

// passkey-kit's public, deterministic default deployer (its DEFAULT_DEPLOYER_SEED). It only salts
// wallet addresses and signs the deploy's own authorisation; it never holds funds or sources a
// transaction, and every passkey-kit app derives the same key. Wallet addresses depend on it.
const PASSKEY_KIT_DEPLOYER_SEED = "kalepail";
let deployer: Keypair | undefined;

function kitDeployer(): Keypair {
  deployer ??= Keypair.fromRawEd25519Seed(hash(Buffer.from(PASSKEY_KIT_DEPLOYER_SEED)));
  return deployer;
}

function newKit(config: WorkerConfig, env: WebAuthnEnv, ceremonies: Ceremonies): PasskeyKit {
  const kit = new PasskeyKit({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    walletWasmHash: config.walletWasmHash,
    WebAuthn: ceremonies,
    rpId: env.rpId,
    allowedOrigins: [env.origin],
    requireUserVerification: true,
  });
  // Addresses this module derives and deploy calls it re-signs must match the kit's, so a kit
  // upgrade that moved the deployer stops here instead of building wallets at other addresses.
  if (kit.deployerPublicKey !== kitDeployer().publicKey()) throw new WorkerError("WALLET_SETUP_FAILED");
  return kit;
}

/** The kit's error for a failed prompt wraps ours, so ours is read first. */
function passkeyFailure(ceremonies: Ceremonies, err: unknown, otherwise: "WALLET_SETUP_FAILED" | "PASSKEY_FAILED"): WorkerError {
  const own = ceremonies.failure;
  if (own instanceof PrfUnavailableError || err instanceof PrfUnavailableError) return new WorkerError("PRF_UNAVAILABLE");
  if (own instanceof WorkerError) return own;
  if (err instanceof WorkerError) return err;
  return new WorkerError(otherwise);
}

/**
 * passkey-kit 0.19.1's connectWallet throws for every wallet whose signer never expires: it tests
 * the decoded expiry with !== undefined, and the SDK decodes "none" as null (M1b). So the portal
 * proves ownership itself (connectPasskey) and only hands the kit the wallet client it signs with.
 */
function attachWallet(kit: PasskeyKit, config: WorkerConfig, contractId: string, keyId: string): void {
  kit.wallet = new PasskeyClient({ contractId, rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase });
  kit.keyId = keyId;
}

function entrySigner(kit: PasskeyKit, ceremonies: Ceremonies, keyId: string) {
  return async (entryXdr: string, expirationLedger: number): Promise<string> => {
    ceremonies.reset();
    // The kit and this module share one Stellar SDK copy; entries cross as base64 so no XDR object
    // made by core's copy ever reaches it.
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
    try {
      const signed = await kit.signAuthEntry(entry, new PasskeySigner(keyId), { expiration: expirationLedger });
      return signed.toXDR("base64");
    } catch (err) {
      throw passkeyFailure(ceremonies, err, "PASSKEY_FAILED");
    }
  };
}

/**
 * The first signer passkey-kit 0.19.1's deploy hands the wallet's constructor (deploy-ops.js
 * buildDeployTransaction), in the exact encoding the live deploy in
 * packages/server/test/sponsor/live-wallet-creation.json carries: the Secp256r1 tag, the credential
 * id, the 65-byte public key, then SignerExpiration(None), SignerLimits(None) and
 * SignerStorage::Persistent, each a one-item vec. Compared as whole bytes, so an expiry, a limit or
 * temporary storage slipped into any field is a different signer.
 */
function fullSigner(keyId: Uint8Array, publicKey: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Secp256r1"),
    xdr.ScVal.scvBytes(Buffer.from(keyId)),
    xdr.ScVal.scvBytes(Buffer.from(publicKey)),
    xdr.ScVal.scvVec([xdr.ScVal.scvVoid()]),
    xdr.ScVal.scvVec([xdr.ScVal.scvVoid()]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Persistent")]),
  ]);
}

/**
 * Checks that a stored or freshly built deploy call creates exactly this worker's wallet: one
 * createContractV2 from the kit's deployer, salted with sha256(credential id), running the pinned
 * wallet code, at the address the credential id derives to (M1b's carrier guard), whose constructor
 * makes this credential, with this passkey's public key, its first signer, never expiring, with no
 * limits, stored persistent (fullSigner). The salt alone does not bind the key: the kit's deployer
 * key is public, so anyone holding the credential id can build a deploy for this address that trusts
 * a key of their own, or this key on terms that let it lapse.
 *
 * @throws WorkerError WALLET_RECORD_INVALID for anything else.
 */
export function checkDeployFunc(funcB64: string, p: { contractId: string; keyId: string; publicKey: Uint8Array; config: WorkerConfig }): xdr.HostFunction {
  let func: xdr.HostFunction;
  let keyId: Buffer;
  try {
    func = xdr.HostFunction.fromXDR(funcB64, "base64");
    keyId = Buffer.from(fromB64url(p.keyId));
  } catch {
    throw new WorkerError("WALLET_RECORD_INVALID");
  }
  const from = kitDeployer().publicKey();
  const ok = (() => {
    if (func.switch().name !== "hostFunctionTypeCreateContractV2") return false;
    const args = func.createContractV2();
    const preimage = args.contractIdPreimage();
    if (preimage.switch().name !== "contractIdPreimageFromAddress") return false;
    const salted = preimage.fromAddress();
    if (Address.fromScAddress(salted.address()).toString() !== from) return false;
    if (!Buffer.from(salted.salt()).equals(hash(keyId))) return false;
    const executable = args.executable();
    if (executable.switch().name !== "contractExecutableWasm" || executable.wasmHash().toString("hex") !== p.config.walletWasmHash) return false;
    if (deriveContractAddress(keyId, from, p.config.networkPassphrase) !== p.contractId) return false;
    // The wallet's __constructor(signer, proof).
    const signer = args.constructorArgs()[0];
    return signer !== undefined && p.publicKey.length === 65 && signer.toXDR().equals(fullSigner(keyId, p.publicKey).toXDR());
  })();
  if (!ok) throw new WorkerError("WALLET_RECORD_INVALID");
  return func;
}

/** The deploy call out of the kit's signed carrier, after the carrier guard: one operation, one deployer entry with no sub-calls. */
function deployFuncFromCarrier(carrierXdr: string, p: { contractId: string; keyId: string; publicKey: Uint8Array; config: WorkerConfig }): string {
  const carrier = TransactionBuilder.fromXDR(carrierXdr, p.config.networkPassphrase);
  if (!(carrier instanceof Transaction) || carrier.operations.length !== 1) throw new WorkerError("WALLET_SETUP_FAILED");
  const op = carrier.operations[0];
  if (op?.type !== "invokeHostFunction" || op.auth?.length !== 1) throw new WorkerError("WALLET_SETUP_FAILED");
  const func = checkDeployFunc(op.func.toXDR("base64"), p);
  const root = op.auth[0]!.rootInvocation();
  const authorised = root.function();
  if (
    authorised.switch().name !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn" ||
    !authorised.createContractV2HostFn().toXDR().equals(func.createContractV2().toXDR()) ||
    root.subInvocations().length !== 0
  ) {
    throw new WorkerError("WALLET_SETUP_FAILED");
  }
  return func.toXDR("base64");
}

/**
 * A fresh deployer authorisation for the wallet's deploy call: a new random nonce and an expiry
 * the caller picks, signed with the kit's public deployer key the way the kit's own signDeploy does,
 * so a wallet created days before the worker joins can still be deployed.
 */
export async function deployerAuth(func: xdr.HostFunction, p: { expirationLedger: number; networkPassphrase: string }): Promise<string> {
  const signer = kitDeployer();
  const nonce = BigInt.asIntN(64, BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`));
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer.publicKey()).toScAddress(),
        nonce: new xdr.Int64(nonce),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(func.createContractV2()),
      subInvocations: [],
    }),
  });
  return (await authorizeEntry(unsigned, signer, p.expirationLedger, p.networkPassphrase)).toXDR("base64");
}

/**
 * Whether the worker's wallet is on chain and, when it is, the passkey public key it trusts for
 * this credential. The signer must be the full one the kit's deploy writes (fullSigner): a signer
 * that expires, acts only within limits, or sits in temporary storage can lapse or be outvoted, so
 * the wallet is not this passkey's alone.
 *
 * @throws WorkerError WALLET_CODE_UNKNOWN when the contract at the address runs other code;
 *   PASSKEY_NOT_THIS_WALLET when it does not list this credential as a full signer.
 */
export async function walletState(rt: WorkerRuntime, contractId: string, keyId: string): Promise<{ deployed: false } | { deployed: true; publicKey: Uint8Array }> {
  const wasm = await rt.ledger.contractWasm(contractId);
  if (wasm === null) return { deployed: false };
  if (wasm !== rt.config.walletWasmHash) throw new WorkerError("WALLET_CODE_UNKNOWN");
  const signer = await rt.ledger.walletSigner(contractId, fromB64url(keyId));
  if (signer === null || signer.publicKey.length !== 65 || signer.expiry !== null || signer.limited || !signer.persistent) {
    throw new WorkerError("PASSKEY_NOT_THIS_WALLET");
  }
  return { deployed: true, publicKey: signer.publicKey };
}

const TX_HASH = /^[0-9a-f]{64}$/;
// core's transfer binding cap (tx-binding.ts MAX_ENVELOPE_CHARS): the network's largest transaction plus a fee bump.
const MAX_ENVELOPE_CHARS = 180_000;

/** The address a CreateContractV2 makes, by the network's rule (passkey-kit's contractIdFromCreateV2), or null for a preimage that is not from an address. */
function createdAddress(create: xdr.CreateContractArgsV2, networkPassphrase: string): string | null {
  const preimage = create.contractIdPreimage();
  if (preimage.switch().name !== "contractIdPreimageFromAddress") return null;
  const id = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(networkPassphrase)), contractIdPreimage: preimage }));
  return StrKey.encodeContract(hash(id.toXDR()));
}

/**
 * Whether the transaction with this hash is the wallet's birth, and whether that birth is ours. A
 * Soroban address does not depend on its code and the kit's deployer key is public, so anyone who
 * learns the credential id can create the wallet first from code of their own, write this signer
 * beside one of theirs, then switch to the pinned code: the current state alone looks like ours.
 * The creation itself cannot be rewritten. An address is created once, so a successful transaction
 * whose one operation creates this address is its birth, and it is ours only when that creation
 * passes checkDeployFunc (the pinned code, the kit's deployer and salt, this full signer).
 *
 * The hash is a pointer from this browser, the relayer or the index, never proof (C55): the
 * envelope comes from rt.txSource (RPC, then Horizon) and must hash to it on this network, outer or
 * inner hash as core's transfer binding allows, because the relayer names a fee bump by its outer
 * hash. A pointer that fails any of that proves nothing either way. Success is read only after the
 * envelope is shown to be this address's creation: an unrelated transaction that failed says
 * nothing about this address, and counting it as a failed creation would let a wrong pointer tell
 * an honest worker their wallet was taken.
 *
 * @returns "ours", "not_ours" (the address was born to someone else), "failed" (the transaction
 *   the pointer names is this address's own creation, and the network applied it and it failed, so
 *   it created nothing), or "unavailable" (no source has it, it does not hash to the pointer, or it
 *   is not this address's creation, failed or not).
 * @throws WorkerError NETWORK when the transaction source could not answer.
 */
export async function verifyWalletBirth(
  rt: WorkerRuntime,
  p: { contractId: string; keyId: string; publicKey: Uint8Array; hash: string },
): Promise<"ours" | "not_ours" | "failed" | "unavailable"> {
  if (typeof p.hash !== "string" || !TX_HASH.test(p.hash)) return "unavailable";
  let record: TxRecord | null;
  try {
    record = await rt.txSource.transaction(p.hash);
  } catch {
    throw new WorkerError("NETWORK");
  }
  if (record === null || typeof record !== "object" || typeof record.envelopeXdr !== "string" || typeof record.successful !== "boolean") return "unavailable";
  if (record.envelopeXdr.length > MAX_ENVELOPE_CHARS) return "unavailable";
  let func: xdr.HostFunction;
  try {
    const parsed = TransactionBuilder.fromXDR(record.envelopeXdr, rt.config.networkPassphrase);
    const inner = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    if (parsed.hash().toString("hex") !== p.hash && inner.hash().toString("hex") !== p.hash) return "unavailable";
    if (inner.operations.length !== 1) return "unavailable";
    const op = inner.operations[0];
    if (op?.type !== "invokeHostFunction" || op.func.switch().name !== "hostFunctionTypeCreateContractV2") return "unavailable";
    const created = createdAddress(op.func.createContractV2(), rt.config.networkPassphrase);
    if (created === null || parseAccount(created).address !== parseAccount(p.contractId).address) return "unavailable";
    func = op.func;
  } catch {
    return "unavailable";
  }
  if (!record.successful) return "failed";
  try {
    checkDeployFunc(func.toXDR("base64"), { contractId: p.contractId, keyId: p.keyId, publicKey: p.publicKey, config: rt.config });
    return "ours";
  } catch {
    return "not_ours";
  }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * The wallet at the address, read as a squat check: absent, or ours (the pinned code, listing this
 * credential with this passkey's key). Anything else was put there by someone else, because the
 * kit's deployer key is public and anyone holding the credential id can deploy at this address.
 *
 * @throws WorkerError ADDRESS_TAKEN for a wallet that is not ours.
 */
async function walletAtAddress(rt: WorkerRuntime, contractId: string, keyId: string, publicKey: Uint8Array): Promise<"absent" | "ours"> {
  let state: Awaited<ReturnType<typeof walletState>>;
  try {
    state = await walletState(rt, contractId, keyId);
  } catch (err) {
    if (err instanceof WorkerError && (err.code === "WALLET_CODE_UNKNOWN" || err.code === "PASSKEY_NOT_THIS_WALLET")) throw new WorkerError("ADDRESS_TAKEN");
    throw err;
  }
  if (!state.deployed) return "absent";
  if (!sameKey(state.publicKey, publicKey)) throw new WorkerError("ADDRESS_TAKEN");
  return "ours";
}

type BirthIndex = Partial<BirthIndexPort> & Partial<Pick<SponsorPort, "status">>;
type RelayPointer = { transactionId: string; hash: string | null };

/**
 * Where one pointer leads: a hash to read from chain; "unknown" when it has no hash to read (no id
 * to ask by, no status to ask, or a status that names none); null when there is no pointer at all.
 * There is no "failed" lead: only a chain read of the relay's own transaction can show it created
 * nothing (verifyWalletBirth).
 */
type Lead = { hash: string } | "unknown" | null;

/**
 * A relay's lead, asking the sponsor for its hash when only its id is known. The relayer saying it
 * failed or expired is its word, not a chain read (C55), so with no hash it stays unknown.
 *
 * @throws SponsorError from the status read.
 */
async function relayLead(index: BirthIndex, pending: { transactionId: string | null; hash: string | null } | null | undefined): Promise<Lead> {
  if (pending === null || pending === undefined) return null;
  if (pending.hash !== null) return { hash: pending.hash };
  if (pending.transactionId === null || typeof index?.status !== "function") return "unknown";
  const answer = await index.status(pending.transactionId);
  return answer.hash === null ? "unknown" : { hash: answer.hash };
}

/**
 * Proves from chain that the worker's wallet was born ours (verifyWalletBirth), following the
 * pointers to its birth in order: the birth this browser saved, the deploy relay it saved (its hash,
 * or the hash the sponsor reports for its id), the relay this call just made, then our server's
 * lookup: the birth it holds, then each creation the sponsor relayed for this address (its hash, or
 * the sponsor's status for its id). The first birth found settles it: an address is created once,
 * so a birth that is not ours means the address was taken, whatever its state shows now. A pointer
 * that leads nowhere is skipped, a missing index method is no pointer at all, and a pointer that
 * throws (the sponsor has forgotten an old id, the transaction source is down) does not stop the
 * search: its error is kept and the next pointer is tried. A proved birth is saved here and offered
 * to the index for other devices.
 *
 * Each pointer that proves nothing ends either "failed" (it names this address's own creation, read
 * from chain as failed, so it created nothing) or unknown (it may still land, has no hash to read,
 * whatever the relayer says of it, cannot be read just now, is not this address's creation, or
 * threw). A saved birth that does not prove itself counts as unknown, never failed, since this
 * browser once proved it ours.
 *
 * When nothing proves the birth, the lookup answered with its whole list (more is false), and
 * every pointer found, this browser's and the lookup's, ended "failed" (none at all included:
 * Kalypso holds no birth, never relayed a creation of this address, and this browser holds no
 * pointer of its own), the wallet there came from elsewhere: every Kalypso creation goes through
 * the sponsor, which records it before handing it on, and none of them created this address. That
 * covers a squat that front-ran our own deploy, which then failed on chain. Any unknown pointer, a
 * list the lookup cut short, or no lookup answer, concludes nothing, and the address stays hidden.
 *
 * @throws WorkerError ADDRESS_TAKEN as soon as a birth is found that is not ours, or when every
 *   pointer failed as above; otherwise the first error a pointer or the lookup threw (WorkerError
 *   NETWORK, a SponsorError), else WALLET_BIRTH_UNKNOWN.
 */
async function proveBirth(rt: WorkerRuntime, worker: WorkerSession, index: BirthIndex, relayed: RelayPointer | null = null): Promise<void> {
  const held = heldBy(worker);
  if (held.kind !== "passkey") throw new WorkerError("NO_SESSION");
  const saved = readWorkerRecord(rt.storage, worker.address).passkey;
  const own = saved?.keyId === held.keyId ? saved : null;
  const tried = new Set<string>();
  const failures: unknown[] = [];
  // Set by any pointer that may yet lead to a creation of this address, so nothing is concluded.
  let anyUnknown = false;
  /**
   * Follows one pointer: true once it proved the birth ours. A saved birth is never "failed".
   * @throws WorkerError ADDRESS_TAKEN for a birth that is not ours.
   */
  const attempt = async (pointer: () => Promise<Lead>, savedBirth = false): Promise<boolean> => {
    let hash: string;
    let verdict: Awaited<ReturnType<typeof verifyWalletBirth>>;
    try {
      const lead = await pointer();
      if (lead === null) return false;
      if (lead === "unknown") {
        anyUnknown = true;
        return false;
      }
      hash = lead.hash;
      if (tried.has(hash)) return false;
      tried.add(hash);
      verdict = await verifyWalletBirth(rt, { contractId: worker.address, keyId: held.keyId, publicKey: held.publicKey, hash });
    } catch (err) {
      failures.push(err);
      anyUnknown = true;
      return false;
    }
    if (verdict === "not_ours") throw new WorkerError("ADDRESS_TAKEN");
    if (verdict === "unavailable" || (verdict === "failed" && savedBirth)) anyUnknown = true;
    if (verdict !== "ours") return false;
    const proved = hash;
    if (own !== null) {
      updateWorkerRecord(rt.storage, worker.address, (r) => {
        if (r.passkey?.keyId === held.keyId) r.passkey.birth = { hash: proved };
      });
    }
    try {
      await index?.recordBirth?.(worker.address, proved);
    } catch {
      // The index only helps other devices find the birth; this one has just proved it from chain.
    }
    return true;
  };

  const savedBirth = own?.birth ?? null;
  if (await attempt(async () => (savedBirth === null ? null : { hash: savedBirth.hash }), true)) return;
  if (await attempt(() => relayLead(index, own?.deployRelay))) return;
  if (await attempt(() => relayLead(index, relayed))) return;
  let lookup: Awaited<ReturnType<BirthIndexPort["birth"]>> | null = null;
  if (typeof index?.birth === "function") {
    try {
      lookup = await index.birth(worker.address);
    } catch (err) {
      failures.push(err);
    }
  }
  if (lookup !== null) {
    const answer = lookup;
    if (await attempt(async () => (answer.hash === null ? null : { hash: answer.hash }))) return;
    for (const creation of answer.relayed) {
      if (await attempt(() => relayLead(index, creation))) return;
    }
    // The relays left out of a cut list may hold the creation that landed.
    if (answer.more !== false) anyUnknown = true;
    if (!anyUnknown) throw new WorkerError("ADDRESS_TAKEN");
  }
  if (failures.length > 0) throw failures[0];
  throw new WorkerError("WALLET_BIRTH_UNKNOWN");
}

/**
 * Lets the session show its address (C51), once proveBirth has passed. The saved deploy relay is
 * dropped only when the birth itself is saved, so a refused write never loses the way back to it.
 */
function markProven(rt: WorkerRuntime, worker: WorkerSession, held: PasskeyHeld): void {
  held.proven = true;
  held.deployFunc = null;
  const saved = readWorkerRecord(rt.storage, worker.address).passkey;
  if (saved?.keyId === held.keyId && saved.birth !== null && saved.deployRelay !== null) {
    updateWorkerRecord(rt.storage, worker.address, (r) => {
      if (r.passkey !== null) r.passkey.deployRelay = null;
    });
  }
}

/**
 * Puts the passkey wallet on chain through the sponsor unless it is there already, then proves
 * from chain that it trusts exactly this passkey's key and was born ours (proveBirth) before the
 * session may show its address (C51). The deploy call is the one built when the passkey was made,
 * checked again before it is sent (its constructor must trust this credential with this full
 * signer); its deployer authorisation is signed fresh. The relayer's word that the deploy landed
 * proves nothing: only the chain reads after it do (C55). Its id and hash are saved as soon as each
 * is known, so a lost answer can still be followed to the birth. A failed or lost relay is settled
 * the same way, so a deploy that lost a race to a squatter reports ADDRESS_TAKEN, and one whose
 * answer was lost but landed counts as done once its birth is found.
 *
 * @param sponsor also the birth index, when it has the methods (createHttpSponsor does).
 * @param onSending called just before the deploy is handed to the sponsor.
 * @returns the deploy's hash, or null when nothing was sent or its answer was lost.
 * @throws WorkerError ADDRESS_TAKEN; WALLET_RECORD_INVALID when this browser has no deploy call that
 *   passes the check; CHAIN_DISAGREES when the relay reported success and no wallet is there;
 *   WALLET_BIRTH_UNKNOWN or NETWORK from proveBirth; the relay's own errors; SponsorError.
 */
export async function setUpWallet(
  rt: WorkerRuntime,
  worker: WorkerSession,
  sponsor: SponsorPort & Partial<BirthIndexPort>,
  onSending?: () => void,
): Promise<{ hash: string | null }> {
  const held = heldBy(worker);
  if (held.kind !== "passkey") return { hash: null };
  if ((await walletAtAddress(rt, worker.address, held.keyId, held.publicKey)) === "ours") {
    held.deployed = true;
    await proveBirth(rt, worker, sponsor);
    markProven(rt, worker, held);
    return { hash: null };
  }
  const stored = readWorkerRecord(rt.storage, worker.address).passkey;
  const funcB64 = held.deployFunc ?? (stored?.keyId === held.keyId ? stored.deployFunc : null);
  if (funcB64 === null) throw new WorkerError("WALLET_RECORD_INVALID");
  const func = checkDeployFunc(funcB64, { contractId: worker.address, keyId: held.keyId, publicKey: held.publicKey, config: rt.config });
  const { sequence } = await rt.port.latestLedger();
  const auth = await deployerAuth(func, { expirationLedger: sequence + AUTH_LIFETIME_LEDGERS, networkPassphrase: rt.config.networkPassphrase });
  onSending?.();
  let hash: string | null = null;
  let failure: unknown = null;
  let relayed: RelayPointer | null = null;
  const onRelayed = (pointer: RelayPointer) => {
    relayed = pointer;
    updateWorkerRecord(rt.storage, worker.address, (r) => {
      if (r.passkey?.keyId === held.keyId) r.passkey.deployRelay = pointer;
    });
  };
  try {
    hash = (await relay(rt, sponsor, { func: funcB64, auth: [auth] }, onRelayed)).hash;
  } catch (err) {
    failure = err;
  }
  let after: "absent" | "ours";
  try {
    after = await walletAtAddress(rt, worker.address, held.keyId, held.publicKey);
  } catch (err) {
    if (failure !== null && !(err instanceof WorkerError && err.code === "ADDRESS_TAKEN")) throw failure;
    throw err;
  }
  if (after === "absent") throw failure ?? new WorkerError("CHAIN_DISAGREES", hash === null ? {} : { hash });
  held.deployed = true;
  await proveBirth(rt, worker, sponsor, relayed);
  markProven(rt, worker, held);
  return { hash };
}

/**
 * The deploy right after a passkey is made. A refused or failed one leaves the session in hand with
 * its address hidden (addressProven stays false) and the reason, so the screen can offer to finish
 * setting up; a squatted address throws, since that session can never be proven.
 *
 * @throws WorkerError ADDRESS_TAKEN.
 */
export async function settleNewWallet(rt: WorkerRuntime, worker: WorkerSession, sponsor: SponsorPort & Partial<BirthIndexPort>): Promise<{ setupFailure?: WorkerError | SponsorError }> {
  try {
    await setUpWallet(rt, worker, sponsor);
    return {};
  } catch (err) {
    const failure = toWorkerError(err);
    if (failure instanceof WorkerError && failure.code === "ADDRESS_TAKEN") throw failure;
    return { setupFailure: failure };
  }
}

/**
 * Runs setUpWallet again for a signed-in passkey worker whose wallet is not proven yet, under the
 * same lock joining takes, so two tabs never send two deploys.
 *
 * @throws WorkerError INVALID_INPUT, BUSY, or setUpWallet's errors, ADDRESS_TAKEN among them; SponsorError.
 */
export async function finishSetup(rt: WorkerRuntime, worker: WorkerSession, sponsor: SponsorPort & Partial<BirthIndexPort>): Promise<{ hash: string | null }> {
  if (typeof sponsor?.send !== "function" || typeof sponsor.status !== "function") throw new WorkerError("INVALID_INPUT");
  heldBy(worker);
  return rt.exclusive(`kalypso/worker/v1/join/${worker.address}`, async () => {
    try {
      return await setUpWallet(rt, worker, sponsor);
    } catch (err) {
      throw toWorkerError(err);
    }
  });
}

function sessionFrom(
  rt: WorkerRuntime,
  p: {
    kit: PasskeyKit;
    ceremonies: Ceremonies;
    prf: Uint8Array;
    contractId: string;
    keyId: string;
    publicKey: Uint8Array;
    auditorId: number | null;
    deployFunc: string | null;
    proven: boolean;
    deployed: boolean;
  },
): WorkerSession {
  attachWallet(p.kit, rt.config, p.contractId, p.keyId);
  const { cashout, ...keys } = deriveFromPrf(p.prf, rt.config.contracts.token, p.contractId);
  p.prf.fill(0);
  return openSession(
    { kind: "passkey", address: p.contractId, cashOutAddress: cashout.publicKey, keys, auditorId: p.auditorId },
    {
      kind: "passkey",
      keyId: p.keyId,
      publicKey: p.publicKey,
      cashOutSeed: cashout.secretSeed,
      signEntry: entrySigner(p.kit, p.ceremonies, p.keyId),
      deployFunc: p.deployFunc,
      proven: p.proven,
      deployed: p.deployed,
    },
  );
}

/**
 * Registers a new passkey with PRF, builds its smart wallet's deploy call and deploys it through
 * the sponsor at once, returning only after the chain shows the wallet trusting this passkey's key
 * (setUpWallet, C51). The credential id leaves the browser before the deploy (the kit simulates it
 * at RPC), so until that read the address could belong to whoever deployed there first. When the
 * deploy is refused or fails, the session comes back unproven, its address hidden, with the reason
 * in setupFailure (settleNewWallet). Two prompts: the registration, then the kit's binding proof,
 * which also returns the PRF output. The deploy needs no passkey signature.
 *
 * @throws WorkerError INVALID_INPUT for a sponsor without send and status; PRF_UNAVAILABLE when the
 *   passkey gives no PRF output (C15: refused, never weakened, and the useless passkey is reported
 *   to the browser as unknown so it can drop it); PASSKEY_CANCELLED, NO_USER_VERIFICATION,
 *   PASSKEY_FAILED, WALLET_SETUP_FAILED; ADDRESS_TAKEN when the address is squatted.
 */
export async function createPasskey(rt: WorkerRuntime, sponsor: SponsorPort & Partial<BirthIndexPort>): Promise<{ worker: WorkerSession; setupFailure?: WorkerError | SponsorError }> {
  if (typeof sponsor?.send !== "function" || typeof sponsor.status !== "function") throw new WorkerError("INVALID_INPUT");
  const env = rt.webauthn();
  const ceremonies = createCeremonies(env);
  const kit = newKit(rt.config, env, ceremonies);
  ceremonies.requestPrf(prfEvalSalt());
  let created: Awaited<ReturnType<PasskeyKit["createWallet"]>>;
  try {
    created = await kit.createWallet(APP_NAME, APP_NAME, { authenticatorSelection: { residentKey: "required", userVerification: "required" } });
  } catch (err) {
    const failure = passkeyFailure(ceremonies, err, "WALLET_SETUP_FAILED");
    const made = ceremonies.registered;
    if (failure.code === "PRF_UNAVAILABLE" && made) await env.signalUnknownCredential?.({ rpId: env.rpId, credentialId: made.credentialId }).catch(() => undefined);
    throw failure;
  }
  let prf: Uint8Array;
  try {
    prf = requirePrfOutput(ceremonies.takePrfResults());
  } catch {
    await env.signalUnknownCredential?.({ rpId: env.rpId, credentialId: created.keyIdBase64 }).catch(() => undefined);
    throw new WorkerError("PRF_UNAVAILABLE");
  }
  const where = { contractId: created.contractId, keyId: created.keyIdBase64, publicKey: new Uint8Array(created.publicKey), config: rt.config };
  const deployFunc = deployFuncFromCarrier(created.signedTx, where);
  const userId = ceremonies.registered?.userId;
  // Saved before the deploy, so a refused or lost one can be finished from a later sign-in.
  updateWorkerRecord(rt.storage, created.contractId, (record) => {
    record.passkey = { keyId: created.keyIdBase64, publicKey: b64url(created.publicKey), deployFunc, birth: null, deployRelay: null };
  });
  const worker = sessionFrom(rt, {
    kit,
    ceremonies,
    prf,
    contractId: created.contractId,
    keyId: created.keyIdBase64,
    publicKey: new Uint8Array(created.publicKey),
    auditorId: null,
    deployFunc,
    proven: false,
    deployed: false,
  });
  const settled = await settleNewWallet(rt, worker, sponsor);
  // The name carries the start of the address, so the passkey manager learns it only once it is proven.
  if (userId && settled.setupFailure === undefined) {
    const name = passkeyDisplayName(created.contractId);
    await env.signalUserDetails?.({ rpId: env.rpId, userId, name, displayName: name }).catch(() => undefined);
  }
  return { worker, ...settled };
}

/**
 * Signs a returning passkey worker in with one prompt: a discoverable assertion that also returns the
 * PRF output. The wallet address comes from the credential id, and ownership is proved by checking
 * the assertion against the signer key the wallet holds on chain (or, before the wallet is deployed,
 * the key this browser recorded when it created it). Only the first can prove the address is this
 * worker's (C51), and only once proveBirth has read from chain that the wallet was born ours: a
 * wallet someone else created first can hold this key today. When the birth cannot be found or read
 * just now, or shows someone else created the wallet (ADDRESS_TAKEN), the session still opens, its
 * address hidden, with the reason in setupFailure: the payslips and cash-out need only the keys and a
 * wallet on chain trusting this passkey, and the screen offers a new pay key for a taken address. A
 * session from the stored key keeps the address hidden until setUpWallet has run.
 *
 * @param sponsor the birth index and the relay status for proveBirth; a missing method is no pointer.
 * @throws WorkerError PRF_UNAVAILABLE, PASSKEY_CANCELLED, NO_USER_VERIFICATION, PASSKEY_FAILED,
 *   WALLET_CODE_UNKNOWN, PASSKEY_NOT_THIS_WALLET, KEYS_MISMATCH, or PASSKEY_WALLET_UNKNOWN when the
 *   wallet is not on chain and this browser has no record of creating it.
 */
export async function connectPasskey(
  rt: WorkerRuntime,
  sponsor: SponsorPort & Partial<BirthIndexPort>,
): Promise<{ worker: WorkerSession; setupFailure?: WorkerError | SponsorError }> {
  const env = rt.webauthn();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await getAssertion(env, { challenge, prfSalt: prfEvalSalt() });
  let prf: Uint8Array;
  try {
    prf = requirePrfOutput(assertion.extensions);
  } catch {
    throw new WorkerError("PRF_UNAVAILABLE");
  }
  const ceremonies = createCeremonies(env);
  const kit = newKit(rt.config, env, ceremonies);
  const keyId = assertion.credentialId;
  const contractId = deriveContractAddress(Buffer.from(assertion.rawId), kit.deployerPublicKey, rt.config.networkPassphrase);
  const chain = await walletState(rt, contractId, keyId);
  const stored = readWorkerRecord(rt.storage, contractId);
  const publicKey = chain.deployed ? chain.publicKey : stored.passkey?.keyId === keyId ? fromB64url(stored.passkey.publicKey) : null;
  if (publicKey === null) {
    prf.fill(0);
    throw new WorkerError("PASSKEY_WALLET_UNKNOWN");
  }
  if (!(await verifyAssertion(env, assertion, { publicKey, challenge }))) {
    prf.fill(0);
    throw new WorkerError("PASSKEY_NOT_THIS_WALLET");
  }
  const account = chain.deployed ? await confidentialBalance(rt.port, rt.config.contracts.token, contractId) : null;
  const deployFunc = chain.deployed ? null : (stored.passkey?.deployFunc ?? null);
  const worker = sessionFrom(rt, { kit, ceremonies, prf, contractId, keyId, publicKey, auditorId: account?.auditorId ?? stored.auditorId, deployFunc, proven: false, deployed: chain.deployed });
  let setupFailure: WorkerError | SponsorError | undefined;
  if (chain.deployed) {
    try {
      await proveBirth(rt, worker, sponsor);
      const held = heldBy(worker);
      if (held.kind === "passkey") markProven(rt, worker, held);
    } catch (err) {
      const failure = toWorkerError(err);
      const kept = failure instanceof SponsorError || failure.code === "WALLET_BIRTH_UNKNOWN" || failure.code === "NETWORK" || failure.code === "ADDRESS_TAKEN";
      if (!kept) throw failure;
      setupFailure = failure;
    }
  }
  if (account !== null && !account.pvk.equals(worker.keys.PVK)) throw new WorkerError("KEYS_MISMATCH");
  return setupFailure === undefined ? { worker } : { worker, setupFailure };
}
