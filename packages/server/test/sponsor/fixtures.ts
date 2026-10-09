import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  authorizeInvocation,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { AUDITOR, STRANGER, TEST_ORIGIN, TOKEN, USDC, contractFor, keypairFor } from "../helpers.ts";

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

/** passkey-kit 0.19.1's shared deployer: an ed25519 seed of sha256("kalepail"), its DEFAULT_DEPLOYER_SEED. */
export const kitDeployer = Keypair.fromRawEd25519Seed(hash(Buffer.from("kalepail")));

const sym = (name: string) => xdr.ScVal.scvSymbol(name);
const none = () => xdr.ScVal.scvVec([xdr.ScVal.scvVoid()]);

/** An uncompressed P-256 public key's shape: 0x04 then x and y. Only the wallet's constructor checks the curve. */
export const p256Key = (fill = 0x11): Buffer => Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, fill)]);

/**
 * The first signer passkey-kit's buildDeployTransaction gives a wallet, in its contract client's
 * encoding as read back from the live deploy: Secp256r1(key id, public key, no expiry, no limits,
 * persistent).
 */
export function kitSigner(keyId: Buffer, fields: Partial<Record<"variant" | "expiration" | "limits" | "storage", xdr.ScVal>> = {}): xdr.ScVal {
  return xdr.ScVal.scvVec([
    fields.variant ?? sym("Secp256r1"),
    xdr.ScVal.scvBytes(keyId),
    xdr.ScVal.scvBytes(p256Key()),
    fields.expiration ?? none(),
    fields.limits ?? none(),
    fields.storage ?? xdr.ScVal.scvVec([sym("Persistent")]),
  ]);
}

/** WebAuthn client data as a browser writes it for an assertion on `origin`. */
export const clientDataJson = (origin = TEST_ORIGIN, type = "webauthn.get"): Buffer =>
  Buffer.from(JSON.stringify({ type, challenge: "3x4_eMFvuRHKI9I-Amm5sxW-1G_Jq0SAtQwvY-hD880", origin, crossOrigin: false }));

/** WebAuthn authenticator data for `rpId`: its sha256, the user-present and user-verified flags, a zero counter. */
export const authenticatorData = (rpId = new URL(TEST_ORIGIN).hostname): Buffer =>
  Buffer.concat([hash(Buffer.from(rpId)), Buffer.from([0x05, 0, 0, 0, 0])]);

export interface ProofOptions {
  authenticatorData?: Buffer;
  clientDataJson?: Buffer;
  signatureBytes?: number;
  names?: string[];
}

/**
 * The Genesis binding proof's shape, as made on TEST_ORIGIN unless a field is
 * given. Its signature bytes are not a real assertion: only the wallet's own
 * constructor checks those.
 */
export function genesisProof(opts: ProofOptions = {}): xdr.ScVal {
  const names = opts.names ?? ["authenticator_data", "client_data_json", "signature"];
  const values = [opts.authenticatorData ?? authenticatorData(), opts.clientDataJson ?? clientDataJson(), Buffer.alloc(opts.signatureBytes ?? 64, 3)];
  return xdr.ScVal.scvMap(names.map((name, i) => new xdr.ScMapEntry({ key: sym(name), val: xdr.ScVal.scvBytes(values[i]!) })));
}

export interface CreationOptions {
  keyId?: Buffer;
  deployer?: string;
  wasm?: string;
  salt?: Buffer;
  constructorArgs?: xdr.ScVal[];
}

/** A wallet creation as passkey-kit makes one, with any part swapped out. */
export function walletCreation(opts: CreationOptions = {}): xdr.CreateContractArgsV2 {
  const keyId = opts.keyId ?? Buffer.alloc(32, 0x5e);
  return new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: new Address(opts.deployer ?? kitDeployer.publicKey()).toScAddress(), salt: opts.salt ?? hash(keyId) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(opts.wasm ?? PINNED_WALLET_WASM, "hex")),
    constructorArgs: opts.constructorArgs ?? [kitSigner(keyId), genesisProof()],
  });
}

/** The wallet address a creation makes, computed the way passkey-kit's deriveContractAddress does. */
export function createdAddress(creation: xdr.CreateContractArgsV2, network = Networks.TESTNET): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(network)), contractIdPreimage: creation.contractIdPreimage() }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

export const creationRoot = (creation: xdr.CreateContractArgsV2, sub: xdr.SorobanAuthorizedInvocation[] = []): xdr.SorobanAuthorizedInvocation =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(creation),
    subInvocations: sub,
  });

let deployerNonce = 1_000n;

/** The deployer's signed entry for a creation, as lib/worker/passkey.ts deployerAuth builds it: a fresh nonce each time. */
export async function deployerEntry(
  root: xdr.SorobanAuthorizedInvocation,
  opts: { signer?: Keypair; validUntil?: number; network?: string } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  const signer = opts.signer ?? kitDeployer;
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString((deployerNonce++).toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
  return authorizeEntry(unsigned, signer, opts.validUntil ?? LATEST_LEDGER + 60, opts.network ?? Networks.TESTNET);
}

export const creationFunc = (creation: xdr.CreateContractArgsV2): string => b64(xdr.HostFunction.hostFunctionTypeCreateContractV2(creation));

/** A complete { func, auth } wallet creation body, signed by the kit's deployer. */
export async function walletCreationBody(opts: CreationOptions = {}): Promise<{ func: string; auth: string[]; created: string }> {
  const creation = walletCreation(opts);
  return { func: creationFunc(creation), auth: [b64(await deployerEntry(creationRoot(creation)))], created: createdAddress(creation) };
}

const walletEntryKey = (owner: string, variant: string, keyId: Buffer, durability: xdr.ContractDataDurability): xdr.LedgerKey =>
  dataKey(owner, xdr.ScVal.scvVec([sym(variant), xdr.ScVal.scvBytes(keyId)]), durability);

/**
 * The footprint of the live deploy dbd9ab22 (testnet ledger 5100757), for any created wallet: the
 * deployer's account, the wallet's temporary signer lookup and its code read; the deployer's nonce
 * and the wallet's persistent signer, binding record and instance written.
 */
export function creationFootprint(created: string, keyId: Buffer = Buffer.alloc(32, 0x5e)): Footprint {
  return {
    readOnly: [
      accountKey(kitDeployer.publicKey()),
      walletEntryKey(created, "Secp256r1", keyId, xdr.ContractDataDurability.temporary()),
      codeKey(PINNED_WALLET_WASM),
    ],
    readWrite: [
      nonceKey(kitDeployer.publicKey()),
      walletEntryKey(created, "Secp256r1", keyId, xdr.ContractDataDurability.persistent()),
      walletEntryKey(created, "Secp256r1Binding", keyId, xdr.ContractDataDurability.persistent()),
      instanceKey(created),
    ],
  };
}

/** register_key(owner, point) on the auditor registry, as core's buildRegisterKey encodes it. */
export const registerKeyArgs = (owner: string, point: Buffer = Buffer.alloc(64, 9)): xdr.ScVal[] => [addr(owner), xdr.ScVal.scvBytes(point)];
