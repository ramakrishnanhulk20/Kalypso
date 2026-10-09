import type { HistorySource } from "@kalypso/core";

/**
 * The archive part of a HistorySource. Our archive is served by this app at /api/archive, and
 * core accepts it only over https, so a local http dev server reads RPC's window alone. When the
 * archive does not answer, core falls back to RPC, so a site whose archive is not configured yet
 * costs one refused request, never a wrong history. Without it, history older than RPC's window
 * (about 7 days) cannot be read and views report themselves incomplete.
 */
export function archiveSource(): Pick<HistorySource, "archive"> {
  if (typeof location === "undefined" || location.protocol !== "https:") return {};
  return { archive: { baseUrl: `${location.origin}/api/archive` } };
}
