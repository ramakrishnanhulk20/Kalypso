// Covers the four translations against the English file: every key exists with the same ICU
// placeholders and plural branches, no value is left in English except the brand terms, and no
// file carries the long dash (U+2014) or the doubled Chinese dash. Also covers the English file
// against the libs' own lists of anchor statuses, worker error codes, sandbox steps, history gaps,
// faucet codes, console progress steps, join steps and failed-row reasons (C56), and each anchor
// status against the anchor lib's own English sentence.
// Does NOT assess the wording, or cover codes from libs that publish no list.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HISTORY_GAP_REASONS } from "../lib/accountant/books";
import { PROGRESS_STEPS } from "../lib/employer/progress";
import { ROW_FAILURE_REASONS } from "../lib/employer/runs";
import { FAUCET_CODES } from "../lib/faucet";
import { SANDBOX_STEPS } from "../lib/sandbox/storage";
import { CASH_OUT_STATUSES, STATUS_SENTENCES } from "../lib/worker/anchor";
import { WORKER_ERROR_CODES } from "../lib/worker/errors";
import { JOIN_STEP_KEYS } from "../lib/worker/join";
import en from "./en.json";

const LOCALES = ["es", "pt", "fr", "zh"] as const;
const LONG_DASH = String.fromCharCode(0x2014);

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out.set(prefix + key, value);
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

// The ICU arguments a message uses, with their plural branches, and the rich-text tags.
function shapeOf(message: string): string {
  const args = [...message.matchAll(/\{\s*(\w+)\s*(?:,\s*(\w+))?/g)].map((m) => (m[2] ? `${m[1]}:${m[2]}` : m[1])).sort();
  const branches = [...message.matchAll(/\b(one|other)\s*\{/g)].map((m) => m[1]).sort();
  const tags = [...message.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
  return JSON.stringify({ args, branches, tags });
}

// A value that may read the same in every language: once its placeholders and the brand and
// protocol words are taken out, no letters are left ("{label} · #{id}", "Stellar testnet", "01").
const BRAND_WORDS = /Kalypso|USDC|XLM|EN|Stellar|Freighter|Face ID|testnet|Sandbox/g;
function languageNeutral(value: string): boolean {
  return !/\p{L}/u.test(value.replace(/\{[^}]*\}/g, "").replace(BRAND_WORDS, ""));
}

// Keys whose translation is, correctly, the English word: "Total", "Memo", "tx" and "s" read the
// same in Spanish, Portuguese and French; French also keeps "Invitation" and the "open source"
// loanword, and Brazilian Portuguese says "Status". French and Portuguese both say "Menu". Spanish,
// Portuguese and French say "Test" on the short testnet badge, where a longer word does not fit a phone.
const TOTALS = ["landing.ledger.total", "landing.ledger.tx", "sandbox.card.total", "sandbox.run.seconds", "employer.payroll.total", "accountant.books.total"];
const SAME_AS_ENGLISH: Record<(typeof LOCALES)[number], ReadonlySet<string>> = {
  es: new Set([...TOTALS, "worker.confirm.memo", "common.testShort"]),
  pt: new Set([...TOTALS, "worker.confirm.memo", "employer.payroll.status", "siteNav.menu", "common.testShort"]),
  fr: new Set([...TOTALS, "landing.hero.credit4", "worker.invite.label", "siteNav.menu", "common.testShort"]),
  zh: new Set(),
};

const english = flatten(en as Tree);

describe.each(LOCALES)("messages/%s.json", (locale) => {
  const file = path.join(import.meta.dirname, `${locale}.json`);
  const raw = readFileSync(file, "utf8");
  const translated = flatten(JSON.parse(raw) as Tree);

  it("has every English key and no other", () => {
    const missing = [...english.keys()].filter((key) => !translated.has(key));
    const extra = [...translated.keys()].filter((key) => !english.has(key));
    expect(missing, "missing").toEqual([]);
    expect(extra, "extra").toEqual([]);
  });

  it("keeps every placeholder, plural branch and rich tag", () => {
    const wrong = [...english].filter(([key, value]) => shapeOf(value) !== shapeOf(translated.get(key) ?? "")).map(([key]) => key);
    expect(wrong).toEqual([]);
  });

  it("translates every value except the brand terms", () => {
    const untouched = [...english]
      .filter(([key, value]) => translated.get(key) === value && !languageNeutral(value) && !SAME_AS_ENGLISH[locale].has(key))
      .map(([key]) => key);
    expect(untouched).toEqual([]);
  });

  it("has no long dash, no doubled dash and no byte-order mark", () => {
    expect(raw.includes(LONG_DASH)).toBe(false);
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(raw.slice(0, 1)).toBe("{");
  });
});

describe("messages/en.json", () => {
  it("has no long dash", () => {
    expect(readFileSync(path.join(import.meta.dirname, "en.json"), "utf8").includes(LONG_DASH)).toBe(false);
  });

  // The other four files are held to these same keys above, so a key here is a sentence in all five.
  it.each([
    ["worker.anchor.status", CASH_OUT_STATUSES],
    ["errors.worker", WORKER_ERROR_CODES],
    ["sandbox.progress", SANDBOX_STEPS],
    ["worker.gaps", HISTORY_GAP_REASONS],
    ["testFunds.errors", FAUCET_CODES],
    ["progress", PROGRESS_STEPS],
    ["worker.joinSteps", JOIN_STEP_KEYS],
    ["errors.run", ROW_FAILURE_REASONS],
  ] as const)("has a sentence under %s for every entry in the lib's own list", (namespace, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter((entry) => !english.has(`${namespace}.${entry}`))).toEqual([]);
  });

  // The English page shows the anchor lib's own sentence and the other languages translate this
  // file, so the two English wordings must be one, or a status means different things by language.
  it("says every anchor status in exactly the words of lib/worker/anchor.ts", () => {
    const drift = CASH_OUT_STATUSES.filter((status) => english.get(`worker.anchor.status.${status}`) !== STATUS_SENTENCES[status]);
    expect(drift).toEqual([]);
  });
});
