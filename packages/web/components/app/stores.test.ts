import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAccountantId, saveAccountantId } from "./accountant/accountant-store";
import { readCompanies, saveCompany } from "./employer/company-store";
import { ShownMessage, describeError, problemsOf } from "./errors";

const ADDRESS = "GDG33P5FV5F5A2JDU5O2C4SXVBXWVAZRFY2DNVZZKHIKY2DO4R26QSAZ";

function fakeWindow(items: Record<string, string>, failWrites = false) {
  const localStorage = {
    getItem: (key: string) => (key in items ? (items[key] as string) : null),
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("quota");
      items[key] = value;
    },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("saved companies", () => {
  beforeEach(() => fakeWindow({}));

  it("reads nothing when nothing is saved", () => {
    expect(readCompanies(ADDRESS)).toEqual([]);
  });

  it("ignores damaged, wrong-shaped and repeated entries instead of throwing", () => {
    const items = {
      [`kalypso/employer/v1/${ADDRESS}`]: JSON.stringify([
        { id: "3", label: "Kept" },
        { id: "3", label: "Repeated id" },
        { id: 4, label: "Number id" },
        { id: "abc", label: "Not digits" },
        { id: "5" },
        null,
        "text",
        { id: "6", label: "x".repeat(500) },
        { id: "7", label: "Also kept" },
      ]),
    };
    fakeWindow(items);
    expect(readCompanies(ADDRESS)).toEqual([
      { id: "3", label: "Kept" },
      { id: "7", label: "Also kept" },
    ]);
    fakeWindow({ [`kalypso/employer/v1/${ADDRESS}`]: "{not json" });
    expect(readCompanies(ADDRESS)).toEqual([]);
    fakeWindow({ [`kalypso/employer/v1/${ADDRESS}`]: '{"id":"1"}' });
    expect(readCompanies(ADDRESS)).toEqual([]);
  });

  it("puts the newest company first and replaces one with the same id", () => {
    saveCompany(ADDRESS, { id: "1", label: "First" });
    saveCompany(ADDRESS, { id: "2", label: "Second" });
    const list = saveCompany(ADDRESS, { id: "1", label: "First renamed" });
    expect(list).toEqual([
      { id: "1", label: "First renamed" },
      { id: "2", label: "Second" },
    ]);
    expect(readCompanies(ADDRESS)).toEqual(list);
  });

  it("still returns the list for this visit when the browser refuses to save", () => {
    fakeWindow({}, true);
    expect(saveCompany(ADDRESS, { id: "9", label: "Nine" })).toEqual([{ id: "9", label: "Nine" }]);
  });
});

describe("saved accountant id", () => {
  it("round-trips a whole number and refuses anything else", () => {
    fakeWindow({});
    expect(readAccountantId(ADDRESS)).toBeUndefined();
    saveAccountantId(ADDRESS, 71);
    expect(readAccountantId(ADDRESS)).toBe(71);
    fakeWindow({ [`kalypso/accountant/v1/${ADDRESS}`]: '{"id":-1}' });
    expect(readAccountantId(ADDRESS)).toBeUndefined();
    fakeWindow({ [`kalypso/accountant/v1/${ADDRESS}`]: '{"id":1.5}' });
    expect(readAccountantId(ADDRESS)).toBeUndefined();
    fakeWindow({ [`kalypso/accountant/v1/${ADDRESS}`]: "garbage" });
    expect(readAccountantId(ADDRESS)).toBeUndefined();
  });
});

describe("what an error note shows", () => {
  it("shows the lib's own sentence and flags rebuildable and damaged-record errors", () => {
    const rebuild = Object.assign(new Error("Rebuild it."), { name: "ConsoleError", code: "NEEDS_REBUILD", rebuildable: true });
    expect(describeError(rebuild)).toMatchObject({ message: "Rebuild it.", rebuildable: true, damaged: false, code: "NEEDS_REBUILD" });
    const damaged = Object.assign(new Error("Damaged."), { name: "ConsoleError", code: "RECORD_DAMAGED", rebuildable: false });
    expect(describeError(damaged)).toMatchObject({ damaged: true, rebuildable: false });
  });

  it("words a pending deposit the page's own way", () => {
    const pending = Object.assign(new Error("lib sentence"), { name: "ConsoleError", code: "DEPOSIT_PENDING" });
    expect(describeError(pending).message).toBe("A deposit is still waiting on the network. Try again in a minute.");
  });

  it("never passes on the text of an error it does not know", () => {
    const shown = describeError(new Error("secret-looking detail from somewhere"));
    expect(shown.message).not.toContain("secret-looking");
    expect(shown.message).toMatch(/try again/i);
    expect(describeError("a string").kind).toBe("unknown");
  });

  it("shows the page's own messages and lists a refused file's problems", () => {
    expect(describeError(new ShownMessage("Mine.")).message).toBe("Mine.");
    const refused = Object.assign(new Error("x"), { name: "ConsoleError", problems: [{ line: 2, code: "A", sentence: "Line 2 has no amount." }, { nope: 1 }] });
    expect(problemsOf(refused)).toEqual([{ line: 2, code: "A", sentence: "Line 2 has no amount." }]);
    expect(problemsOf(new Error("x"))).toEqual([]);
  });
});
