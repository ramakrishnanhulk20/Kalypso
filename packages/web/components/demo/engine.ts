export type Engine = typeof import("@/lib/sandbox/engine");

let loading: Promise<Engine> | undefined;

// The engine pulls in the Stellar SDK and the prover, and reads localStorage. A dynamic import
// from the browser keeps all of it out of server rendering and out of the landing page's bundle.
export function loadEngine(): Promise<Engine> {
  loading ??= import("@/lib/sandbox/engine").catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}
