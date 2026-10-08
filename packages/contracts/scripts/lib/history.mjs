// What the prove command reads once RPC's 7-day window has passed: our archive server for the
// token's and the payroll's events, and Horizon for transaction bodies. The rules match core's
// archive reader (packages/core/src/history/events.ts): https only, no redirects, a timeout and a
// size cap, and every reply checked against the shape packages/server/src/archive/api.ts defines.
// Any other reply is an error, never an empty history.
import { HORIZON_URL } from "./network.mjs";

const TIMEOUT_MS = 10_000;
const MAX_REPLY_CHARS = 4_000_000;
const PAGE_LIMIT = 200;
// 50,000 events, the same bound core uses. More than that is reported, never cut short.
const MAX_PAGES = 250;
const MAX_LEDGER = 0xffffffff;
const TX_HASH = /^[0-9a-f]{64}$/;
const ARCHIVE_CURSOR = /^\d{1,10}-\d{1,7}-\d{1,4}-\d{1,10}$/;
// Core's httpsBaseUrl rule, character for character, so a URL accepted here is the one core accepts.
const HTTPS_BASE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/?$/;

const isLedger = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_LEDGER;

/**
 * The archive's base URL with one trailing slash.
 * @throws for anything but an https URL made of a host and a plain path.
 */
export function archiveBaseUrl(text, setting) {
  if (typeof text !== "string" || !HTTPS_BASE.test(text)) throw new Error(`${setting} must be an https URL with no query, fragment or credentials`);
  return text.endsWith("/") ? text : `${text}/`;
}

async function getJson(url, okStatuses = [200]) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" }, redirect: "error" });
  const text = await res.text();
  const where = new URL(url).pathname;
  if (!okStatuses.includes(res.status)) throw new Error(`${where} answered ${res.status}`);
  if (text.length > MAX_REPLY_CHARS) throw new Error(`${where} answered more than ${MAX_REPLY_CHARS} characters`);
  const body = JSON.parse(text);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error(`${where} did not answer an object`);
  return body;
}

/** Where the archive's word begins and ends (/v1/health). A raised alarm (503) still reports both. */
export async function archiveHealth(base) {
  const body = await getJson(`${base}v1/health`, [200, 503]);
  if (!isLedger(body.ingested_from) || !isLedger(body.ingested_through)) throw new Error("the archive's health reply has no ingested_from or ingested_through");
  return { from: body.ingested_from, through: body.ingested_through, alarm: body.alarm === true };
}

/**
 * Every event row of one /v1 route (a token account's or a payroll company's), raw XDR kept, so
 * the stranger's search reads exactly the bytes the archive serves. complete is the archive's
 * own flag on every page.
 */
export async function archiveRows(base, route, fromLedger) {
  const rows = [];
  let complete = true;
  let cursor = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`${route} holds more than ${MAX_PAGES * PAGE_LIMIT} events`);
    const body = await getJson(`${base}${route}?from_ledger=${fromLedger}&limit=${PAGE_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    if (!Array.isArray(body.events) || body.events.length > PAGE_LIMIT || typeof body.complete !== "boolean") {
      throw new Error(`${route} answered without its events list or complete flag`);
    }
    for (const r of body.events) {
      if (!isLedger(r?.ledger_seq) || r.ledger_seq < fromLedger || typeof r.tx_hash !== "string" || !TX_HASH.test(r.tx_hash)) {
        throw new Error(`${route} answered a row with a malformed ledger or transaction hash`);
      }
      if (!Array.isArray(r.topics_xdr) || !r.topics_xdr.every((t) => typeof t === "string") || typeof r.data_xdr !== "string") {
        throw new Error(`${route} answered a row with no XDR`);
      }
      rows.push({ ledger: r.ledger_seq, txHash: r.tx_hash, topicsXdr: r.topics_xdr, dataXdr: r.data_xdr });
    }
    complete &&= body.complete;
    if (body.cursor === null) break;
    if (typeof body.cursor !== "string" || !ARCHIVE_CURSOR.test(body.cursor) || body.cursor === cursor) throw new Error(`${route} answered a malformed cursor`);
    cursor = body.cursor;
  }
  return { rows, complete };
}

/**
 * Every event of the token from `startLedger` through `endLedger`, from the archive's per-contract
 * stream. That route answers 409 for any range it cannot vouch for in full, which stops here.
 * Topics and values arrive as the plain JSON the archive's IndexerClient route uses.
 */
export async function archiveTokenStream(base, token, startLedger, endLedger) {
  const events = [];
  let cursor = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`the token's archived stream holds more than ${MAX_PAGES * PAGE_LIMIT} events`);
    const query = `startLedger=${startLedger}&endLedger=${endLedger}&limit=${PAGE_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    // 409 is the archive refusing a range it cannot vouch for; its body says complete: false.
    const body = await getJson(`${base}contracts/${token}/events?${query}`, [200, 409]);
    if (body.complete !== true || !Array.isArray(body.events) || body.events.length > PAGE_LIMIT) {
      throw new Error(`the archive does not vouch for the token's ledgers ${startLedger} to ${endLedger}`);
    }
    for (const e of body.events) {
      if (!isLedger(e?.ledger) || e.ledger < startLedger || e.ledger > endLedger || typeof e.txHash !== "string" || !TX_HASH.test(e.txHash) || !Array.isArray(e.topic)) {
        throw new Error("the archive's token stream answered a malformed event");
      }
      events.push({ ledger: e.ledger, txHash: e.txHash, topic: e.topic, value: e.value });
    }
    if (body.cursor === null) break;
    if (typeof body.cursor !== "string" || !ARCHIVE_CURSOR.test(body.cursor) || body.cursor === cursor) throw new Error("the archive's token stream answered a malformed cursor");
    cursor = body.cursor;
  }
  return events;
}

/**
 * One transaction as Horizon keeps it after RPC's window: the XDR fields it serves, by name.
 * The envelope must be there; the result and result meta are taken when Horizon serves them.
 */
export async function horizonTransaction(txHash) {
  if (!TX_HASH.test(txHash)) throw new Error("a transaction hash is malformed");
  const body = await getJson(`${HORIZON_URL}transactions/${txHash}`);
  if (body.hash !== txHash || typeof body.envelope_xdr !== "string") throw new Error(`Horizon has no envelope for transaction ${txHash}`);
  const part = (name) => (typeof body[name] === "string" && body[name] !== "" ? body[name] : null);
  return { envelopeXdr: body.envelope_xdr, resultXdr: part("result_xdr"), resultMetaXdr: part("result_meta_xdr") };
}
