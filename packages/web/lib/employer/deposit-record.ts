import { MAX_STROOPS, parseAccount } from "@kalypso/core";
import type { TextStore } from "./opening-store";

/** A deposit this browser signed whose result it has not seen yet. */
export interface DepositRecord {
  /** The deposit transaction's hash, 64 lowercase hex characters. */
  hash: string;
  /** The amount in stroops, public on chain like every deposit. */
  amount: bigint;
  /** The transaction's last valid moment, in Unix seconds. */
  maxTime: number;
}

const TX_HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^[1-9]\d{0,18}$/;

/** Store key of the treasury's deposit in flight. One per treasury: a deposit waits for the last to settle. */
export function depositRecordKey(treasury: string): string {
  return `kalypso/employer/v1/deposit/${parseAccount(treasury).address}`;
}

/**
 * A saved deposit, read back as untrusted: exactly { hash, amount, maxTime } with a 64 hex hash,
 * a decimal amount from 1 stroop to MAX_STROOPS and a positive whole maxTime. Anything else reads
 * as missing, as the opening store does: the worst a damaged record can then cause is one more
 * deposit into the employer's own treasury, never a payment to anyone else.
 */
export function parseDepositRecord(raw: unknown): DepositRecord | undefined {
  if (typeof raw !== "string" || raw.length > 1_000) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { hash, amount, maxTime } = value as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || typeof hash !== "string" || !TX_HASH.test(hash)) return undefined;
  if (typeof amount !== "string" || !DECIMAL.test(amount) || BigInt(amount) > MAX_STROOPS) return undefined;
  if (typeof maxTime !== "number" || !Number.isSafeInteger(maxTime) || maxTime <= 0) return undefined;
  return { hash, amount: BigInt(amount), maxTime };
}

export async function readDepositRecord(text: TextStore, treasury: string): Promise<DepositRecord | undefined> {
  return parseDepositRecord(await text.get(depositRecordKey(treasury)));
}

/**
 * Saves the deposit before it is submitted, the amount as a decimal string. A record that would
 * not read back is refused before anything is written, so nothing is sent without one.
 *
 * @throws TypeError for such a record; ConsoleError STORAGE_FAILED when the browser refuses the write.
 */
export async function saveDepositRecord(text: TextStore, treasury: string, record: DepositRecord): Promise<void> {
  const json = JSON.stringify({ hash: record.hash, amount: String(record.amount), maxTime: record.maxTime });
  if (parseDepositRecord(json)?.hash !== record.hash) throw new TypeError("this deposit record could not be read back, so it was not kept");
  await text.put(depositRecordKey(treasury), json);
}

export async function clearDepositRecord(text: TextStore, treasury: string): Promise<void> {
  await text.delete(depositRecordKey(treasury));
}
