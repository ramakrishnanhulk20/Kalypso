// Covers the docs search route end to end for all five languages: it answers 200 for each, a word
// from that language's own index page finds a result written in that language, a page nobody has
// translated is found once and under its English address, and nothing answers 500.
// The docs pages are the real files in content/docs, read from disk with the page text cut into
// headings and lines by a small reader below, because the MDX compiler that normally does this runs
// only inside the Next build. Does NOT cover the compiler's own search text (code blocks, tables), or
// the search box in the browser; the browser walk in scratchpad/web-lens/w9a-walk.mjs covers that.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/.source/server", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  const root = nodePath.join(import.meta.dirname, "../../../content/docs");

  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "");

  // The first heading level the search cares about, then each line of prose under it.
  const structuredData = (body: string) => {
    const headings: { id: string; content: string }[] = [];
    const contents: { heading?: string; content: string }[] = [];
    let heading: string | undefined;
    let fenced = false;
    for (const line of body.split("\n")) {
      if (line.startsWith("```")) {
        fenced = !fenced;
        continue;
      }
      const trimmed = line.trim();
      if (fenced || !trimmed || /^\|?[\s:|-]+\|?$/.test(trimmed) || trimmed.startsWith("<")) continue;
      const match = /^#{1,6}\s+(.*)$/.exec(trimmed);
      if (match) {
        heading = slug(match[1] as string);
        headings.push({ id: heading, content: match[1] as string });
      } else {
        contents.push({ heading, content: trimmed.replace(/[|*`]/g, " ").replace(/\s+/g, " ") });
      }
    }
    return { headings, contents };
  };

  const files: unknown[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(nodePath.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      const absolutePath = nodePath.join(dir, entry.name);
      const text = readFileSync(absolutePath, "utf8");
      const path = `${prefix}${entry.name}`;
      if (entry.name.endsWith(".json")) {
        files.push({ type: "meta", path, absolutePath, data: JSON.parse(text) });
        continue;
      }
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
      const field = (name: string) => new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, "m").exec(front?.[1] ?? "")?.[1];
      files.push({
        type: "page",
        path,
        absolutePath,
        data: {
          info: { path, fullPath: absolutePath },
          title: field("title"),
          description: field("description"),
          structuredData: structuredData(text.slice(front?.[0].length ?? 0)),
        },
      });
    }
  };
  walk(root);
  return { docs: { toFumadocsSource: () => ({ files }) } };
});

const { GET } = await import("./route");

type Hit = { id: string; type: string; content: string; url: string };

async function search(query: string, locale: string): Promise<{ status: number; hits: Hit[] }> {
  // The route answers 500 when it throws, so a throw is reported as one.
  try {
    const response = await GET(new Request(`http://localhost/api/search?query=${encodeURIComponent(query)}&locale=${locale}`));
    return { status: response.status, hits: response.status === 200 ? ((await response.json()) as Hit[]) : [] };
  } catch {
    return { status: 500, hits: [] };
  }
}

// A word from each language's own index page (content/docs/index.<locale>.mdx).
const KNOWN_WORD: Record<string, string> = { en: "payroll", es: "nómina", pt: "folha", fr: "paie", zh: "薪酬" };

describe("GET /api/search", () => {
  it.each(Object.entries(KNOWN_WORD))("answers 200 in %s and finds %s", async (locale, word) => {
    const { status, hits } = await search(word, locale);
    expect(status).toBe(200);
    expect(hits.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(KNOWN_WORD))("finds text written in the language for %s: %s", async (locale, word) => {
    const { hits } = await search(word, locale);
    expect(hits.some((hit) => hit.content.toLowerCase().includes(word))).toBe(true);
  });

  it.each(Object.keys(KNOWN_WORD))("never answers 500 in %s, whatever the query", async (locale) => {
    for (const query of ["zzzzqqqq", "a", "the", "'", "<script>", "支付 payroll nómina"]) {
      expect((await search(query, locale)).status, `${locale} ${query}`).toBe(200);
    }
    const nothing = await GET(new Request(`http://localhost/api/search?locale=${locale}`));
    expect(nothing.status).toBe(200);
  });

  it("answers 200 for a locale it has no index for", async () => {
    expect((await search("payroll", "xx")).status).toBe(200);
  });

  it.each(["es", "pt", "fr", "zh"])("finds an untranslated page once, under its English address, in %s", async (locale) => {
    // Contracts and addresses has no translation, so every language shows the English page.
    const { hits } = await search("addresses", locale);
    const pages = hits.filter((hit) => hit.type === "page" && hit.url === "/docs/contracts");
    expect(pages).toHaveLength(1);
    expect(hits.every((hit) => hit.url.startsWith("/docs"))).toBe(true);
  });

  it("keeps each language's pages out of the others' results", async () => {
    // "nómina" is Spanish; the English index has no such word anywhere.
    expect((await search("nómina", "en")).hits.some((hit) => hit.content.toLowerCase().includes("nómina"))).toBe(false);
  });
});
