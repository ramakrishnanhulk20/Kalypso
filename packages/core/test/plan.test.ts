// Does NOT cover: which rows still need paying (the engine filters paid rows before planning).
import { describe, expect, it } from 'vitest';
import type { CsvRow } from '../src/csv.js';
import { planRun } from '../src/run/plan.js';

const rows: CsvRow[] = [3, 4, 6, 9, 12].map((line, i) => ({
  line,
  address: `G-placeholder-${i}`,
  kind: 'G',
  amount: BigInt(line),
  nameLooksLikeFormula: false,
}));

describe('planRun', () => {
  it('cuts rows into batches of two in CSV order', () => {
    expect(planRun(rows).map((batch) => batch.map((row) => row.line))).toEqual([[3, 4], [6, 9], [12]]);
    expect(planRun(rows, 1)).toHaveLength(5);
    expect(planRun([])).toEqual([]);
  });

  it('refuses a batch size the payroll contract would refuse', () => {
    for (const size of [0, 3, 1.5, Number.NaN]) expect(() => planRun(rows, size)).toThrow(RangeError);
  });
});
