// The companies this wallet created or opened, kept in this browser. It is only a list of
// shortcuts: every figure on screen is read from the chain, so a lost or tampered list can at
// worst hide a company that "Open a company by id" brings back.

export interface SavedCompany {
  /** The company id as decimal text. */
  id: string;
  label: string;
}

const MAX_COMPANIES = 50;
const MAX_LABEL_LENGTH = 200;
const DECIMAL_ID = /^(0|[1-9]\d{0,19})$/;

const keyOf = (address: string) => `kalypso/employer/v1/${address}`;

export function readCompanies(address: string): SavedCompany[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(keyOf(address)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: SavedCompany[] = [];
    for (const item of parsed) {
      const { id, label } = (item ?? {}) as { id?: unknown; label?: unknown };
      if (typeof id !== "string" || !DECIMAL_ID.test(id) || typeof label !== "string" || label.length > MAX_LABEL_LENGTH || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label });
      if (out.length === MAX_COMPANIES) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Adds or renames a company and returns the new list. A browser that refuses to save still gets the list for this visit. */
export function saveCompany(address: string, company: SavedCompany): SavedCompany[] {
  const next = [company, ...readCompanies(address).filter((c) => c.id !== company.id)].slice(0, MAX_COMPANIES);
  try {
    window.localStorage.setItem(keyOf(address), JSON.stringify(next));
  } catch {
    /* the list lives on screen for this visit */
  }
  return next;
}
