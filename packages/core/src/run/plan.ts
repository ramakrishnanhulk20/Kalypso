import type { CsvRow } from '../csv.js';
import { MAX_BATCH } from '../chain/payroll.js';

/**
 * Splits payroll rows into pay batches of at most maxBatch rows, keeping CSV order inside and
 * across batches. One batch is one pay transaction.
 *
 * Rows may carry extra fields (the engine adds each worker's keys); batches keep them.
 *
 * @param maxBatch 1 to MAX_BATCH (2, the measured limit of a root-signed pay). Default 2.
 * @throws RangeError for any other maxBatch.
 */
export function planRun<Row extends CsvRow>(rows: Row[], maxBatch = MAX_BATCH): Row[][] {
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > MAX_BATCH) {
    throw new RangeError(`maxBatch must be a whole number from 1 to ${MAX_BATCH}`);
  }
  const batches: Row[][] = [];
  for (let i = 0; i < rows.length; i += maxBatch) batches.push(rows.slice(i, i + maxBatch));
  return batches;
}
