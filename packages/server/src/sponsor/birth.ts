import { FeeBumpTransaction, StrKey, TransactionBuilder, hash as sha256, xdr } from "@stellar/stellar-sdk";
import { countSponsorRequest, creationRelaysOf, recordWalletBirth, walletBirthOf, type Db } from "../archive/db.ts";
import type { Config } from "../config.ts";
import { errorResponse, json, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { RpcError, type RpcTransactionReader } from "../rpc.ts";
import { canonicalContractId } from "../stellar.ts";
import { clientBucket, ipTag } from "./client-ip.ts";

export interface WalletBirthLookupContext {
  cfg: Config;
  /** A connection that may write (DATABASE_URL_INGEST): the per-IP counter and the births live here. */
  db: Db;
  log: Logger;
  now?: () => Date;
}

export interface WalletBirthRecordContext extends WalletBirthLookupContext {
  rpc: Pick<RpcTransactionReader, "getTransaction">;
}

// The status route takes at most 2,048 characters of input (its URL); these routes take the same
// as a body. A wallet and a hash in JSON are about 140 bytes.
const MAX_BIRTH_BODY_BYTES = 2_048;
const TX_HASH = /^[0-9a-f]{64}$/;

const hourStartOf = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

type Refuse = (status: number, code: string, tag?: string, headers?: Record<string, string>) => Response;

function refuser(log: Logger, event: string): Refuse {
  return (status, code, tag, headers = {}) => {
    log.info(event, tag === undefined ? { code } : { code, ipTag: tag });
    return errorResponse(status, code, headers);
  };
}

/** POST only, from a caller the trusted client-IP header places: its rate-limit bucket and salted log tag. */
function place(req: Request, cfg: Config, refuse: Refuse): { ip: string; tag: string } | Response {
  if (req.method !== "POST") return refuse(405, "method_not_allowed", undefined, { allow: "POST" });
  const ip = clientBucket(req.headers.get(cfg.TRUSTED_IP_HEADER));
  if (ip === null) return refuse(400, "no_client_ip");
  return { ip, tag: ipTag(ip, cfg.LOG_SALT) };
}

/**
 * The status route's own hourly count on the same bucket ("status " + IP), before the body is
 * read, so birth requests and status polls share one allowance and nothing below runs unmetered
 * (C50). Then a JSON object body of at most 2 KiB with exactly `keys`.
 */
async function admit(req: Request, ctx: WalletBirthLookupContext, caller: { ip: string; tag: string }, keys: readonly string[], refuse: Refuse): Promise<Record<string, unknown> | Response> {
  const { cfg } = ctx;
  const now = ctx.now?.() ?? new Date();
  if (!(await countSponsorRequest(ctx.db, "status " + caller.ip, hourStartOf(now), cfg.PER_IP_LIMIT_PER_HOUR))) return refuse(429, "rate_limited", caller.tag);
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) return refuse(415, "unsupported_media_type", caller.tag);
  const body = await readJsonBody(req, MAX_BIRTH_BODY_BYTES);
  if (!body.ok) return refuse(body.status, body.code, caller.tag);
  if (!isRecord(body.value) || !hasExactKeys(body.value, keys)) return refuse(400, "bad_request", caller.tag);
  return body.value;
}

/**
 * POST /api/sponsor/birth/lookup with `{ address }`: replies `{ hash, relayed, more }`: the
 * creation transaction stored for that passkey wallet, or null; the creations of it the sponsor
 * handed to Channels, newest first, at most 20, each `{ transactionId, hash }` with either still
 * null when not yet known; and `more`, true when older creations were left out. An empty list with
 * `more` false means Kalypso never relayed a creation of this address. With `more` true the list
 * is not every relay, so the browser concludes nothing from all of it having failed. Every entry is
 * a pointer, never proof: the browser reads each from chain and judges it itself. The wallet
 * travels in the body, never the URL, so no request log pairs a caller's IP with it. Refusals are
 * `{ error: code }` and are logged with the salted IP tag, never the IP or the wallet; a found or
 * missing answer is logged with neither.
 */
export async function walletBirthLookupHandler(req: Request, ctx: WalletBirthLookupContext): Promise<Response> {
  const refuse = refuser(ctx.log, "wallet_birth_lookup_refused");
  const caller = place(req, ctx.cfg, refuse);
  if (caller instanceof Response) return caller;
  try {
    const body = await admit(req, ctx, caller, ["address"], refuse);
    if (body instanceof Response) return body;
    const address = canonicalContractId(body.address);
    if (address === null) return refuse(400, "bad_address", caller.tag);
    const hash = await walletBirthOf(ctx.db, address);
    const { relayed, more } = await creationRelaysOf(ctx.db, address);
    ctx.log.info("wallet_birth_lookup", { found: hash !== null, relayed: relayed.length, more });
    return json({ hash, relayed, more });
  } catch (err) {
    ctx.log.warn("wallet_birth_internal_error", { ipTag: caller.tag, error: err instanceof Error ? err.name : "unknown" });
    return errorResponse(500, "internal_error");
  }
}

/** The address a CreateContractV2 preimage makes on this network, by the network's own rule, in the server's one spelling. */
function createdAddress(preimage: xdr.ContractIdPreimage, passphrase: string): string | null {
  const id = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({ networkId: sha256(Buffer.from(passphrase)), contractIdPreimage: preimage }),
  );
  return canonicalContractId(StrKey.encodeContract(sha256(id.toXDR())));
}

/**
 * True when the envelope hashes to `hash` on this network (outer or inner hash: the relayer names
 * a fee bump by its outer one) and its one operation is a CreateContractV2 that creates `address`.
 */
function createsAddress(envelopeXdr: string, hash: string, address: string, passphrase: string): boolean {
  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
    const inner = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    if (parsed.hash().toString("hex") !== hash && inner.hash().toString("hex") !== hash) return false;
    if (inner.operations.length !== 1) return false;
    const op = inner.operations[0];
    if (op?.type !== "invokeHostFunction" || op.func.switch().name !== "hostFunctionTypeCreateContractV2") return false;
    const preimage = op.func.createContractV2().contractIdPreimage();
    return preimage.switch().name === "contractIdPreimageFromAddress" && createdAddress(preimage, passphrase) === address;
  } catch {
    return false;
  }
}

/**
 * POST /api/sponsor/birth with `{ address, hash }`: stores the transaction that created a passkey
 * wallet, so the worker's other devices can find it, and replies `{ recorded: true }`.
 *
 * The transaction is read from RPC by its hash: NOT_FOUND is 404 birth_unavailable, an RPC failure
 * 503 rpc_unavailable, and anything but a successful transaction whose envelope hashes to `hash`
 * and whose one operation is a CreateContractV2 creating `address` is 400 not_a_birth. Only then is
 * it stored, and a second record for the address changes nothing.
 *
 * This route does not check the wasm or the signer the creation used, on purpose: any successful
 * creation of an address is its one birth, so nothing else can ever be stored for it, and storing a
 * squatter's birth only lets the browser see the squat. The browser judges whether a birth is its
 * own (verifyWalletBirth in packages/web/lib/worker/passkey.ts).
 *
 * Counted and logged like the lookup; a recorded birth is logged with its hash, no IP-derived field.
 */
export async function walletBirthRecordHandler(req: Request, ctx: WalletBirthRecordContext): Promise<Response> {
  const refuse = refuser(ctx.log, "wallet_birth_record_refused");
  const caller = place(req, ctx.cfg, refuse);
  if (caller instanceof Response) return caller;
  try {
    const body = await admit(req, ctx, caller, ["address", "hash"], refuse);
    if (body instanceof Response) return body;
    const address = canonicalContractId(body.address);
    if (address === null) return refuse(400, "bad_address", caller.tag);
    const hash = body.hash;
    if (typeof hash !== "string" || !TX_HASH.test(hash)) return refuse(400, "bad_hash", caller.tag);

    let found;
    try {
      found = await ctx.rpc.getTransaction(hash);
    } catch (err) {
      ctx.log.warn("wallet_birth_rpc_failed", { ipTag: caller.tag, error: err instanceof RpcError ? String(err.code) : err instanceof Error ? err.name : "unknown" });
      return errorResponse(503, "rpc_unavailable");
    }
    if (found.status === "NOT_FOUND") return refuse(404, "birth_unavailable", caller.tag);
    if (found.status !== "SUCCESS" || !createsAddress(found.envelopeXdr, hash, address, ctx.cfg.NETWORK_PASSPHRASE)) return refuse(400, "not_a_birth", caller.tag);

    const inserted = await recordWalletBirth(ctx.db, { address, hash, ledger: found.ledger });
    ctx.log.info("wallet_birth_recorded", { hash, ledger: found.ledger, inserted });
    return json({ recorded: true });
  } catch (err) {
    ctx.log.warn("wallet_birth_internal_error", { ipTag: caller.tag, error: err instanceof Error ? err.name : "unknown" });
    return errorResponse(500, "internal_error");
  }
}
