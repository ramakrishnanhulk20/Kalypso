import type { CoverageRows, GapRecord } from "./db.ts";

/*
 * The archive's answer to "do you hold every event in ledgers [from, to]?"
 * (threat model C17, INDEXER.md C3). Only the ingest job's own records count:
 * ranges it read in full, and gaps it found RPC had already forgotten.
 * Nothing else, and in particular not "we hold no events there", can make a
 * range complete, because an empty answer and a missing answer look the same.
 */

export interface Coverage {
  /** Merged, sorted, non-touching ranges read in full. */
  ranges: Array<readonly [number, number]>;
  gaps: GapRecord[];
  startLedger: number | null;
  /** The archive began at or before both contracts existed, so nothing earlier can exist. */
  coversFromGenesis: boolean;
  latestLedger: number;
  lastIngestAt: Date | null;
}

export function coverageOf(rows: CoverageRows): Coverage {
  return {
    ranges: mergeRanges(rows.ranges),
    gaps: rows.gaps,
    startLedger: rows.state.startLedger,
    coversFromGenesis: rows.state.coversFromGenesis,
    latestLedger: rows.state.latestLedger ?? 0,
    lastIngestAt: rows.state.lastIngestAt,
  };
}

export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** The highest ledger read in full; 0 when nothing has been read. */
export function ingestedThrough(c: Coverage): number {
  return c.ranges.length === 0 ? 0 : c.ranges[c.ranges.length - 1]![1];
}

/** The lowest ledger the archive can vouch for; 0 when nothing has been read. */
export function ingestedFrom(c: Coverage): number {
  if (c.ranges.length === 0) return 0;
  return c.coversFromGenesis ? 1 : c.ranges[0]![0];
}

/**
 * True only when every ledger in [from, to] was read in full and no recorded
 * gap touches the range. Ledgers before the archive's start count as read
 * only when the archive was started at or before the contracts' deployment.
 */
export function isComplete(c: Coverage, from: number, to: number): boolean {
  if (from < 1 || to < from) return false;
  if (c.gaps.some((g) => g.fromLedger <= to && g.toLedger >= from)) return false;
  let next = from;
  if (c.coversFromGenesis && c.startLedger !== null && next < c.startLedger) next = c.startLedger;
  for (const [rangeFrom, rangeTo] of c.ranges) {
    if (next > to) break;
    if (rangeTo < next) continue;
    if (rangeFrom > next) return false;
    next = rangeTo + 1;
  }
  return next > to;
}
