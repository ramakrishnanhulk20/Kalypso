import {
  AddressError,
  AuditorErrorCode,
  ContractCallError,
  MAX_COMPANY_LABEL_BYTES,
  PUBLISHED_DEMO_AUDITOR_IDS,
  PayrollErrorCode,
  buildCheckedRegister,
  buildCreateCompany,
  confidentialBalance,
  decodeContractEvent,
  getAuditorKey,
  getCompany,
  getOwnerOf,
  isPayrollError,
  parseAccount,
  parseRpcEventId,
  requireOnCurvePoint,
} from "@kalypso/core";
import type { Company, ContractEventsQuery, KalypsoKeys } from "@kalypso/core";
import { keyHex, shortKeyHex } from "../accountant/key";
import type { Point, xdr } from "../sandbox/sdk";
import type { WalletPort } from "../wallet/port";
import { PAYROLL_FROM_LEDGER, consoleContext, reporter, type ConsoleContext, type OnProgress } from "./context";
import { ConsoleError } from "./errors";
import { walletKeys } from "./keys";
import { withWalletLock } from "./lock";
import { confirmOnChain, sendCall } from "./send";

const MAX_U32 = 0xffff_ffff;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const KEY_HEX = /^[0-9a-f]{128}$/;
const SCAN_PAGE = 200;
// 10,000 payroll events. The scan only avoids a duplicate company after a crash mid-send, so a
// cap that stops it early can at worst create a second company record, never move money.
const MAX_SCAN_PAGES = 50;

export interface AccountantCheck {
  accountantId: number;
  /** The accountant's address, as the registry names the id's owner. */
  accountant: string;
  /** The key under the id, 128 hex characters. Pass it back to setUpCompany once confirmed. */
  keyHex: string;
  /** The first 16 hex characters, in groups of four, for the accountant to confirm out of band. */
  shortKeyHex: string;
}

export interface CompanySetUp {
  companyId: bigint;
  treasury: string;
  label: string;
  accountantId: number;
  accountant: string;
  /** What this call sent, in order. Empty when everything was already on chain. */
  transactions: { what: string; hash: string }[];
}

function requireAccountant(input: { accountantId: number; accountant: string }): { accountantId: number; accountant: string } {
  const { accountantId } = input;
  if (!Number.isSafeInteger(accountantId) || accountantId < 0 || accountantId > MAX_U32) throw new ConsoleError("ACCOUNTANT_ID_INVALID");
  try {
    return { accountantId, accountant: parseAccount(input.accountant).address };
  } catch (err) {
    if (err instanceof AddressError) throw new ConsoleError("ACCOUNTANT_ADDRESS_INVALID", { message: `The accountant's address: ${err.message}` });
    throw err;
  }
}

/**
 * True when `accountantId` is one whose secret key Kalypso publishes on purpose in this registry
 * (threat model C34, C47), so anything sealed to it can be read by anyone. It covers the ids core's
 * PUBLISHED_DEMO_AUDITOR_IDS lists, not a key its own holder leaked. The registry goes through
 * parseAccount first, the same decoding core's run engine applies before its own lookup.
 *
 * @throws AddressError when `registry` is not a valid address.
 */
export function isPublishedDemoAccountant(registry: string, accountantId: number): boolean {
  const { address } = parseAccount(registry);
  const ids = Object.hasOwn(PUBLISHED_DEMO_AUDITOR_IDS, address) ? PUBLISHED_DEMO_AUDITOR_IDS[address] : undefined;
  return ids?.includes(accountantId) ?? false;
}

// A token registration can never move to another id, so this runs before any read or signature.
function refusePublished(ctx: ConsoleContext, accountantId: number): void {
  if (isPublishedDemoAccountant(ctx.config.contracts.auditor, accountantId)) throw new ConsoleError("DEMO_ACCOUNTANT");
}

/** The key under the id, refused unless the registry names this accountant as its owner. Outages throw as themselves. */
async function readAccountant(ctx: ConsoleContext, accountantId: number, accountant: string): Promise<Point> {
  const registry = ctx.config.contracts.auditor;
  const unknownAs = (code: number) => (err: unknown) => {
    if (err instanceof ContractCallError && err.contractCode === code) throw new ConsoleError("ACCOUNTANT_UNKNOWN");
    throw err;
  };
  // Both sides come out of the one address parser: parseAccount for the input, the SDK's address
  // decoder (which yields the same canonical text) for the chain's answer.
  const owner = await getOwnerOf(ctx.port, registry, accountantId).catch(unknownAs(AuditorErrorCode.UnknownAuditor));
  if (owner !== accountant) throw new ConsoleError("ACCOUNTANT_MISMATCH");
  return getAuditorKey(ctx.port, registry, accountantId).catch(unknownAs(AuditorErrorCode.AuditorNotRegistered));
}

/**
 * Reads, for the employer, who owns an accountant id and which key it holds, and refuses unless
 * the owner is the address the accountant gave. Show shortKeyHex to the employer and ask them to
 * check it against the accountant's own screen before calling setUpCompany. Nothing is signed.
 * An id whose key is published on purpose is refused before the registry is read.
 *
 * @throws ConsoleError ACCOUNTANT_ID_INVALID, ACCOUNTANT_ADDRESS_INVALID, DEMO_ACCOUNTANT,
 *   ACCOUNTANT_UNKNOWN or ACCOUNTANT_MISMATCH; the network's own error when the registry cannot be read.
 */
export async function checkAccountant(input: { accountantId: number; accountant: string }): Promise<AccountantCheck> {
  const { accountantId, accountant } = requireAccountant(input);
  const ctx = consoleContext();
  refusePublished(ctx, accountantId);
  const key = await readAccountant(ctx, accountantId, accountant);
  return { accountantId, accountant, keyHex: keyHex(key), shortKeyHex: shortKeyHex(key) };
}

function requireLabel(label: unknown): string {
  if (typeof label !== "string") throw new ConsoleError("LABEL_INVALID");
  const bytes = new TextEncoder().encode(label).length;
  if (bytes === 0 || bytes > MAX_COMPANY_LABEL_BYTES) throw new ConsoleError("LABEL_INVALID");
  return label;
}

function confirmedKey(hex: unknown): Point {
  if (typeof hex !== "string" || !KEY_HEX.test(hex)) throw new ConsoleError("ACCOUNTANT_KEY_INVALID");
  const bytes = Uint8Array.from(hex.match(/../g) as string[], (pair) => parseInt(pair, 16));
  let point: Point;
  try {
    point = requireOnCurvePoint(bytes, "accountant key");
  } catch {
    throw new ConsoleError("ACCOUNTANT_KEY_INVALID");
  }
  if (point.is0()) throw new ConsoleError("ACCOUNTANT_KEY_INVALID");
  return point;
}

async function companyOrNull(ctx: ConsoleContext, companyId: bigint): Promise<Company | null> {
  try {
    return await getCompany(ctx.port, ctx.config.contracts.payroll, companyId);
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) return null;
    throw err;
  }
}

interface Expected {
  admin: string;
  accountant: string;
  auditorId: number;
  label: string;
}

const sameCompany = (c: Company, e: Expected) => c.admin === e.admin && c.accountant === e.accountant && c.auditorId === e.auditorId && c.label === e.label;

/**
 * A company this admin already created with exactly these settings, found from the payroll
 * contract's company_created events and confirmed with get_company, newest first. It is how a
 * set-up that crashed after create_company was sent finds that company instead of making another.
 * It reads what the RPC still holds (about 7 days), at most MAX_SCAN_PAGES pages.
 */
async function findCreatedCompany(ctx: ConsoleContext, expected: Expected): Promise<bigint | null> {
  const { payroll, token } = ctx.config.contracts;
  const window = await ctx.events.ledgerWindow();
  const start = Math.max(PAYROLL_FROM_LEDGER, window.oldestLedger);
  if (start > window.latestLedger) return null;
  const ids: bigint[] = [];
  let query: ContractEventsQuery = { contractId: payroll, limit: SCAN_PAGE, startLedger: start };
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const reply = await ctx.events.contractEvents(query);
    for (const raw of reply.events) {
      if (!raw.successful || raw.contractId !== payroll) continue;
      let event: ReturnType<typeof decodeContractEvent>;
      try {
        event = decodeContractEvent(raw, { payroll, token });
      } catch {
        continue;
      }
      if (event.kind !== "payroll" || event.event.type !== "company_created") continue;
      const created = event.event;
      if (created.admin === expected.admin && created.accountant === expected.accountant && created.auditorId === expected.auditorId && created.label === expected.label) {
        ids.push(created.companyId);
      }
    }
    if (reply.cursor === null) break;
    const scanned = parseRpcEventId(reply.cursor).ledger;
    if (reply.events.length < SCAN_PAGE && scanned >= reply.latestLedger) break;
    if ("cursor" in query && query.cursor === reply.cursor) break;
    query = { contractId: payroll, limit: SCAN_PAGE, cursor: reply.cursor };
  }
  for (const id of ids.reverse()) {
    const company = await companyOrNull(ctx, id);
    if (company !== null && sameCompany(company, expected)) return id;
  }
  return null;
}

/**
 * True when the treasury is registered with the token under the accountant's id with these keys.
 * A token registration is permanent, so one made any other way stops the set-up.
 */
async function treasuryRegistered(ctx: ConsoleContext, treasury: string, keys: KalypsoKeys, accountantId: number): Promise<boolean> {
  const account = await confidentialBalance(ctx.port, ctx.config.contracts.token, treasury);
  if (account === null) return false;
  if (!account.pvk.equals(keys.PVK)) throw new ConsoleError("TREASURY_KEYS_MISMATCH");
  if (account.auditorId !== accountantId) throw new ConsoleError("TREASURY_BOUND_ELSEWHERE");
  return true;
}

function companyIdOf(value: xdr.ScVal | undefined): bigint {
  if (value === undefined || value.switch().name !== "scvU64") {
    throw new ConsoleError("CHAIN_DISAGREES", { message: "The company was created, but the network did not say its id. Look the transaction up on stellar.expert to find it." });
  }
  return BigInt(value.u64().toString());
}

/**
 * Sets up a company whose treasury is this wallet and whose books open with the named
 * accountant's key. An id whose key is published on purpose is refused before anything is read or
 * signed. Each step reads the chain first and skips what is already there:
 *
 * 1. The registry is read again: the id's owner must be `accountant` and its key must equal
 *    accountantKeyHex, the key the employer confirmed from checkAccountant.
 * 2. With companyId, that company must exist with this admin, accountant, id and label, and
 *    nothing is sent. Without it, a company this admin created with the same settings is looked
 *    up from the payroll's events and reused if found.
 * 3. The treasury keys come from two wallet signatures (token id, this address; C15, C40).
 * 4. The treasury registers with the token under the accountant's id through core's
 *    buildCheckedRegister, which reads the id's owner and key from chain right before the
 *    registration is built (C33, C43), with the key just read from chain as the expected key.
 * 5. create_company(admin, accountant, id, label); its id comes from the confirmed return value
 *    and is read back with get_company before it is returned.
 *
 * @throws ConsoleError ACCOUNTANT_ID_INVALID, ACCOUNTANT_ADDRESS_INVALID, DEMO_ACCOUNTANT,
 *   ACCOUNTANT_UNKNOWN, ACCOUNTANT_MISMATCH, ACCOUNTANT_KEY_INVALID, ACCOUNTANT_KEY_CHANGED, LABEL_INVALID,
 *   COMPANY_ID_INVALID, COMPANY_NOT_FOUND, COMPANY_MISMATCH, ACCOUNT_NOT_FOUND,
 *   TREASURY_KEYS_MISMATCH, TREASURY_BOUND_ELSEWHERE, KEY_NOT_DERIVED, BUSY, CHAIN_DISAGREES,
 *   NOT_ON_CHAIN or any sendCall code; the wallet's own error; AuditorBindingError from core
 *   when the id changed hands between the reads.
 */
export async function setUpCompany(
  wallet: WalletPort,
  input: { accountantId: number; accountant: string; accountantKeyHex: string; label: string; companyId?: bigint },
  onProgress?: OnProgress,
): Promise<CompanySetUp> {
  const { accountantId, accountant } = requireAccountant(input);
  const label = requireLabel(input.label);
  const confirmed = confirmedKey(input.accountantKeyHex);
  const known = input.companyId;
  if (known !== undefined && (typeof known !== "bigint" || known < 0n || known > MAX_U64)) throw new ConsoleError("COMPANY_ID_INVALID");
  const ctx = consoleContext();
  refusePublished(ctx, accountantId);
  const { config } = ctx;
  const treasury = wallet.address;
  const expected: Expected = { admin: treasury, accountant, auditorId: accountantId, label };

  return withWalletLock(treasury, async () => {
    const p = reporter(onProgress, 3);
    const transactions: CompanySetUp["transactions"] = [];
    const done = (companyId: bigint): CompanySetUp => ({ companyId, treasury, label, accountantId, accountant, transactions });

    p.say("Checking the accountant id on chain");
    const key = await readAccountant(ctx, accountantId, accountant);
    if (!key.equals(confirmed)) throw new ConsoleError("ACCOUNTANT_KEY_CHANGED");
    p.tick(`Accountant id ${accountantId} belongs to the accountant and holds the key you confirmed`);

    if (known !== undefined) {
      const company = await companyOrNull(ctx, known);
      if (company === null) throw new ConsoleError("COMPANY_NOT_FOUND");
      if (!sameCompany(company, expected)) throw new ConsoleError("COMPANY_MISMATCH");
      p.tick("The company's wallet is registered with the confidential token");
      p.tick(`Company ${known} already exists on the payroll contract`);
      return done(known);
    }
    p.say("Looking for a company this wallet already set up");
    const found = await findCreatedCompany(ctx, expected);
    if (found !== null) {
      p.tick("The company's wallet is registered with the confidential token");
      p.tick(`Company ${found} already exists on the payroll contract`);
      return done(found);
    }

    if ((await ctx.ledger.xlmBalance(treasury)) === null) throw new ConsoleError("ACCOUNT_NOT_FOUND");
    p.say("Sign the Kalypso key message twice in your wallet to make the company's private payroll key");
    const keys = await walletKeys(wallet, { domain: config.keyDomain, token: config.contracts.token });

    if (!(await treasuryRegistered(ctx, treasury, keys, accountantId))) {
      const sent = await sendCall(ctx, wallet, {
        what: "token registration",
        contractId: config.contracts.token,
        build: async (base) => {
          p.say("Proving the company's registration in your browser");
          const envelope = await (await ctx.prover()).proveRegister(keys);
          p.say("Registering the company's wallet with the confidential token");
          return buildCheckedRegister(ctx.port, base, {
            account: treasury,
            auditorId: accountantId,
            data: envelope,
            registry: config.contracts.auditor,
            auditorOwner: accountant,
            auditorKey: key,
          });
        },
      });
      transactions.push({ what: "token registration", hash: sent.hash });
      await confirmOnChain(ctx, "The company's token registration", () => treasuryRegistered(ctx, treasury, keys, accountantId));
      p.tick("The company's wallet is registered under the accountant's id", sent.hash);
    } else {
      p.tick("The company's wallet is registered with the confidential token");
    }

    p.say(`Creating ${label} on the payroll contract`);
    const created = await sendCall(ctx, wallet, {
      what: "create_company",
      contractId: config.contracts.payroll,
      build: (base) => buildCreateCompany(base, expected),
    });
    transactions.push({ what: "create_company", hash: created.hash });
    const companyId = companyIdOf(created.returnValue);
    await confirmOnChain(ctx, "The company", async () => {
      const company = await companyOrNull(ctx, companyId);
      return company !== null && sameCompany(company, expected);
    });
    p.tick(`Company ${companyId} exists on the payroll contract`, created.hash);
    return done(companyId);
  });
}
