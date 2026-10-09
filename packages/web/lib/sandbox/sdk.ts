// Both SDKs come from @kalypso/core's own install, never a second copy. A curve point or an XDR
// value made by another copy fails core's checks, and a second copy of the prover's bb.js would
// be a second multi-megabyte download. packages/contracts/scripts/lib/kalypso.mjs follows the
// same rule for the seed.
import { Buffer } from "../../../core/node_modules/buffer/index.js";
import { installProverData } from "../prover-data";

// stellar-confidential-token-sdk 0.1.9 encodes every proof's payload with the Node global Buffer
// (its chain/payload.ts), which a browser does not have, so each proof failed right after it was
// made. This is the same buffer package the Stellar SDK imports, and Node keeps its own.
const runtime = globalThis as { Buffer?: unknown };
runtime.Buffer ??= Buffer;

export {
  Account,
  Asset,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/base/index.js";
export { Server as RpcServer } from "../../../core/node_modules/@stellar/stellar-sdk/lib/esm/rpc/index.js";
export {
  FR_MODULUS,
  H,
  commit,
  scalarMul,
} from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";
export type { Point } from "../../../core/node_modules/stellar-confidential-token-sdk/dist/index.js";

type CircuitSet = import("@kalypso/core").CircuitSet;

/**
 * The register, transfer and withdraw circuits the deployed verifier's keys were made from: the
 * files stellar-confidential-token-sdk 0.1.9 ships, the same version core pins. Loaded on first
 * use only, so a page that never proves never downloads them. Every prover is built from this,
 * so it also puts the self-hosted proving data in place first (lib/prover-data.ts).
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
