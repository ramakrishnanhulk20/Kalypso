import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL } from "./network.mjs";

export const server = new rpc.Server(RPC_URL);

// Long enough for a congested ledger or two, short enough that a resumed run
// waits at most this long to learn that an unsent transaction can never land.
const TX_WINDOW_SECONDS = 120;
const POLL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const scv = {
  sym: (s) => xdr.ScVal.scvSymbol(s),
  u32: (n) => xdr.ScVal.scvU32(n),
  bytes: (b) => xdr.ScVal.scvBytes(Buffer.from(b)),
  addr: (a) => new Address(a).toScVal(),
  // A #[contracttype] enum variant: Vec[Symbol(variant), ...fields].
  variant: (name, ...fields) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...fields]),
  // A #[contracttype] struct: a map whose symbol keys are sorted by name.
  struct: (fields) =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k] })),
    ),
};

// Ledger keys and storage keys are compared by their XDR bytes, so both sides
// of every comparison go through the same encoder.
const keyId = (x) => x.toXDR("base64");

export const isVoid = (v) => v.switch().name === "scvVoid";
export const addressOf = (v) => (v.switch().name === "scvAddress" ? Address.fromScVal(v).toString() : null);
export const normalizeAddress = (s) => new Address(s).toString();

export function describeScVal(v) {
  switch (v.switch().name) {
    case "scvVoid":
      return "None";
    case "scvSymbol":
      return v.sym().toString();
    case "scvU32":
      return String(v.u32());
    case "scvAddress":
      return Address.fromScVal(v).toString();
    case "scvBytes":
      return `bytes(${v.bytes().length})`;
    case "scvVec":
      return `[${(v.vec() ?? []).map(describeScVal).join(", ")}]`;
    case "scvMap":
      return `{${(v.map() ?? []).map((e) => `${describeScVal(e.key())}: ${describeScVal(e.val())}`).join(", ")}}`;
    default:
      return v.switch().name;
  }
}

function contractDataKey(contractId, key, durability) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability[durability](),
    }),
  );
}

/** One getLedgerEntries call; returns a lookup from ledger key to entry. */
async function readEntries(keys) {
  const res = await server.getLedgerEntries(...keys);
  const byKey = new Map(res.entries.map((e) => [keyId(e.key), e]));
  return { latestLedger: res.latestLedger, get: (k) => byKey.get(keyId(k)) ?? null };
}

/**
 * Reads a contract's instance entry straight from the ledger. Returns null if
 * there is none. `wasmHash` is set only for plain wasm executables; any other
 * kind is reported in `executable` so callers can refuse it.
 */
export async function readInstance(contractId) {
  const key = contractDataKey(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), "persistent");
  const { latestLedger, get } = await readEntries([key]);
  const entry = get(key);
  if (!entry) return null;
  const instance = entry.val.contractData().val().instance();
  const exe = instance.executable();
  const executable = exe.switch().name;
  const storage = new Map((instance.storage() ?? []).map((e) => [keyId(e.key()), { key: e.key(), val: e.val() }]));
  return {
    executable,
    wasmHash: executable === "contractExecutableWasm" ? exe.wasmHash().toString("hex") : null,
    storage,
    storageGet: (k) => storage.get(keyId(k))?.val ?? null,
    liveUntilLedger: entry.liveUntilLedgerSeq,
    latestLedger,
  };
}

/** Reads contract data entries by key, each null when the ledger has no such entry. */
export async function readContractData(contractId, requests) {
  const keys = requests.map(({ key, durability }) => contractDataKey(contractId, key, durability));
  const { get } = await readEntries(keys);
  return keys.map((k) => {
    const entry = get(k);
    return entry ? entry.val.contractData().val() : null;
  });
}

/** The uploaded code entry for `wasmHash`, or null. Includes the bytes. */
export async function readCode(wasmHash) {
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, "hex") }));
  const { latestLedger, get } = await readEntries([key]);
  const entry = get(key);
  if (!entry) return null;
  return {
    bytes: entry.val.contractCode().code(),
    liveUntilLedger: entry.liveUntilLedgerSeq,
    live: entry.liveUntilLedgerSeq === undefined || entry.liveUntilLedgerSeq >= latestLedger,
  };
}

// The SDK's getAccount reports every failure, a network error included, as
// "not found". Reading the entry directly keeps the two apart.
export async function accountExists(publicKey) {
  const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(publicKey).xdrPublicKey() }));
  const { get } = await readEntries([key]);
  return get(key) !== null;
}

/** The contract id a deploy from `deployer` with `saltHex` will get. */
export function contractIdFor(deployer, saltHex) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(deployer).toScAddress(),
          salt: Buffer.from(saltHex, "hex"),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

function firstLine(s) {
  return String(s).split(/\r?\n/)[0].trim();
}

/** The contract error code a simulation failed with, or null if it was not a contract error. */
export function contractErrorCode(simError) {
  const m = firstLine(simError).match(/Error\(Contract, #(\d+)\)/);
  return m ? Number(m[1]) : null;
}

/**
 * Simulates `method` on `contractId` with `source` as the transaction source.
 * Nothing is signed or sent. Returns { ok, retval } or { ok: false, error, code }.
 */
export async function simulateCall({ source, contractId, method, args }) {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(TX_WINDOW_SECONDS)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: firstLine(sim.error), code: contractErrorCode(sim.error) };
  if (rpc.Api.isSimulationRestore(sim)) return { ok: false, error: "needs a restore of archived state first", code: null };
  return { ok: true, retval: sim.result?.retval ?? xdr.ScVal.scvVoid() };
}

export const xlm = (stroops) => `${(Number(stroops) / 1e7).toFixed(4)} XLM`;

/**
 * Waits for a sent or possibly sent transaction. Returns the result once it is
 * in a ledger, or null once its time window has passed without it landing,
 * after which it can never land.
 */
export async function settle(txHash, validUntilUnix) {
  for (;;) {
    const r = await server.getTransaction(txHash);
    if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        ok: true,
        ledger: r.ledger,
        feeStroops: Number(r.resultXdr.feeCharged().toString()),
        returnValue: r.returnValue ?? null,
      };
    }
    if (r.status === rpc.Api.GetTransactionStatus.FAILED) {
      return { ok: false, ledger: r.ledger, error: r.resultXdr.result().switch().name };
    }
    // Ledger close times can trail the local clock a little; the margin covers that.
    if (Date.now() / 1000 > validUntilUnix + 30) return null;
    await sleep(POLL_MS);
  }
}

/**
 * Builds, simulates, signs (through `sign`) and submits one operation from
 * `source`, then waits for it. `onPending` receives the transaction hash and
 * its deadline before anything is sent, so a crashed run can find it again.
 * Archived state in the footprint is restored first in its own transaction.
 */
export async function submit({ source, operation, sign, label, onPending, log }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const account = await server.getAccount(source);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(operation)
      .setTimeout(TX_WINDOW_SECONDS)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${label}: simulation failed: ${firstLine(sim.error)}`);
    if (rpc.Api.isSimulationRestore(sim)) {
      const restored = await restore({ source, preamble: sim.restorePreamble, sign, label });
      log?.(`${label}: restored archived state first, tx ${restored.hash}`);
      continue;
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    const txHash = prepared.hash().toString("hex");
    const validUntil = Number(prepared.timeBounds.maxTime);
    await onPending?.({ hash: txHash, pendingUntil: validUntil });
    const result = await send(sign(prepared), validUntil, label);
    return { hash: txHash, ...result };
  }
  throw new Error(`${label}: still needs a restore after restoring once`);
}

async function restore({ source, preamble, sign, label }) {
  const account = await server.getAccount(source);
  const fee = (BigInt(BASE_FEE) + BigInt(preamble.minResourceFee)).toString();
  const tx = new TransactionBuilder(account, { fee, networkPassphrase: NETWORK_PASSPHRASE })
    .setSorobanData(preamble.transactionData.build())
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(TX_WINDOW_SECONDS)
    .build();
  const result = await send(sign(tx), Number(tx.timeBounds.maxTime), `${label} (restore)`);
  return { hash: tx.hash().toString("hex"), ...result };
}

async function send(signed, validUntil, label) {
  for (;;) {
    const res = await server.sendTransaction(signed);
    if (res.status === "PENDING" || res.status === "DUPLICATE") break;
    if (res.status === "TRY_AGAIN_LATER" && Date.now() / 1000 < validUntil) {
      await sleep(POLL_MS);
      continue;
    }
    const code = res.errorResult ? res.errorResult.result().switch().name : res.status;
    throw new Error(`${label}: rejected on send: ${code}`);
  }
  const result = await settle(signed.hash().toString("hex"), validUntil);
  if (!result) throw new Error(`${label}: not included before its time window closed`);
  if (!result.ok) throw new Error(`${label}: failed in ledger ${result.ledger}: ${result.error}`);
  return result;
}
