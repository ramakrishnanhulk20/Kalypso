import { BlockList, isIP } from "node:net";
import { Networks } from "@stellar/stellar-sdk";
import { z } from "zod";
import { canonicalContractId } from "./stellar.ts";

export interface Config {
  readonly NETWORK: "testnet";
  readonly NETWORK_PASSPHRASE: string;
  readonly RPC_URL: string;
  readonly PAYROLL_CONTRACT_ID: string;
  readonly TOKEN_CONTRACT_ID: string;
  readonly USDC_SAC_ID: string;
  readonly AUDITOR_CONTRACT_ID: string;
  readonly VERIFIER_CONTRACT_ID: string;
  /** Lower-case hex. The only code a contract-account signer may run for the sponsor to pay. */
  readonly PASSKEY_WALLET_WASM_HASH: string;
  readonly CHANNELS_URL: string;
  readonly CHANNELS_API_KEY: string;
  readonly DATABASE_URL_INGEST: string;
  readonly DATABASE_URL_API: string;
  /** Most the sponsor pays for the one passkey wallet creation it accepts. */
  readonly FEE_CAP_CREATION_STROOPS: bigint;
  /** Most the sponsor pays for any other request. */
  readonly FEE_CAP_CALL_STROOPS: bigint;
  readonly DAILY_FEE_BUDGET_STROOPS: bigint;
  /** The share of each day's budget that wallet creations may use, from 1 to 100. */
  readonly CREATION_BUDGET_SHARE_PERCENT: number;
  readonly PER_IP_LIMIT_PER_HOUR: number;
  /** Relays each authorising address may have per UTC day. */
  readonly PER_ADDRESS_LIMIT_PER_DAY: number;
  /** Passkey wallet creations each client IP bucket (IPv6: per /48) may have paid for per UTC day. */
  readonly WALLET_CREATIONS_PER_IP_PER_DAY: number;
  /** Passkey wallet creations the whole service pays for per UTC day. */
  readonly WALLET_CREATIONS_PER_DAY: number;
  /**
   * The web origins whose sign-ups the sponsor pays a wallet creation for,
   * each as URL().origin spells it. Empty refuses every creation.
   */
  readonly SPONSOR_ALLOWED_ORIGINS: readonly string[];
  readonly TRUSTED_IP_HEADER: string;
  /** The bearer token the scheduler sends to the ingest route. */
  readonly CRON_SECRET: string;
  /** The key for the tag that stands in for a caller's IP in log lines. */
  readonly LOG_SALT: string;
  /** Where an empty archive starts reading: the token's deploy ledger. */
  readonly ARCHIVE_START_LEDGER?: number;
  /** The token's deploy transaction hash, lower-case hex: the only proof of where its history begins. */
  readonly TOKEN_DEPLOY_TX?: string;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super("Invalid server configuration:\n" + problems.map((p) => "  - " + p).join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** passkey-kit 0.19.1's canonical testnet wallet (docs/deployments-2026-09-01.md line 10 in that repo). */
export const PINNED_PASSKEY_WALLET_WASM_HASH = "97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/**
 * Outbound calls go to HTTPS origins only. Plain HTTP is allowed to this
 * machine alone, which is what the local Channels stand-in in the tests uses.
 * A URL carrying a user name, password or fragment is refused, because it
 * would put a credential somewhere a log line could print it.
 */
export function isAllowedOutboundUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const family = isIP(host);
  return family !== 0 && loopback.check(host, family === 4 ? "ipv4" : "ipv6");
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const contractId = (hint: string) =>
  z.string({ error: "missing" }).refine((v) => canonicalContractId(v) !== null, { error: hint });

const outboundUrl = z
  .string({ error: "missing" })
  .refine(isAllowedOutboundUrl, { error: "must be an https URL (plain http only to this machine), with no credentials" });

const postgresUrl = z
  .string({ error: "missing" })
  .refine(isPostgresUrl, { error: "must be a postgres:// or postgresql:// connection URL" });

const stroops = (max: bigint) =>
  z
    .string({ error: "missing" })
    .refine((v) => /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= max, {
      error: "must be a whole number of stroops from 1 to " + max.toString(),
    })
    .transform((v) => BigInt(v));

// Channels issues UUID keys today; the rule is looser on purpose but forbids
// whitespace and control characters, so the key can never split an HTTP header.
const apiKey = z
  .string({ error: "missing" })
  .refine((v) => /^[A-Za-z0-9._~+/=-]{16,256}$/.test(v), {
    error: "must be 16 to 256 characters from A-Z a-z 0-9 . _ ~ + / = -",
  });

const countUpTo99999 = z
  .string()
  .refine((v) => /^[1-9]\d{0,4}$/.test(v), { error: "must be a whole number from 1 to 99999" })
  .transform(Number);

const percent = z
  .string()
  .refine((v) => /^[1-9]\d{0,2}$/.test(v) && Number(v) <= 100, { error: "must be a whole number from 1 to 100" })
  .transform(Number);

/**
 * One configured origin as URL().origin spells it, the same parser the
 * sponsor runs on a passkey's client data, or null. https only, except
 * http://localhost outside production, which is where a developer's own
 * passkeys are made. A path, query, fragment or credential means it was not
 * written as an origin, so it is refused rather than cut down to one.
 */
export function allowedOrigin(value: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && url.hostname === "localhost" && !production ? url.origin : null;
}

function originList(value: string, production: boolean): string[] | null {
  const origins = value.split(",").map((item) => allowedOrigin(item.trim(), production));
  return origins.every((o): o is string => o !== null) ? [...new Set(origins)] : null;
}

const allowedOrigins = (production: boolean) =>
  z
    .string()
    .refine((v) => originList(v, production) !== null, {
      error: production
        ? "must be comma-separated https origins, each with no path, query or credentials"
        : "must be comma-separated https origins (or http://localhost:<port> outside production), each with no path, query or credentials",
    })
    .transform((v) => originList(v, production)!)
    .default([]);

/**
 * Keys that were removed. A deployment that still sets one would otherwise
 * boot on the new defaults and look configured.
 */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  FEE_CAP_STROOPS: "no longer read; set FEE_CAP_CREATION_STROOPS and FEE_CAP_CALL_STROOPS instead, then remove it",
};

// A shared secret that travels in a header: no whitespace or control
// characters, and long enough that guessing it is hopeless.
const sharedSecret = z
  .string({ error: "missing" })
  .refine((v) => /^[A-Za-z0-9._~+/=-]{32,256}$/.test(v), {
    error: "must be 32 to 256 characters from A-Z a-z 0-9 . _ ~ + / = -",
  });

// Built once per NODE_ENV answer, because the origin rule is the only one
// that depends on it.
const schemaFor = (production: boolean) => z
  .object({
    NETWORK: z.literal("testnet", { error: "must be testnet (the only network this server supports)" }),
    RPC_URL: outboundUrl.default("https://soroban-testnet.stellar.org"),
    PAYROLL_CONTRACT_ID: contractId("must be a contract address (C...)"),
    TOKEN_CONTRACT_ID: contractId("must be a contract address (C...)"),
    USDC_SAC_ID: contractId("must be a contract address (C...)").default(
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ),
    AUDITOR_CONTRACT_ID: contractId("must be a contract address (C...)"),
    VERIFIER_CONTRACT_ID: contractId("must be a contract address (C...)"),
    // One spelling only, because it is compared as a string with the hex of the on-chain hash.
    PASSKEY_WALLET_WASM_HASH: z
      .string()
      .refine((v) => /^[0-9a-f]{64}$/.test(v), { error: "must be 64 lower-case hex characters" })
      .default(PINNED_PASSKEY_WALLET_WASM_HASH),
    CHANNELS_URL: outboundUrl.default("https://channels.openzeppelin.com/testnet"),
    CHANNELS_API_KEY: apiKey,
    DATABASE_URL_INGEST: postgresUrl,
    DATABASE_URL_API: postgresUrl,
    // Testnet defaults. A passkey wallet creation measured 1.79 XLM charged
    // (2.06 XLM declared resource fee, scratchpad/worker/logs), so 2.5 XLM
    // leaves it margin. Every other worker action is far cheaper (accept_invite
    // 0.53 XLM charged, 0.61 reserved), so 1 XLM, and a call cannot declare
    // inflated resources up to the creation's cap. Creations may use half of
    // the 200 XLM day, about 48 joins at 2.06 XLM, and the other half stays
    // for the workers already paid.
    FEE_CAP_CREATION_STROOPS: stroops(10_000_000_000n).default(25_000_000n),
    FEE_CAP_CALL_STROOPS: stroops(10_000_000_000n).default(10_000_000n),
    DAILY_FEE_BUDGET_STROOPS: stroops(1_000_000_000_000n).default(2_000_000_000n),
    CREATION_BUDGET_SHARE_PERCENT: percent.default(50),
    PER_IP_LIMIT_PER_HOUR: countUpTo99999.default(60),
    PER_ADDRESS_LIMIT_PER_DAY: countUpTo99999.default(20),
    WALLET_CREATIONS_PER_IP_PER_DAY: countUpTo99999.default(3),
    WALLET_CREATIONS_PER_DAY: countUpTo99999.default(60),
    SPONSOR_ALLOWED_ORIGINS: allowedOrigins(production),
    TRUSTED_IP_HEADER: z
      .string()
      .refine((v) => /^[a-z0-9-]{1,64}$/.test(v), { error: "must be a lower-case HTTP header name" })
      .default("x-real-ip"),
    CRON_SECRET: sharedSecret,
    LOG_SALT: sharedSecret,
    ARCHIVE_START_LEDGER: z
      .string()
      .refine((v) => /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 0xffffffff, { error: "must be a ledger number from 1 to 4294967295" })
      .transform(Number)
      .optional(),
    // One spelling only, because it is compared as a string with RPC's event hashes.
    TOKEN_DEPLOY_TX: z
      .string()
      .refine((v) => /^[0-9a-f]{64}$/.test(v), { error: "must be 64 lower-case hex characters" })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    // A key that failed its own rule arrives here as its raw string, which
    // BigInt arithmetic would throw on, so these rules wait for clean amounts.
    const amounts = [cfg.DAILY_FEE_BUDGET_STROOPS, cfg.FEE_CAP_CALL_STROOPS, cfg.FEE_CAP_CREATION_STROOPS];
    if (amounts.every((v) => typeof v === "bigint") && typeof cfg.CREATION_BUDGET_SHARE_PERCENT === "number") {
      if (cfg.DAILY_FEE_BUDGET_STROOPS < cfg.FEE_CAP_CALL_STROOPS) {
        ctx.addIssue({
          code: "custom",
          path: ["DAILY_FEE_BUDGET_STROOPS"],
          message: "must be at least FEE_CAP_CALL_STROOPS",
        });
      }
      // Below this no creation could ever be paid for, which would look like
      // a working sponsor that refuses every sign-up.
      if (creationBudgetOf(cfg) < cfg.FEE_CAP_CREATION_STROOPS) {
        ctx.addIssue({
          code: "custom",
          path: ["CREATION_BUDGET_SHARE_PERCENT"],
          message: "must give creations at least FEE_CAP_CREATION_STROOPS of DAILY_FEE_BUDGET_STROOPS",
        });
      }
    }
    if (cfg.TOKEN_DEPLOY_TX !== undefined && cfg.ARCHIVE_START_LEDGER === undefined) {
      ctx.addIssue({ code: "custom", path: ["TOKEN_DEPLOY_TX"], message: "needs ARCHIVE_START_LEDGER, the ledger of that transaction" });
    }
    // The cron secret is sent by the scheduler on every call, so one leak of
    // it would also untag every caller IP in the logs if the two were equal.
    if (cfg.CRON_SECRET === cfg.LOG_SALT) {
      ctx.addIssue({ code: "custom", path: ["LOG_SALT"], message: "must be different from CRON_SECRET" });
    }
    const ids = [cfg.PAYROLL_CONTRACT_ID, cfg.TOKEN_CONTRACT_ID, cfg.USDC_SAC_ID, cfg.AUDITOR_CONTRACT_ID, cfg.VERIFIER_CONTRACT_ID];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["PAYROLL_CONTRACT_ID"],
        message: "PAYROLL, TOKEN, USDC_SAC, AUDITOR and VERIFIER contract ids must all be different",
      });
    }
  });

const schemas = { production: schemaFor(true), other: schemaFor(false) };
const KEYS = Object.keys(schemas.other.shape) as Array<keyof typeof schemas.other.shape>;

/** The most wallet creations may reserve of one day's budget, rounded down to a whole stroop. */
export function creationBudgetOf(cfg: Pick<Config, "DAILY_FEE_BUDGET_STROOPS" | "CREATION_BUDGET_SHARE_PERCENT">): bigint {
  return (cfg.DAILY_FEE_BUDGET_STROOPS * BigInt(cfg.CREATION_BUDGET_SHARE_PERCENT)) / 100n;
}

/**
 * Validates the environment at boot and fails loudly.
 *
 * Throws ConfigError listing every missing or invalid key, and every retired
 * key still set. The message names keys and rules only, never a value,
 * because the values include secrets. An empty string counts as missing so a
 * blank line in a .env file cannot silently become a value. NODE_ENV is read
 * from `env` too: "production" refuses http://localhost origins.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const input: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    const raw = env[key];
    input[key] = raw === undefined || raw === "" ? undefined : raw;
  }
  const problems = Object.entries(RETIRED_KEYS)
    .filter(([key]) => env[key] !== undefined && env[key] !== "")
    .map(([key, rule]) => key + ": " + rule);
  const parsed = (env.NODE_ENV === "production" ? schemas.production : schemas.other).safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? String(issue.path[0]) : "config";
      // A cross-key rule can fail on a key left to its default, and saying
      // "missing" there would send the reader to the wrong line.
      problems.push(key + ": " + (input[key] === undefined && issue.code !== "custom" ? "missing" : issue.message));
    }
  }
  if (!parsed.success || problems.length > 0) throw new ConfigError([...new Set(problems)]);
  return Object.freeze({ ...parsed.data, NETWORK_PASSPHRASE: Networks.TESTNET });
}

/** Every secret string a log line or error body must never contain. */
export function secretValues(cfg: Config): string[] {
  const out = [cfg.CHANNELS_API_KEY, cfg.DATABASE_URL_INGEST, cfg.DATABASE_URL_API, cfg.CRON_SECRET, cfg.LOG_SALT];
  for (const value of [cfg.DATABASE_URL_INGEST, cfg.DATABASE_URL_API]) {
    const password = new URL(value).password;
    if (password) out.push(password, decodeURIComponent(password));
  }
  return [...new Set(out.filter((s) => s.length >= 4))];
}
