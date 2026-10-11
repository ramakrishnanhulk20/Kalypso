import { Account, Asset, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { countAuthoriserRelays, countSponsorRequest, releaseAuthoriserRelays, type Db } from "../archive/db.ts";
import type { Config } from "../config.ts";
import { errorResponse, json, readJsonBody } from "../http.ts";
import type { Logger } from "../log.ts";
import { RpcError, type RpcClient, type RpcTransactionReader } from "../rpc.ts";
import { clientBucket, creationBucket, ipTag } from "../sponsor/client-ip.ts";
import { canonicalAccountId } from "../stellar.ts";
import { accountKey, ledgerView, trustlineKey, type LedgerView } from "./ledger.ts";
import { FAUCET_MAX_MS } from "./limits.ts";
import { FAUCET_MAX_FEE_STROOPS, FAUCET_TX_LIFETIME_SECONDS, faucetUsdcAsset, type FaucetSigner } from "./signer.ts";
import { confirmPayout, failureCodeOf, sendPayout } from "./submit.ts";

export interface FaucetContext {
  cfg: Config;
  /** A connection that may write (DATABASE_URL_INGEST): the counters and the lock live here. */
  db: Db;
  rpc: Pick<RpcClient, "getLedgerEntries"> & Pick<RpcTransactionReader, "getTransaction">;
  log: Logger;
  now?: () => Date;
  /** Carries the payout to RPC's sendTransaction; tests put a fake chain behind it. */
  fetchImpl?: typeof fetch;
  /** Tests shorten the claim's bound; production keeps FAUCET_MAX_MS and POLL_INTERVAL_MS. */
  maxMs?: number;
  pollIntervalMs?: number;
}

export type FaucetAsset = "xlm" | "usdc";

interface Claim {
  address: string;
  asset: FaucetAsset;
}

const MAX_FAUCET_BODY_BYTES = 1_024;
/** XLM the faucet keeps past one claim for its own fees: 100 payouts at the highest bid. */
export const FEE_RESERVE_STROOPS = 1_000_000n;
export const POLL_INTERVAL_MS = 1_000;
/** The service-wide count's key in the daily counter; a key with a space can never be an address. */
const ALL_CLAIMS_KEY = "faucet claims";

// The key is "kfaucet!" in ASCII. Only this route takes it.
const TRY_FAUCET_LOCK = "select pg_try_advisory_xact_lock(7738980166489437217) as locked";
// A function frozen or killed mid-claim would otherwise hold the lock until its connection
// dropped, and every claim until then would be faucet_busy. 90 s is past the route's 60 s limit,
// and nothing legitimate leaves the transaction idle that long.
const BOUND_LOCK_LIFE = "set local idle_in_transaction_session_timeout = '90s'";

type PayoutResult =
  | { outcome: "paid"; hash: string; kind: "create" | "payment" }
  /** Provably nothing was paid. The claim is given back unless `keep`: the destination caused the failure, or its cause is unknown. */
  | { outcome: "refused"; status: number; code: string; keep: boolean }
  /** It may have landed, so the claim stays counted. */
  | { outcome: "unknown"; hash: string };

/**
 * On-chain failures the faucet's own side caused, and the answer for each. Only these give the
 * claim back. Any other cause, and one that cannot be read, keeps it and answers payout_failed,
 * because a failure the destination caused (no trustline, a full or unauthorised line, an account
 * merged away, often by removing the trustline in the same ledger as the payout) would otherwise
 * let it make the faucet pay fees again and again. A code missing here only keeps a claim that
 * could have gone back.
 */
const FAUCET_SIDE_FAILURES: ReadonlyMap<string, "faucet_empty" | "faucet_busy"> = new Map([
  ["paymentUnderfunded", "faucet_empty"],
  ["paymentSrcNoTrust", "faucet_empty"],
  ["paymentSrcNotAuthorized", "faucet_empty"],
  ["createAccountUnderfunded", "faucet_empty"],
  ["txInsufficientBalance", "faucet_empty"],
  // The account appeared after the destination read, so the faucet chose createAccount on stale
  // state; a retry pays it with a payment instead.
  ["createAccountAlreadyExist", "faucet_busy"],
  ["txBadSeq", "faucet_busy"],
]);

const hourStartOf = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
const refused = (status: number, code: string, keep = false): PayoutResult => ({ outcome: "refused", status, code, keep });
const unitsOf = (stroops: bigint) => (stroops / 10_000_000n).toString() + "." + (stroops % 10_000_000n).toString().padStart(7, "0");
const errorName = (err: unknown) => (err instanceof RpcError ? String(err.code) : err instanceof Error ? err.name : "unknown");

/**
 * One request's log (C36). A line that carries a transaction hash never carries the caller's IP
 * tag, and once one has been written, no later line of the same request carries the tag either, so
 * reading one request's lines together cannot pair the two.
 */
function requestLog(log: Logger): Logger {
  let hashWritten = false;
  const write = (level: "info" | "warn") => (event: string, fields: Record<string, unknown> = {}) => {
    if ("hash" in fields) hashWritten = true;
    log[level](event, hashWritten ? Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "ipTag")) : fields);
  };
  return { info: write("info"), warn: write("warn") };
}

/**
 * POST /api/faucet with `{ address, asset }`: pays a testnet account FAUCET_XLM_STROOPS of XLM
 * (creating the account when it does not exist yet) or FAUCET_USDC_STROOPS of Circle's testnet
 * USDC, from the faucet account, and replies `{ hash, asset, amount }` (amount in stroops, as a
 * string) only once a chain read says the payout succeeded (C55).
 *
 * Order: configured (503 not_configured), POST, a trusted client IP, the per-IP hourly request
 * count before the body is read (rate_limited), a JSON body of at most 1 KiB with exactly
 * `address` and `asset` (bad_request), a canonical G address that is not the faucet's own
 * (bad_address), then the daily claim counts: this address for this asset once (already_claimed),
 * the caller's IP, IPv6 per /48 (network_limit), and the whole service (daily_limit), all 429.
 * Then, before the lock, the destination read (rpc_unavailable) and for USDC its checks (409
 * no_account, 409 no_trustline, 409 trustline_unauthorized for a line not allowed to receive, 409
 * trustline_full for a line with less room than the payout), so a refusal the destination causes
 * never holds the lock. Then,
 * under the faucet lock (faucet_busy while another claim holds it): the faucet read
 * (rpc_unavailable), its balance (faucet_empty), build, sign, send and confirm. Every RPC call
 * shares one deadline, FAUCET_MAX_MS from the claim's start.
 *
 * Every refusal before the payout is sent gives the daily counts back, and so does a payout core
 * refused (faucet_busy, or faucet_empty for txINSUFFICIENT_BALANCE). A payout that failed on chain
 * gives them back only for a cause on the faucet's side (FAUCET_SIDE_FAILURES); any other keeps
 * them and answers 409 payout_failed. A payout whose outcome is unknown keeps them and answers 503
 * `{ error: "payout_unconfirmed", hash }`, because it may still land.
 *
 * Logging (C36): refusals carry their code and the caller's salted IP tag; payout lines carry the
 * hash and no IP-derived field, and once one is written the rest of the request's lines drop the
 * tag too; no line ever carries the address. The faucet key never leaves its
 * signer, which signs nothing but a faucet payout.
 */
export async function faucetHandler(req: Request, context: FaucetContext): Promise<Response> {
  const ctx = { ...context, log: requestLog(context.log) };
  const { cfg, log } = ctx;
  const refuse = (status: number, code: string, tag?: string, headers: Record<string, string> = {}) => {
    log.info("faucet_refused", tag === undefined ? { code } : { code, ipTag: tag });
    return errorResponse(status, code, headers);
  };

  const signer = cfg.FAUCET_SIGNER;
  const usdc = faucetUsdcAsset(cfg.USDC_SAC_ID, cfg.NETWORK_PASSPHRASE);
  if (signer === undefined || usdc === null) return refuse(503, "not_configured");
  if (req.method !== "POST") return refuse(405, "method_not_allowed", undefined, { allow: "POST" });
  const ipHeader = req.headers.get(cfg.TRUSTED_IP_HEADER);
  const ip = clientBucket(ipHeader);
  if (ip === null) return refuse(400, "no_client_ip");
  const tag = ipTag(ip, cfg.LOG_SALT);

  try {
    const now = ctx.now?.() ?? new Date();
    // One deadline for every RPC call of this claim: the reads, the send and every poll, the last included.
    const deadline = AbortSignal.timeout(ctx.maxMs ?? FAUCET_MAX_MS);
    // Counted before the body is read, as on the sponsor routes: a refused body costs its
    // sender a request too, so parsing never runs unmetered.
    if (!(await countSponsorRequest(ctx.db, "faucet " + ip, hourStartOf(now), cfg.PER_IP_LIMIT_PER_HOUR))) {
      return refuse(429, "rate_limited", tag);
    }
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) return refuse(415, "bad_request", tag);
    const body = await readJsonBody(req, MAX_FAUCET_BODY_BYTES);
    if (!body.ok) return refuse(body.status, "bad_request", tag);
    const claim = claimOf(body.value, signer.publicKey);
    if (typeof claim === "string") return refuse(400, claim, tag);

    const day = now.toISOString().slice(0, 10);
    const counted = await countClaim(ctx, claim, ipTag(creationBucket(ipHeader) ?? ip, cfg.LOG_SALT), day);
    if (!Array.isArray(counted)) return refuse(429, counted, tag);

    const progress = { sent: false };
    let result: PayoutResult;
    try {
      const destination = await readDestination(ctx, usdc, claim, deadline);
      result =
        typeof destination !== "boolean"
          ? destination
          : ((await underFaucetLock(ctx.db, () => payOut(ctx, signer, usdc, claim, destination, progress, deadline))) ?? refused(503, "faucet_busy"));
    } catch (err) {
      // Nothing sent can never land, so the claim goes back before the error is reported.
      if (!progress.sent) await releaseAuthoriserRelays(ctx.db, counted, day);
      throw err;
    }

    const amount = claim.asset === "xlm" ? cfg.FAUCET_XLM_STROOPS : cfg.FAUCET_USDC_STROOPS;
    if (result.outcome === "paid") {
      log.info("faucet_paid", { hash: result.hash, asset: claim.asset, stroops: amount, kind: result.kind });
      return json({ hash: result.hash, asset: claim.asset, amount: amount.toString() });
    }
    if (result.outcome === "refused") {
      if (!result.keep) await releaseAuthoriserRelays(ctx.db, counted, day);
      return refuse(result.status, result.code, tag);
    }
    // It may still land, so the claim stays counted and the caller gets the hash to check.
    log.warn("faucet_unconfirmed", { hash: result.hash, asset: claim.asset });
    log.info("faucet_refused", { code: "payout_unconfirmed" });
    return json({ error: "payout_unconfirmed", hash: result.hash }, 503);
  } catch (err) {
    log.warn("faucet_internal_error", { ipTag: tag, error: err instanceof Error ? err.name : "unknown" });
    return errorResponse(500, "internal_error");
  }
}

/**
 * The claim in a parsed body, or the refusal code. The address goes through the server's one
 * account parser, and the G-only test runs on its output, so the value checked is the value paid.
 */
function claimOf(value: unknown, faucet: string): Claim | "bad_request" | "bad_address" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "bad_request";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, "address") || !Object.hasOwn(record, "asset")) return "bad_request";
  const asset = record.asset;
  if (asset !== "xlm" && asset !== "usdc") return "bad_request";
  const address = canonicalAccountId(record.address);
  if (address === null || !StrKey.isValidEd25519PublicKey(address) || address === faucet) return "bad_address";
  return { address, asset };
}

type DailyLimit = "already_claimed" | "network_limit" | "daily_limit";

/**
 * Counts one claim against the address for this asset (once per UTC day: already_claimed), against
 * the caller's IPv4 address or IPv6 /48 by its salted tag, so no raw IP is stored for a day
 * (network_limit), and against the whole service (daily_limit). All three or none. Returns the
 * keys counted, so a provable failure can give them back, or the code of the first limit reached.
 * They share the sponsor's per-address daily counter under keys with spaces, which can never be
 * an address.
 */
async function countClaim(ctx: FaucetContext, claim: Claim, callerTag: string, day: string): Promise<string[] | DailyLimit> {
  const limits: Array<[string, number, DailyLimit]> = [
    ["faucet " + claim.asset + " " + claim.address, 1, "already_claimed"],
    ["faucet caller " + callerTag, ctx.cfg.FAUCET_CLAIMS_PER_IP_PER_DAY, "network_limit"],
    [ALL_CLAIMS_KEY, ctx.cfg.FAUCET_CLAIMS_PER_DAY, "daily_limit"],
  ];
  const counted: string[] = [];
  for (const [key, limit, code] of limits) {
    if (!(await countAuthoriserRelays(ctx.db, [key], day, limit))) {
      await releaseAuthoriserRelays(ctx.db, counted, day);
      return code;
    }
    counted.push(key);
  }
  return counted;
}

/**
 * Runs `work` holding the faucet's Postgres advisory lock, or returns null at once when another
 * claim holds it.
 *
 * Why a lock and not one retry on txBAD_SEQ: two payouts built on one sequence number do not
 * reliably come back as txBAD_SEQ. While the first waits in core's queue the second is refused as
 * a fee too low to replace it, or as TRY_AGAIN_LATER, and a single retry cannot tell either from a
 * real refusal. The lock makes read, build, send and confirm one step per faucet across every
 * server instance, so the sequence number read is always the one the payout uses.
 *
 * It is transaction-scoped, so it works through a pooled connection and goes with the commit, the
 * rollback or the session, never left behind by a path that forgot to release it. `work` must not
 * use the database: this transaction holds a connection for its length, and PGlite (tests and the
 * dev memory database) runs every query through one session.
 */
async function underFaucetLock<T>(db: Db, work: () => Promise<T>): Promise<T | null> {
  const finished: Array<{ value: T }> = [];
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.query<{ locked: boolean }>(TRY_FAUCET_LOCK);
      if (rows[0]?.locked !== true) return;
      await tx.query(BOUND_LOCK_LIFE);
      finished.push({ value: await work() });
    });
  } catch (err) {
    // A commit that fails after the work ran (the session was cut) loses only the lock, which went with the session.
    if (finished.length === 0) throw err;
  }
  return finished[0]?.value ?? null;
}

/**
 * The destination's side, read before the lock is taken: whether its account exists, or the
 * refusal it causes (USDC needs an account and an authorised trustline with room). Nothing here
 * holds the faucet lock, so a caller naming an unready destination never blocks anyone else.
 */
async function readDestination(ctx: FaucetContext, usdc: Asset, claim: Claim, deadline: AbortSignal): Promise<boolean | PayoutResult> {
  const keys = [accountKey(claim.address)];
  if (claim.asset === "usdc") keys.push(trustlineKey(claim.address, usdc));
  let ledger: LedgerView;
  try {
    ledger = ledgerView(await ctx.rpc.getLedgerEntries(keys, deadline));
  } catch (err) {
    ctx.log.warn("faucet_rpc_failed", { step: "destination", error: errorName(err) });
    return refused(503, "rpc_unavailable");
  }
  const exists = ledger.account(claim.address) !== null;
  if (claim.asset === "xlm") return exists;
  if (!exists) return refused(409, "no_account");
  // Three answers, because each has a different fix in the wallet: add USDC, add it again so the
  // issuer authorises it, or raise the line's limit. None is sent, so none counts as a claim.
  const line = ledger.trustline(claim.address, usdc);
  if (line === null) return refused(409, "no_trustline");
  if (!line.authorized) return refused(409, "trustline_unauthorized");
  if (line.room < ctx.cfg.FAUCET_USDC_STROOPS) return refused(409, "trustline_full");
  return true;
}

/** Whether the faucet's own read can cover a payout of `amount` plus its fee reserve. */
function faucetCanPay(ledger: LedgerView, faucet: string, usdc: Asset, claim: Claim, amount: bigint): boolean {
  const own = ledger.account(faucet);
  if (own === null) return false;
  if (claim.asset === "xlm") return own.spendableXlm >= amount + FEE_RESERVE_STROOPS;
  const ownLine = ledger.trustline(faucet, usdc);
  return ownLine !== null && ownLine.spendable >= amount && own.spendableXlm >= FEE_RESERVE_STROOPS;
}

/**
 * Inside the lock: the faucet's read and checks, build, sign, send, confirm. `destinationExists`
 * comes from the read before the lock and picks createAccount or a payment for XLM. Sets
 * progress.sent just before the payout can reach the network.
 */
async function payOut(
  ctx: FaucetContext,
  signer: FaucetSigner,
  usdc: Asset,
  claim: Claim,
  destinationExists: boolean,
  progress: { sent: boolean },
  deadline: AbortSignal,
): Promise<PayoutResult> {
  const { cfg, log } = ctx;
  const amount = claim.asset === "xlm" ? cfg.FAUCET_XLM_STROOPS : cfg.FAUCET_USDC_STROOPS;
  const keys = [accountKey(signer.publicKey)];
  if (claim.asset === "usdc") keys.push(trustlineKey(signer.publicKey, usdc));
  let ledger: LedgerView;
  try {
    ledger = ledgerView(await ctx.rpc.getLedgerEntries(keys, deadline));
  } catch (err) {
    log.warn("faucet_rpc_failed", { step: "faucet", error: errorName(err) });
    return refused(503, "rpc_unavailable");
  }
  if (!faucetCanPay(ledger, signer.publicKey, usdc, claim, amount)) {
    log.warn("faucet_low", { asset: claim.asset });
    return refused(503, "faucet_empty");
  }

  const units = unitsOf(amount);
  const operation =
    claim.asset === "usdc"
      ? Operation.payment({ destination: claim.address, asset: usdc, amount: units })
      : destinationExists
        ? Operation.payment({ destination: claim.address, asset: Asset.native(), amount: units })
        : Operation.createAccount({ destination: claim.address, startingBalance: units });
  const at = ctx.now?.() ?? new Date();
  const tx = new TransactionBuilder(new Account(signer.publicKey, ledger.account(signer.publicKey)!.sequence), {
    fee: FAUCET_MAX_FEE_STROOPS.toString(),
    networkPassphrase: cfg.NETWORK_PASSPHRASE,
    timebounds: { minTime: 0, maxTime: Math.floor(at.getTime() / 1000) + FAUCET_TX_LIFETIME_SECONDS },
  })
    .addOperation(operation)
    .build();
  const { tx: signed, payout } = signer.signPayout(tx, at);
  const hash = signed.hash().toString("hex");

  progress.sent = true;
  const sent = await sendPayout(cfg, signed.toXDR(), hash, deadline, ctx.fetchImpl);
  if (sent.kind === "refused") {
    log.warn("faucet_send_refused", { asset: claim.asset, reason: sent.reason });
    return refused(503, sent.reason === "txInsufficientBalance" ? "faucet_empty" : "faucet_busy");
  }
  if (sent.kind === "unknown") log.warn("faucet_send_unclear", { asset: claim.asset, reason: sent.reason });
  const confirmed = await confirmPayout(ctx.rpc, hash, cfg.NETWORK_PASSPHRASE, { deadline, pollMs: ctx.pollIntervalMs ?? POLL_INTERVAL_MS });
  if (confirmed.kind === "success") return { outcome: "paid", hash, kind: payout.kind };
  if (confirmed.kind === "failed") {
    const cause = await failureCodeOf(cfg, hash, cfg.NETWORK_PASSPHRASE, deadline, ctx.fetchImpl);
    const faucetSide = cause === null ? undefined : FAUCET_SIDE_FAILURES.get(cause);
    log.warn("faucet_payout_failed", { hash, asset: claim.asset, cause: cause ?? "unreadable", claim: faucetSide ? "given back" : "kept" });
    return faucetSide ? refused(503, faucetSide) : refused(409, "payout_failed", true);
  }
  return { outcome: "unknown", hash };
}
