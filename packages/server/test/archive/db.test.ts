// Not covered here: Neon itself (its server version, TLS, and its role and
// password handling). `npm test` runs this SQL in PGlite directly; `npm run
// test:wire` runs it through the production driver, postgres.js with
// production's options, over a socket to PGlite standing in for the server.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addIngestedRange,
  claimAuthEntries,
  claimIngestSlot,
  claimRelay,
  countAuthoriserRelays,
  creationFeeSpent,
  dailyFeeSpent,
  forgetExpiredRelays,
  holdRelay,
  readArchiveState,
  recordRelay,
  releaseAuthoriserRelays,
  releaseDailyFee,
  releaseRelay,
  reserveDailyFee,
  countSponsorRequest,
  creationRelaysOf,
  dropCreationRelay,
  eventsForAccount,
  finishCreationRelay,
  noteCreationHash,
  startCreationRelay,
  insertEvents,
  latestCheckpoint,
  readCoverage,
  recordWalletBirth,
  schemaSql,
  setArchiveStart,
  settleArchiveStart,
  walletBirthOf,
  type Db,
  type EventRow,
  type StoredEvent,
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
  await clearTables(db, ["ip_hour", "address_day", "day_budget", "creation_budget", "relay_dedupe", "relay_auth", "wallet_births", "relayed_creations"]);
});

const WALLET = "CBSDDY2NMUMLVTXGTKJ2R7JBJDRWG2NJN6J7ZHLZHT6NJID6ZEYFGKSK";

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

  it("forgets unheld claims older than an hour, and never a held one by time", async () => {
    await claimRelay(db, "old", t, 120_000);
    await claimRelay(db, "held", t, 120_000);
    await holdRelay(db, "held", t, 5_000);
    await claimRelay(db, "new", after(3_600_001), 120_000);
    expect(await db.query("select digest from relay_dedupe order by digest")).toEqual([{ digest: "held" }, { digest: "new" }]);
  });

  it("holds a claim held to a ledger past every time window, until a simulation reports that ledger reached", async () => {
    const hours = (h: number, ms = 0) => after(h * 3_600_000 + ms);
    await claimRelay(db, "h1", t, 120_000);
    await holdRelay(db, "h1", t, 1_000);
    expect(await claimRelay(db, "h1", hours(10), 120_000)).toEqual({ claimed: false, transactionId: null, status: null });
    await recordRelay(db, "h1", t, "tx_9", "pending");
    expect(await claimRelay(db, "h1", hours(10, 1), 120_000)).toEqual({ claimed: false, transactionId: "tx_9", status: "pending" });
    await forgetExpiredRelays(db, 999);
    expect(await claimRelay(db, "h1", hours(10, 2), 120_000)).toMatchObject({ claimed: false });
    await forgetExpiredRelays(db, 1_000);
    expect(await claimRelay(db, "h1", hours(10, 3), 120_000)).toMatchObject({ claimed: true });
  });

  it("holds only the claim it was given", async () => {
    await claimRelay(db, "h2", t, 120_000);
    await holdRelay(db, "h2", after(1), 1_000);
    expect(await claimRelay(db, "h2", after(120_000), 120_000)).toMatchObject({ claimed: true });
  });
});

describe("signed auth entry claims", () => {
  const t = new Date("2026-10-07T12:00:00Z");
  const after = (ms: number) => new Date(t.getTime() + ms);
  const e1 = { address: "GW", nonce: "1", expiryLedger: 900 };
  const e2 = { address: "GW", nonce: "2", expiryLedger: 1_000 };
  const claimBody = async (digest: string, at: Date, entries = [e1]) => {
    expect(await claimRelay(db, digest, at, 120_000)).toMatchObject({ claimed: true });
    return claimAuthEntries(db, entries, digest, at, 120_000);
  };

  it("lets one body claim an entry, all or nothing, and refuses it to every other body", async () => {
    expect(await claimBody("a", t, [e1])).toBe(true);
    expect(await claimBody("b", after(1), [e2, e1])).toBe(false);
    expect(await db.query("select address, nonce, digest from relay_auth order by nonce")).toEqual([{ address: "GW", nonce: "1", digest: "a" }]);
    expect(await claimBody("c", after(2), [e2])).toBe(true);
  });

  it("lets an unheld claim go after its window, but holds a held entry past any window until its own expiry ledger", async () => {
    await claimBody("a", t, [e1, e2]);
    expect(await claimBody("b", after(120_000), [e1])).toBe(true);
    await holdRelay(db, "b", after(120_000), 900);
    const hours = (h: number) => after(h * 3_600_000);
    expect(await claimBody("c", hours(5), [e1])).toBe(false);
    await forgetExpiredRelays(db, 899);
    expect(await claimBody("d", hours(6), [e1])).toBe(false);
    await forgetExpiredRelays(db, 900);
    expect(await claimBody("e", hours(7), [e1])).toBe(true);
  });

  it("gives entries back with their body, and never once the body recorded a relay", async () => {
    await claimBody("a", t, [e1]);
    await releaseRelay(db, "a", t);
    expect(await claimBody("b", after(1), [e1])).toBe(true);
    await recordRelay(db, "b", after(1), "tx_1", "pending");
    await releaseRelay(db, "b", after(1));
    expect(await claimBody("c", after(2), [e1])).toBe(false);
  });

  it("forgets unheld entry claims older than an hour", async () => {
    await claimBody("a", t, [e1]);
    await claimBody("b", after(3_600_001), [e2]);
    expect(await db.query("select nonce from relay_auth")).toEqual([{ nonce: "2" }]);
  });

  it("passes a database failure on instead of reading it as a claimed entry", async () => {
    const broken: Db = { ...db, transaction: async () => Promise.reject(new Error("connection lost")) };
    await expect(claimAuthEntries(broken, [e1], "a", t, 120_000)).rejects.toThrow("connection lost");
  });
});

describe("daily fee budget", () => {
  const day = "2026-10-07";

  it("gives a reservation back on release, never below zero, and ignores a release of nothing", async () => {
    expect(await reserveDailyFee(db, day, 500n, 1_000n)).toBe(true);
    expect(await reserveDailyFee(db, day, 600n, 1_000n)).toBe(false);
    await releaseDailyFee(db, day, 500n);
    expect(await dailyFeeSpent(db, day)).toBe(0n);
    expect(await reserveDailyFee(db, day, 600n, 1_000n)).toBe(true);
    await releaseDailyFee(db, day, 10_000n);
    expect(await dailyFeeSpent(db, day)).toBe(0n);
    expect(await reserveDailyFee(db, day, 300n, 1_000n)).toBe(true);
    await releaseDailyFee(db, day, 0n);
    await releaseDailyFee(db, day, -300n);
    expect(await dailyFeeSpent(db, day)).toBe(300n);
    await releaseDailyFee(db, "2026-10-08", 100n);
    expect(await dailyFeeSpent(db, "2026-10-08")).toBe(0n);
  });

  it("reserves a creation from the day and from the creation share together, all or nothing, and gives both back together", async () => {
    const spent = async () => [await dailyFeeSpent(db, day), await creationFeeSpent(db, day)];
    expect(await reserveDailyFee(db, day, 400n, 1_000n, 500n)).toBe(true);
    expect(await reserveDailyFee(db, day, 200n, 1_000n, 500n)).toBe(false);
    expect(await spent()).toEqual([400n, 400n]);
    expect(await reserveDailyFee(db, day, 500n, 1_000n)).toBe(true);
    expect(await reserveDailyFee(db, day, 100n, 1_000n, 500n)).toBe(true);
    expect(await reserveDailyFee(db, day, 1n, 1_000n, 1_000n)).toBe(false);
    expect(await spent()).toEqual([1_000n, 500n]);
    expect(await reserveDailyFee(db, day, 600n, 2_000n, 500n)).toBe(false);
    await releaseDailyFee(db, day, 100n, true);
    expect(await spent()).toEqual([900n, 400n]);
    await releaseDailyFee(db, day, 500n);
    expect(await spent()).toEqual([400n, 400n]);
    await releaseDailyFee(db, day, 9_000n, true);
    expect(await spent()).toEqual([0n, 0n]);
  });

  it("passes a database failure in a creation reservation on instead of reading it as a spent budget", async () => {
    const broken: Db = { ...db, transaction: async () => Promise.reject(new Error("connection lost")) };
    await expect(reserveDailyFee(broken, day, 1n, 10n, 5n)).rejects.toThrow("connection lost");
  });
});

describe("per-address daily count", () => {
  const counts = () => db.query("select address, day::text as day, count from address_day order by address, day");

  it("counts every address of a request once, all or nothing, up to the limit per day", async () => {
    expect(await countAuthoriserRelays(db, ["GA", "CB"], "2026-10-07", 2)).toBe(true);
    expect(await countAuthoriserRelays(db, ["GA", "GA"], "2026-10-07", 2)).toBe(true);
    expect(await countAuthoriserRelays(db, ["CB", "GA"], "2026-10-07", 2)).toBe(false);
    expect(await counts()).toEqual([
      { address: "CB", day: "2026-10-07", count: 1 },
      { address: "GA", day: "2026-10-07", count: 2 },
    ]);
    expect(await countAuthoriserRelays(db, ["CB"], "2026-10-07", 2)).toBe(true);
    expect(await countAuthoriserRelays(db, ["GA"], "2026-10-08", 2)).toBe(true);
  });

  it("gives one relay back per address, all at once, dropping a row that reaches zero and touching no other day", async () => {
    await countAuthoriserRelays(db, ["GA", "CB"], "2026-10-07", 5);
    await countAuthoriserRelays(db, ["GA"], "2026-10-07", 5);
    await countAuthoriserRelays(db, ["GA"], "2026-10-08", 5);
    await releaseAuthoriserRelays(db, ["GA", "CB", "GA", "CZ"], "2026-10-07");
    expect(await counts()).toEqual([
      { address: "GA", day: "2026-10-07", count: 1 },
      { address: "GA", day: "2026-10-08", count: 1 },
    ]);
    await releaseAuthoriserRelays(db, ["CB"], "2026-10-07");
    expect(await counts()).toHaveLength(2);
  });

  it("forgets days before yesterday", async () => {
    for (const day of ["2026-10-05", "2026-10-06", "2026-10-07"]) await countAuthoriserRelays(db, ["GA"], day, 2);
    expect((await counts()).map((r) => r.day)).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("passes a database failure on instead of reading it as the limit", async () => {
    const broken: Db = { ...db, transaction: async () => Promise.reject(new Error("connection lost")) };
    await expect(countAuthoriserRelays(broken, ["GA"], "2026-10-07", 2)).rejects.toThrow("connection lost");
  });
});

describe("lists through the driver", () => {
  // Every list travels as one JSON text parameter. postgres.js serialises again any parameter the
  // server describes as jsonb, so under test:wire a list that is not cast through text arrives as
  // one JSON string. Not covered: lists long enough to meet a parameter size limit.
  const day = "2026-10-07";
  const counts = () => db.query("select address, count from address_day where day = $1::date order by address", [day]);
  const stored = (r: EventRow): StoredEvent => ({
    id: r.id,
    ledger: r.ledger,
    txHash: r.txHash,
    txIndex: r.txIndex,
    opIndex: r.opIndex,
    eventIndex: r.eventIndex,
    contractId: r.contractId,
    topicsXdr: r.topicsXdr,
    valueXdr: r.valueXdr,
    ledgerClosedAt: new Date(r.ledgerClosedAt),
  });

  it("counts and gives back several authorising addresses in one call", async () => {
    expect(await countAuthoriserRelays(db, ["GA", "CB", "GC"], day, 2)).toBe(true);
    expect(await countAuthoriserRelays(db, ["CB", "GC"], day, 2)).toBe(true);
    expect(await countAuthoriserRelays(db, ["GA", "GC"], day, 2)).toBe(false);
    expect(await counts()).toEqual([
      { address: "CB", count: 2 },
      { address: "GA", count: 1 },
      { address: "GC", count: 2 },
    ]);
    await releaseAuthoriserRelays(db, ["GA", "CB"], day);
    expect(await counts()).toEqual([
      { address: "CB", count: 1 },
      { address: "GC", count: 2 },
    ]);
  });

  it("stores several events in one call and reads every value back as sent, filtered by a list of names", async () => {
    const merge: EventRow = { ...row("e1", 10), accounts: ["GA", "CB"], topicsXdr: ["AAAA", "BBBB"], topic1Address: "GA" };
    const transfer: EventRow = { ...row("e2", 11), eventName: "transfer", accounts: ["GA"], topic1Address: "GA", ledgerClosedAt: "2026-10-07T12:00:05.123Z" };
    const deposit: EventRow = { ...row("e3", 12), eventName: "deposit", accounts: ["GA"], topic1Address: "GA" };
    expect(await insertEvents(db, [merge, transfer, deposit])).toBe(3);
    expect(await db.query("select accounts from events where id = 'e1'")).toEqual([{ accounts: ["GA", "CB"] }]);

    const read = { contractId: TOKEN, account: "GA", fromLedger: 1, toLedger: 100, after: null, limit: 10 };
    expect(await eventsForAccount(db, { ...read, types: ["merge", "transfer"] })).toEqual([stored(merge), stored(transfer)]);
    expect(await eventsForAccount(db, { ...read, types: null })).toEqual([stored(merge), stored(transfer), stored(deposit)]);
    expect(await latestCheckpoint(db, { contractId: TOKEN, account: "GA", atLedger: 100, eventNames: ["merge", "transfer"] })).toEqual(stored(transfer));
  });
});

describe("wallet births", () => {
  it("keeps the first birth stored for an address and reads it back; an unknown wallet has none", async () => {
    expect(await walletBirthOf(db, WALLET)).toBeNull();
    expect(await recordWalletBirth(db, { address: WALLET, hash: "ab".repeat(32), ledger: 5_100_757 })).toBe(true);
    expect(await recordWalletBirth(db, { address: WALLET, hash: "cd".repeat(32), ledger: 5_100_800 })).toBe(false);
    expect(await walletBirthOf(db, WALLET)).toBe("ab".repeat(32));
    expect(await walletBirthOf(db, "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL")).toBeNull();
  });

  it("refuses a row whose address, hash or ledger is not in its one format, whatever the caller checked", async () => {
    for (const birth of [
      { address: WALLET.toLowerCase(), hash: "ab".repeat(32), ledger: 1 },
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", hash: "ab".repeat(32), ledger: 1 },
      { address: WALLET, hash: "AB".repeat(32), ledger: 1 },
      { address: WALLET, hash: "ab", ledger: 1 },
      { address: WALLET, hash: "ab".repeat(32), ledger: 0 },
    ]) {
      await expect(recordWalletBirth(db, birth), JSON.stringify(birth)).rejects.toThrow();
    }
    expect(await walletBirthOf(db, WALLET)).toBeNull();
  });
});

describe("relayed creations", () => {
  const OTHER = "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL";

  it("keeps each relayed creation per address, lists them newest first, fills one in, notes a hash once, and drops only the one it is given", async () => {
    const first = await startCreationRelay(db, WALLET);
    const second = await startCreationRelay(db, WALLET);
    const elsewhere = await startCreationRelay(db, OTHER);
    expect(typeof first).toBe("string");
    expect(new Set([first, second, elsewhere]).size).toBe(3);
    await finishCreationRelay(db, first, "tx_a", null);
    await finishCreationRelay(db, second, "tx_b", "cd".repeat(32));
    await noteCreationHash(db, "tx_a", "ab".repeat(32));
    await noteCreationHash(db, "tx_b", "ef".repeat(32));
    await noteCreationHash(db, "tx_unrelated", "ef".repeat(32));
    expect(await creationRelaysOf(db, WALLET)).toEqual({
      relayed: [
        { transactionId: "tx_b", hash: "cd".repeat(32) },
        { transactionId: "tx_a", hash: "ab".repeat(32) },
      ],
      more: false,
    });
    await dropCreationRelay(db, first);
    expect(await creationRelaysOf(db, WALLET)).toEqual({ relayed: [{ transactionId: "tx_b", hash: "cd".repeat(32) }], more: false });
    expect(await creationRelaysOf(db, OTHER)).toEqual({ relayed: [{ transactionId: null, hash: null }], more: false });
  });

  it("refuses a row whose address, transaction id or hash is not in its one format", async () => {
    await expect(startCreationRelay(db, WALLET.toLowerCase())).rejects.toThrow();
    const id = await startCreationRelay(db, WALLET);
    await expect(finishCreationRelay(db, id, "tx 1", null)).rejects.toThrow();
    await expect(finishCreationRelay(db, id, "tx_1", "AB".repeat(32))).rejects.toThrow();
    expect(await creationRelaysOf(db, WALLET)).toEqual({ relayed: [{ transactionId: null, hash: null }], more: false });
  });
});

describe("archive start", () => {
  it("sets the start once, never covering from genesis, and records the start check once", async () => {
    await setArchiveStart(db, 100, true);
    await setArchiveStart(db, 50, false);
    expect(await readArchiveState(db)).toMatchObject({ startLedger: 100, coversFromGenesis: false, startCheckPending: true });
    expect(await settleArchiveStart(db, true)).toBe(true);
    expect(await settleArchiveStart(db, false)).toBe(false);
    expect(await readArchiveState(db)).toMatchObject({ coversFromGenesis: true, startCheckPending: false });
  });

  it("never settles a start that had no check pending", async () => {
    await setArchiveStart(db, 100, false);
    expect(await settleArchiveStart(db, true)).toBe(false);
    expect(await readArchiveState(db)).toMatchObject({ coversFromGenesis: false, startCheckPending: false });
  });
});

describe("the read-only role from the schema comment", () => {
  it("can read the archive and nothing else, and cannot write anywhere, the wallet births included", async () => {
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
        "select * from wallet_births",
        "insert into wallet_births (address, tx_hash, ledger) values ('" + WALLET + "', '" + "ab".repeat(32) + "', 9)",
        "update wallet_births set tx_hash = '" + "cd".repeat(32) + "'",
        "delete from wallet_births",
        "truncate wallet_births",
        "insert into events (id, ledger, tx_hash, tx_index, op_index, event_index, contract_id, accounts, topics_xdr, value_xdr, ledger_closed_at) values ('x', 1, 'h', 0, 0, 0, 'c', '{}', '{}', 'v', now())",
        "delete from events",
        "update archive_state set latest_ledger = 1",
        "insert into gaps values (1, 2, now())",
        "truncate ingested_ranges",
        "select * from ip_hour",
        "select * from address_day",
        "select * from day_budget",
        "select * from creation_budget",
        "select * from relayed_creations",
        "select * from relay_dedupe",
        "select * from relay_auth",
      ]) {
        await expect(pg.query(write), write).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await pg.exec("reset role");
    }
  });
});
