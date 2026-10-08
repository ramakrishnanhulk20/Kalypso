import { vi } from "vitest";
import { Address, Networks, SorobanDataBuilder, Transaction, xdr } from "@stellar/stellar-sdk";
import type { RpcLedgerEntries, RpcSimulation, SimulationAuthMode } from "../../src/rpc.ts";
import { TOKEN } from "../helpers.ts";
import { LATEST_LEDGER, fakeCode, instanceEntry, type FakeCode, type Footprint } from "./fixtures.ts";

/**
 * A stand-in for simulateTransaction in both modes, shaped like the live
 * testnet replies captured in live-read-only-call.json. Record mode reports
 * the auth a call `fn(account, ...)` needs the way the host records it: one
 * entry for `account`, rooted at the call, as a source-account entry when
 * `account` is the transaction source.
 *
 * getLedgerEntries answers contract-instance reads from `code`, which by
 * default gives the passkey wallet fixture the pinned wallet wasm.
 */
export interface FakeSimulationOptions {
  enforce?: Partial<RpcSimulation>;
  record?: Partial<RpcSimulation>;
  /** Read-write footprint entries in the enforce reply; 0 makes the call read-only. */
  readWrite?: number;
  /** The whole enforce-mode footprint; overrides readWrite. */
  footprint?: Footprint;
  /** Overrides what record mode says the call needs. */
  requiredAuth?: (txBase64: string) => string[];
  /** What each contract instance runs. */
  code?: (contract: string) => FakeCode;
  fail?: SimulationAuthMode | "ledger_entries";
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
      transactionData: opts.footprint ? transactionData(opts.footprint) : footprintData(opts.readWrite ?? 1),
      results: [{ auth: [], xdr: "AAAAAQ==" }],
      ...opts.enforce,
    };
  });
  const getLedgerEntries = vi.fn(async (keys: readonly string[]): Promise<RpcLedgerEntries> => {
    if (opts.fail === "ledger_entries") throw new Error("rpc down");
    return { entries: instanceEntries(keys, opts.code ?? fakeCode), latestLedger: LATEST_LEDGER };
  });
  return { simulateTransaction, getLedgerEntries };
}

/** The contract a requested instance key belongs to. */
export const contractOfKey = (keyBase64: string): string =>
  Address.fromScAddress(xdr.LedgerKey.fromXDR(keyBase64, "base64").contractData().contract()).toString();

export function instanceEntries(keys: readonly string[], code: (contract: string) => FakeCode): RpcLedgerEntries["entries"] {
  return keys.flatMap((key) => {
    const contract = contractOfKey(key);
    const runs = code(contract);
    return runs === null ? [] : [{ key, xdr: instanceEntry(contract, runs), lastModifiedLedgerSeq: LATEST_LEDGER - 10 }];
  });
}

export function transactionData(footprint: Footprint): string {
  return new SorobanDataBuilder()
    .setFootprint(footprint.readOnly, footprint.readWrite)
    .setResourceFee(490_000)
    .build()
    .toXDR("base64");
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
  return transactionData({ readOnly: [key(100)], readWrite: Array.from({ length: readWrite }, (_, i) => key(i)) });
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
