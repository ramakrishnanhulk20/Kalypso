import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import { loadConfig, type Config } from "../src/config.ts";

export const contractFor = (label: string): string => StrKey.encodeContract(hash(Buffer.from("kalypso test " + label)));
export const keypairFor = (label: string): Keypair => Keypair.fromRawEd25519Seed(hash(Buffer.from("kalypso key " + label)));

export const TOKEN = contractFor("token");
export const PAYROLL = contractFor("payroll");
export const AUDITOR = contractFor("auditor");
export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const STRANGER = contractFor("third party");
export const VERIFIER = contractFor("verifier");

export const API_KEY = "0f6c1d3e-7a2b-4c5d-9e8f-123456789abc";
export const DB_INGEST = "postgres://ingest:ingest-pass-7Hq2@db.internal:5432/kalypso";
export const DB_API = "postgres://reader:reader-pass-K9z4@db.internal:5432/kalypso";
export const CRON_SECRET = "cron-secret-4bW9xQ2mZ7pL1vK8sD3fH6jN0tR5yE2u";
export const LOG_SALT = "log-salt-9Tq3Lm7Xc2Vb8Nz1Kp4Rw6Yh0Gd5Fs3a";

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NETWORK: "testnet",
    PAYROLL_CONTRACT_ID: PAYROLL,
    TOKEN_CONTRACT_ID: TOKEN,
    AUDITOR_CONTRACT_ID: AUDITOR,
    VERIFIER_CONTRACT_ID: VERIFIER,
    CHANNELS_API_KEY: API_KEY,
    DATABASE_URL_INGEST: DB_INGEST,
    DATABASE_URL_API: DB_API,
    CRON_SECRET,
    LOG_SALT,
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig(testEnv(overrides));
}
