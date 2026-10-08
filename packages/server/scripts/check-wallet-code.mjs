// Live read-only check against Stellar testnet RPC: reads one contract's
// instance and prints the wasm hash it runs, and whether that is the passkey
// wallet code the fee sponsor accepts. It goes through the server's own RPC
// client and the same instance decoder the sponsor uses (contractCodeOf).
// Needs network access only: no keys, no database, no Channels calls.
//
//   node scripts/check-wallet-code.mjs <C-address>
import { PINNED_PASSKEY_WALLET_WASM_HASH } from "../src/config.ts";
import { createRpcClient } from "../src/rpc.ts";
import { contractCodeOf } from "../src/sponsor/validate.ts";
import { canonicalContractId } from "../src/stellar.ts";

const contract = canonicalContractId(process.argv[2]);
if (contract === null) {
  console.error("usage: node scripts/check-wallet-code.mjs <C-address>");
  process.exit(2);
}

const rpc = createRpcClient({
  RPC_URL: process.env.RPC_URL || "https://soroban-testnet.stellar.org",
  CHANNELS_URL: "https://channels.openzeppelin.com/testnet",
});
const wasm = (await contractCodeOf(rpc, [contract])).get(contract) ?? null;
const match = wasm === PINNED_PASSKEY_WALLET_WASM_HASH;

console.log("contract:    " + contract);
console.log("runs wasm:   " + (wasm ?? "none (no instance, or not plain wasm)"));
console.log("pinned wasm: " + PINNED_PASSKEY_WALLET_WASM_HASH);
console.log(match ? "RESULT: MATCH, the sponsor accepts this wallet" : "RESULT: NO MATCH, the sponsor refuses it as unknown_wallet_code");
process.exit(match ? 0 : 1);
