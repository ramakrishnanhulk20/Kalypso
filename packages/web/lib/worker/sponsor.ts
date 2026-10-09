import { parseAccount } from "@kalypso/core";
import type { SponsorRefusalCode } from "@kalypso/server";

/**
 * What the fee sponsor relays, exactly the two body shapes packages/server/src/sponsor/validate.ts
 * accepts: a passkey wallet's call as a base64 HostFunction plus its signed auth entries (the
 * relayer becomes the transaction source), or a wallet's signed transaction envelope (the relayer
 * wraps it in a fee bump).
 */
export type SponsorBody = { func: string; auth: string[] } | { xdr: string };

/** The relayer's transaction states, as the sponsor passes them on. */
export type RelayStatus = "pending" | "sent" | "submitted" | "confirmed" | "failed" | "expired";

/**
 * The fee sponsor as the worker portal uses it. The production one is createHttpSponsor; tests and
 * the scratch live run supply their own.
 */
export interface SponsorPort {
  /** Asks the sponsor to pay for and relay one transaction. @throws SponsorError */
  send(body: SponsorBody): Promise<{ transactionId: string; status: RelayStatus }>;
  /** Where a relayed transaction is. hash is null until the relayer has submitted it. @throws SponsorError */
  status(transactionId: string): Promise<{ status: RelayStatus; hash: string | null }>;
}

/**
 * Our server's index of passkey wallet births: which transaction created each wallet address, so a
 * worker signing in on another device can find it. Its answers are pointers, never proof (C55): the
 * caller reads the transaction from chain and judges it itself (verifyWalletBirth).
 */
/** A creation of the wallet the sponsor handed to the relayer, with what is known of it so far. */
export interface RelayedCreation {
  transactionId: string | null;
  hash: string | null;
}

export interface BirthIndexPort {
  /**
   * The creation transaction hash the index holds for this wallet, or null; the creations of it the
   * sponsor relayed, newest first, at most 20; and `more`, true when older ones were left out. Both
   * empty with `more` false means Kalypso never relayed one. An answer that leaves `more` out is read
   * as cut short, so it can never end in ADDRESS_TAKEN. @throws SponsorError
   */
  birth(address: string): Promise<{ hash: string | null; relayed: RelayedCreation[]; more: boolean }>;
  /** Asks the index to keep this hash; the server stores it only once the chain shows it created the address. @throws SponsorError */
  recordBirth(address: string, hash: string): Promise<void>;
}

/**
 * not_sent: the sponsor refused before relaying, so nothing can reach the network and the same
 * action can be retried once its cause is fixed. unknown: it may have been relayed, so the caller
 * reads the chain before trying again, never assumes either way.
 */
export type SponsorOutcome = "not_sent" | "unknown";

type HandlerRefusalCode =
  | "method_not_allowed"
  | "no_client_ip"
  | "rate_limited"
  | "unsupported_media_type"
  | "body_too_large"
  | "invalid_json"
  | "duplicate_in_flight"
  | "auth_entry_in_use"
  | "address_rate_limited"
  | "daily_budget_spent"
  | "relay_timeout"
  | "relay_unavailable"
  | "relay_refused"
  | "relay_bad_reply"
  | "internal_error"
  | "not_configured"
  | "bad_id"
  | "bad_request"
  | "bad_address"
  | "bad_hash"
  | "birth_unavailable"
  | "not_a_birth"
  | "creation_not_recorded";

const CLIENT_CODES = ["network", "timeout", "bad_reply", "unknown_refusal", "relay_failed", "still_pending"] as const;
/** Failures this client finds itself, with no answer from the sponsor to go on. */
type ClientCode = (typeof CLIENT_CODES)[number];

export type SponsorErrorCode = SponsorRefusalCode | HandlerRefusalCode | ClientCode;

const NOT_SENT = "not_sent" as const;
const UNKNOWN = "unknown" as const;
const CHECK_FIRST = "It may still reach the network, so Kalypso checks the chain before trying again.";

// Keyed by the server's own refusal type, so a code the server adds and this table lacks fails
// the typecheck instead of reaching a worker as a raw code.
const REFUSALS = {
  method_not_allowed: [NOT_SENT, "The fee sponsor was called the wrong way. Reload the page and try again."],
  no_client_ip: [NOT_SENT, "The fee sponsor could not tell where the request came from, so it refused it. Try again on a normal connection."],
  rate_limited: [NOT_SENT, "This connection has used its free requests for now: a few an hour, and a few new Face ID wallets a day. Try again later, or from another network."],
  unsupported_media_type: [NOT_SENT, "The fee sponsor was sent a request it does not read. Reload the page and try again."],
  body_too_large: [NOT_SENT, "This transaction is too large for the fee sponsor."],
  invalid_json: [NOT_SENT, "The fee sponsor could not read the request. Reload the page and try again."],
  bad_shape: [NOT_SENT, "The fee sponsor does not pay for a transaction shaped like this one."],
  bad_encoding: [NOT_SENT, "The transaction was not encoded the way the fee sponsor requires."],
  envelope_not_accepted: [NOT_SENT, "The fee sponsor only pays for a plain signed transaction."],
  not_one_operation: [NOT_SENT, "The fee sponsor only pays for a transaction that does exactly one thing."],
  not_invoke_host_function: [NOT_SENT, "The fee sponsor only pays for calls into Kalypso's contracts."],
  missing_soroban_data: [NOT_SENT, "The transaction does not state its resource limits, so the fee sponsor will not pay for it."],
  wasm_upload: [NOT_SENT, "The fee sponsor never pays to upload contract code."],
  contract_creation: [NOT_SENT, "The fee sponsor only pays to create a passkey wallet set up the way Kalypso sets one up."],
  root_contract_not_allowed: [NOT_SENT, "The fee sponsor only pays for calls into the Kalypso payroll and token contracts, and for registering your own audit key."],
  nested_contract_not_allowed: [NOT_SENT, "This call reaches a contract the fee sponsor does not pay for."],
  no_auth: [NOT_SENT, "The call carries no approval from you, so the fee sponsor will not pay for it."],
  source_account_auth: [NOT_SENT, "The fee sponsor needs your own approval on this call, not the sender's."],
  too_many_auth_entries: [NOT_SENT, "The call asks for more approvals than the fee sponsor accepts."],
  auth_tree_too_large: [NOT_SENT, "The call asks for more permissions than the fee sponsor accepts."],
  unsigned_auth: [NOT_SENT, "An approval this call needs has not been signed."],
  signer_key_mismatch: [NOT_SENT, "An approval was signed by a different key than the account it speaks for."],
  not_signed_for_testnet: [NOT_SENT, "The approval was not signed for the Stellar test network."],
  fee_over_cap: [NOT_SENT, "This transaction costs more than the fee sponsor pays for one action."],
  auth_expired: [NOT_SENT, "Your approval ran out before the fee sponsor could send it. Approve it again."],
  auth_expiry_too_far: [NOT_SENT, "Your approval stays valid longer than the fee sponsor accepts. Approve it again."],
  simulation_failed: [NOT_SENT, "The network would not run this transaction, so nothing was sent."],
  simulation_needs_restore: [NOT_SENT, "Some contract data this needs is archived and has to be restored before it can run."],
  read_only_call: [NOT_SENT, "This call changes nothing, so the fee sponsor will not pay for it."],
  unused_auth: [NOT_SENT, "The transaction carries an approval the call does not use, so the fee sponsor refused it."],
  unknown_wallet_code: [NOT_SENT, "Your wallet runs code the fee sponsor does not trust, so it will not pay for it."],
  foreign_contract_in_footprint: [NOT_SENT, "This call touches a contract the fee sponsor does not pay for."],
  footprint_not_declared: [NOT_SENT, "The transaction does not list everything it touches, so it would fail on the network."],
  resources_not_declared: [NOT_SENT, "The transaction reserves less work than it needs, so it would fail on the network."],
  rpc_unavailable: [NOT_SENT, "The fee sponsor could not reach the Stellar network. Try again shortly."],
  duplicate_in_flight: [UNKNOWN, "This exact transaction is already being sent. Wait for it to finish."],
  auth_entry_in_use: [UNKNOWN, "This approval is already being used by another request. Wait for it to finish."],
  address_rate_limited: [NOT_SENT, "This account has used up its sponsored transactions for today. Try again tomorrow."],
  daily_budget_spent: [NOT_SENT, "The fee sponsor has spent today's budget. Try again tomorrow."],
  relay_timeout: [UNKNOWN, `The relayer did not answer in time. ${CHECK_FIRST}`],
  relay_unavailable: [UNKNOWN, `The relayer could not be reached. ${CHECK_FIRST}`],
  relay_refused: [UNKNOWN, `The relayer refused the transaction. ${CHECK_FIRST}`],
  relay_bad_reply: [UNKNOWN, `The relayer gave an answer the fee sponsor could not read. ${CHECK_FIRST}`],
  internal_error: [UNKNOWN, `The fee sponsor had an internal error. ${CHECK_FIRST}`],
  not_configured: [NOT_SENT, "The fee sponsor is not set up on this site yet."],
  bad_id: [NOT_SENT, "The fee sponsor did not recognise that transaction."],
  bad_request: [NOT_SENT, "Kalypso asked about a wallet setup in a form the server does not read. Reload the page and try again."],
  bad_address: [NOT_SENT, "That is not a wallet address the server recognises."],
  bad_hash: [NOT_SENT, "That is not a transaction hash the server recognises."],
  birth_unavailable: [NOT_SENT, "The network does not show that wallet setup yet. Try again in a minute."],
  not_a_birth: [NOT_SENT, "That transaction did not create this wallet, so it was not recorded."],
  creation_not_recorded: [NOT_SENT, "The fee sponsor could not note this wallet setup before sending it, so nothing was sent. Try again in a minute."],
  network: [UNKNOWN, `Kalypso could not reach the fee sponsor. ${CHECK_FIRST}`],
  timeout: [UNKNOWN, `The fee sponsor did not answer in time. ${CHECK_FIRST}`],
  bad_reply: [UNKNOWN, `The fee sponsor gave an answer Kalypso could not read. ${CHECK_FIRST}`],
  unknown_refusal: [UNKNOWN, `The fee sponsor refused for a reason Kalypso does not know. ${CHECK_FIRST}`],
  relay_failed: [NOT_SENT, "The relayer could not send this transaction, so nothing reached the network. Try again."],
  still_pending: [UNKNOWN, "The fee sponsor has not finished sending this transaction yet. Check again in a minute."],
} as const satisfies Record<SponsorErrorCode, readonly [SponsorOutcome, string]>;

/** Every code this client can raise, for screens and tests that list them. */
export const SPONSOR_ERROR_CODES = Object.keys(REFUSALS) as SponsorErrorCode[];

/** A code the sponsor itself may send. A client-only code in a reply is not one, whoever wrote it. */
function isServerCode(code: unknown): code is SponsorErrorCode {
  return typeof code === "string" && Object.hasOwn(REFUSALS, code) && !(CLIENT_CODES as readonly string[]).includes(code);
}

/** A sponsor request did not end in a relayed transaction. The message is a sentence the screen shows as it is. */
export class SponsorError extends Error {
  readonly code: SponsorErrorCode;
  readonly outcome: SponsorOutcome;
  /** The HTTP status when the sponsor answered at all. */
  readonly httpStatus: number | undefined;
  /** The transaction hash, when the relayer reported one before this failure. Public. */
  readonly hash: string | undefined;

  constructor(code: SponsorErrorCode, httpStatus?: number, hash?: string) {
    const [outcome, sentence] = REFUSALS[code];
    super(sentence);
    this.name = "SponsorError";
    this.code = code;
    this.outcome = outcome;
    this.httpStatus = httpStatus;
    this.hash = hash;
  }
}

const RELAY_STATUSES: readonly RelayStatus[] = ["pending", "sent", "submitted", "confirmed", "failed", "expired"];
// The sponsor's own formats (handler.ts TRANSACTION_ID and the hash rule), so nothing else is passed on.
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TX_HASH = /^[0-9a-f]{64}$/;
const MAX_REPLY_CHARS = 64 * 1024;
// The sponsor route may run 60 s (its maxDuration), so the client waits a little longer before
// calling the outcome unknown.
const SEND_TIMEOUT_MS = 70_000;
const STATUS_TIMEOUT_MS = 20_000;

// The server's own cap (packages/server/src/archive/db.ts MAX_CREATION_RELAYS); a longer list is not its answer.
const MAX_RELAYED_CREATIONS = 20;

function isHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && TX_HASH.test(value));
}

function isRelayStatus(value: unknown): value is RelayStatus {
  return typeof value === "string" && (RELAY_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/**
 * The body in exactly one of the server's two shapes, rebuilt from its parts so nothing else rides
 * along. @throws TypeError for anything else, before any request is made.
 */
function requireBody(body: SponsorBody): SponsorBody {
  const raw: unknown = body;
  if (isRecord(raw) && hasExactKeys(raw, ["xdr"]) && typeof raw.xdr === "string" && raw.xdr !== "") return { xdr: raw.xdr };
  if (
    isRecord(raw) &&
    hasExactKeys(raw, ["func", "auth"]) &&
    typeof raw.func === "string" &&
    raw.func !== "" &&
    Array.isArray(raw.auth) &&
    raw.auth.every((entry) => typeof entry === "string" && entry !== "")
  ) {
    return { func: raw.func, auth: [...(raw.auth as string[])] };
  }
  throw new TypeError("A sponsor body is either { func, auth } or { xdr }.");
}

type FetchLike = (input: string, init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface HttpSponsorOptions {
  /** Where the app is served from, with no trailing slash. Empty means this page's own origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  sendTimeoutMs?: number;
  statusTimeoutMs?: number;
}

async function call(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch (err) {
    const name = (err as { name?: unknown } | null | undefined)?.name;
    throw new SponsorError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new SponsorError("bad_reply", response.status);
  }
  if (text.length > MAX_REPLY_CHARS) throw new SponsorError("bad_reply", response.status);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

/** A refusal body is `{ error: code }`; anything else from a non-200 answer is unknown_refusal. */
function refusalOf(status: number, json: unknown): SponsorError {
  const code = isRecord(json) ? json.error : undefined;
  return isServerCode(code) ? new SponsorError(code, status) : new SponsorError("unknown_refusal", status);
}

/** A wallet address in the one spelling core's parser gives, or null for anything that is not a C address. */
function walletAddress(address: unknown): string | null {
  try {
    const parsed = parseAccount(address as string);
    return parsed.kind === "C" ? parsed.address : null;
  } catch {
    return null;
  }
}

/**
 * The production SponsorPort and BirthIndexPort: POST /api/sponsor, GET /api/sponsor/status?id=,
 * POST /api/sponsor/birth/lookup and POST /api/sponsor/birth on this app's own server. Replies are
 * checked against the shapes the server sends, so a malformed or oversized answer becomes bad_reply
 * instead of a value the portal acts on. A wallet address travels only in a request body, never in
 * a URL, so no request log pairs a caller's IP with a wallet.
 */
export function createHttpSponsor(options: HttpSponsorOptions = {}): SponsorPort & BirthIndexPort {
  const base = options.baseUrl ?? "";
  if (base !== "" && !/^https?:\/\/[^/\s]+$/.test(base)) throw new TypeError("baseUrl must be an origin with no path, or empty.");
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sendTimeout = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const statusTimeout = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;

  return {
    async send(body) {
      const checked = requireBody(body);
      const { status, json } = await call(
        fetchImpl,
        `${base}/api/sponsor`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checked) },
        sendTimeout,
      );
      if (status !== 200) throw refusalOf(status, json);
      if (!isRecord(json) || !hasExactKeys(json, ["transactionId", "status"])) throw new SponsorError("bad_reply", status);
      const { transactionId, status: relay } = json;
      if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId) || !isRelayStatus(relay)) throw new SponsorError("bad_reply", status);
      return { transactionId, status: relay };
    },

    async status(transactionId) {
      if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) throw new SponsorError("bad_id");
      const { status, json } = await call(fetchImpl, `${base}/api/sponsor/status?id=${encodeURIComponent(transactionId)}`, { method: "GET" }, statusTimeout);
      if (status !== 200) throw refusalOf(status, json);
      if (!isRecord(json) || !hasExactKeys(json, ["status", "hash"])) throw new SponsorError("bad_reply", status);
      const { status: relay, hash } = json;
      if (!isRelayStatus(relay) || !(hash === null || (typeof hash === "string" && TX_HASH.test(hash)))) throw new SponsorError("bad_reply", status);
      return { status: relay, hash };
    },

    async birth(address) {
      const wallet = walletAddress(address);
      if (wallet === null) throw new SponsorError("bad_address");
      const { status, json } = await call(
        fetchImpl,
        `${base}/api/sponsor/birth/lookup`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet }) },
        statusTimeout,
      );
      if (status !== 200) throw refusalOf(status, json);
      if (!isRecord(json) || !hasExactKeys(json, ["hash", "relayed", "more"])) throw new SponsorError("bad_reply", status);
      const { hash, relayed, more } = json;
      if (!isHashOrNull(hash) || !Array.isArray(relayed) || relayed.length > MAX_RELAYED_CREATIONS || typeof more !== "boolean") {
        throw new SponsorError("bad_reply", status);
      }
      const creations: RelayedCreation[] = [];
      for (const entry of relayed as unknown[]) {
        if (!isRecord(entry) || !hasExactKeys(entry, ["transactionId", "hash"])) throw new SponsorError("bad_reply", status);
        const { transactionId, hash: entryHash } = entry;
        if (!(transactionId === null || (typeof transactionId === "string" && TRANSACTION_ID.test(transactionId))) || !isHashOrNull(entryHash)) {
          throw new SponsorError("bad_reply", status);
        }
        creations.push({ transactionId, hash: entryHash });
      }
      return { hash, relayed: creations, more };
    },

    async recordBirth(address, hash) {
      const wallet = walletAddress(address);
      if (wallet === null) throw new SponsorError("bad_address");
      if (typeof hash !== "string" || !TX_HASH.test(hash)) throw new SponsorError("bad_hash");
      const { status, json } = await call(
        fetchImpl,
        `${base}/api/sponsor/birth`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet, hash }) },
        statusTimeout,
      );
      if (status !== 200) throw refusalOf(status, json);
      if (!isRecord(json) || !hasExactKeys(json, ["recorded"]) || json.recorded !== true) throw new SponsorError("bad_reply", status);
    },
  };
}

export interface RelayWaitOptions {
  /** How long to look before the outcome is still_pending. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const FIRST_LOOK_MS = 1_500;
const MAX_LOOK_MS = 5_000;
const RELAY_WAIT_MS = 120_000;
// Answers that say nothing about the transaction itself, only that this look failed.
const TRANSIENT: ReadonlySet<SponsorErrorCode> = new Set<SponsorErrorCode>(["network", "timeout", "bad_reply", "rate_limited", "relay_timeout", "relay_unavailable", "relay_bad_reply", "internal_error", "rpc_unavailable"]);

/**
 * Asks the sponsor until the relayer names the transaction's hash. From there the chain itself is
 * the authority (the caller waits on the hash with RPC), because the relayer's word that something
 * landed is only a claim. Looks start at 1.5 s and stretch to 5 s, so one relay costs a few status
 * requests against the sponsor's per-IP limit, not dozens.
 *
 * @throws SponsorError relay_failed when the relayer gave up before submitting (nothing reached
 *   the network); still_pending at the deadline, carrying no hash; a definitive refusal of the
 *   status request itself.
 */
export async function waitForRelayHash(sponsor: SponsorPort, transactionId: string, options: RelayWaitOptions = {}): Promise<{ hash: string; status: RelayStatus }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? RELAY_WAIT_MS);
  let wait = FIRST_LOOK_MS;
  for (;;) {
    await sleep(wait);
    wait = Math.min(MAX_LOOK_MS, Math.round(wait * 1.5));
    try {
      const answer = await sponsor.status(transactionId);
      if (answer.hash !== null) return { hash: answer.hash, status: answer.status };
      if (answer.status === "failed" || answer.status === "expired") throw new SponsorError("relay_failed");
    } catch (err) {
      if (!(err instanceof SponsorError) || !TRANSIENT.has(err.code)) throw err;
    }
    if (now() >= deadline) throw new SponsorError("still_pending");
  }
}
