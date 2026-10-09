// Covers the worker's saved record: the round trip, the defensive read that drops each damaged
// field on its own, a passkey saved before its birth fields existed, the one key per account, a
// refused write, and the company cap that keeps the newest.
// Does NOT cover: real browser storage quotas or private-mode rules (a map stands in), or whether
// a saved fact is still true on chain (every caller checks that before using it).
import { describe, expect, it } from "vitest";
import { MAX_WORKER_COMPANIES } from "@kalypso/core";
import { emptyRecord, readWorkerRecord, setCompanies, updateWorkerRecord, withCompany, workerRecordKey, writeWorkerRecord, type KeyValueStorage, type WorkerRecord } from "./storage";

const WORKER = "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL";

function memory(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

function sample(): WorkerRecord {
  return {
    companyIds: [3n, 18_446_744_073_709_551_615n, 0n],
    auditorId: 41,
    auditorKeyRelay: { transactionId: "tx_abc-1", hash: "c".repeat(64) },
    registeredLedger: 5_100_123,
    passkey: {
      keyId: "aGVsbG8td29ybGQ",
      publicKey: "B" + "A".repeat(86),
      deployFunc: "AAAAAQ==",
      birth: { hash: "d".repeat(64) },
      deployRelay: { transactionId: "tx_deploy-2", hash: null },
    },
  };
}

const store = (raw: unknown) => {
  const s = memory();
  s.map.set(workerRecordKey(WORKER), typeof raw === "string" ? raw : JSON.stringify(raw));
  return s;
};

describe("worker record", () => {
  it("reads back exactly what it wrote, company ids as bigints", () => {
    const s = memory();
    expect(writeWorkerRecord(s, WORKER, sample())).toBe(true);
    expect(s.map.get(`kalypso/worker/v1/${WORKER}`)).not.toMatch(/\d+n\b/);
    expect(readWorkerRecord(s, WORKER)).toEqual(sample());
  });

  it("uses one key per account whatever surrounding spaces the address came with", () => {
    expect(workerRecordKey(`  ${WORKER}\n`)).toBe(workerRecordKey(WORKER));
    expect(() => workerRecordKey("not an address")).toThrow();
  });

  it("reads missing, unreadable, oversized or other-version values as an empty record", () => {
    const broken = memory();
    broken.getItem = () => {
      throw new Error("SecurityError");
    };
    for (const s of [memory(), store("{not json"), store({ v: 2, companyIds: ["1"] }), store("[]"), store(`{"v":1,"pad":"${"x".repeat(70_000)}"}`), broken]) {
      expect(readWorkerRecord(s, WORKER)).toEqual(emptyRecord());
    }
    expect(readWorkerRecord(null, WORKER)).toEqual(emptyRecord());
    expect(readWorkerRecord(memory(), "garbage")).toEqual(emptyRecord());
  });

  it("keeps only u64 decimal company ids, once each, in order", () => {
    const s = store({ v: 1, companyIds: ["7", "01", "-1", 5, "18446744073709551616", "7", "2", "1e3", " 4", "18446744073709551615"] });
    expect(readWorkerRecord(s, WORKER).companyIds).toEqual([7n, 2n, 18_446_744_073_709_551_615n]);
  });

  it("stops at the most companies a worker view reads", () => {
    const ids = Array.from({ length: MAX_WORKER_COMPANIES + 10 }, (_, i) => String(i));
    expect(readWorkerRecord(store({ v: 1, companyIds: ids }), WORKER).companyIds).toHaveLength(MAX_WORKER_COMPANIES);
  });

  it("drops each damaged field on its own and keeps the rest", () => {
    const good = JSON.parse(JSON.stringify({ v: 1, ...sample(), companyIds: ["3"] })) as Record<string, unknown>;
    const cases: [string, unknown, keyof WorkerRecord, unknown][] = [
      ["auditorId", "41", "auditorId", null],
      ["auditorId", -1, "auditorId", null],
      ["auditorId", 1.5, "auditorId", null],
      ["registeredLedger", 2 ** 32, "registeredLedger", null],
      ["auditorKeyRelay", { transactionId: "tx 1", hash: null }, "auditorKeyRelay", null],
      ["auditorKeyRelay", { transactionId: "tx_1", hash: "C".repeat(64) }, "auditorKeyRelay", null],
      ["passkey", { keyId: "a", publicKey: "short", deployFunc: "AAAA" }, "passkey", null],
      ["passkey", { keyId: "a+b", publicKey: "B" + "A".repeat(86), deployFunc: "AAAA" }, "passkey", null],
    ];
    for (const [field, value, key, expected] of cases) {
      const record = readWorkerRecord(store({ ...good, [field]: value }), WORKER);
      expect(record[key], `${field} = ${JSON.stringify(value)}`).toEqual(expected);
      expect(record.companyIds).toEqual([3n]);
    }
    expect(readWorkerRecord(store({ ...good, auditorKeyRelay: { transactionId: "tx_1", hash: null } }), WORKER).auditorKeyRelay).toEqual({ transactionId: "tx_1", hash: null });
  });

  it("reads a passkey saved before birth and deployRelay existed, and drops either one when damaged, never the passkey (T11)", () => {
    const passkey = { keyId: "aGVsbG8td29ybGQ", publicKey: "B" + "A".repeat(86), deployFunc: "AAAAAQ==" };
    const read = (extra: object) => readWorkerRecord(store({ v: 1, passkey: { ...passkey, ...extra } }), WORKER).passkey;
    const bare = { ...passkey, birth: null, deployRelay: null };
    expect(read({})).toEqual(bare);
    expect(read({ birth: { hash: "D".repeat(64) } })).toEqual(bare);
    expect(read({ birth: "d".repeat(64) })).toEqual(bare);
    expect(read({ deployRelay: { transactionId: "tx 1", hash: null } })).toEqual(bare);
    expect(read({ deployRelay: { transactionId: "tx_1", hash: "short" } })).toEqual(bare);
    const both = { birth: { hash: "d".repeat(64) }, deployRelay: { transactionId: "tx_1", hash: "e".repeat(64) } };
    expect(read(both)).toEqual({ ...passkey, ...both });
  });

  it("reports a write the browser refused, so the caller can say so", () => {
    const full = memory();
    full.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    expect(writeWorkerRecord(full, WORKER, sample())).toBe(false);
    expect(writeWorkerRecord(null, WORKER, sample())).toBe(false);
    expect(updateWorkerRecord(full, WORKER, (r) => withCompany(r, 1n))).toBe(false);
  });

  it("adds a company once and keeps the join order", () => {
    const s = memory();
    for (const id of [5n, 2n, 5n, 9n]) updateWorkerRecord(s, WORKER, (r) => withCompany(r, id));
    expect(readWorkerRecord(s, WORKER).companyIds).toEqual([5n, 2n, 9n]);
  });

  it("makes the 51st confirmed company replace the oldest, never dropping the new one", () => {
    const s = memory();
    const first50 = Array.from({ length: MAX_WORKER_COMPANIES }, (_, i) => BigInt(i + 1));
    updateWorkerRecord(s, WORKER, (r) => setCompanies(r, first50));
    expect(updateWorkerRecord(s, WORKER, (r) => withCompany(r, 51n))).toBe(true);
    const kept = readWorkerRecord(s, WORKER).companyIds;
    expect([kept.length, kept[0], kept.at(-1), kept.includes(1n)]).toEqual([MAX_WORKER_COMPANIES, 2n, 51n, false]);
  });

  it("replaces the recorded companies with a new list, each once, in order, the newest kept", () => {
    const record = sample();
    setCompanies(record, [9n, 2n, 9n, 4n]);
    expect(record.companyIds).toEqual([9n, 2n, 4n]);
    setCompanies(record, Array.from({ length: MAX_WORKER_COMPANIES + 5 }, (_, i) => BigInt(i)));
    expect([record.companyIds.length, record.companyIds[0]]).toEqual([MAX_WORKER_COMPANIES, 5n]);
  });
});
