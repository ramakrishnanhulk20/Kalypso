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
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { AUDITOR, STRANGER, TOKEN, USDC, contractFor, keypairFor } from "../helpers.ts";

export const LATEST_LEDGER = 5_070_600;
export const worker = keypairFor("worker");
export const employer = keypairFor("employer");
export const passkeyWallet = contractFor("passkey wallet");

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
export function contractAccountEntry(call: Call, validUntil = LATEST_LEDGER + 100): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(passkeyWallet).toScAddress(),
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
}

export function envelope(opts: TxOptions = {}): string {
  const source = opts.signer === null ? worker : (opts.signer ?? worker);
  const builder = new TransactionBuilder(new Account(source.publicKey(), "100"), {
    fee: opts.fee ?? "600000",
    networkPassphrase: opts.network ?? Networks.TESTNET,
    ...(opts.soroban === false ? {} : { sorobanData: new SorobanDataBuilder().setResourceFee(opts.resourceFee ?? 500_000).build() }),
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
