// The stranger's scan: every form an amount could take in a transaction, and every form a
// transaction takes when someone reads it from RPC. A salary counts as readable if any form
// of it shows up in any form of the transaction.
//
// Covers: the amount as raw bytes (i128 and u64, both byte orders), as text (stroops, USDC with
// 7, 2 or trimmed decimals, with a thousands separator, hex in both cases), inside the raw XDR
// RPC returns and inside a full rendering of every decoded XDR field, with byte fields as hex.
// Does not cover: an amount split across fields, scaled by anything but its own decimals, or
// hidden by an encryption the attacker can undo; reading those is the decryption checks' job.
import { core, sdk } from "./kalypso.mjs";

const USDC_SCALE = 10_000_000n;
const MAX_RENDER_DEPTH = 64;

function fixedBytes(value, size, littleEndian) {
  const out = Buffer.alloc(size);
  let v = value;
  for (let i = 0; i < size; i++) {
    out[littleEndian ? i : size - 1 - i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function usdcText(stroops) {
  const whole = stroops / USDC_SCALE;
  const fraction = (stroops % USDC_SCALE).toString().padStart(7, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const forms = [
    ["USDC trimmed decimal", core.formatUsdc(stroops)],
    ["USDC with 7 decimals", `${whole}.${fraction}`],
  ];
  // Cents forms exist only when the amount has no smaller digit, so they never round.
  if (fraction.endsWith("00000")) {
    forms.push(["USDC with cents", `${whole}.${fraction.slice(0, 2)}`]);
    forms.push(["USDC with thousands separator", `${grouped}.${fraction.slice(0, 2)}`]);
  }
  return forms;
}

/**
 * Every encoding of `stroops` the scan looks for, each { name, kind: "bytes" | "text", value }.
 * Uppercase hex is kept for text an account could have written itself (a label, a memo); byte
 * fields are rendered lowercase, and case does not change whether bytes are present.
 */
export function amountNeedles(stroops) {
  if (typeof stroops !== "bigint" || stroops <= 0n || stroops >= 1n << 63n) throw new RangeError("amount must be a positive i64");
  const i128be = fixedBytes(stroops, 16, false);
  const u64be = fixedBytes(stroops, 8, false);
  return [
    { name: "decimal stroops", kind: "text", value: stroops.toString() },
    ...usdcText(stroops).map(([name, value]) => ({ name, kind: "text", value })),
    { name: "i128 big endian", kind: "bytes", value: i128be },
    { name: "i128 little endian", kind: "bytes", value: fixedBytes(stroops, 16, true) },
    { name: "u64 big endian", kind: "bytes", value: u64be },
    { name: "u64 little endian", kind: "bytes", value: fixedBytes(stroops, 8, true) },
    { name: "lowercase hex", kind: "text", value: stroops.toString(16) },
    { name: "uppercase hex", kind: "text", value: stroops.toString(16).toUpperCase() },
    { name: "i128 big endian as lowercase hex", kind: "text", value: i128be.toString("hex") },
    { name: "i128 big endian as uppercase hex", kind: "text", value: i128be.toString("hex").toUpperCase() },
    { name: "u64 big endian as lowercase hex", kind: "text", value: u64be.toString("hex") },
    { name: "u64 big endian as uppercase hex", kind: "text", value: u64be.toString("hex").toUpperCase() },
  ];
}

/** The encoding names amountNeedles can produce, for the report. */
export const ENCODING_NAMES = [...new Set(amountNeedles(12_455_000_000n).map((n) => n.name))];

/** Renders every leaf of a decoded XDR value as text: numbers in decimal, bytes as hex, strings as is. */
function render(value, out, depth = 0) {
  if (depth > MAX_RENDER_DEPTH) throw new Error("an XDR value nests deeper than the scan allows");
  if (value === null || value === undefined) return;
  if (value instanceof Uint8Array) {
    out.push(Buffer.from(value).toString("hex"));
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (typeof value.toBigInt === "function") {
    out.push(value.toBigInt().toString());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) render(item, out, depth + 1);
    return;
  }
  if (value instanceof sdk.xdr.ScVal && /^scv[IU](64|128|256)$/.test(value.switch().name)) {
    out.push(sdk.scValToNative(value).toString());
  }
  if (value._attributes) {
    for (const field of Object.values(value._attributes)) render(field, out, depth + 1);
    return;
  }
  if ("_switch" in value) render(value._value, out, depth + 1);
}

function decodeAll(type, list) {
  const out = [];
  for (const b64 of list) render(type.fromXDR(b64, "base64"), out);
  return out;
}

/**
 * What a stranger gets for one transaction from RPC getTransaction, in every form the scan
 * searches: the raw XDR bytes of each part, and one text made of the base64 strings exactly as
 * RPC sent them plus the rendering of every decoded field. `raw` is the unparsed RPC reply
 * (rpc.Server#_getTransaction), so nothing is lost to the SDK's own parsing first.
 */
export function transactionHaystack(raw) {
  if (raw?.status !== "SUCCESS") throw new Error(`the transaction is ${raw?.status ?? "unknown"}, not SUCCESS`);
  const x = sdk.xdr;
  const parts = [
    { type: x.TransactionEnvelope, list: [raw.envelopeXdr] },
    { type: x.TransactionResult, list: [raw.resultXdr] },
    { type: x.TransactionMeta, list: [raw.resultMetaXdr] },
    { type: x.DiagnosticEvent, list: raw.diagnosticEventsXdr ?? [] },
    { type: x.TransactionEvent, list: raw.events?.transactionEventsXdr ?? [] },
    { type: x.ContractEvent, list: (raw.events?.contractEventsXdr ?? []).flat() },
  ];
  const bytes = [];
  const text = [];
  for (const { type, list } of parts) {
    for (const b64 of list) {
      if (typeof b64 !== "string") throw new Error("RPC returned a transaction part that is not base64 text");
      bytes.push(Buffer.from(b64, "base64"));
      text.push(b64);
    }
    text.push(...decodeAll(type, list));
  }
  return { bytes, text: text.join("\n"), size: bytes.reduce((n, b) => n + b.length, 0) };
}

/**
 * The same search space for a transaction past RPC's window, as a stranger can still get it:
 * Horizon's envelope, and its result and result meta when it serves them, plus the archive's raw
 * event rows for that transaction (each topic and data value as ScVal XDR). `parts` names what
 * was there to search, so the report can say what a later reader no longer gets.
 */
export function storedHaystack(horizon, eventRows) {
  const x = sdk.xdr;
  const parts = [
    { name: "envelope", type: x.TransactionEnvelope, list: [horizon.envelopeXdr] },
    { name: "result", type: x.TransactionResult, list: horizon.resultXdr ? [horizon.resultXdr] : [] },
    { name: "result meta", type: x.TransactionMeta, list: horizon.resultMetaXdr ? [horizon.resultMetaXdr] : [] },
    { name: "archived events", type: x.ScVal, list: eventRows.flatMap((r) => [...r.topicsXdr, r.dataXdr]) },
  ];
  const bytes = [];
  const text = [];
  for (const { type, list } of parts) {
    for (const b64 of list) {
      if (typeof b64 !== "string") throw new Error("a stored transaction part is not base64 text");
      bytes.push(Buffer.from(b64, "base64"));
      text.push(b64);
    }
    text.push(...decodeAll(type, list));
  }
  return {
    bytes,
    text: text.join("\n"),
    size: bytes.reduce((n, b) => n + b.length, 0),
    parts: parts.filter((p) => p.list.length > 0).map((p) => p.name),
  };
}

/** The names of the encodings of `needles` found in `haystack`. Empty means none. */
export function findAmount(haystack, needles) {
  const found = new Set();
  for (const needle of needles) {
    const hit = needle.kind === "bytes"
      ? haystack.bytes.some((b) => b.indexOf(needle.value) !== -1)
      : haystack.text.includes(needle.value);
    if (hit) found.add(needle.name);
  }
  return [...found];
}

/**
 * Refuses text bound for a public file if it holds a Stellar secret seed or any encoding of any
 * amount in `privateAmounts`. Raw-byte needles are checked as hex, the only way bytes reach text.
 */
export function assertPublicText(text, privateAmounts) {
  if (/S[A-Z2-7]{55}/.test(text)) throw new Error("refusing to write a public file that contains a Stellar secret seed");
  const haystack = { bytes: [Buffer.from(text, "utf8")], text };
  for (const amount of privateAmounts) {
    const found = findAmount(haystack, amountNeedles(amount));
    if (found.length > 0) throw new Error(`refusing to write a public file that contains a private amount (${found.join(", ")})`);
  }
}
