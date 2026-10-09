// Covers readCompanies, the company bookkeeping usePayslips runs after each payslips read: an
// answer is kept even after the next read started and failed (the reviewer's F5 sequence), an
// unreadable company is marked unknown, and an answer is dropped once the worker or kit changed.
// Also the state rules the portal reads: the joined list holds the companies the latest view was
// read for, a join card waits for a read to answer, a view never carries over to another worker,
// and NOT_REGISTERED is the new account's empty state, not an error.
// Does NOT cover: the hook's React effects and state (no React renderer here), the rendered page
// (the R-J walk), or the payslips read itself (lib/worker tests).
import { describe, expect, it } from "vitest";
import type { WorkerView } from "@kalypso/core";
import { WorkerError } from "../../../lib/worker/errors";
import { UNJOINED_TEXT, answered, failedFrom, joinedFrom, loadingFrom, readCompanies, viewOf, type PayslipsState } from "./use-payslips";
import type { CompanyFacts } from "./worker-lib";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const slips = (...ids: bigint[]) => ({ payslips: ids.map((companyId) => ({ companyId })) }) as unknown as Pick<WorkerView, "payslips">;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("readCompanies (g)", () => {
  it("keeps company 7's answer after the tick moved on and the next read failed", async () => {
    const companies = new Map<string, CompanyFacts | "unknown">();
    const asked = deferred<CompanyFacts | null>();
    const kit = { company: (id: bigint) => (id === 7n ? asked.promise : Promise.resolve(null)) };
    const signedIn = { kit, worker: {} };
    const owner = { ...signedIn };
    readCompanies(kit, slips(7n), () => owner.kit === signedIn.kit && owner.worker === signedIn.worker, (id, facts) => companies.set(id, facts));
    // The tick moves on: a second payslips read starts and fails. Nothing about the worker or kit changed.
    const second = Promise.reject(new Error("rpc down"));
    await second.catch(() => undefined);
    asked.resolve({ label: "Acme", publiclyReadable: true });
    await flush();
    expect(companies.get("7")).toEqual({ label: "Acme", publiclyReadable: true });
  });

  it("marks a company that cannot be read as unknown, and drops an answer once the worker or the kit changed", async () => {
    const companies = new Map<string, CompanyFacts | "unknown">();
    const late = deferred<CompanyFacts | null>();
    const kit = { company: (id: bigint) => (id === 1n ? Promise.reject(new Error("no such company")) : late.promise) };
    const signedIn = { kit, worker: {} };
    const owner: { kit: unknown; worker: unknown } = { ...signedIn };
    readCompanies(kit, slips(1n, 2n, 2n), () => owner.kit === signedIn.kit && owner.worker === signedIn.worker, (id, facts) => companies.set(id, facts));
    await flush();
    expect(companies.get("1")).toBe("unknown");
    owner.worker = {};
    late.resolve({ label: "Other", publiclyReadable: false });
    await flush();
    expect(companies.has("2")).toBe(false);
  });
});

const viewFor = (...confirmedCompanyIds: bigint[]): WorkerView => ({ complete: true, payslips: [], gaps: [], confirmedCompanyIds });

describe("the joined list and the join card", () => {
  it("lists the recorded companies, then those the latest view confirmed on the roster, each once", () => {
    const done: PayslipsState = { phase: "done", view: viewFor(9n, 4n) };
    expect(joinedFrom([4n], done)).toEqual([4n, 9n]);
    expect(joinedFrom([], { phase: "loading", view: viewFor(9n), answered: true })).toEqual([9n]);
    expect(joinedFrom([3n], { phase: "unjoined" })).toEqual([3n]);
    expect(joinedFrom([], { phase: "idle" })).toEqual([]);
  });

  it("offers a join card only after a read for this worker answered, and keeps that through the next read", () => {
    const idle: PayslipsState = { phase: "idle" };
    const first = loadingFrom(idle, true);
    expect([answered(idle), answered(first)]).toEqual([false, false]);
    const done: PayslipsState = { phase: "done", view: viewFor(9n) };
    expect([answered(done), answered({ phase: "unjoined" }), answered(failedFrom(first, new WorkerError("NETWORK")))]).toEqual([true, true, true]);
    const again = loadingFrom(done, true);
    expect([answered(again), viewOf(again)?.confirmedCompanyIds, answered(loadingFrom(again, true))]).toEqual([true, [9n], true]);
  });

  it("never carries one worker's view or companies over to the next worker", () => {
    const next = loadingFrom({ phase: "done", view: viewFor(9n) }, false);
    expect(next).toEqual({ phase: "loading", view: null, answered: false });
    expect(joinedFrom([], next)).toEqual([]);
  });
});

describe("the unjoined empty state", () => {
  it("turns NOT_REGISTERED into the empty state with its words, and keeps every other failure an error with the last view", () => {
    expect(failedFrom({ phase: "loading", view: null, answered: false }, new WorkerError("NOT_REGISTERED"))).toEqual({ phase: "unjoined" });
    expect(viewOf({ phase: "unjoined" })).toBeNull();
    expect(UNJOINED_TEXT).toBe("No payslips yet. Send your address to your employer. Once they invite you and you join, your payslips appear here.");
    const kept = viewFor(9n);
    const failed = failedFrom({ phase: "loading", view: kept, answered: true }, new WorkerError("CHAIN_DISAGREES"));
    expect(failed).toMatchObject({ phase: "failed", view: kept, error: { code: "CHAIN_DISAGREES" } });
  });
});
