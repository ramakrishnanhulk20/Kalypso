"use client";

import { useEffect, useState } from "react";

export type EmployerLib = typeof import("@/lib/employer");

// The console code pulls in the Stellar SDK and the prover and touches IndexedDB. A dynamic import
// from the browser keeps all of it out of server rendering and out of the first load.
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () => {
    loading ??= load().catch((err: unknown) => {
      loading = undefined;
      throw err;
    });
    return loading;
  };
}

export const loadEmployer = once(() => import("@/lib/employer"));
export const loadAccountant = once(() => import("@/lib/accountant"));
export const loadFreighter = once(() => import("@/lib/wallet/freighter"));

/** The employer code once it has loaded, or null before that. */
export function useEmployerLib(): EmployerLib | null {
  const [lib, setLib] = useState<EmployerLib | null>(null);
  useEffect(() => {
    let current = true;
    loadEmployer().then(
      (loaded) => {
        if (current) setLib(loaded);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  return lib;
}
