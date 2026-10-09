import { RowChip } from "../row-chip";
import type { CompanyFacts } from "./worker-lib";

export const PUBLIC_TITLE = "This company uses the published demo accountant key, so anyone can read its amounts.";
export const UNKNOWN_TITLE = "This company's settings did not load from the chain, so Kalypso cannot say whether anyone else can read this amount. Reload to check again.";

/**
 * True when the company's auditor id is one whose secret key Kalypso published on purpose, in this
 * registry. `published` is core's PUBLISHED_DEMO_AUDITOR_IDS, passed in so the page's first load
 * never pulls in core.
 */
export function isPublishedAuditor(published: Readonly<Record<string, readonly number[]>>, registry: string, auditorId: number): boolean {
  const ids = Object.hasOwn(published, registry) ? published[registry] : undefined;
  return ids?.includes(auditorId) ?? false;
}

// Wherever a company bound to the published demo accountant key is shown, its pay is labelled as
// readable by anyone (C47).
export function PubliclyReadable() {
  return (
    <span title={PUBLIC_TITLE} data-public-accountant>
      <RowChip tone="wait">Publicly readable</RowChip>
    </span>
  );
}

// A company whose settings could not be read must not look private: a missing chip would read as
// the safe answer (C47).
export function ReadersUnknown() {
  return (
    <span title={UNKNOWN_TITLE} data-readers-unknown>
      <RowChip tone="wait">Readers unknown</RowChip>
    </span>
  );
}

// The chip slot of a payslip: a pulsing bar while the company is still being read, the unknown
// chip when it could not be, the public chip when anyone can read it, and nothing for a private one.
export function ReadersChip({ facts }: { facts: CompanyFacts | "unknown" | undefined }) {
  if (facts === undefined) return <span className="skeleton-bar block w-28" aria-hidden="true" />;
  if (facts === "unknown") return <ReadersUnknown />;
  return facts.publiclyReadable ? <PubliclyReadable /> : null;
}
