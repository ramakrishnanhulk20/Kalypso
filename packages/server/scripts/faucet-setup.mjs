// Sets up the Kalypso testnet faucet in one run, using only files inside this repo. Prints public
// facts only (the public key, balances and transaction hashes), never the secret key:
//   1. reads FAUCET_SECRET_KEY from packages/server/.env, or makes a new keypair and writes it into
//      packages/server/.env and packages/web/.env.local, the two env files the .env.example notes
//      name (both git-ignored; each must exist, copied from its .env.example)
//   2. funds the account through friendbot when it does not exist yet
//   3. adds the trustline to Circle's testnet USDC when it is missing
//   4. buys USDC with part of its XLM on the testnet DEX in one path payment (strict receive),
//      aiming at 2,000 USDC and stepping down when the pool is thin, under the same two 1% limits
//      as packages/web/lib/sandbox/dex.ts, and always keeping 5,000 XLM for XLM claims
//   5. prints the public key and both balances, so the faucet can be topped up from Freighter
// Safe to run again: it reuses the key, skips what is done, and buys only what is still missing.
//
//   node packages/server/scripts/faucet-setup.mjs            set up or top up
//   node packages/server/scripts/faucet-setup.mjs --dry-run  read the existing key and the chain;
//                                                            write nothing, send nothing
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Horizon, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER_ENV = "packages/server/.env";
const WEB_ENV = "packages/web/.env.local";
const TEMPLATES = { [SERVER_ENV]: "packages/server/.env.example", [WEB_ENV]: "packages/web/.env.example" };
const KEY = "FAUCET_SECRET_KEY";
const DRY = process.argv.includes("--dry-run");

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STROOPS = 10_000_000n;
const TARGET_USDC = 2_000n * STROOPS;
const STEPS_USDC = [2_000n, 1_500n, 1_000n, 750n, 500n, 250n, 100n].map((n) => n * STROOPS);
const XLM_KEPT = 5_000n * STROOPS;
const MAX_POOL_SHARE = 0.01;
const MAX_COST_OVER_POOL_PRICE = 0.01;
// The path payment may spend this much more XLM than quoted, in case the pool moves in between.
const SEND_MAX_PER_MILLE = 1_005n;

const usdc = new Asset("USDC", USDC_ISSUER);
const horizon = new Horizon.Server(HORIZON);

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

const stroopsOf = (amount) => {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole) * STROOPS + BigInt((frac + "0000000").slice(0, 7));
};
const units = (stroops) => (stroops / STROOPS).toString() + "." + (stroops % STROOPS).toString().padStart(7, "0");

/** The file's text and its FAUCET_SECRET_KEY value. A missing file stops the run with how to make it. */
function envFile(relative) {
  const file = path.join(REPO, relative);
  if (!existsSync(file)) fail(`${relative} does not exist. Copy ${TEMPLATES[relative]} to ${relative} first, then run this again.`);
  const text = readFileSync(file, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith(KEY + "="));
  return { file, text, value: line === undefined ? undefined : line.slice(KEY.length + 1).trim() };
}

/** Writes the key into one env file without printing it: fills an empty line, appends a missing one, refuses a different one. */
function writeKey(relative, secret) {
  const { file, text, value } = envFile(relative);
  if (value === secret) return "already set";
  if (value !== undefined && value !== "") fail(`${relative} holds a different ${KEY}; make it match ${SERVER_ENV} by hand.`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (value === "") {
    writeFileSync(file, text.split(eol).map((l) => (l.startsWith(KEY + "=") ? KEY + "=" + secret : l)).join(eol));
    return "filled in";
  }
  writeFileSync(file, text + (text === "" || text.endsWith("\n") ? "" : eol) + KEY + "=" + secret + eol);
  return "added";
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!res.ok) throw new Error("HTTP " + res.status + " from " + url.split("?")[0]);
  return res.json();
}

async function loadAccount(publicKey) {
  try {
    return await horizon.loadAccount(publicKey);
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

const xlmOf = (account) => stroopsOf(account.balances.find((b) => b.asset_type === "native").balance);
const usdcLineOf = (account) => account.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);

async function submit(keypair, operation, label) {
  const account = await horizon.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: "10000", networkPassphrase: Networks.TESTNET }).addOperation(operation).setTimeout(60).build();
  tx.sign(keypair);
  try {
    const res = await horizon.submitTransaction(tx);
    console.log(label + ": " + res.hash);
    return res.hash;
  } catch (err) {
    const codes = err?.response?.data?.extras?.result_codes;
    fail(label + " failed: " + (codes ? JSON.stringify(codes) : (err?.message ?? "unknown error")));
  }
}

async function biggestPool() {
  const page = await getJson(HORIZON + "/liquidity_pools?reserves=" + encodeURIComponent("native,USDC:" + USDC_ISSUER) + "&limit=20");
  const pools = page._embedded.records.flatMap((p) => {
    const xlm = p.reserves.find((r) => r.asset === "native");
    const coin = p.reserves.find((r) => r.asset === "USDC:" + USDC_ISSUER);
    return p.reserves.length === 2 && xlm && coin ? [{ xlm: stroopsOf(xlm.amount), usdc: stroopsOf(coin.amount) }] : [];
  });
  return pools.reduce((a, b) => (a === null || b.usdc > a.usdc ? b : a), null);
}

async function cheapestQuote(amount) {
  const q = new URLSearchParams({
    source_assets: "native",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: USDC_ISSUER,
    destination_amount: units(amount),
  });
  const offers = (await getJson(HORIZON + "/paths/strict-receive?" + q))._embedded.records.map((r) => ({
    xlm: stroopsOf(r.source_amount),
    path: r.path.map((a) => (a.asset_type === "native" ? Asset.native() : new Asset(a.asset_code, a.asset_issuer))),
  }));
  return offers.reduce((a, b) => (a === null || b.xlm < a.xlm ? b : a), null);
}

/** Buys up to `missing` USDC in one purchase: the largest step every limit allows. Returns what it bought. */
async function buyUsdc(keypair, missing, spendable) {
  const pool = await biggestPool();
  if (pool === null) {
    console.log("USDC purchase: skipped, the testnet DEX has no XLM/USDC pool right now");
    return 0n;
  }
  const poolPrice = Number(pool.xlm) / Number(pool.usdc);
  const candidates = [missing, ...STEPS_USDC.filter((s) => s < missing)];
  for (const amount of candidates) {
    if (Number(amount) / Number(pool.usdc) > MAX_POOL_SHARE) {
      console.log("  " + units(amount) + " USDC: more than 1% of the pool, stepping down");
      continue;
    }
    const quote = await cheapestQuote(amount);
    if (quote === null) {
      console.log("  " + units(amount) + " USDC: no path on the DEX, stepping down");
      continue;
    }
    const over = Number(quote.xlm) / Number(amount) / poolPrice - 1;
    const sendMax = (quote.xlm * SEND_MAX_PER_MILLE) / 1_000n;
    if (over > MAX_COST_OVER_POOL_PRICE) {
      console.log("  " + units(amount) + " USDC: " + (over * 100).toFixed(2) + "% over the pool price, stepping down");
      continue;
    }
    if (sendMax > spendable) {
      console.log("  " + units(amount) + " USDC: costs up to " + units(sendMax) + " XLM, more than the " + units(spendable) + " XLM it may spend, stepping down");
      continue;
    }
    console.log("  " + units(amount) + " USDC quoted at " + units(quote.xlm) + " XLM (" + (over * 100).toFixed(2) + "% over the pool price)");
    await submit(
      keypair,
      Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: units(sendMax), destination: keypair.publicKey(), destAsset: usdc, destAmount: units(amount), path: quote.path }),
      "USDC purchase of " + units(amount),
    );
    return amount;
  }
  console.log("USDC purchase: none, every step broke a limit; top the faucet up with USDC from Freighter instead");
  return 0n;
}

function report(publicKey, account) {
  console.log("Faucet " + publicKey);
  if (account === null) {
    console.log("   The account does not exist on testnet yet.");
    return;
  }
  const line = usdcLineOf(account);
  console.log("   XLM:  " + units(xlmOf(account)));
  console.log("   USDC: " + (line === undefined ? "no USDC trustline yet" : units(stroopsOf(line.balance))));
  console.log("   Explorer: https://stellar.expert/explorer/testnet/account/" + publicKey);
}

if (usdc.contractId(Networks.TESTNET) !== USDC_SAC) fail("Circle's testnet USDC no longer derives to " + USDC_SAC);

const server = envFile(SERVER_ENV);
const web = envFile(WEB_ENV);
if (server.value && !StrKey.isValidEd25519SecretSeed(server.value)) fail(`${SERVER_ENV} has a ${KEY} that is not a Stellar secret key.`);

if (DRY) {
  if (!server.value) fail(`No ${KEY} in ${SERVER_ENV} yet; run this without --dry-run to make one.`);
  const publicKey = Keypair.fromSecret(server.value).publicKey();
  const webState = !web.value ? "missing" : web.value === server.value ? "the same key" : "a different key";
  console.log(`Dry run: nothing is written or sent.`);
  console.log(`Faucet key: found in ${SERVER_ENV}; ${WEB_ENV} holds ${webState}.`);
  report(publicKey, await loadAccount(publicKey));
  process.exit(0);
}

let keypair;
if (server.value) {
  keypair = Keypair.fromSecret(server.value);
  console.log(`1. Faucet key: reused from ${SERVER_ENV}`);
} else {
  keypair = Keypair.random();
  console.log("1. Faucet key: made a new one");
}
for (const file of [SERVER_ENV, WEB_ENV]) console.log("   " + file + ": " + writeKey(file, keypair.secret()));
const publicKey = keypair.publicKey();
console.log("   Public key: " + publicKey);

let account = await loadAccount(publicKey);
if (account === null) {
  const funded = await getJson(FRIENDBOT + "/?addr=" + encodeURIComponent(publicKey));
  console.log("2. Friendbot funding: " + funded.hash);
  account = await horizon.loadAccount(publicKey);
} else {
  console.log("2. Friendbot funding: skipped, the account exists");
}

if (usdcLineOf(account) === undefined) {
  await submit(keypair, Operation.changeTrust({ asset: usdc }), "3. USDC trustline");
  account = await horizon.loadAccount(publicKey);
} else {
  console.log("3. USDC trustline: already there");
}

const haveUsdc = stroopsOf(usdcLineOf(account).balance);
if (haveUsdc >= TARGET_USDC) {
  console.log("4. USDC purchase: skipped, it already holds " + units(haveUsdc) + " USDC");
} else {
  console.log("4. USDC purchase: aiming at " + units(TARGET_USDC - haveUsdc) + " USDC more");
  const bought = await buyUsdc(keypair, TARGET_USDC - haveUsdc, xlmOf(account) - XLM_KEPT);
  if (bought > 0n) console.log("   Bought " + units(bought) + " USDC");
  account = await horizon.loadAccount(publicKey);
}

console.log("5. Done.");
report(publicKey, account);
console.log("   Top it up from Freighter on testnet: send XLM or USDC (Circle, " + USDC_ISSUER + ") to the key above.");
