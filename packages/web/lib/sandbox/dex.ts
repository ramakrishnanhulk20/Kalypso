// Test USDC for the sandbox treasury, bought on the testnet DEX the way the seed buys it
// (packages/contracts/scripts/lib/funding.mjs): every purchase is measured first against the
// pool's own reserves and refused if it would cost more than 1% over the pool price or take more
// than 1% of the pool's USDC, so no sandbox drains the pool every other testnet project buys from.
import { formatUsdc, parseUsdc } from "@kalypso/core";
import type { LedgerPort } from "./accounts";
import { HTTP_TIMEOUT_MS } from "./accounts";
import type { SandboxConfig } from "./config";
import { SandboxError } from "./errors";
import { Asset, Operation } from "./sdk";
import type { Keypair } from "./sdk";
import { classic, findRecorded, landed, type Landed, type TxContext } from "./transactions";

export const MAX_COST_OVER_POOL_PRICE = 0.01;
export const MAX_POOL_SHARE = 0.01;
/** Each account that buys keeps this much of its friendbot XLM for its reserve and its own fees. */
export const XLM_KEPT_STROOPS = 50_0000000n;
// The path payment may spend this much more XLM than quoted, in case the pool moves in between.
const SEND_MAX_PER_MILLE = 1_005n;
const CENT = 100_000n;

/** A GET on the configured Horizon, returning the parsed JSON. */
export interface HorizonPort {
  get(pathAndQuery: string): Promise<unknown>;
}

export function createHorizon(config: SandboxConfig): HorizonPort {
  const base = config.horizonUrl.replace(/\/+$/, "");
  return {
    async get(pathAndQuery) {
      const res = await fetch(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
      if (!res.ok) throw new Error(`Horizon answered ${res.status} for ${pathAndQuery.split("?")[0]}.`);
      return res.json();
    },
  };
}

export interface DexContext {
  tx: TxContext;
  ledger: LedgerPort;
  horizon: HorizonPort;
  issuer: string;
}

export interface Pool {
  xlm: bigint;
  usdc: bigint;
}

export interface Measured {
  pool: Pool;
  quote: { xlm: bigint; path: Asset[] };
  share: number;
  costOverPool: number;
}

function records(page: unknown): Record<string, unknown>[] {
  const list = (page as { _embedded?: { records?: unknown } } | null)?._embedded?.records;
  if (!Array.isArray(list)) throw new Error("Horizon answered in a shape it never uses.");
  return list.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
}

// XLM and USDC both have 7 decimals, so core's one amount parser reads Horizon's amounts too.
const stroopsOf = (text: unknown) => parseUsdc(String(text));

/** The XLM/USDC constant-product pool with the most USDC. */
export async function usdcPool(ctx: DexContext): Promise<Pool> {
  const usdc = `USDC:${ctx.issuer}`;
  const page = await ctx.horizon.get(`/liquidity_pools?reserves=${encodeURIComponent(`native,${usdc}`)}&limit=20`);
  const pools = records(page).flatMap((p) => {
    const reserves = Array.isArray(p.reserves) ? (p.reserves as { asset?: unknown; amount?: unknown }[]) : [];
    const xlm = reserves.find((r) => r.asset === "native");
    const coin = reserves.find((r) => r.asset === usdc);
    return reserves.length === 2 && xlm && coin ? [{ xlm: stroopsOf(xlm.amount), usdc: stroopsOf(coin.amount) }] : [];
  });
  if (pools.length === 0) throw new SandboxError("NOT_ENOUGH_XLM", "There is no XLM to USDC pool on the testnet DEX right now.");
  return pools.reduce((a, b) => (b.usdc > a.usdc ? b : a));
}

function assetOf(r: unknown): Asset {
  const a = r as { asset_type?: unknown; asset_code?: unknown; asset_issuer?: unknown };
  if (a.asset_type === "native") return Asset.native();
  if (typeof a.asset_code === "string" && typeof a.asset_issuer === "string") return new Asset(a.asset_code, a.asset_issuer);
  throw new Error("Horizon named a path asset in a shape it never uses.");
}

/** The cheapest XLM price Horizon finds for receiving exactly `usdc` stroops of USDC. */
export async function quote(ctx: DexContext, usdc: bigint): Promise<{ xlm: bigint; path: Asset[] }> {
  const q = new URLSearchParams({
    source_assets: "native",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: ctx.issuer,
    destination_amount: formatUsdc(usdc),
  });
  const offers = records(await ctx.horizon.get(`/paths/strict-receive?${q}`)).map((r) => ({
    xlm: stroopsOf(r.source_amount),
    path: (Array.isArray(r.path) ? r.path : []).map(assetOf),
  }));
  const best = offers.reduce<(typeof offers)[number] | null>((a, b) => (a === null || b.xlm < a.xlm ? b : a), null);
  if (!best) throw new SandboxError("NOT_ENOUGH_XLM", "The testnet DEX finds no way to buy USDC with XLM right now.");
  return best;
}

/**
 * Measures a purchase of `usdc` stroops: the pool, the quote, and how far over the pool price it
 * costs.
 * @throws SandboxError NOT_ENOUGH_XLM when either 1% limit is passed.
 */
export async function measurePurchase(ctx: DexContext, usdc: bigint): Promise<Measured> {
  const pool = await usdcPool(ctx);
  const share = Number(usdc) / Number(pool.usdc);
  if (share > MAX_POOL_SHARE) throw new SandboxError("NOT_ENOUGH_XLM", "Buying this much would take more than 1% of the testnet pool's USDC. Lower the salaries.");
  const q = await quote(ctx, usdc);
  const costOverPool = Number(q.xlm) / Number(usdc) / (Number(pool.xlm) / Number(pool.usdc)) - 1;
  if (costOverPool > MAX_COST_OVER_POOL_PRICE) {
    throw new SandboxError("NOT_ENOUGH_XLM", "The testnet DEX price is more than 1% over the pool price right now. Try again in a few minutes.");
  }
  return { pool, quote: q, share, costOverPool };
}

export interface Funder {
  label: string;
  keypair: Keypair;
}

/** Buys exactly `usdc` stroops of USDC with the funder's XLM and delivers it to `destination` in one path payment. */
export async function buyUsdc(ctx: DexContext, p: { label: string; funder: Keypair; destination: string; usdc: bigint }): Promise<Landed> {
  const m = await measurePurchase(ctx, p.usdc);
  const op = Operation.pathPaymentStrictReceive({
    sendAsset: Asset.native(),
    sendMax: formatUsdc((m.quote.xlm * SEND_MAX_PER_MILLE) / 1_000n),
    destination: p.destination,
    destAsset: new Asset("USDC", ctx.issuer),
    destAmount: formatUsdc(p.usdc),
    path: m.quote.path,
  });
  return classic(ctx.tx, { label: p.label, signer: p.funder, operations: [op] });
}

async function spendableXlm(ctx: DexContext, funder: Keypair): Promise<bigint> {
  const xlm = await ctx.ledger.xlmBalance(funder.publicKey());
  return xlm === null ? 0n : xlm - XLM_KEPT_STROOPS;
}

/**
 * Refuses before anything is bought when the funders that have not bought yet cannot pay for
 * `need` stroops of USDC at today's quote, so a judge's salaries never leave a half-funded treasury.
 *
 * @throws SandboxError NOT_ENOUGH_XLM, or either 1% limit from measurePurchase.
 */
export async function requireAffordable(ctx: DexContext, need: bigint, funders: readonly Funder[]): Promise<void> {
  if (need <= 0n) return;
  const m = await measurePurchase(ctx, need);
  let budget = 0n;
  for (const f of funders) if (!landed(ctx.tx, f.label)) budget += await spendableXlm(ctx, f.keypair);
  if ((m.quote.xlm * SEND_MAX_PER_MILLE) / 1_000n > budget) {
    throw new SandboxError("NOT_ENOUGH_XLM", "These salaries need more test USDC than the sandbox accounts' friendbot XLM can buy. Lower them and start again.");
  }
}

/**
 * Tops `destination` up to `target` stroops of USDC, the seed's topUpUsdc: each funder buys at
 * most once, keeps XLM_KEPT_STROOPS, and what is still missing is read from the chain before every
 * purchase, so a resumed run buys only the rest.
 *
 * @throws SandboxError NOT_ENOUGH_XLM when the funders ran out before the target was reached.
 */
export async function topUpUsdc(
  ctx: DexContext,
  p: { destination: string; target: bigint; funders: readonly Funder[]; onBought: (tx: Landed) => void },
): Promise<void> {
  for (const { label, keypair } of p.funders) {
    // A purchase sent before a reload is settled first, so it is counted, never bought again.
    const prior = ctx.tx.journal.get(label);
    if (prior !== undefined && !prior.landed) {
      const settled = await findRecorded(ctx.tx, label);
      if (settled) p.onBought(settled);
    }
    const have = await ctx.ledger.usdcBalance(p.destination);
    if (have === null) throw new SandboxError("CHAIN_DISAGREES", "The treasury has no USDC trustline, so it cannot receive test USDC.");
    if (have >= p.target) return;
    if (landed(ctx.tx, label)) continue;
    const spendable = await spendableXlm(ctx, keypair);
    if (spendable <= 0n) continue;
    const missing = p.target - have;
    const full = await measurePurchase(ctx, missing);
    let usdc = missing;
    if (full.quote.xlm > spendable) {
      // What this funder's XLM buys at the measured price, with 1% room, in whole cents.
      usdc = ((((missing * spendable) / full.quote.xlm) * 99n) / 100n / CENT) * CENT;
    }
    if (usdc <= 0n) continue;
    p.onBought(await buyUsdc(ctx, { label, funder: keypair, destination: p.destination, usdc }));
  }
  const have = await ctx.ledger.usdcBalance(p.destination);
  if (have === null || have < p.target) {
    throw new SandboxError("NOT_ENOUGH_XLM", "The sandbox accounts ran out of test XLM before the treasury held the USDC the payroll needs.");
  }
}
