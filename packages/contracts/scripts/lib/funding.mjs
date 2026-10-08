// Testnet money for the showcase. Friendbot gives each throwaway account 10,000 XLM, and
// funders swap XLM for Circle's testnet USDC on the testnet DEX with path payments. Every
// purchase is measured first against the pool's own reserves and refused if it would cost more
// than 1% over the pool price or take more than 1% of the pool's USDC, so the seed never drains
// the pool every other testnet project buys from.
import { classic } from "./transactions.mjs";
import { core, rpcServer, sdk, stack } from "./kalypso.mjs";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const HTTP_TIMEOUT_MS = 10_000;
const FRIENDBOT_TRIES = 5;

export const MAX_COST_OVER_POOL_PRICE = 0.01;
export const MAX_POOL_SHARE = 0.01;
// A funder keeps this much of its friendbot XLM for its minimum balance and fees.
export const XLM_KEPT_STROOPS = 50_0000000n;
export const FRIENDBOT_XLM_STROOPS = 10_000_0000000n;
// The path payment may spend this much more XLM than quoted, in case the pool moves in between.
const SEND_MAX_MARGIN = 1.005;
const CENT = 100_000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// XLM and USDC both have 7 decimals, so core's one amount parser reads Horizon's amounts too.
const stroopsOf = (text) => core.parseUsdc(String(text));
const decimal = (stroops) => core.formatUsdc(stroops);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return res.json();
}

async function ledgerEntry(key) {
  const res = await rpcServer.getLedgerEntries(key);
  return res.entries[0]?.val ?? null;
}

const accountKey = (g) => sdk.xdr.LedgerKey.account(new sdk.xdr.LedgerKeyAccount({ accountId: sdk.Keypair.fromPublicKey(g).xdrPublicKey() }));

/** The account's XLM balance in stroops, or null when the account does not exist. */
export async function xlmBalance(g) {
  const entry = await ledgerEntry(accountKey(g));
  return entry ? BigInt(entry.account().balance().toString()) : null;
}

/** The account's USDC balance in stroops, or null when it has no USDC trustline. */
export async function usdcBalance(g) {
  const key = sdk.xdr.LedgerKey.trustline(
    new sdk.xdr.LedgerKeyTrustLine({ accountId: sdk.Keypair.fromPublicKey(g).xdrPublicKey(), asset: stack.usdc.asset.toTrustLineXDRObject() }),
  );
  const entry = await ledgerEntry(key);
  return entry ? BigInt(entry.trustLine().balance().toString()) : null;
}

/** Creates `g` with friendbot's 10,000 XLM unless it already exists. Returns true if it did. */
export async function ensureFunded(g) {
  if ((await xlmBalance(g)) !== null) return false;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(g)}`, { signal: AbortSignal.timeout(30_000), redirect: "error" }).catch((e) => ({ ok: false, status: e.name }));
    if (res.ok) break;
    // Friendbot answers 400 when the account already exists, for example after a lost reply.
    if ((await xlmBalance(g)) !== null) return true;
    if (attempt === FRIENDBOT_TRIES) throw new Error(`friendbot refused ${g} ${FRIENDBOT_TRIES} times, last status ${res.status}`);
    await sleep(3000 * attempt);
  }
  for (let i = 0; i < 15; i++) {
    if ((await xlmBalance(g)) !== null) return true;
    await sleep(2000);
  }
  throw new Error(`friendbot said yes but ${g} did not appear on chain`);
}

/** The hash of the transaction that created account `g`, read from Horizon's first operation on it. */
export async function creationTxHash(g) {
  const page = await getJson(`${HORIZON}/accounts/${encodeURIComponent(g)}/operations?order=asc&limit=1`);
  const first = page._embedded.records[0];
  if (first?.type !== "create_account" || first.account !== g) throw new Error(`Horizon does not show how ${g} was created`);
  return first.transaction_hash;
}

/** Adds a USDC trustline to `keypair`'s account unless it has one. Returns the transaction, or null. */
export async function ensureTrustline({ label, keypair, journal }) {
  if ((await usdcBalance(keypair.publicKey())) !== null) return null;
  return classic({ label, signer: keypair, operations: [sdk.Operation.changeTrust({ asset: stack.usdc.asset })], journal });
}

/** The XLM/USDC constant-product pool with the most USDC, read from Horizon. */
export async function usdcPool() {
  const reserves = `native,USDC:${stack.usdc.issuer}`;
  const page = await getJson(`${HORIZON}/liquidity_pools?reserves=${encodeURIComponent(reserves)}&limit=20`);
  const pools = page._embedded.records
    .filter((p) => p.reserves.length === 2 && p.reserves.some((r) => r.asset === "native") && p.reserves.some((r) => r.asset === `USDC:${stack.usdc.issuer}`))
    .map((p) => ({
      id: p.id,
      feeBp: p.fee_bp,
      xlm: stroopsOf(p.reserves.find((r) => r.asset === "native").amount),
      usdc: stroopsOf(p.reserves.find((r) => r.asset !== "native").amount),
    }));
  if (pools.length === 0) throw new Error("there is no XLM/USDC pool on the testnet DEX");
  return pools.reduce((a, b) => (b.usdc > a.usdc ? b : a));
}

/** The cheapest XLM price Horizon finds for receiving exactly `usdc` stroops of USDC. */
export async function quote(usdc) {
  const q = new URLSearchParams({
    source_assets: "native",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: stack.usdc.issuer,
    destination_amount: decimal(usdc),
  });
  const page = await getJson(`${HORIZON}/paths/strict-receive?${q}`);
  const best = page._embedded.records
    .map((r) => ({ xlm: stroopsOf(r.source_amount), path: r.path }))
    .reduce((a, b) => (a === null || b.xlm < a.xlm ? b : a), null);
  if (!best) throw new Error("Horizon finds no XLM to USDC path");
  return best;
}

/**
 * Measures a purchase of `usdc` stroops: the pool, the quote, and how much more than the pool
 * price the quote costs. Refuses when either limit is passed.
 */
export async function measurePurchase(usdc) {
  const pool = await usdcPool();
  const share = Number(usdc) / Number(pool.usdc);
  if (share > MAX_POOL_SHARE) throw new Error(`buying would take ${(share * 100).toFixed(3)}% of the pool's USDC, above the ${MAX_POOL_SHARE * 100}% limit`);
  const q = await quote(usdc);
  const poolPrice = Number(pool.xlm) / Number(pool.usdc);
  const paid = Number(q.xlm) / Number(usdc);
  const costOverPool = paid / poolPrice - 1;
  if (costOverPool > MAX_COST_OVER_POOL_PRICE) {
    throw new Error(`the quote costs ${(costOverPool * 100).toFixed(2)}% over the pool price, above the ${MAX_COST_OVER_POOL_PRICE * 100}% limit`);
  }
  return { pool, quote: q, share, costOverPool, xlmPerUsdc: paid };
}

const assetOf = (r) => (r.asset_type === "native" ? sdk.Asset.native() : new sdk.Asset(r.asset_code, r.asset_issuer));

/** Buys exactly `usdc` stroops of USDC with `funder`'s XLM and delivers it to `destination` in one path payment. */
export async function buyUsdc({ label, funder, destination, usdc, journal }) {
  const m = await measurePurchase(usdc);
  const sendMax = (m.quote.xlm * BigInt(Math.round(SEND_MAX_MARGIN * 1000))) / 1000n;
  const op = sdk.Operation.pathPaymentStrictReceive({
    sendAsset: sdk.Asset.native(),
    sendMax: decimal(sendMax),
    destination,
    destAsset: stack.usdc.asset,
    destAmount: decimal(usdc),
    path: m.quote.path.map(assetOf),
  });
  const tx = await classic({ label, signer: funder, operations: [op], journal });
  return { ...tx, measured: m };
}

/**
 * Tops `destination` up to `target` stroops of USDC, buying with each funder in turn until it is
 * reached. What is still missing is read from the chain before every purchase, so a resumed
 * seed buys only the rest. Each funder buys at most once, and keeps XLM_KEPT_STROOPS.
 */
export async function topUpUsdc({ destination, target, funders, journal, log }) {
  for (const { label, keypair } of funders) {
    const have = await usdcBalance(destination);
    if (have === null) throw new Error(`${destination} has no USDC trustline`);
    if (have >= target) return;
    const done = journal.get(label);
    if (done?.ledger) continue;
    await ensureFunded(keypair.publicKey());
    const spendable = (await xlmBalance(keypair.publicKey())) - XLM_KEPT_STROOPS;
    const missing = target - have;
    const full = await measurePurchase(missing);
    let usdc = missing;
    if (full.quote.xlm > spendable) {
      // What this funder's XLM buys at the measured price, with 1% room, in whole cents.
      usdc = ((((missing * spendable) / full.quote.xlm) * 99n) / 100n / CENT) * CENT;
    }
    if (usdc <= 0n) continue;
    const bought = await buyUsdc({ label, funder: keypair, destination, usdc, journal });
    log(`${label}: ${bought.reused ? "already done" : "done"}, tx ${bought.hash}, ${(bought.measured.share * 100).toFixed(4)}% of the pool, ${(bought.measured.costOverPool * 100).toFixed(2)}% over the pool price`);
  }
  const have = await usdcBalance(destination);
  if (have < target) throw new Error("the funders ran out of XLM before the treasury held what the runs need");
}

