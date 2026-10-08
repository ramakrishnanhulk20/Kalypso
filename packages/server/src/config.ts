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
  readonly FEE_CAP_STROOPS: bigint;
  readonly DAILY_FEE_BUDGET_STROOPS: bigint;
  readonly PER_IP_LIMIT_PER_HOUR: number;
  /** Relays each authorising address may have per UTC day. */
  readonly PER_ADDRESS_LIMIT_PER_DAY: number;
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

// A shared secret that travels in a header: no whitespace or control
// characters, and long enough that guessing it is hopeless.
const sharedSecret = z
  .string({ error: "missing" })
  .refine((v) => /^[A-Za-z0-9._~+/=-]{32,256}$/.test(v), {
    error: "must be 32 to 256 characters from A-Z a-z 0-9 . _ ~ + / = -",
  });

const schema = z
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
    FEE_CAP_STROOPS: stroops(10_000_000_000n).default(2_000_000n),
    DAILY_FEE_BUDGET_STROOPS: stroops(1_000_000_000_000n).default(200_000_000n),
    PER_IP_LIMIT_PER_HOUR: countUpTo99999.default(60),
    PER_ADDRESS_LIMIT_PER_DAY: countUpTo99999.default(20),
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
    if (cfg.DAILY_FEE_BUDGET_STROOPS < cfg.FEE_CAP_STROOPS) {
      ctx.addIssue({
        code: "custom",
        path: ["DAILY_FEE_BUDGET_STROOPS"],
        message: "must be at least FEE_CAP_STROOPS",
      });
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

const KEYS = Object.keys(schema.shape) as Array<keyof typeof schema.shape>;

/**
 * Validates the environment at boot and fails loudly.
 *
 * Throws ConfigError listing every missing or invalid key. The message names
 * keys and rules only, never a value, because the values include secrets.
 * An empty string counts as missing so a blank line in a .env file cannot
 * silently become a value.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const input: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    const raw = env[key];
    input[key] = raw === undefined || raw === "" ? undefined : raw;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? String(issue.path[0]) : "config";
      return key + ": " + (input[key] === undefined ? "missing" : issue.message);
    });
    throw new ConfigError([...new Set(problems)]);
  }
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
