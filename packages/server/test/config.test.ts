// Not covered here: whether the configured contract ids are the contracts we
// actually deployed (the deploy script and the smoke run check that), and
// whether the trusted IP header is really set by the hosting platform.
import { describe, expect, it } from "vitest";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { ConfigError, isAllowedOutboundUrl, loadConfig, secretValues } from "../src/config.ts";
import { API_KEY, CRON_SECRET, DB_API, DB_INGEST, LOG_SALT, TOKEN, keypairFor, testEnv } from "./helpers.ts";

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return [...(err as ConfigError).problems];
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("fills every documented default", () => {
    const cfg = loadConfig(testEnv());
    expect(cfg.RPC_URL).toBe("https://soroban-testnet.stellar.org");
    expect(cfg.USDC_SAC_ID).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(cfg.CHANNELS_URL).toBe("https://channels.openzeppelin.com/testnet");
    expect(cfg.FEE_CAP_CREATION_STROOPS).toBe(25_000_000n);
    expect(cfg.FEE_CAP_CALL_STROOPS).toBe(10_000_000n);
    expect(cfg.DAILY_FEE_BUDGET_STROOPS).toBe(2_000_000_000n);
    expect(cfg.CREATION_BUDGET_SHARE_PERCENT).toBe(50);
    expect(cfg.WALLET_CREATIONS_PER_DAY).toBe(60);
    expect(loadConfig(testEnv({ SPONSOR_ALLOWED_ORIGINS: undefined })).SPONSOR_ALLOWED_ORIGINS).toEqual([]);
    expect(cfg.PER_IP_LIMIT_PER_HOUR).toBe(60);
    expect(cfg.PER_ADDRESS_LIMIT_PER_DAY).toBe(20);
    expect(cfg.ARCHIVE_START_LEDGER).toBeUndefined();
    expect(cfg.TRUSTED_IP_HEADER).toBe("x-real-ip");
    expect(cfg.PASSKEY_WALLET_WASM_HASH).toBe("97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e");
    expect(cfg.NETWORK_PASSPHRASE).toBe(Networks.TESTNET);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("lists every missing key in one error, and treats empty strings as missing", () => {
    const problems = problemsOf({ TOKEN_CONTRACT_ID: "" });
    for (const key of [
      "NETWORK",
      "PAYROLL_CONTRACT_ID",
      "TOKEN_CONTRACT_ID",
      "AUDITOR_CONTRACT_ID",
      "VERIFIER_CONTRACT_ID",
      "CHANNELS_API_KEY",
      "DATABASE_URL_INGEST",
      "DATABASE_URL_API",
      "CRON_SECRET",
      "LOG_SALT",
    ]) {
      expect(problems).toContain(key + ": missing");
    }
  });

  it("refuses a shared secret that is short or could split a header", () => {
    for (const bad of ["a".repeat(31), "a".repeat(40) + " b", "a".repeat(40) + "\n", "a".repeat(257)]) {
      expect(problemsOf(testEnv({ CRON_SECRET: bad }))[0]).toMatch(/^CRON_SECRET: must be 32 to 256 characters/);
      expect(problemsOf(testEnv({ LOG_SALT: bad }))[0]).toMatch(/^LOG_SALT: must be 32 to 256 characters/);
    }
  });

  it("refuses a log salt equal to the cron secret, without repeating either", () => {
    const problems = problemsOf(testEnv({ LOG_SALT: CRON_SECRET }));
    expect(problems).toEqual(["LOG_SALT: must be different from CRON_SECRET"]);
    expect(JSON.stringify(problems)).not.toContain(CRON_SECRET);
  });

  it("takes ARCHIVE_START_LEDGER as a ledger number, and refuses anything else", () => {
    expect(loadConfig(testEnv({ ARCHIVE_START_LEDGER: "5083382" })).ARCHIVE_START_LEDGER).toBe(5_083_382);
    expect(loadConfig(testEnv({ ARCHIVE_START_LEDGER: "4294967295" })).ARCHIVE_START_LEDGER).toBe(4_294_967_295);
    for (const bad of ["0", "-1", "1.5", "1e6", " 100", "05083382", "4294967296", "latest"]) {
      expect(problemsOf(testEnv({ ARCHIVE_START_LEDGER: bad })), bad).toEqual(["ARCHIVE_START_LEDGER: must be a ledger number from 1 to 4294967295"]);
    }
  });

  it("takes TOKEN_DEPLOY_TX as 64 lower-case hex characters, only beside ARCHIVE_START_LEDGER", () => {
    const hash = "855f7e94dcbbbb09946036ce1b6dd1684e2f8f2e2aaad8c3679e2c70c1810891";
    expect(loadConfig(testEnv()).TOKEN_DEPLOY_TX).toBeUndefined();
    expect(loadConfig(testEnv({ ARCHIVE_START_LEDGER: "5083382", TOKEN_DEPLOY_TX: hash })).TOKEN_DEPLOY_TX).toBe(hash);
    for (const bad of [hash.toUpperCase(), hash.slice(1), "0x" + hash.slice(2), "g".repeat(64)]) {
      expect(problemsOf(testEnv({ ARCHIVE_START_LEDGER: "5083382", TOKEN_DEPLOY_TX: bad })), bad).toEqual([
        "TOKEN_DEPLOY_TX: must be 64 lower-case hex characters",
      ]);
    }
    expect(problemsOf(testEnv({ TOKEN_DEPLOY_TX: hash }))).toEqual(["TOKEN_DEPLOY_TX: needs ARCHIVE_START_LEDGER, the ledger of that transaction"]);
  });

  it("accepts testnet only", () => {
    expect(problemsOf(testEnv({ NETWORK: "public" }))[0]).toMatch(/^NETWORK: must be testnet/);
  });

  it("refuses contract ids that are not canonical contract addresses", () => {
    const flipped = TOKEN.slice(0, 55) + (TOKEN.endsWith("A") ? "B" : "A");
    for (const bad of [flipped, TOKEN.toLowerCase(), keypairFor("g").publicKey(), "C" + "A".repeat(55)]) {
      expect(problemsOf(testEnv({ TOKEN_CONTRACT_ID: bad }))).toEqual([
        "TOKEN_CONTRACT_ID: must be a contract address (C...)",
      ]);
    }
  });

  it("refuses two roles sharing one contract id", () => {
    expect(problemsOf(testEnv({ PAYROLL_CONTRACT_ID: TOKEN }))[0]).toMatch(/must all be different/);
    expect(problemsOf(testEnv({ VERIFIER_CONTRACT_ID: TOKEN }))[0]).toMatch(/must all be different/);
  });

  it("takes the wallet wasm hash in one spelling only: 64 lower-case hex characters", () => {
    for (const bad of ["97CE047884106B1C6C3BB40B8973CC48DB1C4DAD95C9E20462BF2C701DAA764E", "97ce04", "0x" + "a".repeat(64), "g".repeat(64)]) {
      expect(problemsOf(testEnv({ PASSKEY_WALLET_WASM_HASH: bad }))).toEqual(["PASSKEY_WALLET_WASM_HASH: must be 64 lower-case hex characters"]);
    }
    expect(loadConfig(testEnv({ PASSKEY_WALLET_WASM_HASH: "ab".repeat(32) })).PASSKEY_WALLET_WASM_HASH).toBe("ab".repeat(32));
  });

  it("refuses outbound URLs that are not https, except plain http to this machine", () => {
    expect(problemsOf(testEnv({ RPC_URL: "http://soroban-testnet.stellar.org" }))[0]).toMatch(/^RPC_URL:/);
    expect(problemsOf(testEnv({ CHANNELS_URL: "https://user:pw@channels.example" }))[0]).toMatch(/^CHANNELS_URL:/);
    expect(loadConfig(testEnv({ CHANNELS_URL: "http://127.0.0.1:4010" })).CHANNELS_URL).toBe("http://127.0.0.1:4010");
  });

  it("refuses fee numbers that are not whole positive stroops, and a budget below the call cap", () => {
    for (const bad of ["0", "-5", "1.5", "1e6", " 100", "99999999999999999999"]) {
      for (const key of ["FEE_CAP_CREATION_STROOPS", "FEE_CAP_CALL_STROOPS"]) {
        expect(problemsOf(testEnv({ [key]: bad }))[0], key + " " + bad).toMatch(new RegExp("^" + key + ": must be a whole number"));
      }
    }
    expect(problemsOf(testEnv({ FEE_CAP_CALL_STROOPS: "500", FEE_CAP_CREATION_STROOPS: "100", DAILY_FEE_BUDGET_STROOPS: "499" }))).toEqual([
      "DAILY_FEE_BUDGET_STROOPS: must be at least FEE_CAP_CALL_STROOPS",
    ]);
    expect(problemsOf(testEnv({ PER_IP_LIMIT_PER_HOUR: "0" }))[0]).toMatch(/^PER_IP_LIMIT_PER_HOUR:/);
    for (const bad of ["0", "-1", "2.5", "100000"]) {
      expect(problemsOf(testEnv({ PER_ADDRESS_LIMIT_PER_DAY: bad })), bad).toEqual(["PER_ADDRESS_LIMIT_PER_DAY: must be a whole number from 1 to 99999"]);
    }
    expect(loadConfig(testEnv({ PER_ADDRESS_LIMIT_PER_DAY: "5" })).PER_ADDRESS_LIMIT_PER_DAY).toBe(5);
    expect(problemsOf(testEnv({ TRUSTED_IP_HEADER: "X Real IP" }))[0]).toMatch(/^TRUSTED_IP_HEADER:/);
  });

  it("fails boot while the retired FEE_CAP_STROOPS is still set, naming the two keys that replace it, and ignores it blank", () => {
    const problems = problemsOf(testEnv({ FEE_CAP_STROOPS: "25000000" }));
    expect(problems).toEqual(["FEE_CAP_STROOPS: no longer read; set FEE_CAP_CREATION_STROOPS and FEE_CAP_CALL_STROOPS instead, then remove it"]);
    expect(JSON.stringify(problems)).not.toContain("25000000");
    expect(problemsOf({ ...testEnv(), FEE_CAP_STROOPS: "1", NETWORK: undefined })).toEqual([
      "FEE_CAP_STROOPS: no longer read; set FEE_CAP_CREATION_STROOPS and FEE_CAP_CALL_STROOPS instead, then remove it",
      "NETWORK: missing",
    ]);
    expect(loadConfig(testEnv({ FEE_CAP_STROOPS: "" })).FEE_CAP_CALL_STROOPS).toBe(10_000_000n);
  });

  it("takes the creation share as a whole percent from 1 to 100, and needs it to cover one creation at the creation cap", () => {
    expect(loadConfig(testEnv({ CREATION_BUDGET_SHARE_PERCENT: "100" })).CREATION_BUDGET_SHARE_PERCENT).toBe(100);
    expect(loadConfig(testEnv({ CREATION_BUDGET_SHARE_PERCENT: "1", FEE_CAP_CREATION_STROOPS: "20000000" })).CREATION_BUDGET_SHARE_PERCENT).toBe(1);
    for (const bad of ["0", "101", "-1", "50.5", "050", " 50", "half"]) {
      expect(problemsOf(testEnv({ CREATION_BUDGET_SHARE_PERCENT: bad })), bad).toEqual(["CREATION_BUDGET_SHARE_PERCENT: must be a whole number from 1 to 100"]);
    }
    // 1 percent of the default 200 XLM is 2 XLM, under the default 2.5 XLM creation cap. The rule's own text is
    // printed even though the cap and the budget were left to their defaults.
    expect(problemsOf(testEnv({ CREATION_BUDGET_SHARE_PERCENT: "1", FEE_CAP_CREATION_STROOPS: "25000000" }))).toEqual([
      "CREATION_BUDGET_SHARE_PERCENT: must give creations at least FEE_CAP_CREATION_STROOPS of DAILY_FEE_BUDGET_STROOPS",
    ]);
    expect(problemsOf(testEnv({ FEE_CAP_CREATION_STROOPS: "1000000001" }))).toEqual([
      "CREATION_BUDGET_SHARE_PERCENT: must give creations at least FEE_CAP_CREATION_STROOPS of DAILY_FEE_BUDGET_STROOPS",
    ]);
    expect(loadConfig(testEnv({ FEE_CAP_CREATION_STROOPS: "1000000000" })).FEE_CAP_CREATION_STROOPS).toBe(1_000_000_000n);
  });

  it("takes WALLET_CREATIONS_PER_DAY as a whole number from 1 to 99999", () => {
    expect(loadConfig(testEnv({ WALLET_CREATIONS_PER_DAY: "7" })).WALLET_CREATIONS_PER_DAY).toBe(7);
    for (const bad of ["0", "-1", "2.5", "100000", "sixty"]) {
      expect(problemsOf(testEnv({ WALLET_CREATIONS_PER_DAY: bad })), bad).toEqual(["WALLET_CREATIONS_PER_DAY: must be a whole number from 1 to 99999"]);
    }
  });

  it("takes SPONSOR_ALLOWED_ORIGINS as comma-separated origins, spelled the way URL().origin spells them", () => {
    const origins = (value: string, NODE_ENV?: string) => loadConfig({ ...testEnv({ SPONSOR_ALLOWED_ORIGINS: value }), NODE_ENV }).SPONSOR_ALLOWED_ORIGINS;
    expect(origins("https://kalypso-payroll.vercel.app")).toEqual(["https://kalypso-payroll.vercel.app"]);
    expect(origins("HTTPS://Kalypso-Payroll.Vercel.App/, https://kalypso-payroll.vercel.app:443,https://kalypso-payroll.vercel.app")).toEqual([
      "https://kalypso-payroll.vercel.app",
    ]);
    expect(origins("http://localhost:3001,http://localhost:3002", "development")).toEqual(["http://localhost:3001", "http://localhost:3002"]);
    expect(origins("https://kalypso-payroll.vercel.app", "production")).toEqual(["https://kalypso-payroll.vercel.app"]);
  });

  it("refuses an origin list with anything but https origins, and http://localhost in production", () => {
    const rule = "SPONSOR_ALLOWED_ORIGINS: must be comma-separated https origins (or http://localhost:<port> outside production), each with no path, query or credentials";
    for (const bad of [
      "http://kalypso-payroll.vercel.app",
      "http://127.0.0.1:3001",
      "https://kalypso-payroll.vercel.app/app",
      "https://kalypso-payroll.vercel.app/?x=1",
      "https://kalypso-payroll.vercel.app/#top",
      "https://user:pw@kalypso-payroll.vercel.app",
      "https://kalypso-payroll.vercel.app,,https://kalypso.test",
      "kalypso-payroll.vercel.app",
      "ftp://kalypso.test",
      "null",
    ]) {
      expect(problemsOf(testEnv({ SPONSOR_ALLOWED_ORIGINS: bad })), bad).toEqual([rule]);
    }
    expect(problemsOf({ ...testEnv({ SPONSOR_ALLOWED_ORIGINS: "https://kalypso-payroll.vercel.app,http://localhost:3001" }), NODE_ENV: "production" })).toEqual([
      "SPONSOR_ALLOWED_ORIGINS: must be comma-separated https origins, each with no path, query or credentials",
    ]);
  });

  it("never repeats a rejected value in the error", () => {
    const err = (() => {
      try {
        loadConfig(
          testEnv({
            DATABASE_URL_INGEST: "not a url hunter2-secret",
            CHANNELS_API_KEY: "key with spaces hunter3-secret",
            DATABASE_URL_API: "mysql://u:hunter4-secret@h/db",
          }),
        );
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err.message).toMatch(/DATABASE_URL_INGEST/);
    expect(err.message).not.toMatch(/hunter/);
  });

  it("collects every secret string, including the passwords inside the database URLs", () => {
    const secrets = secretValues(loadConfig(testEnv()));
    expect(secrets).toEqual(expect.arrayContaining([API_KEY, DB_INGEST, DB_API, "ingest-pass-7Hq2", "reader-pass-K9z4", CRON_SECRET, LOG_SALT]));
  });
});

describe("isAllowedOutboundUrl", () => {
  it("covers https, loopback http, and refuses the rest", () => {
    expect(isAllowedOutboundUrl("https://rpc.example/path")).toBe(true);
    expect(isAllowedOutboundUrl("http://localhost:8080")).toBe(true);
    expect(isAllowedOutboundUrl("http://[::1]:8080")).toBe(true);
    expect(isAllowedOutboundUrl("http://127.8.9.10")).toBe(true);
    expect(isAllowedOutboundUrl("http://10.0.0.1")).toBe(false);
    expect(isAllowedOutboundUrl("ftp://rpc.example")).toBe(false);
    expect(isAllowedOutboundUrl("https://rpc.example/#frag")).toBe(false);
    expect(isAllowedOutboundUrl("not a url")).toBe(false);
    expect(StrKey.isValidContract(TOKEN)).toBe(true);
  });
});
