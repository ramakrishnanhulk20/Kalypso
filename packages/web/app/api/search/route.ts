import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// The docs links carry no language (lib/source.ts hides it), so a page has the same address, and so
// the same index id, in every language. One index for all five rejects the second copy of a page, so
// the search is told to keep one index per language, each page found once under its own address.
// Orama ships a stemmer for English only (and leaves it off), so the other languages get their own
// word splitting and accent folding rather than stemming; Chinese uses the multilingual tokenizer,
// which cuts words with the platform's own segmenter, no extra package.
export const { GET } = createFromSource(source, {
  localeMap: { en: "english", es: "spanish", pt: "portuguese", fr: "french", zh: "multilingual" },
});
