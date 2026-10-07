import { vi } from "vitest";
import { Address, Networks, SorobanDataBuilder, Transaction, xdr } from "@stellar/stellar-sdk";
import type { RpcSimulation, SimulationAuthMode } from "../../src/rpc.ts";
import { TOKEN } from "../helpers.ts";
import { LATEST_LEDGER } from "./fixtures.ts";

/**
 * A stand-in for simulateTransaction in both modes, shaped like the live
 * testnet replies captured in live-read-only-call.json. Record mode reports
 * the auth a call `fn(account, ...)` needs the way the host records it: one
 * entry for `account`, rooted at the call, as a source-account entry when
 * `account` is the transaction source.
 */
export interface FakeSimulationOptions {
  enforce?: Partial<RpcSimulation>;
  record?: Partial<RpcSimulation>;
  /** Read-write footprint entries in the enforce reply; 0 makes the call read-only. */
  readWrite?: number;
  /** Overrides what record mode says the call needs. */
  requiredAuth?: (txBase64: string) => string[];
  fail?: SimulationAuthMode;
}

export function fakeSimulation(opts: FakeSimulationOptions = {}) {
  const simulateTransaction = vi.fn(async (tx: string, authMode: SimulationAuthMode = "enforce"): Promise<RpcSimulation> => {
    if (opts.fail === authMode) throw new Error("rpc down");
    if (authMode === "record") {
      const auth = opts.requiredAuth ? opts.requiredAuth(tx) : recordedAuthOf(tx);
      return { latestLedger: LATEST_LEDGER, minResourceFee: "490000", transactionData: footprintData(1), results: [{ auth, xdr: "AAAAAQ==" }], ...opts.record };
    }
    return {
      latestLedger: LATEST_LEDGER,
      minResourceFee: "490000",
      transactionData: footprintData(opts.readWrite ?? 1),
      results: [{ auth: [], xdr: "AAAAAQ==" }],
      ...opts.enforce,
    };
  });
  return { simulateTransaction };
}

export function footprintData(readWrite: number): string {
  const key = (i: number) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(TOKEN).toScAddress(),
        key: xdr.ScVal.scvU32(i),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  return new SorobanDataBuilder()
    .setFootprint([key(100)], Array.from({ length: readWrite }, (_, i) => key(i)))
    .setResourceFee(490_000)
    .build()
    .toXDR("base64");
}

export function recordedAuthOf(txBase64: string): string[] {
  const tx = new Transaction(txBase64, Networks.TESTNET);
  const op = tx.toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp();
  if (op.auth().length > 0) throw new Error("record mode refuses a transaction that carries auth entries");
  const call = op.hostFunction().invokeContract();
  const first = call.args()[0];
  if (first?.switch().name !== "scvAddress") return [];
  const account = Address.fromScVal(first).toString();
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
    subInvocations: [],
  });
  const credentials =
    account === tx.source
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(account).toScAddress(),
            nonce: xdr.Int64.fromString("0"),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        );
  return [new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation }).toXDR("base64")];
}
