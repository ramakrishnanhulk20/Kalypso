// The two rules prove.mjs applies to history it has read: P3's treasury spend count and P9's
// start-at-deploy check, on made-up histories.
//
// Does not cover: reading that history from RPC or the archive, core's audit producing the
// undecryptable list P3 compares with, or whether testnet.json holds the real deploy transaction.
// Those run only against the live network, in npm run prove:testnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startsAtDeploy, treasurySpendCount } from "./prove-rules.mjs";

const TREASURY = "GTREASURY";
const OUTSIDER = "GOUTSIDER";
const worker = (i) => `GWORKER${i}`;
const token = (type, fields) => ({ kind: "token", event: { type, ...fields } });
const SALARY_COUNT = 12;

// A treasury moved to a new payroll contract: the earlier contract's 12 pays and the new 12 (the
// last one undecodable), with deposits, merges, an incoming transfer and other contracts' events.
const reseeded = [
  token("register", { account: TREASURY }),
  token("deposit", { from: TREASURY, to: TREASURY, amount: 1n }),
  token("merge", { account: TREASURY }),
  ...Array.from({ length: 12 }, (_, i) => token("transfer", { from: TREASURY, to: worker(i % 6) })),
  token("deposit", { from: TREASURY, to: TREASURY, amount: 1n }),
  token("merge", { account: TREASURY }),
  token("transfer", { from: OUTSIDER, to: TREASURY }),
  ...Array.from({ length: 11 }, (_, i) => token("transfer", { from: TREASURY, to: worker(i % 6) })),
  { kind: "undecodable", name: "transfer", parties: [TREASURY, worker(5)] },
  { kind: "undecodable", name: "transfer", parties: [OUTSIDER, TREASURY] },
  { kind: "payroll", event: { type: "payslip_issued" } },
  { kind: "ignored", name: "auditor_set", parties: [] },
];

// P3 passes when every spend is marked undecryptable and the spends cover the showcase salaries.
const p3Passes = (spends, undecryptable) => undecryptable === spends && spends >= SALARY_COUNT;

test("P3 counts the earlier and the new payroll's spends, the undecodable one included", () => {
  assert.equal(treasurySpendCount(reseeded, TREASURY), 24);
});

test("P3 does not count transfers into the treasury, or undecodable ones naming someone else first", () => {
  const incomingOnly = [token("transfer", { from: OUTSIDER, to: TREASURY }), { kind: "undecodable", name: "transfer", parties: [OUTSIDER, TREASURY] }];
  assert.equal(treasurySpendCount(incomingOnly, TREASURY), 0);
});

test("P3 passes at 24 marked and fails at 12 or 25", () => {
  const spends = treasurySpendCount(reseeded, TREASURY);
  assert.equal(p3Passes(spends, 24), true);
  assert.equal(p3Passes(spends, 12), false);
  assert.equal(p3Passes(spends, 25), false);
});

test("P3 fails a history with fewer spends than the showcase salaries", () => {
  const spends = treasurySpendCount(reseeded.slice(0, 3), TREASURY);
  assert.equal(spends, 0);
  assert.equal(p3Passes(spends, spends), false);
});

test("P3 counts a withdraw from the treasury as a spend", () => {
  assert.equal(treasurySpendCount([token("withdraw", { from: TREASURY, to: TREASURY })], TREASURY), 1);
});

const DEPLOY_TX = { hash: "d".repeat(64), ledger: 5083382 };
const deployEvents = [
  { ledger: DEPLOY_TX.ledger, txHash: DEPLOY_TX.hash, name: "underlying_asset_set" },
  { ledger: DEPLOY_TX.ledger, txHash: DEPLOY_TX.hash, name: "verifier_set" },
  { ledger: DEPLOY_TX.ledger, txHash: DEPLOY_TX.hash, name: "auditor_set" },
];
const later = { ledger: DEPLOY_TX.ledger + 8, txHash: "e".repeat(64), name: "register" };
const firstOf = (events) => (events.length === 0 ? null : { ledger: events[0].ledger, txHash: events[0].txHash });

test("P9 accepts the deploy transaction's events with underlying_asset_set first", () => {
  assert.equal(startsAtDeploy(firstOf([...deployEvents, later]), DEPLOY_TX), true);
});

test("P9 accepts the deploy transaction's events in another order", () => {
  const reordered = [deployEvents[2], deployEvents[0], deployEvents[1], later];
  assert.equal(startsAtDeploy(firstOf(reordered), DEPLOY_TX), true);
});

test("P9 refuses another transaction's event first in the deploy ledger", () => {
  const intruder = { ledger: DEPLOY_TX.ledger, txHash: "f".repeat(64), name: "deposit" };
  assert.equal(startsAtDeploy(firstOf([intruder, ...deployEvents]), DEPLOY_TX), false);
});

test("P9 refuses a history that starts after the deploy", () => {
  assert.equal(startsAtDeploy(firstOf([later]), DEPLOY_TX), false);
});

test("P9 refuses the deploy hash in the wrong ledger", () => {
  assert.equal(startsAtDeploy(firstOf([{ ledger: DEPLOY_TX.ledger - 1, txHash: DEPLOY_TX.hash }]), DEPLOY_TX), false);
});

test("P9 refuses a history with no event at all", () => {
  assert.equal(startsAtDeploy(firstOf([]), DEPLOY_TX), false);
});
