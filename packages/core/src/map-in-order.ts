/**
 * How many chain, history or transaction reads one run, view or audit keeps in flight at once.
 * Enough to hide most of an RPC round trip, few enough that a public RPC does not rate-limit it.
 */
export const READ_CONCURRENCY = 8;

/**
 * Runs fn over items, at most READ_CONCURRENCY at a time, and returns the results in item order.
 * Callers never nest it, so READ_CONCURRENCY bounds the reads in flight. The first rejection
 * rejects the whole call; work already started still finishes, with nothing left unhandled.
 */
export async function mapInOrder<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return results;
}
