import { MAX_STROOPS, buildDeposit, buildMerge, confidentialBalance, inFlightKey } from "@kalypso/core";
import { Asset, Operation } from "../sandbox/sdk";
import type { WalletPort } from "../wallet/port";
import { consoleContext, reporter, type ConsoleContext, type OnProgress } from "./context";
import { clearDepositRecord, readDepositRecord, saveDepositRecord } from "./deposit-record";
import { ConsoleError } from "./errors";
import { walletKeys } from "./keys";
import { withWalletLock } from "./lock";
import { rebuildFromChain, type RebuiltTreasury } from "./rebuild";
import { confirmOnChain, sendCall, sendClassic, settle } from "./send";

export interface Trustline {
  /** True when this call opened it. */
  created: boolean;
  txHash?: string;
}

export interface FundedTreasury extends RebuiltTreasury {
  depositTx: string;
  mergeTx: string;
  /** The amount the deposit moved, in stroops: the saved one's when resumed. Public on chain. */
  deposited: bigint;
  /** True when this call finished a deposit an earlier session sent, instead of sending a new one. */
  resumed: boolean;
}

type Reporter = ReturnType<typeof reporter>;

// Only these answers prove a deposit never landed, so only they clear its record.
const NEVER_LANDED = new Set(["SUBMIT_REFUSED", "TRANSACTION_FAILED", "TRANSACTION_EXPIRED"]);

/**
 * Sends the treasury's deposit at most once. A deposit an earlier session saved is settled first,
 * by its hash and by chain time: landed means it is the deposit (no new one is sent); failed, or
 * expired once a ledger closed past its window, means it changed nothing, so its record goes and a
 * new deposit follows; still pending stops here. A new deposit's hash is saved after the wallet
 * signs and before the network sees it, so a crash mid-send always leaves a record to settle.
 * The record stays until the merge after it lands.
 */
async function depositOnce(ctx: ConsoleContext, wallet: WalletPort, amount: bigint, p: Reporter): Promise<{ hash: string; amount: bigint; resumed: boolean }> {
  const treasury = wallet.address;
  const saved = await readDepositRecord(ctx.text, treasury);
  if (saved !== undefined) {
    p.say("Checking the deposit this browser sent last time");
    let status: "SUCCESS" | "FAILED" | "NOT_FOUND";
    try {
      status = (await settle(ctx, saved.hash, saved.maxTime)).status;
    } catch (err) {
      if (err instanceof ConsoleError && err.code === "TRANSACTION_PENDING") throw new ConsoleError("DEPOSIT_PENDING");
      throw err;
    }
    if (status === "SUCCESS") return { hash: saved.hash, amount: saved.amount, resumed: true };
    await clearDepositRecord(ctx.text, treasury);
  }

  const usdc = await ctx.ledger.usdcBalance(treasury);
  if (usdc === null || usdc < amount) throw new ConsoleError("USDC_SHORT");
  p.say("Depositing testnet USDC into the confidential treasury");
  try {
    const sent = await sendCall(ctx, wallet, {
      what: "deposit",
      contractId: ctx.config.contracts.token,
      build: (base) => buildDeposit(base, { from: treasury, to: treasury, amount }),
      beforeSubmit: (hash, validUntil) => saveDepositRecord(ctx.text, treasury, { hash, amount, maxTime: validUntil }),
    });
    return { hash: sent.hash, amount, resumed: false };
  } catch (err) {
    if (err instanceof ConsoleError && NEVER_LANDED.has(err.code)) await clearDepositRecord(ctx.text, treasury);
    throw err;
  }
}

async function trustline(ctx: ConsoleContext, wallet: WalletPort, onProgress: OnProgress | undefined): Promise<Trustline> {
  const p = reporter(onProgress, 1);
  if ((await ctx.ledger.xlmBalance(wallet.address)) === null) throw new ConsoleError("ACCOUNT_NOT_FOUND");
  if ((await ctx.ledger.usdcBalance(wallet.address)) !== null) {
    p.tick("This wallet can hold testnet USDC");
    return { created: false };
  }
  p.say("Opening a USDC trustline so this wallet can hold testnet USDC");
  const sent = await sendClassic(ctx, wallet, {
    what: "USDC trustline",
    operations: [Operation.changeTrust({ asset: new Asset("USDC", ctx.config.usdc.issuer) })],
  });
  await confirmOnChain(ctx, "The USDC trustline", async () => (await ctx.ledger.usdcBalance(wallet.address)) !== null);
  p.tick("This wallet can hold testnet USDC", sent.hash);
  return { created: true, txHash: sent.hash };
}

/**
 * Opens this wallet's trustline to Circle's testnet USDC unless it has one. A wallet needs it
 * before it can receive USDC at all, so the screen can offer it before the employer goes to get
 * some.
 *
 * @throws ConsoleError ACCOUNT_NOT_FOUND, BUSY, NOT_ON_CHAIN, any sendCall code; the wallet's own error.
 */
export async function ensureUsdcTrustline(wallet: WalletPort, onProgress?: OnProgress): Promise<Trustline> {
  const ctx = consoleContext();
  return withWalletLock(wallet.address, () => trustline(ctx, wallet, onProgress));
}

/**
 * Moves `amount` stroops of this wallet's public testnet USDC into its confidential treasury:
 * the USDC trustline if missing, then deposit(amount) to itself, then merge, then
 * rebuildTreasuryOpening, so the opening this browser pays from is always the one the chain's
 * history rebuilds and checks against confidential_balance (threat model C16). No opening is
 * ever computed by hand.
 *
 * A crash mid-send never deposits twice: the deposit's hash is saved under
 * kalypso/employer/v1/deposit/{treasury} before it is submitted, and the next call settles it
 * first. If it landed, that deposit is finished (merged and rebuilt) and no new one is sent:
 * `resumed` is true and `deposited` is its amount, which can differ from `amount`, so the screen
 * should say so. The deposit amount is public on chain, as every deposit is.
 *
 * The wallet is asked for the two key signatures first, before anything is sent.
 *
 * @throws ConsoleError AMOUNT_INVALID, KEY_NOT_DERIVED, ACCOUNT_NOT_FOUND, TREASURY_NOT_REGISTERED,
 *   PAYMENT_PENDING (a pay from this browser is not settled yet), DEPOSIT_PENDING (the saved deposit
 *   is not final yet), USDC_SHORT (with where to get testnet USDC), BUSY, NOT_ON_CHAIN, any sendCall
 *   code, and the rebuild's codes; the wallet's own error.
 */
export async function fundTreasury(wallet: WalletPort, input: { amount: bigint }, onProgress?: OnProgress): Promise<FundedTreasury> {
  const { amount } = input;
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_STROOPS) throw new ConsoleError("AMOUNT_INVALID");
  const ctx = consoleContext();
  const { config } = ctx;
  const treasury = wallet.address;
  const token = config.contracts.token;

  return withWalletLock(treasury, async () => {
    const p = reporter(onProgress, 5);
    // Asked before anything is sent, so a person who declines the key prompts has moved nothing;
    // the rebuild at the end reuses these keys without asking again.
    p.say("Sign the Kalypso key message twice in your wallet to open the treasury");
    await walletKeys(wallet, { domain: config.keyDomain, token });
    p.tick("The treasury is open in this browser");

    // Only the trustline's "opening" sentence is passed on; its last one is this step's own tick.
    const line = await trustline(ctx, wallet, (e) => {
      if (e.done === 0) p.say(e.sentence);
    });
    p.tick("This wallet can hold testnet USDC", line.txHash);

    const account = await confidentialBalance(ctx.port, token, treasury);
    if (account === null) throw new ConsoleError("TREASURY_NOT_REGISTERED");
    // A merge changes the spendable balance a pay in flight was proved on, so funding waits for it.
    if ((await ctx.store.get(inFlightKey(token, treasury))) !== undefined) throw new ConsoleError("PAYMENT_PENDING");

    const deposit = await depositOnce(ctx, wallet, amount, p);
    p.tick(deposit.resumed ? "Your earlier deposit had landed, so no new one was sent" : "The deposit is in the treasury's incoming balance", deposit.hash);

    // Always merged, a resumed deposit too: a read that lags the deposit could show nothing
    // incoming, and merging an empty incoming balance changes nothing on chain.
    p.say("Merging the deposit into the treasury balance");
    const merge = await sendCall(ctx, wallet, { what: "merge", contractId: token, build: (base) => buildMerge(base, { account: treasury }) });
    await clearDepositRecord(ctx.text, treasury);
    p.tick("The deposit is merged into the treasury balance", merge.hash);

    p.say("Rebuilding the treasury balance from the chain's history");
    const rebuilt = await rebuildFromChain(ctx, wallet);
    p.tick("This browser can pay from the treasury balance the chain shows");
    return { ...rebuilt, depositTx: deposit.hash, mergeTx: merge.hash, deposited: deposit.amount, resumed: deposit.resumed };
  });
}
