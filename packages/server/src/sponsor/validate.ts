import {
  Account,
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
import type { RpcClient } from "../rpc.ts";
import { contractIdOfScAddress, decodeCanonicalBase64 } from "../stellar.ts";

/*
 * The sponsor rule (threat model C20), decided on the exact bytes that will be
 * forwarded. It is one structural rule, not a list of function names:
 *
 * - the root call goes into our payroll or our token contract;
 * - no contract creation and no wasm upload, at the root or anywhere in any
 *   auth tree;
 * - every call in every auth tree goes into payroll, token, auditor or the
 *   USDC contract;
 * - signatures we can check offline verify for the testnet network id;
 * - the declared and simulated fees stay under FEE_CAP_STROOPS;
 * - auth entries expire within 1,000 ledgers;
 * - simulation in enforce mode succeeds;
 * - the call writes ledger state: a footprint with no read-write entry is a
 *   read-only call, which is nobody's own action and only costs us a fee;
 * - the auth entries supplied are exactly the ones the call needs, as a
 *   record-mode simulation reports them: none missing and none unused,
 *   because an unused signed entry passes enforce mode and proves nothing.
 *
 * What it covers: which contracts can be reached, that someone authorised the
 * state change, and what that can cost us. What it does not cover: valid,
 * signed but pointless writes into our own contracts (the per-IP limit and
 * the daily budget bound those), and whether a passkey wallet's signature is
 * valid, which only its own __check_auth can decide during simulation.
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
  | "not_signed_for_testnet"
  | "fee_over_cap"
  | "auth_expired"
  | "auth_expiry_too_far"
  | "simulation_failed"
  | "simulation_needs_restore"
  | "read_only_call"
  | "unused_auth"
  | "rpc_unavailable";

export interface Refusal {
  ok: false;
  code: SponsorRefusalCode;
}

interface Validated {
  ok: true;
  authEntries: xdr.SorobanAuthorizationEntry[];
  rootContract: string;
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
  return { ok: true, kind: "func", func, auth: [...auth], hostFunction, authEntries, rootContract: root.contract };
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
  return { ok: true, kind: "xdr", xdr: base64, source, declaredFee, declaredResourceFee, authEntries, rootContract: root.contract };
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
 * verify over this entry's payload for the given network. That is what ties
 * the entry to testnet: a payload signed for another network hashes a
 * different network id. Contract-account (C) nodes use wallet-defined
 * signatures, so their network binding is checked by __check_auth during the
 * enforce-mode simulation, not here.
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

export type SimulationVerdict =
  | { ok: true; chargeStroops: bigint; minResourceFee: bigint; latestLedger: number }
  | Refusal;

export type SimulateFn = (
  cfg: Config,
  request: SponsorRequest,
  rpc: Pick<RpcClient, "simulateTransaction">,
) => Promise<SimulationVerdict>;

/**
 * Simulates the request twice against RPC and applies the checks that need
 * the chain.
 *
 * Enforce mode, with the supplied auth entries: must succeed with no restore
 * needed, and its footprint must hold at least one read-write entry.
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
  const footprint = footprintOf(enforced.transactionData);
  if (footprint === null) return refuse("simulation_failed");
  if (footprint.readWrite().length === 0) return refuse("read_only_call");

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

function footprintOf(transactionData: string | undefined): xdr.LedgerFootprint | null {
  if (transactionData === undefined) return null;
  try {
    return xdr.SorobanTransactionData.fromXDR(transactionData, "base64").resources().footprint();
  } catch {
    return null;
  }
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
