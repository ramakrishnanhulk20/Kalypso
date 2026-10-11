import es from "./docs-ui.es.json";
import fr from "./docs-ui.fr.json";
import pt from "./docs-ui.pt.json";
import zh from "./docs-ui.zh.json";

type DocsUiTable = Partial<Record<string, string>>;

const TABLES: Record<string, DocsUiTable> = { es, fr, pt, zh };

// The Fumadocs chrome (search placeholder, "On this page", previous and next, the sidebar) in
// each language. English is Fumadocs' own default, so it needs no table.
export function docsUiTranslations(locale: string): DocsUiTable | undefined {
  return TABLES[locale];
}
