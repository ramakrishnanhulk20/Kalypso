// Not covered here: the production postgres driver adapter and its session
// settings (no database server in the test run; the same SQL runs in PGlite),
// and the hosting provider's role and password handling.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addIngestedRange,
  claimIngestSlot,
  claimRelay,
  recordRelay,
  releaseRelay,
  countSponsorRequest,
  insertEvents,
  readCoverage,
  schemaSql,
  type Db,
  type EventRow,
} from "../../src/archive/db.ts";
import { TOKEN } from "../helpers.ts";
import { clearTables, freshDb, resetArchive } from "../db.ts";
import type { PGlite } from "@electric-sql/pglite";

let pg: PGlite;
let db: Db;
beforeAll(async () => {
  ({ pg, db } = await freshDb());
});
beforeEach(async () => {
  await resetArchive(db);
  await clearTables(db, ["ip_hour", "relay_dedupe"]);
});

const row = (id: string, ledger: number, valueXdr = "AAAAAQ=="): EventRow => ({
  id,
  ledger,
  txHash: "ab".repeat(32),
  txIndex: 1,
  opIndex: 0,
  eventIndex: 0,
  contractId: TOKEN,
  eventName: "merge",
  topic1Address: null,
  accounts: ["G'; drop table events; --"],
  companyId: null,
  topicsXdr: ["AAAADwAAAAVtZXJnZQAAAA=="],
  valueXdr,
  ledgerClosedAt: "2026-10-07T12:00:00.000Z",
});

describe("archive tables", () => {
  it("applies the schema twice without error", async () => {
    await db.exec(schemaSql());
  });

  it("keeps the first copy of an event id and stores list values as data", async () => {
    expect(await insertEvents(db, [row("e1", 10), row("e2", 11)])).toBe(2);
    expect(await insertEvents(db, [row("e1", 10, "AAAAAA=="), row("e3", 12)])).toBe(1);
    const stored = await db.query<{ id: string; value_xdr: string; accounts: string[] }>(
      "select id, value_xdr, accounts from events order by id",
    );
    expect(stored.map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
    expect(stored[0]!.value_xdr).toBe("AAAAAQ==");
    expect(stored[0]!.accounts).toEqual(["G'; drop table events; --"]);
  });

  it("merges ranges that touch or overlap into one row", async () => {
    await addIngestedRange(db, 100, 199);
    await addIngestedRange(db, 300, 400);
    await addIngestedRange(db, 200, 250);
    await addIngestedRange(db, 240, 299);
    expect((await readCoverage(db)).ranges).toEqual([[100, 400]]);
    await addIngestedRange(db, 402, 410);
    expect((await readCoverage(db)).ranges).toEqual([[100, 400], [402, 410]]);
  });

  it("lets one lazy catch-up start per interval", async () => {
    const t = new Date("2026-10-07T12:00:00Z");
    expect(await claimIngestSlot(db, t, 5_000)).toBe(true);
    expect(await claimIngestSlot(db, new Date(t.getTime() + 1_000), 5_000)).toBe(false);
    expect(await claimIngestSlot(db, new Date(t.getTime() + 5_000), 5_000)).toBe(true);
  });

  it("forgets per-IP counts from hours that are over", async () => {
    const hour = new Date("2026-10-07T12:00:00Z");
    expect(await countSponsorRequest(db, "1.2.3.4", hour, 2)).toBe(true);
    expect(await countSponsorRequest(db, "1.2.3.4", new Date(hour.getTime() + 2 * 3_600_000), 2)).toBe(true);
    expect(await db.query("select hour_start from ip_hour")).toHaveLength(1);
  });
});

describe("relay dedupe", () => {
  const t = new Date("2026-10-07T12:00:00Z");
  const after = (ms: number) => new Date(t.getTime() + ms);

  it("lets one claim through per digest per window and hands later copies the first result", async () => {
    const first = await claimRelay(db, "d1", t, 120_000);
    expect(first).toEqual({ claimed: true, claimedAt: t });
    expect(await claimRelay(db, "d1", after(1_000), 120_000)).toEqual({ claimed: false, transactionId: null, status: null });
    await recordRelay(db, "d1", t, "tx_7", "pending");
    expect(await claimRelay(db, "d1", after(119_999), 120_000)).toEqual({ claimed: false, transactionId: "tx_7", status: "pending" });
    expect(await claimRelay(db, "d2", after(1), 120_000)).toMatchObject({ claimed: true });
    expect(await claimRelay(db, "d1", after(120_000), 120_000)).toMatchObject({ claimed: true });
  });

  it("releases only an unanswered claim, and only the claim it was given", async () => {
    await claimRelay(db, "d3", t, 120_000);
    await releaseRelay(db, "d3", after(5));
    expect(await claimRelay(db, "d3", after(10), 120_000)).toMatchObject({ claimed: false });
    await releaseRelay(db, "d3", t);
    expect(await claimRelay(db, "d3", after(20), 120_000)).toMatchObject({ claimed: true });
    await recordRelay(db, "d3", after(20), "tx_8", "pending");
    await releaseRelay(db, "d3", after(20));
    expect(await claimRelay(db, "d3", after(30), 120_000)).toMatchObject({ claimed: false, transactionId: "tx_8" });
  });

  it("forgets claims older than an hour", async () => {
    await claimRelay(db, "old", t, 120_000);
    await claimRelay(db, "new", after(3_600_001), 120_000);
    expect(await db.query("select digest from relay_dedupe")).toEqual([{ digest: "new" }]);
  });
});

describe("the read-only role from the schema comment", () => {
  it("can read the archive and nothing else, and cannot write anywhere", async () => {
    const database = (await db.query<{ name: string }>("select current_database() as name"))[0]!.name;
    const statements = schemaSql()
      .split("\n")
      .filter((line) => line.startsWith("--   "))
      .map((line) =>
        line
          .slice(5)
          .replace("login password '<generate one>'", "nologin")
          .replace("<your database>", '"' + database + '"'),
      );
    expect(statements).toHaveLength(5);
    await insertEvents(db, [row("e1", 10)]);
    for (const statement of statements) await pg.exec(statement);

    await pg.exec("set role kalypso_api");
    try {
      expect((await pg.query("select id from events")).rows).toHaveLength(1);
      await pg.query("select * from ingested_ranges");
      await pg.query("select * from gaps");
      await pg.query("select * from archive_state");
      for (const write of [
        "insert into events (id, ledger, tx_hash, tx_index, op_index, event_index, contract_id, accounts, topics_xdr, value_xdr, ledger_closed_at) values ('x', 1, 'h', 0, 0, 0, 'c', '{}', '{}', 'v', now())",
        "delete from events",
        "update archive_state set latest_ledger = 1",
        "insert into gaps values (1, 2, now())",
        "truncate ingested_ranges",
        "select * from ip_hour",
        "select * from day_budget",
        "select * from relay_dedupe",
      ]) {
        await expect(pg.query(write), write).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await pg.exec("reset role");
    }
  });
});
