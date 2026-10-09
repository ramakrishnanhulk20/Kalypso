import { vi } from "vitest";
import { Address, Networks, SorobanDataBuilder, Transaction, xdr } from "@stellar/stellar-sdk";
import { RpcError, type RpcLedgerEntries, type RpcSimulation, type RpcTransaction, type SimulationAuthMode } from "../../src/rpc.ts";
import { TOKEN } from "../helpers.ts";
import { LATEST_LEDGER, createdAddress, creationFootprint, fakeCode, instanceEntry, type FakeCode, type Footprint, type Limits } from "./fixtures.ts";

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
  /** The enforce-mode footprint for each simulated transaction; overrides footprint. */
  footprintFor?: (txBase64: string) => Footprint;
  /** The limits the enforce reply says the call used; all zero unless given. */
  limits?: Limits;
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
      transactionData: transactionData(opts.footprintFor?.(tx) ?? opts.footprint ?? defaultFootprint(opts.readWrite ?? 1), opts.limits),
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

export function transactionData(footprint: Footprint, limits?: Limits): string {
  const data = new SorobanDataBuilder().setFootprint(footprint.readOnly, footprint.readWrite).setResourceFee(490_000);
  if (limits) data.setResources(limits.instructions, limits.diskReadBytes, limits.writeBytes);
  return data.build().toXDR("base64");
}

/** The footprint the enforce reply carries unless a test gives one: token storage only. */
export function defaultFootprint(readWrite = 1): Footprint {
  const key = (i: number) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(TOKEN).toScAddress(),
        key: xdr.ScVal.scvU32(i),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  return { readOnly: [key(100)], readWrite: Array.from({ length: readWrite }, (_, i) => key(i)) };
}

/** A footprintFor: the live deploy's footprint around the wallet a creation makes, and the default for any other call. */
export function creationFootprintOf(txBase64: string): Footprint {
  const fn = new Transaction(txBase64, Networks.TESTNET).toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp().hostFunction();
  return fn.switch().name === "hostFunctionTypeCreateContractV2" ? creationFootprint(createdAddress(fn.createContractV2())) : defaultFootprint();
}

export function footprintData(readWrite: number): string {
  return transactionData(defaultFootprint(readWrite));
}

export function recordedAuthOf(txBase64: string): string[] {
  const tx = new Transaction(txBase64, Networks.TESTNET);
  const op = tx.toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp();
  if (op.auth().length > 0) throw new Error("record mode refuses a transaction that carries auth entries");
  if (op.hostFunction().switch().name === "hostFunctionTypeCreateContractV2") {
    // The host asks the preimage's address to authorise the creation itself, with no sub-calls.
    const creation = op.hostFunction().createContractV2();
    return [
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: creation.contractIdPreimage().fromAddress().address(),
            nonce: xdr.Int64.fromString("0"),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        ),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(creation),
          subInvocations: [],
        }),
      }).toXDR("base64"),
    ];
  }
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

/**
 * The live creation transaction live-wallet-creation.json describes, exactly as testnet RPC served
 * it on 9 Oct 2026 (getTransaction dbd9ab22...bdf8): Channels' fee bump around the one
 * CreateContractV2 that made CBSDDY2N...GKSK. Horizon served the same envelope.
 */
export const LIVE_CREATION = {
  hash: "dbd9ab22dd5f0531979e5b175bf4c9f09ed8a6236024e20239bdbb6650c1bdf8",
  ledger: 5100757,
  envelopeXdr:
    "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",
} as const;

/** A stand-in for getTransaction that knows only `known`; every other hash is NOT_FOUND, and fail plays an RPC that cannot answer. */
export function fakeTransactions(known: Record<string, RpcTransaction>, opts: { fail?: boolean } = {}) {
  const getTransaction = vi.fn(async (hash: string): Promise<RpcTransaction> => {
    if (opts.fail) throw new RpcError("http_status", "503");
    return known[hash] ?? { status: "NOT_FOUND" };
  });
  return { getTransaction };
}
