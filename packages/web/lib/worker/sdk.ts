// The confidential SDK comes from @kalypso/core's own install, never a second copy: a curve point
// made by another copy fails core's checks (lib/sandbox/sdk.ts follows the same rule).
import { Buffer } from "../../../core/node_modules/buffer/index.js";
import { installProverData } from "../prover-data";

// passkey-kit reads a global Buffer while its modules load (its utils.js derives the shared
// deployer at import time), and the confidential SDK encodes proof payloads with it. Every module
// in this folder imports this one before passkey-kit, so the global exists first.
const runtime = globalThis as { Buffer?: unknown };
runtime.Buffer ??= Buffer;

export { H, commit, scalarMul } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
export type { Point } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";

type CircuitSet = import("@kalypso/core").CircuitSet;

/**
 * The register and withdraw circuits (and transfer, which the prover requires) from the
 * confidential SDK version core pins, which the deployed verifier's keys were made from. Loaded on
 * first proof only, together with the self-hosted proving data (lib/prover-data.ts).
 */
export async function loadCircuits(): Promise<CircuitSet> {
  const [, register, transfer, withdraw] = await Promise.all([
    installProverData(),
    import("../../../core/node_modules/stellar-confidential-token-sdk/circuits/register.json"),
    import("../../../core/node_modules/stellar-confidential-token-sdk/circuits/transfer.json"),
    import("../../../core/node_modules/stellar-confidential-token-sdk/circuits/withdraw.json"),
  ]);
  return {
    register: register.default as CircuitSet["register"],
    transfer: transfer.default as CircuitSet["transfer"],
    withdraw: withdraw.default as CircuitSet["withdraw"],
  };
}
