import {
  Account,
  Address,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.ts";
import { RpcError, type RpcClient } from "../rpc.ts";
import { canonicalContractId, contractIdOfScAddress, decodeCanonicalBase64 } from "../stellar.ts";

/*
 * The sponsor rule (threat model C20), decided on the exact bytes that will be
 * forwarded. It is one structural rule, not a list of function names:
 *
 * - the root call goes into our payroll or our token contract;
 * - no contract creation and no wasm upload, at the root or anywhere in any
 *   auth tree;
 * - every call in every auth tree goes into payroll, token, auditor or the
 *   USDC contract;
 * - every contract-account (C) signer, delegates included, is deployed with
 *   the pinned passkey wallet wasm, read from its on-chain instance, because
 *   the host runs that contract's own __check_auth on our fee;
 * - every contract-data and contract-code entry the call can touch, in the
 *   simulated footprint and in an envelope's declared one, belongs to
 *   payroll, token, auditor, USDC, the verifier or one of those signing
 *   wallets and the pinned wallet code;
 * - an envelope declares every key the simulated call reads, and declares
 *   read-write every key it writes, compared as XDR bytes, and declares at
 *   least the simulated instructions, disk read bytes, write bytes and
 *   minimum resource fee;
 * - signatures we can check offline verify for the testnet network id, and
 *   each classic-account signature is made by that account's own key;
 * - the declared and simulated fees stay under FEE_CAP_STROOPS;
 * - auth entries expire within 1,000 ledgers;
 * - simulation in enforce mode succeeds;
 * - the call writes ledger state: a footprint with no read-write entry is a
 *   read-only call, which is nobody's own action and only costs us a fee;
 * - the auth entries supplied are exactly the ones the call needs, as a
 *   record-mode simulation reports them: none missing and none unused,
 *   because an unused signed entry passes enforce mode and proves nothing.
 *
 * What it covers: which code can run on our fee, that someone authorised the
 * state change, and what that can cost us. What it does not cover: valid,
 * signed but pointless writes into our own contracts (the per-IP limit and
 * the daily budget bound those); whether a passkey wallet's signature is
 * valid, which only its own __check_auth can decide during simulation; and a
 * wallet whose stored state changes between our simulation and the one
 * Channels runs before it submits a func request.
 */

export const MAX_AUTH_ENTRIES = 16;
/** Invocation nodes plus delegate nodes, across all entries. A worker action uses 2 or 3. */
export const MAX_AUTH_NODES = 64;
export const MAX_AUTH_LIFETIME_LEDGERS = 1_000;
/**
 * Channels adds its own inclusion fee on top of the simulated resource fee:
 * 203 stroops by default (relayer-plugin-channels 0.21.0, src/plugin/config.ts
 * line 12), more when it prices dynamically. 10,000 stroops covers that with
 * room to spare and is what we reserve from the daily budget beyond the
 * resource fee.
 */
export const INCLUSION_FEE_ALLOWANCE_STROOPS = 10_000n;

const SIMULATION_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

export type SponsorRefusalCode =
  | "bad_shape"
  | "bad_encoding"
  | "envelope_not_accepted"
  | "not_one_operation"
  | "not_invoke_host_function"
  | "missing_soroban_data"
  | "wasm_upload"
  | "contract_creation"
  | "root_contract_not_allowed"
  | "nested_contract_not_allowed"
  | "no_auth"
  | "source_account_auth"
  | "too_many_auth_entries"
  | "auth_tree_too_large"
  | "unsigned_auth"
  | "signer_key_mismatch"
  | "not_signed_for_testnet"
  | "fee_over_cap"
  | "auth_expired"
  | "auth_expiry_too_far"
  | "simulation_failed"
  | "simulation_needs_restore"
  | "read_only_call"
  | "unused_auth"
  | "unknown_wallet_code"
  | "foreign_contract_in_footprint"
  | "footprint_not_declared"
  | "resources_not_declared"
  | "rpc_unavailable";

export interface Refusal {
  ok: false;
  code: SponsorRefusalCode;
}

interface Validated {
  ok: true;
  authEntries: xdr.SorobanAuthorizationEntry[];
  rootContract: string;
  /**
   * Every address that authorises the request, once each, in the server's
   * one address spelling: each entry's address, and an envelope's source.
   */
  authorisers: string[];
}

/** A passkey worker's call: Channels becomes the source and pays. */
export interface FuncSponsorRequest extends Validated {
  kind: "func";
  func: string;
  auth: string[];
  hostFunction: xdr.HostFunction;
}

/** A signed transaction envelope that Channels wraps in a fee bump. */
export interface XdrSponsorRequest extends Validated {
  kind: "xdr";
  xdr: string;
  /** The transaction's source account (G...), which source-account auth entries stand for. */
  source: string;
  declaredFee: bigint;
  declaredResourceFee: bigint;
}

export type SponsorRequest = FuncSponsorRequest | XdrSponsorRequest;

const refuse = (code: SponsorRefusalCode): Refusal => ({ ok: false, code });

const bodySchema = z.union([
  z.strictObject({ func: z.string(), auth: z.array(z.string()) }),
  z.strictObject({ xdr: z.string() }),
]);

/**
 * Structural check of a sponsor request body. Pure: no network.
 *
 * Accepts `{ func, auth }` (base64 HostFunction and SorobanAuthorizationEntry
 * list) or `{ xdr }` (base64 TransactionEnvelope). Each value must be
 * canonical base64 of XDR that re-encodes to the same bytes, so the bytes
 * judged here are exactly the bytes forwarded. Returns the parsed request or
 * a refusal code; never throws.
 */
export function validateSponsorRequest(body: unknown, cfg: Config): SponsorRequest | Refusal {
  const shape = bodySchema.safeParse(body);
  if (!shape.success) return refuse("bad_shape");
  try {
    return "xdr" in shape.data
      ? validateEnvelope(shape.data.xdr, cfg)
      : validateFuncAuth(shape.data.func, shape.data.auth, cfg);
  } catch {
    // An XDR accessor throws only on an arm we did not plan for: refuse it.
    return refuse("bad_shape");
  }
}

function decodeXdr<T extends { toXDR(): Buffer }>(base64: string, parse: (bytes: Buffer) => T): T | null {
  const bytes = decodeCanonicalBase64(base64);
  if (bytes === null) return null;
  let value: T;
  try {
    value = parse(bytes);
  } catch {
    return null;
  }
  return value.toXDR().equals(bytes) ? value : null;
}

function validateFuncAuth(func: string, auth: string[], cfg: Config): FuncSponsorRequest | Refusal {
  if (auth.length === 0) return refuse("no_auth");
  if (auth.length > MAX_AUTH_ENTRIES) return refuse("too_many_auth_entries");
  const hostFunction = decodeXdr(func, (b) => xdr.HostFunction.fromXDR(b));
  if (hostFunction === null) return refuse("bad_encoding");
  const authEntries: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of auth) {
    const parsed = decodeXdr(entry, (b) => xdr.SorobanAuthorizationEntry.fromXDR(b));
    if (parsed === null) return refuse("bad_encoding");
    authEntries.push(parsed);
  }
  const root = checkRootCall(hostFunction, cfg);
  if (!root.ok) return root;
  // Channels makes its own channel account the source on this path, so a
  // source-account credential would ask the relayer to authorise the call.
  const tree = checkAuthEntries(authEntries, cfg, false);
  if (tree !== null) return tree;
  const authorisers = authorisersOf(authEntries, null);
  return { ok: true, kind: "func", func, auth: [...auth], hostFunction, authEntries, rootContract: root.contract, authorisers };
}

function validateEnvelope(base64: string, cfg: Config): XdrSponsorRequest | Refusal {
  const envelope = decodeXdr(base64, (b) => xdr.TransactionEnvelope.fromXDR(b));
  if (envelope === null) return refuse("bad_encoding");
  if (envelope.switch().name !== "envelopeTypeTx") return refuse("envelope_not_accepted");
  const tx = envelope.v1().tx();
  const operations = tx.operations();
  if (operations.length !== 1) return refuse("not_one_operation");
  const body = operations[0]!.body();
  if (body.switch().name !== "invokeHostFunction") return refuse("not_invoke_host_function");
  const op = body.invokeHostFunctionOp();
  const root = checkRootCall(op.hostFunction(), cfg);
  if (!root.ok) return root;
  const authEntries = op.auth();
  if (authEntries.length > MAX_AUTH_ENTRIES) return refuse("too_many_auth_entries");
  const tree = checkAuthEntries(authEntries, cfg, true);
  if (tree !== null) return tree;
  const source = sourceOf(envelope);
  if (!signedBySourceForNetwork(envelope, source, cfg.NETWORK_PASSPHRASE)) return refuse("not_signed_for_testnet");
  const ext = tx.ext();
  if (ext.switch() !== 1) return refuse("missing_soroban_data");
  const declaredFee = BigInt(tx.fee());
  const declaredResourceFee = ext.sorobanData().resourceFee().toBigInt();
  if (declaredFee > cfg.FEE_CAP_STROOPS || declaredResourceFee > cfg.FEE_CAP_STROOPS) return refuse("fee_over_cap");
  const authorisers = authorisersOf(authEntries, source);
  return { ok: true, kind: "xdr", xdr: base64, source, declaredFee, declaredResourceFee, authEntries, rootContract: root.contract, authorisers };
}

/**
 * Who authorises the request, each once. A source-account entry stands for
 * `source`, which an envelope always has. Every address here comes out of
 * the SDK's one strkey encoder (inspectAuthEntry and sourceOf), the same
 * spelling the server's address parser accepts, so one account always counts
 * under one key. checkEntrySignatures has already admitted only G and C
 * addresses.
 */
function authorisersOf(entries: readonly xdr.SorobanAuthorizationEntry[], source: string | null): string[] {
  const out = new Set<string>(source === null ? [] : [source]);
  for (const entry of entries) {
    const address = inspectAuthEntry(entry).address;
    if (address !== null) out.add(address);
  }
  return [...out];
}

/** The ed25519 account behind the transaction source, muxed or not. */
function sourceOf(envelope: xdr.TransactionEnvelope): string {
  const source = envelope.v1().tx().sourceAccount();
  const raw = source.switch().name === "keyTypeEd25519" ? source.ed25519() : source.med25519().ed25519();
  return StrKey.encodeEd25519PublicKey(raw);
}

function checkRootCall(fn: xdr.HostFunction, cfg: Config): { ok: true; contract: string } | Refusal {
  switch (fn.switch().name) {
    case "hostFunctionTypeInvokeContract": {
      const id = contractIdOfScAddress(fn.invokeContract().contractAddress());
      if (id === null || (id !== cfg.PAYROLL_CONTRACT_ID && id !== cfg.TOKEN_CONTRACT_ID)) {
        return refuse("root_contract_not_allowed");
      }
      return { ok: true, contract: id };
    }
    case "hostFunctionTypeUploadContractWasm":
      return refuse("wasm_upload");
    case "hostFunctionTypeCreateContract":
    case "hostFunctionTypeCreateContractV2":
      return refuse("contract_creation");
    default:
      return refuse("bad_shape");
  }
}

function checkAuthEntries(entries: xdr.SorobanAuthorizationEntry[], cfg: Config, allowSourceAccount: boolean): Refusal | null {
  const reachable = new Set([cfg.PAYROLL_CONTRACT_ID, cfg.TOKEN_CONTRACT_ID, cfg.AUDITOR_CONTRACT_ID, cfg.USDC_SAC_ID]);
  let budget = MAX_AUTH_NODES;
  for (const entry of entries) {
    const credentials = entry.credentials();
    switch (credentials.switch().name) {
      case "sorobanCredentialsSourceAccount":
        if (!allowSourceAccount) return refuse("source_account_auth");
        break;
      case "sorobanCredentialsAddress":
      case "sorobanCredentialsAddressV2":
        break;
      case "sorobanCredentialsAddressWithDelegates": {
        const delegates = [...credentials.addressWithDelegates().delegates()];
        while (delegates.length > 0) {
          if (--budget < 0) return refuse("auth_tree_too_large");
          delegates.push(...delegates.pop()!.nestedDelegates());
        }
        break;
      }
      default:
        return refuse("bad_shape");
    }

    const pending = [entry.rootInvocation()];
    while (pending.length > 0) {
      if (--budget < 0) return refuse("auth_tree_too_large");
      const node = pending.pop()!;
      const fn = node.function();
      switch (fn.switch().name) {
        case "sorobanAuthorizedFunctionTypeContractFn": {
          const id = contractIdOfScAddress(fn.contractFn().contractAddress());
          if (id === null || !reachable.has(id)) return refuse("nested_contract_not_allowed");
          break;
        }
        case "sorobanAuthorizedFunctionTypeCreateContractHostFn":
        case "sorobanAuthorizedFunctionTypeCreateContractV2HostFn":
          return refuse("contract_creation");
        default:
          return refuse("bad_shape");
      }
      pending.push(...node.subInvocations());
    }
  }
  for (const entry of entries) {
    const signature = checkEntrySignatures(entry, cfg.NETWORK_PASSPHRASE);
    if (signature !== null) return signature;
  }
  return null;
}

/**
 * Every classic-account (G) signer node must carry ed25519 signatures that
 * are made by that account's own key and verify over this entry's payload
 * for the given network. A payload signed for another network hashes a
 * different network id, and the payload does not name the address, so
 * without the key check any key could sign for any account.
 *
 * Covers: the entry was signed for testnet by the key whose public half is
 * the account id. Does not cover whether that key still has weight on the
 * account (it may be removed or outweighed by other signers); only the
 * enforce-mode simulation proves that. Accounts that sign with other keys
 * than their own are refused here. Contract-account (C) nodes use
 * wallet-defined signatures, so their network binding is checked by
 * __check_auth during the enforce-mode simulation, not here.
 */
function checkEntrySignatures(entry: xdr.SorobanAuthorizationEntry, passphrase: string): Refusal | null {
  const info = inspectAuthEntry(entry);
  if (info.credentialType === "sourceAccount") return null;
  if (info.address === null || info.signatureExpirationLedger === null) return refuse("bad_shape");
  const payload = hash(buildAuthorizationEntryPreimage(entry, info.signatureExpirationLedger, passphrase).toXDR());
  for (const signer of info.signers) {
    if (StrKey.isValidContract(signer.address)) continue;
    if (!StrKey.isValidEd25519PublicKey(signer.address)) return refuse("bad_shape");
    if (!signer.signed) return refuse("unsigned_auth");
    if (signer.signatures === null || signer.signatures.length === 0) return refuse("not_signed_for_testnet");
    for (const { publicKey, signature } of signer.signatures) {
      // Both strings come out of the SDK's one ed25519 strkey encoder.
      if (publicKey !== signer.address) return refuse("signer_key_mismatch");
      if (!Keypair.fromPublicKey(publicKey).verify(payload, signature)) return refuse("not_signed_for_testnet");
    }
  }
  return null;
}

/** At least one envelope signature from the source account's own key verifies for this network. */
function signedBySourceForNetwork(envelope: xdr.TransactionEnvelope, source: string, passphrase: string): boolean {
  const signer = Keypair.fromPublicKey(source);
  const txHash = new Transaction(envelope, passphrase).hash();
  const hint = signer.signatureHint();
  return envelope
    .v1()
    .signatures()
    .some((s) => s.hint().equals(hint) && signer.verify(txHash, s.signature()));
}

/**
 * The dedupe key: sha256 over the exact bytes that would be forwarded, each
 * part length-prefixed so two different bodies can never join into the same
 * byte string. The bytes are canonical because validation already required
 * canonical base64 and XDR that re-encodes to itself.
 */
export function requestDigest(request: SponsorRequest): string {
  const digest = createHash("sha256");
  const part = (bytes: Uint8Array) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  };
  part(Buffer.from(request.kind));
  if (request.kind === "func") {
    part(request.hostFunction.toXDR());
    for (const entry of request.authEntries) part(entry.toXDR());
  } else {
    part(Buffer.from(request.xdr, "base64"));
  }
  return digest.digest("hex");
}

/**
 * The last ledger in which every auth entry of the request can still be
 * used: the earliest signature expiration among them, because one expired
 * entry fails the whole call. Null when no entry carries one, which happens
 * only for an envelope authorised by its source account alone. That
 * envelope is bound to its sequence number instead, so only one copy of it
 * can ever enter a ledger.
 */
export function authExpiryLedger(request: SponsorRequest): number | null {
  let earliest: number | null = null;
  for (const entry of request.authEntries) {
    const ledger = inspectAuthEntry(entry).signatureExpirationLedger;
    if (ledger !== null && (earliest === null || ledger < earliest)) earliest = ledger;
  }
  return earliest;
}

/** A signed auth entry as the network uses it up: once per (address, nonce). */
export interface SignedEntryKey {
  address: string;
  /** The int64 nonce in decimal. */
  nonce: string;
  /** This entry's own signature expiration ledger. */
  expiryLedger: number;
}

/**
 * The key of every address-credential entry in the request, each once.
 * Body bytes do not identify an entry: the same signed entry can be wrapped
 * in a func body or in envelopes from any source, so the sponsor dedupes on
 * this key as well. Source-account entries carry no nonce; the envelope's
 * sequence number stands in for one.
 */
export function signedEntryKeys(request: SponsorRequest): SignedEntryKey[] {
  const keys = new Map<string, SignedEntryKey>();
  for (const entry of request.authEntries) {
    const info = inspectAuthEntry(entry);
    if (info.address === null || info.nonce === null || info.signatureExpirationLedger === null) continue;
    const nonce = info.nonce.toString();
    const id = info.address + " " + nonce;
    if (!keys.has(id)) keys.set(id, { address: info.address, nonce, expiryLedger: info.signatureExpirationLedger });
  }
  return [...keys.values()];
}

export type SimulationVerdict =
  | { ok: true; chargeStroops: bigint; minResourceFee: bigint; latestLedger: number }
  | Refusal;

export type SimulateFn = (
  cfg: Config,
  request: SponsorRequest,
  rpc: Pick<RpcClient, "simulateTransaction" | "getLedgerEntries">,
) => Promise<SimulationVerdict>;

/**
 * Reads the chain and simulates the request twice, applying the checks that
 * need the chain.
 *
 * First, one getLedgerEntries call reads the instances of our payroll,
 * token, auditor and verifier and of every contract-account signer. Each
 * signer must run PASSKEY_WALLET_WASM_HASH, or the request is refused
 * before any simulation.
 * Enforce mode, with the supplied auth entries: must succeed with no restore
 * needed, its footprint must hold at least one read-write entry, and that
 * footprint (and an envelope's declared one) must pass the footprint rule.
 * An envelope must also declare every key that footprint holds, and at
 * least the simulated limits and minimum resource fee.
 * Record mode, with the auth entries removed: the entries it reports the call
 * needs must be exactly the supplied ones, matched on who authorises and on
 * the exact invocation tree.
 *
 * Then every auth entry must expire after the current ledger and within
 * 1,000 ledgers of it, and the fee we expect to pay must stay under the cap.
 * For `func` requests the transaction is built with an all-zero source
 * account, which simulation accepts and which nobody can sign for.
 * Returns the fee to reserve from the daily budget.
 */
export const simulate: SimulateFn = async (cfg, request, rpc) => {
  const signers = signersOf(request);
  let code;
  try {
    code = await contractCodeOf(rpc, [...ourCodeOwners(cfg), ...signers.contracts]);
  } catch {
    return refuse("rpc_unavailable");
  }
  if (signers.contracts.some((id) => code.get(id) !== cfg.PASSKEY_WALLET_WASM_HASH)) return refuse("unknown_wallet_code");
  const scope = footprintScope(cfg, code, signers);

  let enforced;
  try {
    enforced = await rpc.simulateTransaction(enforceEnvelope(request, cfg), "enforce");
  } catch {
    return refuse("rpc_unavailable");
  }
  if (enforced.error !== undefined || enforced.minResourceFee === undefined || !enforced.results || enforced.results.length === 0) {
    return refuse("simulation_failed");
  }
  if (enforced.restorePreamble !== undefined && enforced.restorePreamble !== null) return refuse("simulation_needs_restore");
  const resources = resourcesOf(enforced.transactionData);
  if (resources === null) return refuse("simulation_failed");
  const footprint = resources.footprint();
  if (footprint.readWrite().length === 0) return refuse("read_only_call");
  if (!inScope(footprint, scope)) return refuse("foreign_contract_in_footprint");
  if (request.kind === "xdr") {
    // The network holds an envelope to the footprint it declares, so that is
    // the bound on what it can touch if the chain changes after our simulation.
    const declared = declaredResourcesOf(request);
    if (!inScope(declared.footprint(), scope)) return refuse("foreign_contract_in_footprint");
    if (!declaresAll(declared.footprint(), footprint)) return refuse("footprint_not_declared");
    if (!declaresLimits(declared, resources) || request.declaredResourceFee < BigInt(enforced.minResourceFee)) {
      return refuse("resources_not_declared");
    }
  }

  let recorded;
  try {
    recorded = await rpc.simulateTransaction(recordEnvelope(request, cfg), "record");
  } catch {
    return refuse("rpc_unavailable");
  }
  if (recorded.error !== undefined || !recorded.results || recorded.results.length !== 1) return refuse("simulation_failed");
  const required = decodeAll(recorded.results[0]!.auth ?? []);
  if (required === null) return refuse("simulation_failed");
  const source = request.kind === "xdr" ? request.source : SIMULATION_SOURCE;
  if (!sameAuthorisations(required, request.authEntries, source)) return refuse("unused_auth");

  for (const entry of request.authEntries) {
    const info = inspectAuthEntry(entry);
    if (info.signatureExpirationLedger === null) continue;
    if (info.signatureExpirationLedger <= enforced.latestLedger) return refuse("auth_expired");
    if (info.signatureExpirationLedger > enforced.latestLedger + MAX_AUTH_LIFETIME_LEDGERS) return refuse("auth_expiry_too_far");
  }

  const minResourceFee = BigInt(enforced.minResourceFee);
  const expected = minResourceFee + INCLUSION_FEE_ALLOWANCE_STROOPS;
  const charge = request.kind === "xdr" && request.declaredFee > expected ? request.declaredFee : expected;
  if (charge > cfg.FEE_CAP_STROOPS) return refuse("fee_over_cap");
  return { ok: true, chargeStroops: charge, minResourceFee, latestLedger: enforced.latestLedger };
};

function resourcesOf(transactionData: string | undefined): xdr.SorobanResources | null {
  if (transactionData === undefined) return null;
  try {
    return xdr.SorobanTransactionData.fromXDR(transactionData, "base64").resources();
  } catch {
    return null;
  }
}

/** Validation already required the envelope to carry Soroban data, so this cannot miss. */
function declaredResourcesOf(request: XdrSponsorRequest): xdr.SorobanResources {
  return xdr.TransactionEnvelope.fromXDR(request.xdr, "base64").v1().tx().ext().sorobanData().resources();
}

/**
 * True when the declared limits are at least what the simulated call used:
 * instructions, bytes read from disk and bytes written. The network stops a
 * call at its declared limits and still charges the fee, so a lower limit
 * pays for a certain failure. The caller checks the declared resource fee
 * against the simulated minimum for the same reason. Does not cover the
 * chain changing after our simulation in a way that raises what the call
 * needs.
 */
function declaresLimits(declared: xdr.SorobanResources, needed: xdr.SorobanResources): boolean {
  return (
    declared.instructions() >= needed.instructions() &&
    declared.diskReadBytes() >= needed.diskReadBytes() &&
    declared.writeBytes() >= needed.writeBytes()
  );
}

/**
 * True when the declared footprint covers everything the simulated call
 * touches: every key it reads is declared (read-only or read-write) and
 * every key it writes is declared read-write. An envelope that leaves a key
 * out still gets into a ledger and fails there, with our fee charged.
 * Keys are compared as XDR bytes, one encoder on both sides, so no two
 * spellings of one key can be judged differently. The declared limits are
 * checked by declaresLimits.
 */
function declaresAll(declared: xdr.LedgerFootprint, needed: xdr.LedgerFootprint): boolean {
  const bytesOf = (key: xdr.LedgerKey) => key.toXDR("base64");
  const writable = new Set(declared.readWrite().map(bytesOf));
  const readable = new Set([...declared.readOnly().map(bytesOf), ...writable]);
  return needed.readWrite().every((key) => writable.has(bytesOf(key))) && needed.readOnly().every((key) => readable.has(bytesOf(key)));
}

interface Signers {
  /** Contract accounts whose __check_auth the host runs: each entry's own address and every delegate under it. */
  contracts: string[];
  /** Classic accounts that sign an address credential, so the host stores their nonce. */
  accounts: string[];
}

function signersOf(request: SponsorRequest): Signers {
  const contracts = new Set<string>();
  const accounts = new Set<string>();
  for (const entry of request.authEntries) {
    const info = inspectAuthEntry(entry);
    for (const signer of info.signers) {
      const id = canonicalContractId(signer.address);
      if (id !== null) contracts.add(id);
    }
    if (info.address !== null && StrKey.isValidEd25519PublicKey(info.address)) accounts.add(info.address);
  }
  return { contracts: [...contracts], accounts: [...accounts] };
}

/** USDC is left out: it is the built-in asset contract, which has no wasm to read. */
const ourCodeOwners = (cfg: Config) => [cfg.PAYROLL_CONTRACT_ID, cfg.TOKEN_CONTRACT_ID, cfg.AUDITOR_CONTRACT_ID, cfg.VERIFIER_CONTRACT_ID];

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * The wasm hash (lower-case hex) each contract's instance runs, read from
 * chain in one getLedgerEntries call. A contract with no instance, or one
 * whose executable is not plain wasm (the built-in asset contract, a
 * reference to another contract's code), maps to null.
 *
 * Throws RpcError when the reply holds an entry that is not the instance of
 * a contract we asked for, or two entries for one contract: a reply we
 * cannot read whole is not trusted in part.
 */
export async function contractCodeOf(
  rpc: Pick<RpcClient, "getLedgerEntries">,
  contractIds: readonly string[],
): Promise<Map<string, string | null>> {
  const asked = new Set(contractIds);
  const reply = await rpc.getLedgerEntries([...asked].map((id) => instanceKey(id).toXDR("base64")));
  const code = new Map<string, string | null>();
  for (const entry of reply.entries) {
    const found = instanceCodeOf(entry.xdr);
    if (found === null || !asked.has(found.contract) || code.has(found.contract)) {
      throw new RpcError("bad_reply", "getLedgerEntries sent an entry we did not ask for");
    }
    code.set(found.contract, found.wasm);
  }
  for (const id of asked) if (!code.has(id)) code.set(id, null);
  return code;
}

function instanceCodeOf(base64: string): { contract: string; wasm: string | null } | null {
  const bytes = decodeCanonicalBase64(base64);
  if (bytes === null) return null;
  let data: xdr.LedgerEntryData;
  try {
    data = xdr.LedgerEntryData.fromXDR(bytes);
  } catch {
    return null;
  }
  if (data.switch().name !== "contractData") return null;
  const entry = data.contractData();
  const contract = contractIdOfScAddress(entry.contract());
  if (
    contract === null ||
    entry.key().switch().name !== "scvLedgerKeyContractInstance" ||
    entry.durability().name !== "persistent" ||
    entry.val().switch().name !== "scvContractInstance"
  ) {
    return null;
  }
  const executable = entry.val().instance().executable();
  return { contract, wasm: executable.switch().name === "contractExecutableWasm" ? executable.wasmHash().toString("hex") : null };
}

interface FootprintScope {
  contracts: Set<string>;
  code: Set<string>;
  nonceAccounts: Set<string>;
}

/**
 * Who may own what the call touches: our contracts, USDC, the verifier and
 * the signing wallets own contract data; the wasm our contracts run, and the
 * pinned wallet wasm only when a wallet signs, are the contract code.
 */
function footprintScope(cfg: Config, code: Map<string, string | null>, signers: Signers): FootprintScope {
  const ourCode = ourCodeOwners(cfg)
    .map((id) => code.get(id) ?? null)
    .filter((hex): hex is string => hex !== null);
  return {
    contracts: new Set([...ourCodeOwners(cfg), cfg.USDC_SAC_ID, ...signers.contracts]),
    code: new Set(signers.contracts.length > 0 ? [...ourCode, cfg.PASSKEY_WALLET_WASM_HASH] : ourCode),
    nonceAccounts: new Set(signers.accounts),
  };
}

/**
 * The footprint rule. Running any contract reads its instance (contract data
 * it owns) and its wasm (contract code), so no contract outside the scope
 * can run, whoever calls it: our code, a wallet's __check_auth or anything
 * nested under them.
 *
 * Classic account and trustline entries pass: they hold the balances USDC
 * moves and run no code. Contract data owned by a classic account passes
 * only as that account's own nonce, which the host stores there when the
 * account signs an address credential in this request. Any other entry type
 * is refused.
 */
function inScope(footprint: xdr.LedgerFootprint, scope: FootprintScope): boolean {
  for (const key of [...footprint.readOnly(), ...footprint.readWrite()]) {
    switch (key.switch().name) {
      case "account":
      case "trustline":
        break;
      case "contractCode":
        if (!scope.code.has(key.contractCode().hash().toString("hex"))) return false;
        break;
      case "contractData": {
        const data = key.contractData();
        const owner = data.contract();
        const contract = contractIdOfScAddress(owner);
        if (contract !== null) {
          if (!scope.contracts.has(contract)) return false;
          break;
        }
        const isOwnNonce =
          owner.switch().name === "scAddressTypeAccount" &&
          data.key().switch().name === "scvLedgerKeyNonce" &&
          data.durability().name === "temporary" &&
          scope.nonceAccounts.has(Address.fromScAddress(owner).toString());
        if (!isOwnNonce) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

function decodeAll(entries: readonly string[]): xdr.SorobanAuthorizationEntry[] | null {
  try {
    return entries.map((e) => xdr.SorobanAuthorizationEntry.fromXDR(e, "base64"));
  } catch {
    return null;
  }
}

/**
 * Equal as multisets of (authorising address, invocation tree bytes). Nonce,
 * expiry, signature and the credential version are left out: record mode
 * leaves them blank, and the wallet fills them in when it signs. A
 * source-account entry stands for the transaction source, so it matches an
 * address entry for that same account.
 */
function sameAuthorisations(
  required: readonly xdr.SorobanAuthorizationEntry[],
  supplied: readonly xdr.SorobanAuthorizationEntry[],
  source: string,
): boolean {
  if (required.length !== supplied.length) return false;
  const key = (entry: xdr.SorobanAuthorizationEntry) =>
    (inspectAuthEntry(entry).address ?? source) + " " + entry.rootInvocation().toXDR("base64");
  const a = required.map(key).sort();
  const b = supplied.map(key).sort();
  return a.every((k, i) => k === b[i]);
}

function enforceEnvelope(request: SponsorRequest, cfg: Config): string {
  return request.kind === "xdr" ? request.xdr : simulationEnvelope(request.hostFunction, request.authEntries, cfg);
}

/** The same call with no auth entries and no signatures, as record mode requires. */
function recordEnvelope(request: SponsorRequest, cfg: Config): string {
  if (request.kind === "func") return simulationEnvelope(request.hostFunction, [], cfg);
  const envelope = xdr.TransactionEnvelope.fromXDR(request.xdr, "base64");
  envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth([]);
  envelope.v1().signatures([]);
  return envelope.toXDR("base64");
}

function simulationEnvelope(func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[], cfg: Config): string {
  return new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: cfg.NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(0)
    .build()
    .toXDR();
}
