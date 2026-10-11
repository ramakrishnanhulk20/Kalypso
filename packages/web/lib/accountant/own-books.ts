import { confidentialBalance, getOwnerOf } from "@kalypso/core";
import { checkAccountant, type AccountantCheck } from "../employer/setup";
import { consoleContext, reporter, type ConsoleContext, type OnProgress } from "../employer/context";
import { ConsoleError } from "../employer/errors";
import type { WalletPort } from "../wallet/port";
import { accountantSecret, holds, keyHex, registerAccountantKey } from "./key";

const MAX_U32 = 0xffff_ffff;

export interface OwnBooks extends AccountantCheck {
  /** True when an id this wallet already owned held this key, so nothing was sent. */
  reused: boolean;
  /** The register_key transaction, when this call sent one. */
  txHash?: string;
}

/** What the chain says about keeping one's own books with this wallet, before anything is signed. */
export interface OwnBooksState {
  /** The key number this wallet's treasury is registered under with the token, or null before its first company. */
  bound: number | null;
  /** False when the treasury is bound to a key number another address owns: own books is then impossible for this wallet. */
  ownable: boolean;
}

/** The key number the treasury's token registration names, or null when it is not registered. */
async function boundId(ctx: ConsoleContext, treasury: string): Promise<number | null> {
  const account = await confidentialBalance(ctx.port, ctx.config.contracts.token, treasury);
  return account === null ? null : account.auditorId;
}

/**
 * Reads whether this wallet may keep its own books. A token registration binds a treasury to one
 * key number for good, so every company this wallet pays from shares that number: once it names
 * an outside accountant, this wallet cannot keep its own books. Nothing is signed.
 *
 * @throws the network's own error when the token or the registry cannot be read.
 */
export async function readOwnBooksState(wallet: WalletPort): Promise<OwnBooksState> {
  const ctx = consoleContext();
  const bound = await boundId(ctx, wallet.address);
  if (bound === null) return { bound, ownable: true };
  return { bound, ownable: (await getOwnerOf(ctx.port, ctx.config.contracts.auditor, bound)) === wallet.address };
}

/**
 * Makes this wallet the accountant of the company it is about to set up, so one person keeps their
 * own books. The accountant key comes from the same two wallet signatures the Accountant page asks
 * for (or from this page's memory of them), so that page opens the books with the same wallet.
 *
 * 1. When this wallet's treasury is already registered with the token (an earlier company), its
 *    registration names a key number for good, so that number is the only one it can use: it is
 *    reused when the registry, read now, says this wallet owns it and holds this key, and own books
 *    is refused otherwise, before any signature when another address owns it.
 *    Before the treasury's first registration: with knownId (an id this browser saw this wallet
 *    register, as an unfinished setup leaves), the id is reused when the registry says this wallet
 *    owns it and holds this key. Otherwise the key is registered through registerAccountantKey,
 *    owned by this wallet, and its id is read only from the confirmed register_key's return value.
 * 2. The id then goes through checkAccountant, the same owner and key read the employer's
 *    "Check" runs for someone else's id (C43): the registry must name this wallet as the owner and
 *    hold exactly this wallet's key. The result is what setUpCompany takes, and setUpCompany reads
 *    both again right before the treasury registers.
 *
 * @throws ConsoleError OWN_BOOKS_TAKEN (the treasury is bound to a key number this wallet does not
 *   own or whose key is not this wallet's), ACCOUNTANT_ID_INVALID (knownId is not a u32), ACCOUNTANT_MISMATCH (the id
 *   changed hands between the reads), ACCOUNTANT_ID_NOT_YOURS (the key under the id is not this
 *   wallet's), DEMO_ACCOUNTANT, ACCOUNTANT_UNKNOWN, ACCOUNT_NOT_FOUND, BUSY, CHAIN_DISAGREES,
 *   NOT_ON_CHAIN, KEY_NOT_DERIVED or any sendCall code; the wallet's own error.
 */
export async function keepOwnBooks(wallet: WalletPort, input: { knownId?: number } = {}, onProgress?: OnProgress): Promise<OwnBooks> {
  const { knownId } = input;
  if (knownId !== undefined && (!Number.isSafeInteger(knownId) || knownId < 0 || knownId > MAX_U32)) throw new ConsoleError("ACCOUNTANT_ID_INVALID");
  const ctx = consoleContext();
  const bound = await boundId(ctx, wallet.address);
  if (bound !== null && (await getOwnerOf(ctx.port, ctx.config.contracts.auditor, bound)) !== wallet.address) throw new ConsoleError("OWN_BOOKS_TAKEN");
  const p = reporter(onProgress, 2);
  p.say("keys_accountant");
  const { point } = await accountantSecret(wallet);

  let accountantId: number;
  let txHash: string | undefined;
  let reused: boolean;
  if (bound !== null) {
    if (!(await holds(bound, wallet.address, point))) throw new ConsoleError("OWN_BOOKS_TAKEN");
    accountantId = bound;
    reused = true;
  } else if (knownId !== undefined && (await holds(knownId, wallet.address, point))) {
    accountantId = knownId;
    reused = true;
  } else {
    reused = false;
    const registered = await registerAccountantKey(wallet, {}, (step) => p.say(step.step, step.values, step.txHash));
    accountantId = registered.accountantId;
    txHash = registered.txHash;
  }
  p.tick("own_books_number", { id: String(accountantId) }, txHash);

  p.say("own_books_checking");
  const checked = await checkAccountant({ accountantId, accountant: wallet.address });
  // Both keys come out of the one encoder, keyHex, so equal points give equal text.
  if (checked.keyHex !== keyHex(point)) throw new ConsoleError("ACCOUNTANT_ID_NOT_YOURS");
  p.tick("own_books_checked", { id: String(accountantId) });
  return txHash === undefined ? { ...checked, reused } : { ...checked, reused, txHash };
}
