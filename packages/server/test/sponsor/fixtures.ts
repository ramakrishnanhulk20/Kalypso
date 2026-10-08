import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  authorizeInvocation,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { AUDITOR, STRANGER, TOKEN, USDC, contractFor, keypairFor } from "../helpers.ts";

export const LATEST_LEDGER = 5_070_600;
export const worker = keypairFor("worker");
export const employer = keypairFor("employer");
export const passkeyWallet = contractFor("passkey wallet");
/** passkey-kit 0.19.1's canonical testnet wallet wasm, the config default. */
export const PINNED_WALLET_WASM = "97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e";

/** What a contract instance runs: a wasm hash in hex, the built-in asset contract, or nothing deployed. */
export type FakeCode = string | "stellar_asset" | null;

/** The passkey wallet fixture runs the pinned wallet code, USDC is an asset contract, everything else runs its own made-up wasm. */
export function fakeCode(contract: string): FakeCode {
  if (contract === passkeyWallet) return PINNED_WALLET_WASM;
  if (contract === USDC) return "stellar_asset";
  return hash(Buffer.from("kalypso test wasm " + contract)).toString("hex");
}

const dataKey = (owner: string, key: xdr.ScVal, durability: xdr.ContractDataDurability): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(owner).toScAddress(), key, durability }));

export const instanceKey = (contract: string): xdr.LedgerKey =>
  dataKey(contract, xdr.ScVal.scvLedgerKeyContractInstance(), xdr.ContractDataDurability.persistent());

export const storageKey = (owner: string, n = 0, durability = xdr.ContractDataDurability.persistent()): xdr.LedgerKey =>
  dataKey(owner, xdr.ScVal.scvVec([xdr.ScVal.scvU32(n)]), durability);

/** Where the host keeps an address credential's nonce: temporary contract data under the signing address, G or C. */
export const nonceKey = (address: string): xdr.LedgerKey =>
  dataKey(address, xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString("42") })), xdr.ContractDataDurability.temporary());

export const codeKey = (wasmHex: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHex, "hex") }));

export const accountKey = (account: string): xdr.LedgerKey =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }));

/** A contract instance ledger entry as getLedgerEntries returns it: base64 LedgerEntryData. */
export function instanceEntry(contract: string, code: Exclude<FakeCode, null>): string {
  const executable =
    code === "stellar_asset"
      ? xdr.ContractExecutable.contractExecutableStellarAsset()
      : xdr.ContractExecutable.contractExecutableWasm(Buffer.from(code, "hex"));
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  ).toXDR("base64");
}

export interface Footprint {
  readOnly: xdr.LedgerKey[];
  readWrite: xdr.LedgerKey[];
}

/**
 * The footprint of the live M1b passkey merge (testnet transaction
 * 1075ef9d5f8f07b2e15baf8e38d602ff353e8e49c43a2269838a22e13dad06f2, read back
 * on 8 Oct 2026), with our test ids in place of the spike's: the token's
 * instance, code and one balance; the wallet's instance, code, signer storage
 * and nonce. Nothing else runs.
 */
export function passkeyMergeFootprint(): Footprint {
  return {
    readOnly: [
      instanceKey(TOKEN),
      storageKey(passkeyWallet, 0, xdr.ContractDataDurability.temporary()),
      storageKey(passkeyWallet, 1),
      storageKey(passkeyWallet, 2),
      instanceKey(passkeyWallet),
      codeKey(PINNED_WALLET_WASM),
      codeKey(fakeCode(TOKEN)!),
    ],
    readWrite: [storageKey(TOKEN, 3), nonceKey(passkeyWallet)],
  };
}

export type Call = { contract: string; fn: string; args?: xdr.ScVal[]; sub?: Call[] };

export function invocation(call: Call): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(call.contract).toScAddress(),
        functionName: call.fn,
        args: call.args ?? [],
      }),
    ),
    subInvocations: (call.sub ?? []).map(invocation),
  });
}

export function hostCall(contract: string, fn: string, args: xdr.ScVal[]): xdr.HostFunction {
  return new Contract(contract).call(fn, ...args).body().invokeHostFunctionOp().hostFunction();
}

export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();

/** A classic-account auth entry signed with the real SDK signer for the given network. */
export async function signedEntry(
  call: Call | xdr.SorobanAuthorizedInvocation,
  signer: Keypair = worker,
  opts: { validUntil?: number; network?: string; v2?: boolean } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeInvocation({
    signer,
    validUntilLedgerSeq: opts.validUntil ?? LATEST_LEDGER + 100,
    invocation: call instanceof xdr.SorobanAuthorizedInvocation ? call : invocation(call),
    networkPassphrase: opts.network ?? Networks.TESTNET,
    authV2: opts.v2 ?? false,
  });
}

/** A passkey (contract account) entry: its signature is wallet-defined, so only simulation can judge it. */
export function contractAccountEntry(call: Call, validUntil = LATEST_LEDGER + 100, wallet = passkeyWallet): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(wallet).toScAddress(),
        nonce: xdr.Int64.fromString("42"),
        signatureExpirationLedger: validUntil,
        signature: nativeToScVal(Buffer.alloc(96, 7)),
      }),
    ),
    rootInvocation: invocation(call),
  });
}

export const sourceAccountEntry = (call: Call): xdr.SorobanAuthorizationEntry =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(call),
  });

export const b64 = (value: { toXDR(format: "base64"): string }): string => value.toXDR("base64");

export async function mergeFuncAuth(signer: Keypair = worker): Promise<{ func: string; auth: string[] }> {
  const call: Call = { contract: TOKEN, fn: "merge", args: [addr(signer.publicKey())] };
  return { func: b64(hostCall(TOKEN, "merge", [addr(signer.publicKey())])), auth: [b64(await signedEntry(call, signer))] };
}

/** A worker's deposit-shaped call whose tree also reaches USDC and the auditor: all allowed. */
export const depositTree = (extraSub: Call[] = []): Call => ({
  contract: TOKEN,
  fn: "deposit",
  args: [addr(worker.publicKey()), addr(worker.publicKey()), nativeToScVal(5n, { type: "i128" })],
  sub: [{ contract: USDC, fn: "transfer" }, { contract: AUDITOR, fn: "get_key" }, ...extraSub],
});

export interface TxOptions {
  fee?: string;
  resourceFee?: number;
  network?: string;
  signer?: Keypair | null;
  operations?: xdr.Operation[];
  soroban?: boolean;
  /** The footprint the envelope declares; empty unless given. */
  footprint?: Footprint;
  /** The limits the envelope declares; all zero unless given. */
  limits?: Limits;
}

/** Soroban resource limits: instructions, bytes read from disk, bytes written. */
export interface Limits {
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
}

export function envelope(opts: TxOptions = {}): string {
  const source = opts.signer === null ? worker : (opts.signer ?? worker);
  const data = new SorobanDataBuilder()
    .setResourceFee(opts.resourceFee ?? 500_000)
    .setFootprint(opts.footprint?.readOnly ?? [], opts.footprint?.readWrite ?? []);
  if (opts.limits) data.setResources(opts.limits.instructions, opts.limits.diskReadBytes, opts.limits.writeBytes);
  const sorobanData = data.build();
  const builder = new TransactionBuilder(new Account(source.publicKey(), "100"), {
    fee: opts.fee ?? "600000",
    networkPassphrase: opts.network ?? Networks.TESTNET,
    ...(opts.soroban === false ? {} : { sorobanData }),
  });
  for (const op of opts.operations ?? [mergeOperation()]) builder.addOperation(op);
  const tx = builder.setTimeout(30).build();
  if (opts.signer !== null) tx.sign(source);
  return tx.toXDR();
}

/** token.merge(worker) with the source-account auth entry the worker's wallet would attach. */
export const mergeOperation = (): xdr.Operation =>
  Operation.invokeHostFunction({
    func: hostCall(TOKEN, "merge", [addr(worker.publicKey())]),
    auth: [sourceAccountEntry({ contract: TOKEN, fn: "merge", args: [addr(worker.publicKey())] })],
  });

export const paymentOperation = (): xdr.Operation =>
  Operation.payment({ destination: employer.publicKey(), asset: Asset.native(), amount: "1" });

export const uploadOperation = (): xdr.Operation => Operation.uploadContractWasm({ wasm: Buffer.from("\0asm\x01\0\0\0") });

export const createContractOperation = (): xdr.Operation =>
  Operation.createCustomContract({ address: new Address(worker.publicKey()), wasmHash: Buffer.alloc(32, 1), salt: Buffer.alloc(32, 2) });

export const thirdPartyOperation = (): xdr.Operation =>
  Operation.invokeHostFunction({ func: hostCall(STRANGER, "transfer", [addr(worker.publicKey())]), auth: [] });

/** token.merge whose auth tree also asks to create a contract. */
export function createContractInvocation(): xdr.SorobanAuthorizedInvocation {
  const create = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
      new xdr.CreateContractArgsV2({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({ address: new Address(worker.publicKey()).toScAddress(), salt: Buffer.alloc(32, 3) }),
        ),
        executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 4)),
        constructorArgs: [],
      }),
    ),
    subInvocations: [],
  });
  const root = invocation({ contract: TOKEN, fn: "merge", args: [addr(worker.publicKey())] });
  root.subInvocations([create]);
  return root;
}
