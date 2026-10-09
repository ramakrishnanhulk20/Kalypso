// Covers the passkey path with a fake authenticator: a passkey with no PRF output is refused and
// reported unknown before anything reaches the network (C15), every prompt requires user
// verification, registration asks for PRF under Kalypso's own name, and the ownership check that
// connecting relies on accepts only this page, this challenge and this key. A deploy call is
// accepted only when its constructor trusts this credential with this passkey's key as a full
// signer (no expiry, no limits, persistent), and a wallet address is proven (safe to show, C51)
// only once a fake chain shows the wallet trusting this key as a full signer AND a transaction that
// hashes to its pointer shows the address born from the pinned code with that signer: a squatter's
// wallet at the address, before or racing our deploy, or born from other code or terms and switched
// to ours since, ends in ADDRESS_TAKEN, found the production way too: Kalypso's lookup says it never
// relayed a creation of the address and this browser holds no pointer of its own (V1 and V2 squats
// alike). A relay whose reply was lost is followed through the lookup's record of it. A wallet
// whose birth cannot be followed stays hidden (WALLET_BIRTH_UNKNOWN, or the first error a pointer
// threw, which never stops the search), while connect opens its session and marks it on chain so
// the payslips show. A pointer counts as a failed creation only when chain shows it is this
// address's own creation and it failed: an unrelated failed transaction, a relayer's word that it
// failed or expired, and a lookup list cut short (more) each conclude nothing. A deploy refused at create leaves the session with its address hidden and the
// reason, and finishing setup runs the same deploy and chain checks again.
// Does NOT cover: a real platform authenticator or PRF determinism across devices (M1b's open
// item), passkey-kit's own deploy simulation inside createPasskey (it needs RPC), the real sponsor,
// index and chain (scratchpad/attacks/birth-squat runs the squat on testnet), or a creation whose
// relay timed out at the sponsor before Channels named an id (its record holds no id to follow).
import "./sdk";
import { describe, expect, it } from "vitest";
import { Account, Address, Keypair, Operation, TransactionBuilder, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { deriveContractAddress } from "passkey-kit";
import type { KalypsoKeys, TxRecord } from "@kalypso/core";
import { workerConfig } from "./config";
import { WorkerError } from "./errors";
import { checkDeployFunc, connectPasskey, createPasskey, finishSetup, passkeyDisplayName, settleNewWallet, setUpWallet, verifyWalletBirth } from "./passkey";
import { addressProven, openSession, walletOnChain, type LiveSigner, type WorkerRuntime, type WorkerSession } from "./session";
import { showsPayslips } from "../../components/app/worker/setup-gate";
import { SponsorError, type BirthIndexPort, type RelayedCreation, type SponsorErrorCode, type SponsorPort } from "./sponsor";
import { readWorkerRecord, writeWorkerRecord, emptyRecord } from "./storage";
import { b64url, verifyAssertion, type Assertion, type WebAuthnEnv } from "./webauthn";

const RP_ID = "kalypso-payroll.vercel.app";
const ORIGIN = `https://${RP_ID}`;
const LONG_DASH = String.fromCharCode(0x2014);

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
const utf8 = (text: string) => new TextEncoder().encode(text);

/** WebCrypto signs P-256 as r || s; authenticators send DER. */
function toDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let b = bytes;
    while (b.length > 1 && b[0] === 0 && b[1]! < 0x80) b = b.subarray(1);
    return b[0]! >= 0x80 ? Uint8Array.of(0, ...b) : b;
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return Uint8Array.of(0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s);
}

async function authenticator(opts: { prfAtCreate?: boolean; prfOnGet?: boolean; flags?: number } = {}) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const spki = await crypto.subtle.exportKey("spki", keys.publicKey);
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const seen = { created: [] as CredentialCreationOptions[], got: [] as CredentialRequestOptions[], forgotten: [] as string[] };

  async function assertion(challenge: Uint8Array, origin = ORIGIN, flags = opts.flags ?? 0x05): Promise<Assertion> {
    const authenticatorData = new Uint8Array([...(await sha256(utf8(RP_ID))), flags, 0, 0, 0, 1]);
    const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin }));
    const signed = new Uint8Array([...authenticatorData, ...(await sha256(clientDataJSON))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
    return { credentialId: b64url(rawId), rawId, authenticatorData, clientDataJSON, signature: toDer(raw), userHandle: null, extensions: {}, authenticatorAttachment: "platform" };
  }

  const env: WebAuthnEnv = {
    rpId: RP_ID,
    origin: ORIGIN,
    signalUnknownCredential: async ({ credentialId }) => void seen.forgotten.push(credentialId),
    credentials: {
      async create(options) {
        seen.created.push(options);
        return {
          type: "public-key",
          id: b64url(rawId),
          rawId: rawId.buffer,
          authenticatorAttachment: "platform",
          response: {
            clientDataJSON: utf8("{}").buffer,
            attestationObject: new Uint8Array([0xa0]).buffer,
            getPublicKey: () => spki,
            getPublicKeyAlgorithm: () => -7,
            getTransports: () => ["internal"],
          },
          getClientExtensionResults: () => ({ prf: { enabled: opts.prfAtCreate ?? true } }),
        } as unknown as Credential;
      },
      async get(options) {
        seen.got.push(options);
        const a = await assertion(new Uint8Array(options.publicKey!.challenge as ArrayBuffer));
        return {
          type: "public-key",
          id: a.credentialId,
          rawId: rawId.buffer,
          authenticatorAttachment: "platform",
          response: { authenticatorData: a.authenticatorData.buffer, clientDataJSON: a.clientDataJSON.buffer, signature: a.signature.buffer, userHandle: null },
          getClientExtensionResults: () => (opts.prfOnGet ? { prf: { results: { first: crypto.getRandomValues(new Uint8Array(32)).buffer } } } : {}),
        } as unknown as Credential;
      },
    },
  };
  return { env, publicKey, seen, assertion };
}

/**
 * A runtime whose network parts throw if touched, and whose RPC URL (which passkey-kit uses for its
 * own deploy simulation) cannot be reached, so a test proves the refusal came before any network use.
 */
function offline(env: WebAuthnEnv) {
  const touched: string[] = [];
  const trap = (name: string) =>
    new Proxy({}, {
      get(_t, prop) {
        touched.push(`${name}.${String(prop)}`);
        throw new Error(`network part ${name} was used`);
      },
    });
  const config = { ...workerConfig(), rpcUrl: "https://rpc.offline.invalid" };
  const rt = { config, webauthn: () => env, storage: null, port: trap("port"), ledger: trap("ledger") } as unknown as WorkerRuntime;
  const sponsor: SponsorPort = {
    send: async () => {
      touched.push("sponsor.send");
      throw new Error("the sponsor was used");
    },
    status: async () => {
      touched.push("sponsor.status");
      throw new Error("the sponsor was used");
    },
  };
  return { rt, sponsor, touched };
}

describe("createPasskey", () => {
  it("refuses a passkey that returns no PRF output, tells the browser to forget it, and sends nothing", async () => {
    const auth = await authenticator({ prfOnGet: false });
    const { rt, sponsor, touched } = offline(auth.env);
    const err = await createPasskey(rt, sponsor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerError);
    expect(err).toMatchObject({ code: "PRF_UNAVAILABLE" });
    expect((err as Error).message).toContain("sign in with Freighter");
    expect(auth.seen.got).toHaveLength(1);
    expect(auth.seen.got[0]!.publicKey!.extensions?.prf?.eval?.first).toBeDefined();
    expect(auth.seen.forgotten).toEqual([b64url(new Uint8Array(auth.seen.got[0]!.publicKey!.allowCredentials![0]!.id as ArrayBuffer))]);
    expect(touched).toEqual([]);
  });

  it("stops right after registration when the passkey says it has no PRF, without a second prompt", async () => {
    const auth = await authenticator({ prfAtCreate: false });
    const { rt, sponsor, touched } = offline(auth.env);
    await expect(createPasskey(rt, sponsor)).rejects.toMatchObject({ code: "PRF_UNAVAILABLE" });
    expect(auth.seen.got).toEqual([]);
    expect(touched).toEqual([]);
  });

  it("refuses an answer that was not user verified, because its PRF secret is a different one", async () => {
    const auth = await authenticator({ prfOnGet: true, flags: 0x01 });
    const { rt, sponsor } = offline(auth.env);
    await expect(createPasskey(rt, sponsor)).rejects.toMatchObject({ code: "NO_USER_VERIFICATION" });
  });

  it("refuses to start without a sponsor to deploy the wallet, before any prompt", async () => {
    const auth = await authenticator();
    const { rt } = offline(auth.env);
    await expect(createPasskey(rt, {} as SponsorPort)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(auth.seen.created).toEqual([]);
  });

  it("registers with PRF requested, verification required and Kalypso's own name, never the kit's default", async () => {
    const auth = await authenticator({ prfAtCreate: false });
    const { rt, sponsor } = offline(auth.env);
    await createPasskey(rt, sponsor).catch(() => undefined);
    const options = auth.seen.created[0]!.publicKey!;
    expect(options.extensions).toEqual({ prf: {} });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.rp).toEqual({ id: RP_ID, name: "Kalypso" });
    expect(options.user.name).toBe("Kalypso");
    expect(options.user.displayName).toBe("Kalypso");
    expect(passkeyDisplayName("CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL")).toBe(`Kalypso ${String.fromCharCode(0xb7)} CB6B`);
    expect(passkeyDisplayName("CB6B")).not.toContain(LONG_DASH);
  });
});

describe("verifyAssertion", () => {
  it("accepts only this page, this challenge, a verified user and the key the wallet trusts", async () => {
    const auth = await authenticator();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const good = await auth.assertion(challenge);
    expect(await verifyAssertion(auth.env, good, { publicKey: auth.publicKey, challenge })).toBe(true);

    const other = await authenticator();
    expect(await verifyAssertion(auth.env, good, { publicKey: other.publicKey, challenge })).toBe(false);
    expect(await verifyAssertion(auth.env, good, { publicKey: auth.publicKey, challenge: crypto.getRandomValues(new Uint8Array(32)) })).toBe(false);
    expect(await verifyAssertion(auth.env, await auth.assertion(challenge, "https://kalypso-payroll.vercel.app.evil.example"), { publicKey: auth.publicKey, challenge })).toBe(false);
    expect(await verifyAssertion(auth.env, await auth.assertion(challenge, ORIGIN, 0x01), { publicKey: auth.publicKey, challenge })).toBe(false);
    const tampered = { ...good, authenticatorData: good.authenticatorData.slice() };
    tampered.authenticatorData[36] ^= 0x01;
    expect(await verifyAssertion(auth.env, tampered, { publicKey: auth.publicKey, challenge })).toBe(false);
    expect(await verifyAssertion({ ...auth.env, rpId: "other.example" }, good, { publicKey: auth.publicKey, challenge })).toBe(false);
  });
});

const config = workerConfig();
const KIT_DEPLOYER = Keypair.fromRawEd25519Seed(hash(Buffer.from("kalepail"))).publicKey();
const OTHER_WASM = "00".repeat(32);

type Terms = { wasm?: string; expiry?: bigint; limited?: boolean; storage?: "Persistent" | "Temporary" };

/**
 * A wallet deploy call shaped like passkey-kit's: salted with sha256(credential id), its
 * constructor's signer trusting `signer` on the kit's terms (the pinned code, no expiry, no limits,
 * persistent) unless `terms` says otherwise.
 */
function deployCall(keyId: Uint8Array, signer: { keyId: Uint8Array; publicKey: Uint8Array }, terms: Terms = {}): string {
  const limits = terms.limited ? xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: new Address(config.contracts.token).toScVal(), val: xdr.ScVal.scvVoid() })]) : xdr.ScVal.scvVoid();
  const secp256r1 = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Secp256r1"),
    xdr.ScVal.scvBytes(Buffer.from(signer.keyId)),
    xdr.ScVal.scvBytes(Buffer.from(signer.publicKey)),
    xdr.ScVal.scvVec([terms.expiry === undefined ? xdr.ScVal.scvVoid() : nativeToScVal(terms.expiry, { type: "u64" })]),
    xdr.ScVal.scvVec([limits]),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(terms.storage ?? "Persistent")]),
  ]);
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(
    new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: new Address(KIT_DEPLOYER).toScAddress(), salt: hash(Buffer.from(keyId)) }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(terms.wasm ?? config.walletWasmHash, "hex")),
      constructorArgs: [secp256r1, xdr.ScVal.scvBytes(Buffer.alloc(0))],
    }),
  ).toXDR("base64");
}

/** A transaction whose one operation runs `func`, in a fee bump the way the relayer sends it, as a transaction source records it. */
function creationTx(func: string, successful = true): TxRecord & { hash: string; innerHash: string } {
  const source = Keypair.random();
  const inner = new TransactionBuilder(new Account(source.publicKey(), "1"), { fee: "100", networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.fromXDR(func, "base64"), auth: [] }))
    .setTimeout(300)
    .build();
  inner.sign(source);
  const payer = Keypair.random();
  const bump = TransactionBuilder.buildFeeBumpTransaction(payer, "200", inner, config.networkPassphrase);
  bump.sign(payer);
  return { hash: bump.hash().toString("hex"), innerHash: inner.hash().toString("hex"), envelopeXdr: bump.toXDR(), successful, ledger: 1_001 };
}

const full = (publicKey: Uint8Array): LiveSigner => ({ publicKey, expiry: null, limited: false, persistent: true });

function credential() {
  const keyId = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = Uint8Array.of(4, ...crypto.getRandomValues(new Uint8Array(64)));
  const contractId = deriveContractAddress(Buffer.from(keyId), KIT_DEPLOYER, config.networkPassphrase);
  return { keyId, publicKey, contractId, where: { contractId, keyId: b64url(keyId), publicKey, config } };
}

describe("checkDeployFunc", () => {
  it("accepts the deploy call whose constructor trusts this credential with this passkey's key", () => {
    const c = credential();
    expect(() => checkDeployFunc(deployCall(c.keyId, c), c.where)).not.toThrow();
  });

  it("refuses a deploy for this address whose constructor trusts another public key", () => {
    const c = credential();
    const squatter = Uint8Array.of(4, ...crypto.getRandomValues(new Uint8Array(64)));
    expect(() => checkDeployFunc(deployCall(c.keyId, { keyId: c.keyId, publicKey: squatter }), c.where)).toThrow(expect.objectContaining({ code: "WALLET_RECORD_INVALID" }));
  });

  it("refuses a deploy for this address whose constructor names another credential", () => {
    const c = credential();
    const other = crypto.getRandomValues(new Uint8Array(32));
    expect(() => checkDeployFunc(deployCall(c.keyId, { keyId: other, publicKey: c.publicKey }), c.where)).toThrow(expect.objectContaining({ code: "WALLET_RECORD_INVALID" }));
  });

  it("refuses this key on any other terms: an expiry, limits or temporary storage", () => {
    const c = credential();
    for (const terms of [{ expiry: 1_900_000_000n }, { limited: true }, { storage: "Temporary" as const }]) {
      expect(() => checkDeployFunc(deployCall(c.keyId, c, terms), c.where), JSON.stringify(terms, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toThrow(
        expect.objectContaining({ code: "WALLET_RECORD_INVALID" }),
      );
    }
  });
});

const OTHER_HASH = "ef".repeat(32);

/**
 * A chain with one wallet slot at the credential's address and the transactions sources hold, a
 * sponsor whose relay can land our deploy (with its creation), a squatter's, or nothing, RPC that
 * confirms whatever hash it is asked about, and a lookup that answers `index.hash`, `index.relayed`
 * and `index.more` (or throws `index.fails`). Like the server, every creation the sponsor hands on is
 * recorded in `index.relayed` before the hand-off, with the relay id it got back.
 */
function fakeChain(
  c: ReturnType<typeof credential>,
  opts: { before?: LiveSigner | "other code"; onSend?: "ours" | "squatter" | "nothing" | "front-run"; final?: "SUCCESS" | "FAILED"; namedHash?: string; refuse?: SponsorErrorCode } = {},
) {
  const ours = creationTx(deployCall(c.keyId, c));
  let wallet: { wasm: string; signer: LiveSigner | null } | null = null;
  if (opts.before === "other code") wallet = { wasm: OTHER_WASM, signer: null };
  else if (opts.before) wallet = { wasm: config.walletWasmHash, signer: opts.before };
  const squatterKey = Uint8Array.of(4, ...crypto.getRandomValues(new Uint8Array(64)));
  const sent: unknown[] = [];
  const txs = new Map<string, TxRecord>();
  const recorded: [string, string][] = [];
  const index = { hash: null as string | null, relayed: [] as RelayedCreation[], more: false, fails: undefined as SponsorErrorCode | undefined };
  const store = new Map<string, string>();
  const rt = {
    config,
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    ledger: {
      contractWasm: async (id: string) => (id === c.contractId ? (wallet?.wasm ?? null) : null),
      walletSigner: async (id: string, keyId: Uint8Array) => (id === c.contractId && Buffer.from(keyId).equals(Buffer.from(c.keyId)) ? (wallet?.signer ?? null) : null),
    },
    txSource: { transaction: async (h: string) => txs.get(h) ?? null },
    port: {
      latestLedger: async () => ({ sequence: 1_000, closeTime: Math.floor(Date.now() / 1000) }),
      waitFor: async () => ({ status: opts.final ?? "SUCCESS", ledger: 1_001 }),
    },
    sleep: async () => undefined,
    now: () => Date.now(),
    exclusive: <T>(_name: string, work: () => Promise<T>) => work(),
  } as unknown as WorkerRuntime;
  const sponsor: SponsorPort & BirthIndexPort = {
    async send(body) {
      sent.push(body);
      if (opts.refuse) throw new SponsorError(opts.refuse);
      index.relayed.push({ transactionId: "tx_1", hash: null });
      if ((opts.onSend ?? "ours") === "ours") {
        wallet = { wasm: config.walletWasmHash, signer: full(c.publicKey) };
        txs.set(ours.hash, ours);
      }
      if (opts.onSend === "squatter") wallet = { wasm: config.walletWasmHash, signer: full(squatterKey) };
      // The N1 front-run: a squat trusting this very key lands between our simulation and our deploy,
      // so ours fails on chain, and the server notes its hash on the relay record.
      if (opts.onSend === "front-run") {
        wallet = { wasm: config.walletWasmHash, signer: full(c.publicKey) };
        txs.set(ours.hash, { ...ours, successful: false });
        index.relayed[index.relayed.length - 1] = { transactionId: "tx_1", hash: ours.hash };
      }
      return { transactionId: "tx_1", status: "pending" };
    },
    status: async () => ({ status: "confirmed", hash: opts.namedHash ?? ours.hash }),
    birth: async () => {
      if (index.fails !== undefined) throw new SponsorError(index.fails, 429);
      return { hash: index.hash, relayed: [...index.relayed], more: index.more };
    },
    recordBirth: async (address, h) => void recorded.push([address, h]),
  };
  /** Puts a creation on chain, as every source would hold it, and returns its hash. */
  const land = (func: string, successful = true) => {
    const tx = creationTx(func, successful);
    txs.set(tx.hash, tx);
    return tx.hash;
  };
  const landOurs = () => void txs.set(ours.hash, ours);
  /** What createPasskey saves before the deploy, plus anything a test adds. */
  const saveRecord = (extra: { deployRelay?: { transactionId: string; hash: string | null } } = {}) =>
    writeWorkerRecord(rt.storage, c.contractId, {
      ...emptyRecord(),
      passkey: { keyId: b64url(c.keyId), publicKey: b64url(c.publicKey), deployFunc: deployCall(c.keyId, c), birth: null, deployRelay: extra.deployRelay ?? null },
    });
  return { rt, sponsor, sent, squatterKey, ours, txs, recorded, index, land, landOurs, saveRecord };
}

function passkeySession(c: ReturnType<typeof credential>, deployFunc: string | null): WorkerSession {
  return openSession(
    { kind: "passkey", address: c.contractId, cashOutAddress: Keypair.random().publicKey(), keys: {} as KalypsoKeys, auditorId: null },
    { kind: "passkey", keyId: b64url(c.keyId), publicKey: c.publicKey, cashOutSeed: new Uint8Array(32), signEntry: async () => "", deployFunc, proven: false, deployed: false },
  );
}

describe("verifyWalletBirth", () => {
  it("is ours only for a successful creation of this address with the full signer, by its outer or inner hash", async () => {
    const c = credential();
    const chain = fakeChain(c);
    chain.landOurs();
    const ask = (h: string) => verifyWalletBirth(chain.rt, { contractId: c.contractId, keyId: b64url(c.keyId), publicKey: c.publicKey, hash: h });
    expect(await ask(chain.ours.hash)).toBe("ours");
    chain.txs.set(chain.ours.innerHash, chain.ours);
    expect(await ask(chain.ours.innerHash)).toBe("ours");
    const elsewhere = credential();
    expect(await ask(chain.land(deployCall(elsewhere.keyId, elsewhere)))).toBe("unavailable");
    expect(await ask(OTHER_HASH)).toBe("unavailable");
    expect(await ask("not a hash")).toBe("unavailable");
  });

  it("names this address's own creation that failed on chain failed, on our terms or a squatter's: it created nothing (T9, R-K1 b)", async () => {
    const c = credential();
    const chain = fakeChain(c);
    const ask = (h: string) => verifyWalletBirth(chain.rt, { contractId: c.contractId, keyId: b64url(c.keyId), publicKey: c.publicKey, hash: h });
    expect(await ask(chain.land(deployCall(c.keyId, c), false))).toBe("failed");
    expect(await ask(chain.land(deployCall(c.keyId, c, { wasm: OTHER_WASM }), false))).toBe("failed");
  });

  it("names a failed transaction that is not this address's creation unavailable, never failed (R-K1 a)", async () => {
    const c = credential();
    const chain = fakeChain(c);
    const elsewhere = credential();
    const ask = (h: string) => verifyWalletBirth(chain.rt, { contractId: c.contractId, keyId: b64url(c.keyId), publicKey: c.publicKey, hash: h });
    expect(await ask(chain.land(deployCall(elsewhere.keyId, elsewhere), false))).toBe("unavailable");
  });

  it("says NETWORK when no transaction source could answer, never a verdict", async () => {
    const c = credential();
    const chain = fakeChain(c);
    const rt = { ...chain.rt, txSource: { transaction: async () => Promise.reject(new Error("horizon down")) } } as WorkerRuntime;
    await expect(verifyWalletBirth(rt, { contractId: c.contractId, keyId: b64url(c.keyId), publicKey: c.publicKey, hash: chain.ours.hash })).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("setUpWallet (the deploy createPasskey and joining run)", () => {
  it("deploys through the sponsor, then proves the wallet trusts this passkey and was born ours before the address may be shown (T6)", async () => {
    const c = credential();
    const chain = fakeChain(c);
    chain.saveRecord();
    const worker = passkeySession(c, deployCall(c.keyId, c));
    expect(addressProven(worker)).toBe(false);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).resolves.toEqual({ hash: chain.ours.hash });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ func: deployCall(c.keyId, c) });
    expect(addressProven(worker)).toBe(true);
    expect(readWorkerRecord(chain.rt.storage, c.contractId).passkey).toMatchObject({ birth: { hash: chain.ours.hash }, deployRelay: null });
    expect(chain.recorded).toEqual([[c.contractId, chain.ours.hash]]);
  });

  it("never proves an address whose wallet already trusts another key, and sends nothing", async () => {
    const c = credential();
    const squatter = Uint8Array.of(4, ...crypto.getRandomValues(new Uint8Array(64)));
    const chain = fakeChain(c, { before: full(squatter) });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    const err = await setUpWallet(chain.rt, worker, chain.sponsor).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ADDRESS_TAKEN", message: "This address was taken before your wallet was set up. Create a new pay key." });
    expect(chain.sent).toEqual([]);
    expect(addressProven(worker)).toBe(false);
  });

  it("treats other code at the address as taken too", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: "other code" });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });

  it.each([
    ["an expiry (T10)", { expiry: 1_900_000_000 }],
    ["limits", { limited: true }],
    ["temporary storage", { persistent: false }],
  ])("treats this key live with %s as taken, whatever its birth", async (_label, terms) => {
    const c = credential();
    const chain = fakeChain(c, { before: { ...full(c.publicKey), ...terms } });
    chain.landOurs();
    chain.index.hash = chain.ours.hash;
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(chain.sent).toEqual([]);
    expect(addressProven(worker)).toBe(false);
  });

  it("never proves a wallet that looks ours now but was born from other code, found as production finds it: nothing points at the squat, and Kalypso never relayed this address (T1, R-K1 g)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.land(deployCall(c.keyId, c, { wasm: OTHER_WASM }));
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(chain.sent).toEqual([]);
    expect(addressProven(worker)).toBe(false);
    expect(walletOnChain(worker)).toBe(true);
  });

  it("gives ADDRESS_TAKEN for the reviewer's F1 repro: a squat made before the deploy, a saved record and no relay, at create (a)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.land(deployCall(c.keyId, c, { wasm: OTHER_WASM }));
    chain.saveRecord();
    await expect(settleNewWallet(chain.rt, passkeySession(c, deployCall(c.keyId, c)), chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(chain.sent).toEqual([]);
  });

  it("gives ADDRESS_TAKEN for the same squat made with a V1 CreateContract, which no birth check can read (b)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    const v1 = xdr.HostFunction.hostFunctionTypeCreateContract(
      new xdr.CreateContractArgs({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({ address: new Address(KIT_DEPLOYER).toScAddress(), salt: hash(Buffer.from(c.keyId)) }),
        ),
        executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(OTHER_WASM, "hex")),
      }),
    ).toXDR("base64");
    chain.index.hash = chain.land(v1);
    chain.saveRecord();
    const worker = passkeySession(c, deployCall(c.keyId, c));
    expect(await verifyWalletBirth(chain.rt, { contractId: c.contractId, keyId: b64url(c.keyId), publicKey: c.publicKey, hash: chain.index.hash })).toBe("unavailable");
    chain.index.hash = null;
    await expect(settleNewWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("proves a wallet whose relay reply was lost after the sponsor relayed it: the lookup names the relay id, the status names its hash (c)", async () => {
    const c = credential();
    const chain = fakeChain(c);
    chain.saveRecord();
    const lossy: SponsorPort & BirthIndexPort = {
      ...chain.sponsor,
      async send(body) {
        await chain.sponsor.send(body);
        throw new SponsorError("timeout");
      },
    };
    const worker = passkeySession(c, deployCall(c.keyId, c));
    expect(readWorkerRecord(chain.rt.storage, c.contractId).passkey?.deployRelay).toBeNull();
    await expect(setUpWallet(chain.rt, worker, lossy)).resolves.toEqual({ hash: null });
    expect(chain.index.relayed).toEqual([{ transactionId: "tx_1", hash: null }]);
    expect(readWorkerRecord(chain.rt.storage, c.contractId).passkey?.deployRelay).toBeNull();
    expect(addressProven(worker)).toBe(true);
  });

  it("never calls a wallet taken when this browser holds a relay of its own, though the lookup says Kalypso never relayed it (e)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.saveRecord({ deployRelay: { transactionId: "tx_mine", hash: OTHER_HASH } });
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
  });

  it.each([
    ["an expiry (T2)", { expiry: 1_900_000_000n }],
    ["limits (T3)", { limited: true }],
    ["temporary storage", { storage: "Temporary" as const }],
  ])("never proves a wallet born trusting this key with %s, though it looks ours now", async (_label, terms) => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.index.hash = chain.land(deployCall(c.keyId, c, terms));
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("proves a wallet already on chain with this key only once a verified birth is found, sending nothing (T12)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.index.relayed = [{ transactionId: "tx_1", hash: null }];
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
    chain.landOurs();
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).resolves.toEqual({ hash: null });
    expect(chain.sent).toEqual([]);
    expect(addressProven(worker)).toBe(true);
  });

  it("treats an index hash its envelope does not hash to as no pointer: never proven, never taken (T5)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    const lie = "ab".repeat(32);
    chain.txs.set(lie, creationTx(deployCall(c.keyId, c, { wasm: OTHER_WASM })));
    chain.index.hash = lie;
    const worker = passkeySession(c, null);
    const err = await setUpWallet(chain.rt, worker, chain.sponsor).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("follows a relay whose answer was lost by its id: the sponsor's status names the hash and the birth proves it (T8)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.landOurs();
    chain.saveRecord({ deployRelay: { transactionId: "tx_lost", hash: null } });
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).resolves.toEqual({ hash: null });
    expect(addressProven(worker)).toBe(true);
    expect(readWorkerRecord(chain.rt.storage, c.contractId).passkey).toMatchObject({ birth: { hash: chain.ours.hash }, deployRelay: null });
  });

  it("keeps searching when the sponsor has forgotten a saved relay id: the index's birth still proves it", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.landOurs();
    chain.saveRecord({ deployRelay: { transactionId: "tx_forgotten", hash: null } });
    chain.index.hash = chain.ours.hash;
    const forgetful = { ...chain.sponsor, status: async () => Promise.reject(new SponsorError("relay_refused", 502)) };
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, forgetful)).resolves.toEqual({ hash: null });
    expect(addressProven(worker)).toBe(true);
  });

  it("hands back the sponsor's own error, not WALLET_BIRTH_UNKNOWN, when that forgotten id was the only lead", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.landOurs();
    chain.saveRecord({ deployRelay: { transactionId: "tx_forgotten", hash: null } });
    const forgetful = { ...chain.sponsor, status: async () => Promise.reject(new SponsorError("relay_refused", 502)) };
    const worker = passkeySession(c, null);
    const err = await setUpWallet(chain.rt, worker, forgetful).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SponsorError);
    expect(err).toMatchObject({ code: "relay_refused" });
    expect(addressProven(worker)).toBe(false);
  });

  it("reads a lone failed pointer as no creation of the address (T9), but concludes nothing when the index has no method to ask", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.index.hash = chain.land(deployCall(c.keyId, c), false);
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    chain.landOurs();
    const noIndex: SponsorPort = { send: chain.sponsor.send, status: chain.sponsor.status };
    await expect(setUpWallet(chain.rt, worker, noIndex)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("gives ADDRESS_TAKEN when a squat trusting this key front-ran our deploy and ours failed on chain, the lookup naming our failed relay (R-I2 a, R-K1 d)", async () => {
    const c = credential();
    const chain = fakeChain(c, { onSend: "front-run", final: "FAILED" });
    chain.saveRecord();
    const worker = passkeySession(c, deployCall(c.keyId, c));
    await expect(settleNewWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(chain.index.relayed).toEqual([{ transactionId: "tx_1", hash: chain.ours.hash }]);
    expect(addressProven(worker)).toBe(false);
    expect(walletOnChain(worker)).toBe(true);
  });

  it("concludes nothing from one failed pointer beside one the relayer is still working on (R-I2 b)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.index.relayed = [
      { transactionId: "tx_a", hash: chain.land(deployCall(c.keyId, c), false) },
      { transactionId: "tx_b", hash: null },
    ];
    const pending: SponsorPort & BirthIndexPort = { ...chain.sponsor, status: async () => ({ status: "pending", hash: null }) };
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, pending)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
  });

  it.each(["expired", "failed"] as const)("concludes nothing when the relayer says the only relay of the address %s with no hash: its word is not a chain read (R-I2 c, R-K1 c)", async (status) => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.index.relayed = [{ transactionId: "tx_x", hash: null }];
    const gaveUp: SponsorPort & BirthIndexPort = { ...chain.sponsor, status: async () => ({ status, hash: null }) };
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, gaveUp)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("never calls a wallet that is ours on chain taken because the lookup names only an unrelated failed transaction, as its birth or a relay row (R-K1 a)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.landOurs();
    const elsewhere = credential();
    const unrelated = chain.land(deployCall(elsewhere.keyId, elsewhere), false);
    const worker = passkeySession(c, null);
    for (const [hash, relayed] of [
      [unrelated, []],
      [null, [{ transactionId: "tx_bad_row", hash: unrelated }]],
    ] as const) {
      chain.index.hash = hash;
      chain.index.relayed = [...relayed];
      await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    }
    expect(addressProven(worker)).toBe(false);
  });

  it("concludes nothing when every listed relay failed on chain but the lookup left older ones out, and ADDRESS_TAKEN once the list is whole (R-K1 e)", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(c.publicKey) });
    chain.index.relayed = [
      { transactionId: "tx_a", hash: chain.land(deployCall(c.keyId, c), false) },
      { transactionId: "tx_b", hash: chain.land(deployCall(c.keyId, c), false) },
    ];
    chain.index.more = true;
    const worker = passkeySession(c, null);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    chain.index.more = false;
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("reports ADDRESS_TAKEN when a squatter deploys first and our deploy fails on chain", async () => {
    const c = credential();
    const chain = fakeChain(c, { onSend: "squatter", final: "FAILED" });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("proves nothing when the relayer names an unrelated successful hash and no wallet appears", async () => {
    const c = credential();
    const chain = fakeChain(c, { onSend: "nothing", namedHash: OTHER_HASH });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "CHAIN_DISAGREES", hash: OTHER_HASH });
    expect(addressProven(worker)).toBe(false);
  });

  it("refuses a stored deploy call that would trust another key, before anything is sent", async () => {
    const c = credential();
    const chain = fakeChain(c);
    const tampered = deployCall(c.keyId, { keyId: c.keyId, publicKey: chain.squatterKey });
    const worker = passkeySession(c, tampered);
    await expect(setUpWallet(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "WALLET_RECORD_INVALID" });
    expect(chain.sent).toEqual([]);
    expect(addressProven(worker)).toBe(false);
  });
});

describe("connectPasskey and the address", () => {
  /**
   * A sign-in against a wallet slot: `birth` is the creation on chain (none, ours by default, or on
   * other terms), `pointed` whether the lookup holds its hash, `relayed` the creations the lookup
   * says the sponsor relayed, and `lookupFails` a refusal the lookup throws instead of answering.
   */
  async function signIn(
    chainKey: "ours" | "other" | "none",
    opts: { birth?: Terms | "none"; pointed?: boolean; relayed?: RelayedCreation[]; lookupFails?: SponsorErrorCode } = {},
  ) {
    const auth = await authenticator({ prfOnGet: true });
    const a = await auth.assertion(new Uint8Array(32));
    const contractId = deriveContractAddress(Buffer.from(a.rawId), KIT_DEPLOYER, config.networkPassphrase);
    const store = new Map<string, string>();
    const signer = chainKey === "ours" ? auth.publicKey : chainKey === "other" ? Uint8Array.of(4, ...crypto.getRandomValues(new Uint8Array(64))) : null;
    const txs = new Map<string, TxRecord>();
    const recorded: [string, string][] = [];
    const birth = opts.birth ?? {};
    let indexed: string | null = null;
    if (birth !== "none") {
      const tx = creationTx(deployCall(a.rawId, { keyId: a.rawId, publicKey: auth.publicKey }, birth));
      txs.set(tx.hash, tx);
      if (opts.pointed ?? true) indexed = tx.hash;
    }
    const rt = {
      config,
      webauthn: () => auth.env,
      storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      ledger: {
        contractWasm: async () => (signer === null ? null : config.walletWasmHash),
        walletSigner: async () => (signer === null ? null : full(signer)),
      },
      txSource: { transaction: async (h: string) => txs.get(h) ?? null },
      port: {
        read: async () => {
          const { ContractCallError } = await import("@kalypso/core");
          throw new ContractCallError("confidential_balance", 3501);
        },
      },
      exclusive: <T>(_name: string, work: () => Promise<T>) => work(),
    } as unknown as WorkerRuntime;
    if (chainKey === "none") {
      store.set(`kalypso/worker/v1/${contractId}`, JSON.stringify({ v: 1, companyIds: [], auditorId: null, auditorKeyRelay: null, registeredLedger: null, passkey: { keyId: a.credentialId, publicKey: b64url(auth.publicKey), deployFunc: "AAAA" } }));
    }
    const sponsor: SponsorPort & BirthIndexPort = {
      send: async () => {
        throw new Error("the sponsor was used");
      },
      status: async () => ({ status: "pending", hash: null }),
      birth: async () => {
        if (opts.lookupFails !== undefined) throw new SponsorError(opts.lookupFails, 429);
        return { hash: indexed, relayed: opts.relayed ?? [], more: false };
      },
      recordBirth: async (address, h) => void recorded.push([address, h]),
    };
    return { rt, sponsor, recorded, contractId, signedIn: connectPasskey(rt, sponsor) };
  }

  it("proves the address on a new device when the wallet trusts the key that just signed in and the index points to its birth (T7)", async () => {
    const { signedIn, recorded, contractId } = await signIn("ours");
    const { worker, setupFailure } = await signedIn;
    expect(setupFailure).toBeUndefined();
    expect(addressProven(worker)).toBe(true);
    expect(recorded.map(([address]) => address)).toEqual([contractId]);
  });

  it("opens a deployed wallet whose relayed creation cannot be followed yet with its address hidden, and finishing setup still refuses it (T4)", async () => {
    const { rt, sponsor, signedIn } = await signIn("ours", { birth: "none", relayed: [{ transactionId: "tx_lost", hash: null }] });
    const { worker, setupFailure } = await signedIn;
    expect(setupFailure).toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
    await expect(finishSetup(rt, worker, sponsor)).rejects.toMatchObject({ code: "WALLET_BIRTH_UNKNOWN" });
    expect(addressProven(worker)).toBe(false);
  });

  it("opens the session on a rate-limited lookup with that refusal as the reason, its address hidden and its payslips shown (d)", async () => {
    const { worker, setupFailure } = await (await signIn("ours", { lookupFails: "rate_limited" })).signedIn;
    expect(setupFailure).toBeInstanceOf(SponsorError);
    expect(setupFailure).toMatchObject({ code: "rate_limited" });
    expect(addressProven(worker)).toBe(false);
    expect(walletOnChain(worker)).toBe(true);
    expect(showsPayslips({ waitForJoin: false, finishNeeded: true, onChain: walletOnChain(worker) })).toBe(true);
  });

  it("opens a squatted wallet, found the production way, with setupFailure ADDRESS_TAKEN instead of throwing (f)", async () => {
    const { worker, setupFailure } = await (await signIn("ours", { birth: { wasm: OTHER_WASM }, pointed: false })).signedIn;
    expect(setupFailure).toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
    expect(walletOnChain(worker)).toBe(true);
  });

  it("refuses a wallet on chain that trusts another key, so no session or address exists", async () => {
    await expect((await signIn("other")).signedIn).rejects.toMatchObject({ code: "PASSKEY_NOT_THIS_WALLET" });
  });

  it("keeps the address hidden for a wallet this browser recorded but the chain does not hold yet", async () => {
    const { worker, setupFailure } = await (await signIn("none")).signedIn;
    expect(setupFailure).toBeUndefined();
    expect(addressProven(worker)).toBe(false);
  });
});

describe("a deploy refused at create, and finishing setup", () => {
  it("keeps the session with its address hidden and hands back the sponsor's reason", async () => {
    const c = credential();
    const chain = fakeChain(c, { refuse: "rate_limited" });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    const settled = await settleNewWallet(chain.rt, worker, chain.sponsor);
    expect(settled.setupFailure).toMatchObject({ name: "SponsorError", code: "rate_limited" });
    expect(addressProven(worker)).toBe(false);
  });

  it("still throws ADDRESS_TAKEN at create for a squatted address", async () => {
    const c = credential();
    const chain = fakeChain(c, { before: full(Uint8Array.of(4, ...crypto.getRandomValues(new Uint8Array(64)))) });
    await expect(settleNewWallet(chain.rt, passkeySession(c, deployCall(c.keyId, c)), chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
  });

  it("Finish setting up deploys with a working sponsor and proves the address", async () => {
    const c = credential();
    const refused = fakeChain(c, { refuse: "daily_budget_spent" });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    await settleNewWallet(refused.rt, worker, refused.sponsor);
    const working = fakeChain(c);
    await expect(finishSetup(working.rt, worker, working.sponsor)).resolves.toEqual({ hash: working.ours.hash });
    expect(working.sent).toHaveLength(1);
    expect(addressProven(worker)).toBe(true);
  });

  it("Finish setting up reports ADDRESS_TAKEN when someone deployed there meanwhile", async () => {
    const c = credential();
    const chain = fakeChain(c, { onSend: "squatter", final: "FAILED" });
    const worker = passkeySession(c, deployCall(c.keyId, c));
    await expect(finishSetup(chain.rt, worker, chain.sponsor)).rejects.toMatchObject({ code: "ADDRESS_TAKEN" });
    expect(addressProven(worker)).toBe(false);
  });
});
