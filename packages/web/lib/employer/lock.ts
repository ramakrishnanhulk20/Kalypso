import { ConsoleError } from "./errors";

const heldHere = new Set<string>();

/**
 * Runs work while holding this wallet's console lock: a flag for this tab, and the Web Locks API
 * across tabs where the browser has it. Two tabs signing for one account would race for its
 * sequence number, and two tabs paying one treasury would prove on the same balance. The lock is
 * not re-entrant, so console functions take it once at their outer edge.
 *
 * @throws ConsoleError BUSY when this tab or another holds the lock.
 */
export async function withWalletLock<T>(address: string, work: () => Promise<T>): Promise<T> {
  const name = `kalypso/console/v1/${address}`;
  if (heldHere.has(name)) throw new ConsoleError("BUSY");
  heldHere.add(name);
  try {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks === undefined) return await work();
    return await locks.request(name, { ifAvailable: true }, async (lock) => {
      if (lock === null) throw new ConsoleError("BUSY");
      return work();
    });
  } finally {
    heldHere.delete(name);
  }
}
