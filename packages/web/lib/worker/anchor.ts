import { Account, Asset, Keypair, Memo, Operation, StrKey, Transaction, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { AddressError, AmountError, SubmitRejectedError, formatUsdc, parseAccount, parseUsdc, transactionHash } from "@kalypso/core";
import { WorkerError, toWorkerError } from "./errors";
import { heldBy, type AnchorLogin, type WorkerRuntime, type WorkerSession } from "./session";

/** Where the worker continues the cash-out: the anchor's own page, opened by the screen. */
export interface CashOutStart {
  interactiveUrl: string;
  /** The only origin whose window messages the screen may read: URL(interactiveUrl).origin. */
  anchorOrigin: string;
  /** The anchor's id for this withdrawal, for buildAnchorPayment. */
  transactionId: string;
}

/** The USDC payment the anchor asked for, built from its authenticated record and unsigned, for the worker to approve. */
export interface AnchorPayment {
  /** The anchor's id for the withdrawal this pays, so sendAnchorPayment can read the record again. */
  transactionId: string;
  /** The unsigned transaction envelope, base64, from the cash-out account. */
  xdr: string;
  destination: string;
  memo: { type: "text" | "id" | "hash"; value: string } | null;
  /** In stroops: what the screen shows, and exactly what the envelope pays. */
  amount: bigint;
}

// Every status SEP-24 v3.8.0 defines, each with the sentence the screen shows for it.
const STATUS_SENTENCES = {
  incomplete: "The anchor is waiting for you to finish its page.",
  pending_user_transfer_start: "The anchor is ready. Approve the USDC transfer.",
  pending_user_transfer_complete: "The anchor has your USDC, and the cash is ready to collect.",
  pending_external: "The anchor has sent the cash and is waiting for the bank to confirm it.",
  pending_anchor: "The anchor is processing your cash-out.",
  on_hold: "The anchor is reviewing this cash-out before it continues.",
  pending_stellar: "The anchor is sending a Stellar transaction for this cash-out.",
  pending_trust: "The anchor is waiting for your account to accept the asset it is sending.",
  pending_user: "The anchor needs something more from you. Open its page to see what.",
  completed: "Done. The anchor has paid out.",
  refunded: "The anchor sent your USDC back.",
  expired: "The anchor closed this cash-out because the USDC did not arrive in time.",
  no_market: "The anchor could not find a market to convert this cash-out, so it stopped.",
  too_small: "This amount is below the anchor's minimum, so it stopped.",
  too_large: "This amount is above the anchor's maximum, so it stopped.",
  error: "The anchor stopped this cash-out.",
} as const;

export type CashOutStatus = keyof typeof STATUS_SENTENCES;

const FINAL_STATUSES: ReadonlySet<CashOutStatus> = new Set(["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"]);

/** The anchor's record of a cash-out, as the screen follows it. */
export interface CashOutRecord {
  transactionId: string;
  status: CashOutStatus;
  /** The plain sentence for the screen; for "error", the anchor's own explanation when it gives one. */
  message: string;
  /** In stroops, each null until the anchor sets it. */
  amountIn: bigint | null;
  amountFee: bigint | null;
  amountOut: bigint | null;
  /** The anchor's own page about this cash-out, https only, else null. */
  moreInfoUrl: string | null;
  /** The Stellar transaction the anchor matched to this cash-out, once it has seen one. */
  stellarTransactionId: string | null;
}

const HTTP_TIMEOUT_MS = 15_000;
const MAX_REPLY_CHARS = 256 * 1024;
const MAX_HORIZON_CHARS = 1024 * 1024;
const LOGIN_MARGIN_MS = 60_000;
const ANCHOR_TX_ID = /^[A-Za-z0-9-]{1,128}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
// Classic operations pay at most this, enough to clear testnet surge pricing (the seed's figure).
const CLASSIC_FEE = "10000";
const PAYMENT_TIMEOUT_SECONDS = 300;
const PAYMENT_WAIT_MS = 60_000;
const WATCH_FAST_MS = 5_000;
const WATCH_SLOW_MS = 15_000;
const WATCH_FAST_FOR_MS = 60_000;
// A forgotten tab stops polling after this and hands back the latest record.
const WATCH_LIMIT_MS = 30 * 60_000;
const WATCH_MISSES = 3;
const MAX_ANCHOR_MESSAGE_CHARS = 280;
const PAYMENT_PAGE = 100;
const PAYMENT_PAGES = 5;
// Ledger close times and the anchor's started_at come from different clocks, so the search for an
// earlier payment reaches a little before started_at. Older matches only make it refuse more.
const CLOCK_MARGIN_MS = 5 * 60_000;

/** The anchor transactions each session has sent a payment for (or may have), with its hash. */
const paidBySession = new WeakMap<WorkerSession, Map<string, string>>();

function paidIn(worker: WorkerSession): Map<string, string> {
  let paid = paidBySession.get(worker);
  if (paid === undefined) {
    paid = new Map();
    paidBySession.set(worker, paid);
  }
  return paid;
}

function originOf(value: unknown): string | null {
  try {
    return typeof value === "string" ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

/**
 * True only for a window message from the anchor's page: both origins go through URL().origin, the
 * same parser on both sides (C27). Anything unparseable is refused. What such a message says is
 * still never used for the destination, memo or amount; those come from buildAnchorPayment.
 */
export function isAnchorMessage(messageOrigin: string, anchorOrigin: string): boolean {
  const from = originOf(messageOrigin);
  return from !== null && from !== "null" && from === originOf(anchorOrigin);
}

/** A URL from the anchor's toml, accepted only on the anchor's own https origin. */
function onAnchorOrigin(rt: WorkerRuntime, value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new WorkerError("ANCHOR_CONFIG_INVALID");
  }
  if (url.protocol !== "https:" || url.origin !== originOf(rt.config.anchor.origin) || url.username || url.password || url.search || url.hash) {
    throw new WorkerError("ANCHOR_CONFIG_INVALID");
  }
  return url.href.replace(/\/+$/, "");
}

function bounded(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function anchorJson(
  rt: WorkerRuntime,
  url: string,
  init: { method: "GET" | "POST"; token?: string; body?: unknown; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await rt.fetch(url, {
      method: init.method,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: bounded(init.signal),
      redirect: "error",
    });
  } catch {
    throw new WorkerError("ANCHOR_UNAVAILABLE");
  }
  const text = await response.text().catch(() => "");
  if (!response.ok || text.length > MAX_REPLY_CHARS) throw new WorkerError("ANCHOR_REFUSED");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new WorkerError("ANCHOR_REFUSED");
}

function jwtClaims(token: string): { sub?: unknown; exp?: unknown } {
  const part = token.split(".")[1];
  if (part === undefined) throw new WorkerError("ANCHOR_REFUSED");
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
    return JSON.parse(json) as { sub?: unknown; exp?: unknown };
  } catch {
    throw new WorkerError("ANCHOR_REFUSED");
  }
}

/**
 * Signs a transaction with the worker's cash-out key: the PRF-derived key for a passkey, their
 * wallet otherwise. A wallet's reply counts only when it is this transaction, signed by that key.
 */
async function signWithCashOutKey(rt: WorkerRuntime, worker: WorkerSession, tx: Transaction): Promise<string> {
  const held = heldBy(worker);
  if (held.kind === "passkey") {
    tx.sign(Keypair.fromRawEd25519Seed(Buffer.from(held.cashOutSeed)));
    return tx.toXDR();
  }
  let signed: string;
  try {
    signed = await held.wallet.signTransaction(tx.toXDR(), rt.config.networkPassphrase);
  } catch {
    throw new WorkerError("WALLET_REJECTED");
  }
  let back: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    back = TransactionBuilder.fromXDR(signed, rt.config.networkPassphrase);
  } catch {
    throw new WorkerError("WALLET_CHANGED_TRANSACTION");
  }
  const signer = Keypair.fromPublicKey(worker.cashOutAddress);
  const hash = tx.hash();
  if (!(back instanceof Transaction) || !back.hash().equals(hash) || !back.signatures.some((s) => signer.verify(hash, s.signature()))) {
    throw new WorkerError("WALLET_CHANGED_TRANSACTION");
  }
  return signed;
}

/**
 * A SEP-10 login for the cash-out account, kept in memory for this session. The challenge is read
 * with the SDK's own SEP-10 reader, which checks sequence 0, the server key from the toml, the home
 * domain, the web auth domain, the time bounds and the network, and refuses anything else (a
 * payment operation, another account) before the worker is asked to sign it (C27).
 */
async function login(rt: WorkerRuntime, worker: WorkerSession): Promise<AnchorLogin> {
  const held = heldBy(worker);
  if (held.anchor && held.anchor.expiresAt - LOGIN_MARGIN_MS > rt.now()) return held.anchor;
  const { homeDomain } = rt.config.anchor;
  let toml: Record<string, unknown>;
  try {
    toml = await rt.resolveToml(homeDomain);
  } catch {
    throw new WorkerError("ANCHOR_UNAVAILABLE");
  }
  const webAuth = onAnchorOrigin(rt, toml.WEB_AUTH_ENDPOINT);
  const transferServer = onAnchorOrigin(rt, toml.TRANSFER_SERVER_SEP0024);
  const signingKey = toml.SIGNING_KEY;
  if (typeof signingKey !== "string" || !StrKey.isValidEd25519PublicKey(signingKey)) throw new WorkerError("ANCHOR_CONFIG_INVALID");
  if (toml.NETWORK_PASSPHRASE !== undefined && toml.NETWORK_PASSPHRASE !== rt.config.networkPassphrase) throw new WorkerError("ANCHOR_CONFIG_INVALID");

  const account = worker.cashOutAddress;
  const challengeUrl = `${webAuth}?${new URLSearchParams({ account, home_domain: homeDomain })}`;
  const challenge = await anchorJson(rt, challengeUrl, { method: "GET" });
  if (typeof challenge.transaction !== "string") throw new WorkerError("ANCHOR_CHALLENGE_INVALID");
  if (challenge.network_passphrase !== undefined && challenge.network_passphrase !== rt.config.networkPassphrase) throw new WorkerError("ANCHOR_CHALLENGE_INVALID");
  let read: ReturnType<typeof WebAuth.readChallengeTx>;
  try {
    read = WebAuth.readChallengeTx(challenge.transaction, signingKey, rt.config.networkPassphrase, homeDomain, new URL(webAuth).host);
  } catch {
    throw new WorkerError("ANCHOR_CHALLENGE_INVALID");
  }
  if (read.clientAccountID !== account || read.memo !== null) throw new WorkerError("ANCHOR_CHALLENGE_INVALID");
  const signed = await signWithCashOutKey(rt, worker, read.tx);
  const reply = await anchorJson(rt, webAuth, { method: "POST", body: { transaction: signed } });
  if (typeof reply.token !== "string") throw new WorkerError("ANCHOR_REFUSED");
  const claims = jwtClaims(reply.token);
  if (claims.sub !== account || typeof claims.exp !== "number") throw new WorkerError("ANCHOR_REFUSED");
  held.anchor = { token: reply.token, expiresAt: claims.exp * 1000, transferServer };
  return held.anchor;
}

/**
 * Starts a USDC cash-out at the test anchor: logs the cash-out account in with SEP-10, then opens a
 * SEP-24 interactive withdrawal and returns the anchor's page for the screen to open. The screen
 * reads window messages only when isAnchorMessage(event.origin, anchorOrigin) holds.
 *
 * @throws WorkerError ANCHOR_UNAVAILABLE, ANCHOR_CONFIG_INVALID, ANCHOR_CHALLENGE_INVALID,
 *   ANCHOR_REFUSED, WALLET_REJECTED, WALLET_CHANGED_TRANSACTION.
 */
export async function startCashOut(rt: WorkerRuntime, worker: WorkerSession): Promise<CashOutStart> {
  try {
    const session = await login(rt, worker);
    const reply = await anchorJson(rt, `${session.transferServer}/transactions/withdraw/interactive`, {
      method: "POST",
      token: session.token,
      body: { asset_code: "USDC", asset_issuer: rt.config.usdc.issuer, account: worker.cashOutAddress },
    });
    if (reply.type !== "interactive_customer_info_needed" || typeof reply.id !== "string" || !ANCHOR_TX_ID.test(reply.id)) throw new WorkerError("ANCHOR_REFUSED");
    let url: URL;
    try {
      url = new URL(String(reply.url));
    } catch {
      throw new WorkerError("ANCHOR_REFUSED");
    }
    if (url.protocol !== "https:") throw new WorkerError("ANCHOR_REFUSED");
    return { interactiveUrl: url.href, anchorOrigin: url.origin, transactionId: reply.id };
  } catch (err) {
    throw toWorkerError(err);
  }
}

function memoOf(type: unknown, value: unknown): AnchorPayment["memo"] {
  if (type === undefined && value === undefined) return null;
  if (typeof value !== "string") throw new WorkerError("ANCHOR_RECORD_INVALID");
  try {
    if (type === "text") Memo.text(value);
    else if (type === "id") Memo.id(value);
    else if (type === "hash") Memo.hash(Buffer.from(value, "base64").toString("hex"));
    else throw new Error("memo type");
    if (type === "hash" && Buffer.from(value, "base64").length !== 32) throw new Error("memo length");
  } catch {
    throw new WorkerError("ANCHOR_RECORD_INVALID");
  }
  return { type: type as "text" | "id" | "hash", value };
}

function toMemo(memo: AnchorPayment["memo"]): Memo {
  if (memo === null) return Memo.none();
  if (memo.type === "text") return Memo.text(memo.value);
  if (memo.type === "id") return Memo.id(memo.value);
  return Memo.hash(Buffer.from(memo.value, "base64").toString("hex"));
}

/**
 * Reads the anchor's own record of a withdrawal, with the session's SEP-10 login, and builds the
 * USDC payment it asks for, unsigned. The destination, memo and amount come only from that
 * authenticated record (C27), never from a window message or a URL, and the amount goes through
 * core's one amount parser. The record must be this withdrawal, in pending_user_transfer_start,
 * for USDC from Circle's testnet issuer.
 *
 * @throws WorkerError INVALID_INPUT for a malformed id; ANCHOR_NOT_READY before the worker has
 *   finished the anchor's page; ANCHOR_RECORD_INVALID for any field out of shape; the login's errors.
 */
export async function buildAnchorPayment(rt: WorkerRuntime, worker: WorkerSession, transactionId: string): Promise<AnchorPayment> {
  if (typeof transactionId !== "string" || !ANCHOR_TX_ID.test(transactionId)) throw new WorkerError("INVALID_INPUT");
  try {
    const record = await readRecord(rt, worker, transactionId);
    if (record.status !== "pending_user_transfer_start") throw new WorkerError("ANCHOR_NOT_READY");
    const payable = payableFrom(rt, record);
    const { sequence } = await rt.port.sourceAccount(worker.cashOutAddress);
    const tx = paymentTx(rt, worker.cashOutAddress, sequence, payable);
    return { transactionId, xdr: tx.toXDR(), ...payable };
  } catch (err) {
    throw toWorkerError(err);
  }
}

/** The anchor's own record of this withdrawal, read with the session's SEP-10 login. */
async function readRecord(rt: WorkerRuntime, worker: WorkerSession, transactionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const session = await login(rt, worker);
  const reply = await anchorJson(rt, `${session.transferServer}/transaction?${new URLSearchParams({ id: transactionId })}`, {
    method: "GET",
    token: session.token,
    ...(signal === undefined ? {} : { signal }),
  });
  const record = reply.transaction;
  if (typeof record !== "object" || record === null || Array.isArray(record)) throw new WorkerError("ANCHOR_RECORD_INVALID");
  const fields = record as Record<string, unknown>;
  if (fields.id !== transactionId || fields.kind !== "withdrawal") throw new WorkerError("ANCHOR_RECORD_INVALID");
  return fields;
}

interface Payable {
  destination: string;
  memo: AnchorPayment["memo"];
  amount: bigint;
}

/** What a record asks to be paid, in USDC from Circle's testnet issuer, through core's one amount parser and one address parser. */
function payableFrom(rt: WorkerRuntime, record: Record<string, unknown>): Payable {
  if (record.amount_in_asset !== undefined && record.amount_in_asset !== `stellar:USDC:${rt.config.usdc.issuer}`) throw new WorkerError("ANCHOR_RECORD_INVALID");
  let amount: bigint;
  let destination: string;
  try {
    amount = parseUsdc(String(record.amount_in));
    const parsed = parseAccount(String(record.withdraw_anchor_account));
    if (parsed.kind !== "G") throw new AddressError("INVALID");
    destination = parsed.address;
  } catch (err) {
    if (err instanceof AmountError || err instanceof AddressError) throw new WorkerError("ANCHOR_RECORD_INVALID");
    throw err;
  }
  return { destination, memo: memoOf(record.withdraw_memo_type, record.withdraw_memo), amount };
}

/**
 * The one builder of the anchor payment. buildAnchorPayment gives it a fresh sequence and a
 * five-minute window; sendAnchorPayment gives it the envelope's own sequence and window, so the two
 * hashes are equal only when the envelope pays exactly these fields and nothing else.
 */
function paymentTx(rt: WorkerRuntime, source: string, sequence: string, p: Payable, timeBounds?: { minTime: string; maxTime: string }): Transaction {
  const builder = new TransactionBuilder(new Account(source, sequence), {
    fee: CLASSIC_FEE,
    networkPassphrase: rt.config.networkPassphrase,
    ...(timeBounds === undefined ? {} : { timebounds: timeBounds }),
  })
    .addOperation(Operation.payment({ destination: p.destination, asset: new Asset("USDC", rt.config.usdc.issuer), amount: formatUsdc(p.amount) }))
    .addMemo(toMemo(p.memo));
  return (timeBounds === undefined ? builder.setTimeout(PAYMENT_TIMEOUT_SECONDS) : builder).build();
}

function amountOrNull(value: unknown): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new WorkerError("ANCHOR_RECORD_INVALID");
  try {
    return parseUsdc(value);
  } catch (err) {
    if (err instanceof AmountError && err.code === "ZERO") return 0n;
    throw new WorkerError("ANCHOR_RECORD_INVALID");
  }
}

/**
 * The anchor's own explanation, made safe to show as plain text: control and formatting characters
 * (which can reorder text on screen) become spaces, runs of space collapse, and the length is capped.
 */
function anchorMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const chars = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim());
  if (chars.length === 0) return null;
  return chars.length > MAX_ANCHOR_MESSAGE_CHARS ? `${chars.slice(0, MAX_ANCHOR_MESSAGE_CHARS).join("").trimEnd()}...` : chars.join("");
}

/** A link the screen may open: https with no credentials in it. Anything else is dropped, not shown. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

/** A record as the screen follows it. Any status SEP-24 does not define, or a malformed amount, is refused. */
function cashOutRecord(record: Record<string, unknown>, transactionId: string): CashOutRecord {
  const status = record.status;
  if (typeof status !== "string" || !Object.hasOwn(STATUS_SENTENCES, status)) throw new WorkerError("ANCHOR_RECORD_INVALID");
  const known = status as CashOutStatus;
  const feeDetails = record.fee_details;
  const fee = record.amount_fee ?? (typeof feeDetails === "object" && feeDetails !== null ? (feeDetails as { total?: unknown }).total : undefined);
  const stellarTx = typeof record.stellar_transaction_id === "string" ? record.stellar_transaction_id.toLowerCase() : "";
  return {
    transactionId,
    status: known,
    message: (known === "error" ? anchorMessage(record.message) : null) ?? STATUS_SENTENCES[known],
    amountIn: amountOrNull(record.amount_in),
    amountFee: amountOrNull(fee),
    amountOut: amountOrNull(record.amount_out),
    moreInfoUrl: httpsUrl(record.more_info_url),
    stellarTransactionId: TX_HASH.test(stellarTx) ? stellarTx : null,
  };
}

/** rt.sleep, ended at once by an abort, which rejects with the signal's own reason. */
function pause(rt: WorkerRuntime, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return rt.sleep(ms);
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    rt.sleep(ms).then(
      () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(err);
      },
    );
  });
}

/**
 * Follows the anchor's own record of a cash-out, read with the session's SEP-10 login, every 5 s
 * for the first minute and every 15 s after that. onStatus gets each new status with its plain
 * sentence. Resolves with the record at a final status (completed, refunded, expired, no_market,
 * too_small, too_large, error), or at pending_user_transfer_start while this session has not sent
 * that payment, so the screen can ask the worker to approve it. Once sendAnchorPayment has sent
 * it, watching again follows on past that status. Two failed polls in a row are ridden out; the
 * third stops the watch. After 30 minutes it resolves with the latest record, whatever its status.
 *
 * @throws WorkerError INVALID_INPUT for a malformed id or callback; ANCHOR_RECORD_INVALID for a
 *   record out of shape or a status SEP-24 does not define; ANCHOR_UNAVAILABLE; the login's errors.
 *   An abort rejects with the signal's own reason, not a WorkerError.
 */
export async function watchCashOut(
  rt: WorkerRuntime,
  worker: WorkerSession,
  transactionId: string,
  onStatus: (s: { status: CashOutStatus; message: string }) => void,
  signal?: AbortSignal,
): Promise<CashOutRecord> {
  if (typeof transactionId !== "string" || !ANCHOR_TX_ID.test(transactionId) || typeof onStatus !== "function") throw new WorkerError("INVALID_INPUT");
  heldBy(worker);
  const started = rt.now();
  let latest: CashOutRecord | null = null;
  let shown = "";
  let misses = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let fresh: CashOutRecord | null = null;
      try {
        fresh = cashOutRecord(await readRecord(rt, worker, transactionId, signal), transactionId);
        misses = 0;
      } catch (err) {
        if (signal?.aborted || !(err instanceof WorkerError && err.code === "ANCHOR_UNAVAILABLE") || ++misses >= WATCH_MISSES) throw err;
      }
      if (fresh !== null) {
        latest = fresh;
        const seen = `${fresh.status}\n${fresh.message}`;
        if (seen !== shown) {
          shown = seen;
          onStatus({ status: fresh.status, message: fresh.message });
        }
        if (FINAL_STATUSES.has(fresh.status)) return fresh;
        if (fresh.status === "pending_user_transfer_start" && !paidIn(worker).has(transactionId)) return fresh;
      }
      const elapsed = rt.now() - started;
      if (elapsed >= WATCH_LIMIT_MS) {
        if (latest !== null) return latest;
        throw new WorkerError("ANCHOR_UNAVAILABLE");
      }
      await pause(rt, elapsed < WATCH_FAST_FOR_MS ? WATCH_FAST_MS : WATCH_SLOW_MS, signal);
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw toWorkerError(err);
  }
}

function memoXdr(memo: AnchorPayment["memo"]): string {
  return toMemo(memo).toXDRObject().toXDR("base64");
}

/** A memo as Horizon writes it, through the same reader and serialiser as the record's, or null when it is not one Kalypso pays. */
function horizonMemoXdr(type: unknown, value: unknown): string | null {
  if (type === "none") return memoXdr(null);
  try {
    return memoXdr(memoOf(type, value));
  } catch {
    return null;
  }
}

function sameAmount(text: unknown, amount: bigint): boolean {
  try {
    return typeof text === "string" && parseUsdc(text) === amount;
  } catch {
    return false;
  }
}

/** Stellar writes every classic amount with up to seven decimals, so core's amount parser reads XLM too. */
function xlmStroops(value: unknown): bigint {
  if (typeof value !== "string") throw new WorkerError("NETWORK");
  try {
    return parseUsdc(value);
  } catch (err) {
    if (err instanceof AmountError && err.code === "ZERO") return 0n;
    throw new WorkerError("NETWORK");
  }
}

/** A Horizon read, or null for a 404. @throws WorkerError NETWORK for anything else that is not a JSON object. */
async function horizonJson(rt: WorkerRuntime, path: string): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await rt.fetch(`${rt.config.horizonUrl}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
  } catch {
    throw new WorkerError("NETWORK");
  }
  if (response.status === 404) return null;
  const text = await response.text().catch(() => "");
  if (!response.ok || text.length > MAX_HORIZON_CHARS) throw new WorkerError("NETWORK");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new WorkerError("NETWORK");
}

/**
 * The envelope handed back, held to be exactly the payment its fields describe: it is rebuilt with
 * the one builder from those fields, the cash-out account and its own sequence and window, and the
 * two hashes must be equal. Another operation, fee, network, source, extra signature or memo is
 * refused before the record is read.
 */
function envelopeFor(rt: WorkerRuntime, worker: WorkerSession, payment: AnchorPayment): Transaction {
  try {
    const tx = TransactionBuilder.fromXDR(payment.xdr, rt.config.networkPassphrase);
    if (!(tx instanceof Transaction) || tx.signatures.length !== 0 || tx.timeBounds === undefined) throw new Error("not an unsigned payment");
    const given = parseAccount(payment.destination);
    if (given.kind !== "G") throw new Error("not a G destination");
    const fields = { destination: given.address, memo: payment.memo, amount: payment.amount };
    const rebuilt = paymentTx(rt, worker.cashOutAddress, (BigInt(tx.sequence) - 1n).toString(), fields, tx.timeBounds);
    if (!rebuilt.hash().equals(tx.hash())) throw new Error("not this payment");
    return tx;
  } catch {
    throw new WorkerError("INVALID_INPUT");
  }
}

/** Whether the payment shown to the worker is the one the record asks for now, each side through the same parser. */
function sameFields(asked: Payable, payment: AnchorPayment): boolean {
  try {
    const given = parseAccount(payment.destination);
    return given.kind === "G" && given.address === asked.destination && payment.amount === asked.amount && memoXdr(payment.memo) === memoXdr(asked.memo);
  } catch {
    return false;
  }
}

/**
 * The hash of a payment this cash-out account already made for this withdrawal: USDC from Circle's
 * issuer to the same destination, with the same memo and amount, since the anchor transaction
 * started. The match is on the fields every Horizon payment record that moves an asset to a
 * destination carries, so no list of operation types can miss one. Horizon lists only successful
 * operations, newest first. At most five pages of a hundred are read; when that does not reach back
 * to started_at (or started_at is missing), it refuses with NETWORK rather than guess.
 */
async function earlierPayment(rt: WorkerRuntime, worker: WorkerSession, asked: Payable, startedAt: unknown): Promise<string | null> {
  const since = (typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN) - CLOCK_MARGIN_MS;
  const memo = memoXdr(asked.memo);
  let cursor: string | null = null;
  for (let page = 0; page < PAYMENT_PAGES; page++) {
    const query = new URLSearchParams({ order: "desc", limit: String(PAYMENT_PAGE), ...(cursor === null ? {} : { cursor }) });
    const reply = await horizonJson(rt, `/accounts/${worker.cashOutAddress}/payments?${query}`);
    if (reply === null) return null;
    const records = (reply._embedded as { records?: unknown } | undefined)?.records;
    if (!Array.isArray(records)) throw new WorkerError("NETWORK");
    for (const item of records as unknown[]) {
      const r = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const made = typeof r.created_at === "string" ? Date.parse(r.created_at) : Number.NaN;
      if (Number.isNaN(made) || typeof r.paging_token !== "string") throw new WorkerError("NETWORK");
      if (made < since) return null;
      const hash = r.transaction_hash;
      const matches =
        r.from === worker.cashOutAddress &&
        r.to === asked.destination &&
        r.asset_code === "USDC" &&
        r.asset_issuer === rt.config.usdc.issuer &&
        sameAmount(r.amount, asked.amount) &&
        typeof hash === "string" &&
        TX_HASH.test(hash);
      if (matches) {
        const tx = await horizonJson(rt, `/transactions/${hash}`);
        if (tx !== null && horizonMemoXdr(tx.memo_type, tx.memo) === memo) return hash;
      }
      cursor = r.paging_token;
    }
    if (records.length < PAYMENT_PAGE) return null;
  }
  throw new WorkerError("NETWORK");
}

/**
 * Refuses unless the account can pay `fee` (by default a classic payment's highest possible fee)
 * from XLM above its minimum balance: the network's base reserve, read from the latest ledger and
 * never assumed, times two plus its entries, plus any XLM promised to open offers. A missing
 * account has no XLM.
 *
 * @throws WorkerError CASHOUT_NO_XLM; NETWORK when Horizon cannot answer.
 */
export async function requireFeeXlm(rt: WorkerRuntime, account: string, fee: bigint = BigInt(CLASSIC_FEE)): Promise<void> {
  const state = await horizonJson(rt, `/accounts/${account}`);
  if (state === null) throw new WorkerError("CASHOUT_NO_XLM");
  const ledgers = await horizonJson(rt, "/ledgers?order=desc&limit=1");
  const latest = (ledgers?._embedded as { records?: { base_reserve_in_stroops?: unknown }[] } | undefined)?.records?.[0];
  const reserve = latest?.base_reserve_in_stroops;
  const balances = Array.isArray(state.balances) ? (state.balances as unknown[]) : [];
  const native = balances.find((b): b is Record<string, unknown> => typeof b === "object" && b !== null && (b as Record<string, unknown>).asset_type === "native");
  const counts = [state.subentry_count, state.num_sponsoring ?? 0, state.num_sponsored ?? 0];
  if (typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve <= 0 || native === undefined || !counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) {
    throw new WorkerError("NETWORK");
  }
  const [subentries, sponsoring, sponsored] = counts as [number, number, number];
  const minimum = BigInt(2 + subentries + sponsoring - sponsored) * BigInt(reserve);
  const spare = xlmStroops(native.balance) - minimum - xlmStroops(native.selling_liabilities ?? "0");
  if (spare < fee) throw new WorkerError("CASHOUT_NO_XLM");
}

/**
 * Submits the signed payment and waits for it. From the moment it may be in flight this session
 * counts the anchor transaction as paid, so nothing sends it twice; only a refusal that proves it
 * is not in flight, or a final failure, clears that.
 */
async function submitPayment(rt: WorkerRuntime, worker: WorkerSession, transactionId: string, signed: string): Promise<string> {
  const hash = transactionHash(signed, rt.config.networkPassphrase);
  const paid = paidIn(worker);
  paid.set(transactionId, hash);
  try {
    await rt.port.submit(signed);
  } catch (err) {
    if (err instanceof SubmitRejectedError) paid.delete(transactionId);
    throw err;
  }
  const final = await rt.port.waitFor(hash, PAYMENT_WAIT_MS);
  if (final.status === "FAILED") {
    paid.delete(transactionId);
    throw new WorkerError("TX_FAILED", { hash });
  }
  if (final.status !== "SUCCESS") throw new WorkerError("TX_PENDING", { hash });
  return hash;
}

/**
 * Signs and sends the USDC payment buildAnchorPayment built, from the cash-out account, which pays
 * its own small fee in XLM. Right before signing it reads the anchor's record again and sends only
 * while that record still asks for exactly this destination, memo and amount (C27). It never pays
 * one anchor transaction twice: not twice from one session, and not when Horizon already shows a
 * USDC payment from this account to the same destination with the same memo and amount since the
 * anchor transaction started. A passkey worker signs with the PRF-derived cash-out key; a wallet
 * worker's wallet signs, since their cash-out account is their own G account. Once it is sent,
 * watchCashOut follows the record on past pending_user_transfer_start. The amount is never logged.
 *
 * @throws WorkerError INVALID_INPUT when the envelope is not exactly the payment its fields
 *   describe; ANCHOR_ALREADY_PAID, with the earlier payment's hash; ANCHOR_RECORD_CHANGED when the
 *   record no longer asks for this payment or has left pending_user_transfer_start;
 *   ANCHOR_RECORD_INVALID; CASHOUT_NO_XLM; NETWORK when Horizon cannot answer; WALLET_REJECTED;
 *   WALLET_CHANGED_TRANSACTION; TX_FAILED; TX_PENDING, with the hash, when it has not landed yet;
 *   BUSY; the login's errors.
 */
export async function sendAnchorPayment(rt: WorkerRuntime, worker: WorkerSession, payment: AnchorPayment): Promise<{ hash: string }> {
  if (
    typeof payment !== "object" ||
    payment === null ||
    typeof payment.transactionId !== "string" ||
    !ANCHOR_TX_ID.test(payment.transactionId) ||
    typeof payment.xdr !== "string" ||
    typeof payment.destination !== "string" ||
    typeof payment.amount !== "bigint"
  ) {
    throw new WorkerError("INVALID_INPUT");
  }
  heldBy(worker);
  return rt.exclusive(`kalypso/worker/v1/anchor-payment/${worker.cashOutAddress}`, async () => {
    try {
      const tx = envelopeFor(rt, worker, payment);
      const paid = paidIn(worker);
      const sent = paid.get(payment.transactionId);
      if (sent !== undefined) throw new WorkerError("ANCHOR_ALREADY_PAID", { hash: sent });
      const record = await readRecord(rt, worker, payment.transactionId);
      if (record.status !== "pending_user_transfer_start") throw new WorkerError("ANCHOR_RECORD_CHANGED");
      const asked = payableFrom(rt, record);
      if (!sameFields(asked, payment)) throw new WorkerError("ANCHOR_RECORD_CHANGED");
      const before = await earlierPayment(rt, worker, asked, record.started_at);
      if (before !== null) {
        paid.set(payment.transactionId, before);
        throw new WorkerError("ANCHOR_ALREADY_PAID", { hash: before });
      }
      await requireFeeXlm(rt, worker.cashOutAddress);
      const signed = await signWithCashOutKey(rt, worker, tx);
      return { hash: await submitPayment(rt, worker, payment.transactionId, signed) };
    } catch (err) {
      throw toWorkerError(err);
    }
  });
}
