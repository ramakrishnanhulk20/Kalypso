// Not covered here: a real enforce-mode simulation (RPC is faked; the
// scratchpad/m5a live check runs one against testnet), whether a passkey
// wallet's own signature is valid, which only its __check_auth can decide,
// and a wallet or contract changing its state between our simulation and
// Channels' own one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Address, Networks, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  INCLUSION_FEE_ALLOWANCE_STROOPS,
  MAX_AUTH_ENTRIES,
  MAX_AUTH_NODES,
  authExpiryLedger,
  requestDigest,
  simulate,
  validateSponsorRequest,
  type SponsorRequest,
} from "../../src/sponsor/validate.ts";
import { createRpcClient } from "../../src/rpc.ts";
import { canonicalAccountId } from "../../src/stellar.ts";
import { contractOfKey, defaultFootprint, fakeSimulation, instanceEntries, recordedAuthOf, transactionData } from "./fake-rpc.ts";
import { AUDITOR, PAYROLL, STRANGER, TOKEN, USDC, VERIFIER, contractFor, testConfig } from "../helpers.ts";
import {
  LATEST_LEDGER,
  PINNED_WALLET_WASM,
  accountKey,
  addr,
  b64,
  codeKey,
  contractAccountEntry,
  createContractInvocation,
  createContractOperation,
  depositTree,
  employer,
  envelope,
  fakeCode,
  hostCall,
  instanceKey,
  invocation,
  mergeFuncAuth,
  mergeOperation,
  nonceKey,
  passkeyMergeFootprint,
  passkeyWallet,
  paymentOperation,
  signedEntry,
  sourceAccountEntry,
  storageKey,
  thirdPartyOperation,
  uploadOperation,
  worker,
  type Call,
  type Footprint,
  type Limits,
} from "./fixtures.ts";

const cfg = testConfig();
const codeOf = (body: unknown) => {
  const v = validateSponsorRequest(body, cfg);
  return v.ok ? "ok" : v.code;
};
const merge: Call = { contract: TOKEN, fn: "merge", args: [addr(worker.publicKey())] };
const mergeFunc = () => b64(hostCall(TOKEN, "merge", [addr(worker.publicKey())]));

describe("validateSponsorRequest: body shape and encoding", () => {
  it("refuses anything but exactly {func, auth} or {xdr}", async () => {
    const good = await mergeFuncAuth();
    for (const body of [null, 1, "x", {}, { func: good.func }, { ...good, xdr: envelope() }, { ...good, skipWait: true }, { xdr: 5 }]) {
      expect(codeOf(body)).toBe("bad_shape");
    }
  });

  it("refuses base64 that is not canonical, and XDR with trailing bytes", async () => {
    const good = await mergeFuncAuth();
    expect(codeOf({ ...good, func: good.func + "\n" })).toBe("bad_encoding");
    expect(codeOf({ ...good, func: " " + good.func })).toBe("bad_encoding");
    expect(codeOf({ ...good, func: "AAAA$$$$" })).toBe("bad_encoding");
    const trailing = Buffer.concat([Buffer.from(good.func, "base64"), Buffer.alloc(4)]).toString("base64");
    expect(codeOf({ ...good, func: trailing })).toBe("bad_encoding");
    expect(codeOf({ ...good, auth: ["AAAA"] })).toBe("bad_encoding");
    expect(codeOf({ xdr: envelope().slice(0, -4) })).toBe("bad_encoding");
  });
});

describe("validateSponsorRequest: func + auth (passkey workers)", () => {
  it("accepts a token merge signed by a classic account for testnet", async () => {
    const good = await mergeFuncAuth();
    const v = validateSponsorRequest(good, cfg);
    expect(v).toMatchObject({ ok: true, kind: "func", rootContract: TOKEN, func: good.func, auth: good.auth });
  });

  it("accepts a passkey wallet entry and V2 credentials, whose signatures only simulation can judge", async () => {
    expect(codeOf({ func: mergeFunc(), auth: [b64(contractAccountEntry(merge))] })).toBe("ok");
    expect(codeOf({ func: mergeFunc(), auth: [b64(await signedEntry(merge, worker, { v2: true }))] })).toBe("ok");
  });

  it("accepts a tree that reaches only payroll, token, auditor and USDC", async () => {
    const func = b64(hostCall(PAYROLL, "accept_invite", [addr(worker.publicKey())]));
    const tree: Call = { contract: PAYROLL, fn: "accept_invite", sub: [depositTree()] };
    expect(codeOf({ func, auth: [b64(await signedEntry(tree))] })).toBe("ok");
  });

  it("refuses a root call into a third-party contract", async () => {
    const func = b64(hostCall(STRANGER, "merge", [addr(worker.publicKey())]));
    expect(codeOf({ func, auth: [b64(await signedEntry({ contract: STRANGER, fn: "merge" }))] })).toBe("root_contract_not_allowed");
  });

  it("refuses a nested call into a contract that is not ours, at any depth", async () => {
    const deep = depositTree([{ contract: TOKEN, fn: "noop", sub: [{ contract: STRANGER, fn: "drain" }] }]);
    expect(codeOf({ func: mergeFunc(), auth: [b64(await signedEntry(deep))] })).toBe("nested_contract_not_allowed");
    expect(codeOf({ func: mergeFunc(), auth: [b64(await signedEntry({ contract: STRANGER, fn: "x" }))] })).toBe(
      "nested_contract_not_allowed",
    );
  });

  it("refuses a wasm upload and a contract creation as the host function", () => {
    const upload = uploadOperation().body().invokeHostFunctionOp().hostFunction();
    const create = createContractOperation().body().invokeHostFunctionOp().hostFunction();
    expect(codeOf({ func: b64(upload), auth: [b64(contractAccountEntry(merge))] })).toBe("wasm_upload");
    expect(codeOf({ func: b64(create), auth: [b64(contractAccountEntry(merge))] })).toBe("contract_creation");
  });

  it("refuses a contract creation hidden inside an auth tree", async () => {
    expect(codeOf({ func: mergeFunc(), auth: [b64(await signedEntry(createContractInvocation()))] })).toBe("contract_creation");
  });

  it("refuses an entry signed for mainnet", async () => {
    const mainnet = await signedEntry(merge, worker, { network: Networks.PUBLIC });
    expect(codeOf({ func: mergeFunc(), auth: [b64(mainnet)] })).toBe("not_signed_for_testnet");
  });

  it("refuses a classic entry signed by a key that is not the account's own, which the signed payload alone cannot tell apart", async () => {
    for (const v2 of [false, true]) {
      const borrowed = await signedEntry(merge, employer, { v2 });
      expect(codeOf({ func: mergeFunc(), auth: [b64(borrowed)] })).toBe("ok");
      const credentials = v2 ? borrowed.credentials().addressV2() : borrowed.credentials().address();
      credentials.address(new Address(worker.publicKey()).toScAddress());
      expect(codeOf({ func: mergeFunc(), auth: [b64(borrowed)] }), v2 ? "v2" : "v1").toBe("signer_key_mismatch");
    }
  });

  it("names every authorising address once, in the one address spelling", async () => {
    const auth = [b64(await signedEntry(merge)), b64(contractAccountEntry(merge)), b64(await signedEntry(merge))];
    const v = validateSponsorRequest({ func: mergeFunc(), auth }, cfg);
    expect(v).toMatchObject({ ok: true, authorisers: [worker.publicKey(), passkeyWallet] });
    if (!v.ok) throw new Error(v.code);
    for (const address of v.authorisers) expect(canonicalAccountId(address)).toBe(address);
  });

  it("refuses unsigned classic entries, source-account entries and empty auth", () => {
    const unsigned = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(worker.rawPublicKey())),
          nonce: xdr.Int64.fromString("1"),
          signatureExpirationLedger: LATEST_LEDGER + 10,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: invocation(merge),
    });
    expect(codeOf({ func: mergeFunc(), auth: [b64(unsigned)] })).toBe("unsigned_auth");
    expect(codeOf({ func: mergeFunc(), auth: [b64(sourceAccountEntry(merge))] })).toBe("source_account_auth");
    expect(codeOf({ func: mergeFunc(), auth: [] })).toBe("no_auth");
  });

  it("walks delegate signers too, and counts them against the tree budget", () => {
    const withDelegates = (delegateCount: number) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
          new xdr.SorobanAddressCredentialsWithDelegates({
            addressCredentials: contractAccountEntry(merge).credentials().addressV2(),
            delegates: Array.from({ length: delegateCount }, (_, i) => new xdr.SorobanDelegateSignature({
              address: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32, i + 1) as unknown as xdr.ContractId),
              signature: xdr.ScVal.scvVoid(),
              nestedDelegates: [],
            })),
          }),
        ),
        rootInvocation: invocation(merge),
      });
    expect(codeOf({ func: mergeFunc(), auth: [b64(withDelegates(2))] })).toBe("ok");
    expect(codeOf({ func: mergeFunc(), auth: [b64(withDelegates(MAX_AUTH_NODES))] })).toBe("auth_tree_too_large");
  });

  it("bounds the number of entries and the size of the trees", () => {
    const one = b64(contractAccountEntry(merge));
    expect(codeOf({ func: mergeFunc(), auth: Array(MAX_AUTH_ENTRIES + 1).fill(one) })).toBe("too_many_auth_entries");
    const wide: Call = { ...merge, sub: Array.from({ length: MAX_AUTH_NODES }, () => ({ contract: TOKEN, fn: "noop" })) };
    expect(codeOf({ func: mergeFunc(), auth: [b64(contractAccountEntry(wide))] })).toBe("auth_tree_too_large");
  });
});

describe("validateSponsorRequest: signed transaction envelope", () => {
  it("accepts a signed testnet token call and reports its declared fees", () => {
    // The declared fee is the transaction total: inclusion fee plus resource fee.
    const v = validateSponsorRequest({ xdr: envelope() }, cfg);
    expect(v).toMatchObject({ ok: true, kind: "xdr", rootContract: TOKEN, declaredFee: 1_100_000n, declaredResourceFee: 500_000n });
  });

  it("refuses a classic payment", () => {
    expect(codeOf({ xdr: envelope({ operations: [paymentOperation()], soroban: false }) })).toBe("not_invoke_host_function");
  });

  it("refuses a wasm upload, a contract creation and a third-party root call", () => {
    expect(codeOf({ xdr: envelope({ operations: [uploadOperation()] }) })).toBe("wasm_upload");
    expect(codeOf({ xdr: envelope({ operations: [createContractOperation()] }) })).toBe("contract_creation");
    expect(codeOf({ xdr: envelope({ operations: [thirdPartyOperation()] }) })).toBe("root_contract_not_allowed");
  });

  it("refuses more than one operation, a fee bump, and a missing soroban footprint", () => {
    expect(codeOf({ xdr: envelope({ operations: [mergeOperation(), mergeOperation()] }) })).toBe("not_one_operation");
    const inner = TransactionBuilder.fromXDR(envelope(), Networks.TESTNET) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(worker, "700000", inner, Networks.TESTNET);
    bump.sign(worker);
    expect(codeOf({ xdr: bump.toXDR() })).toBe("envelope_not_accepted");
    expect(codeOf({ xdr: envelope({ soroban: false }) })).toBe("missing_soroban_data");
  });

  it("refuses a transaction signed for mainnet, or not signed by its source", () => {
    expect(codeOf({ xdr: envelope({ network: Networks.PUBLIC }) })).toBe("not_signed_for_testnet");
    expect(codeOf({ xdr: envelope({ signer: null }) })).toBe("not_signed_for_testnet");
  });

  it("refuses a declared fee or resource fee over the cap", () => {
    expect(codeOf({ xdr: envelope({ fee: "1500001", resourceFee: 500_000 }) })).toBe("fee_over_cap");
    expect(codeOf({ xdr: envelope({ fee: "100", resourceFee: 2_000_001 }) })).toBe("fee_over_cap");
    expect(codeOf({ xdr: envelope({ fee: "100", resourceFee: 1_999_900 }) })).toBe("ok");
  });

  it("applies the auth-tree rule to the operation's own auth entries", async () => {
    const nested = await signedEntry(depositTree([{ contract: STRANGER, fn: "drain" }]));
    const op = (auth: xdr.SorobanAuthorizationEntry[]) => [
      xdr.Operation.fromXDR(mergeOperation().toXDR()),
    ].map((o) => {
      o.body().invokeHostFunctionOp().auth(auth);
      return o;
    });
    expect(codeOf({ xdr: envelope({ operations: op([nested]) }) })).toBe("nested_contract_not_allowed");
    expect(codeOf({ xdr: envelope({ operations: op([sourceAccountEntry(merge)]) }) })).toBe("ok");
  });

  it("names the source and every entry's address as authorisers, each once", async () => {
    const op = xdr.Operation.fromXDR(mergeOperation().toXDR());
    op.body().invokeHostFunctionOp().auth([sourceAccountEntry(merge), await signedEntry(merge, employer), await signedEntry(merge, worker)]);
    expect(validateSponsorRequest({ xdr: envelope({ operations: [op] }) }, cfg)).toMatchObject({
      ok: true,
      authorisers: [worker.publicKey(), employer.publicKey()],
    });
  });
});

describe("simulate", () => {
  const funcRequest = async (validUntil = LATEST_LEDGER + 100, extra: xdr.SorobanAuthorizationEntry[] = []) => {
    const entry = await signedEntry(merge, worker, { validUntil });
    const v = validateSponsorRequest({ func: mergeFunc(), auth: [b64(entry), ...extra.map(b64)] }, cfg);
    if (!v.ok) throw new Error(v.code);
    return v;
  };

  it("simulates the exact call twice: enforce with the auth entries, record without, both from a source nobody can sign for", async () => {
    const request = await funcRequest();
    const rpc = fakeSimulation();
    expect(await simulate(cfg, request, rpc)).toEqual({
      ok: true,
      chargeStroops: 490_000n + INCLUSION_FEE_ALLOWANCE_STROOPS,
      minResourceFee: 490_000n,
      latestLedger: LATEST_LEDGER,
    });
    const [[enforceTx, enforceMode], [recordTx, recordMode]] = rpc.simulateTransaction.mock.calls as unknown as [[string, string], [string, string]];
    expect([enforceMode, recordMode]).toEqual(["enforce", "record"]);
    const opOf = (tx: string) => new Transaction(tx, Networks.TESTNET).toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp();
    expect(new Transaction(enforceTx, Networks.TESTNET).source).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
    const func = (request as Extract<SponsorRequest, { kind: "func" }>).func;
    expect(b64(opOf(enforceTx).hostFunction())).toBe(func);
    expect(opOf(enforceTx).auth().map(b64)).toEqual((request as Extract<SponsorRequest, { kind: "func" }>).auth);
    expect(b64(opOf(recordTx).hostFunction())).toBe(func);
    expect(opOf(recordTx).auth()).toEqual([]);
  });

  it("refuses a failed simulation in either mode, a needed restore and an unreachable RPC", async () => {
    const request = await funcRequest();
    expect(await simulate(cfg, request, fakeSimulation({ enforce: { error: "HostError: Error(Auth, InvalidAction)" } }))).toEqual({
      ok: false,
      code: "simulation_failed",
    });
    expect(await simulate(cfg, request, fakeSimulation({ enforce: { results: [] } }))).toMatchObject({ code: "simulation_failed" });
    expect(await simulate(cfg, request, fakeSimulation({ enforce: { transactionData: "AAAA" } }))).toMatchObject({ code: "simulation_failed" });
    expect(await simulate(cfg, request, fakeSimulation({ record: { error: "HostError" } }))).toMatchObject({ code: "simulation_failed" });
    expect(await simulate(cfg, request, fakeSimulation({ requiredAuth: () => ["AAAA"] }))).toMatchObject({ code: "simulation_failed" });
    expect(await simulate(cfg, request, fakeSimulation({ enforce: { restorePreamble: { minResourceFee: "1" } } }))).toMatchObject({
      code: "simulation_needs_restore",
    });
    expect(await simulate(cfg, request, fakeSimulation({ fail: "enforce" }))).toMatchObject({ code: "rpc_unavailable" });
    expect(await simulate(cfg, request, fakeSimulation({ fail: "record" }))).toMatchObject({ code: "rpc_unavailable" });
  });

  it("refuses a read-only call: no read-write entry in the simulated footprint", async () => {
    expect(await simulate(cfg, await funcRequest(), fakeSimulation({ readWrite: 0 }))).toEqual({ ok: false, code: "read_only_call" });
  });

  describe("the live 27,596 stroop case (testnet replies captured on 7 Oct 2026)", () => {
    const live = JSON.parse(readFileSync(new URL("./live-read-only-call.json", import.meta.url), "utf8"));
    const liveCfg = testConfig({ TOKEN_CONTRACT_ID: live.token });
    // The wasm the captured footprint names for the spike token.
    const liveTokenWasm = "c77ac818ab3af1a2b9cdbc54964d68070f106fb72c9172ba4fff186995704cfd";
    // Replays the captured JSON-RPC results through the real client, so the
    // reply schema is exercised on the real shapes too.
    const liveRpc = (record = live.record, enforce = live.enforce) =>
      createRpcClient(liveCfg, async (_url, init) => {
        const { id, method, params } = JSON.parse(String(init?.body));
        const result =
          method === "getLedgerEntries"
            ? { entries: instanceEntries(params.keys, (c) => (c === live.token ? liveTokenWasm : fakeCode(c))), latestLedger: enforce.latestLedger }
            : params.authMode === "record"
              ? record
              : enforce;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });

    it("was a signed, structurally valid request that would have cost 17,596 + 10,000 stroops", () => {
      expect(validateSponsorRequest(live.request, liveCfg)).toMatchObject({ ok: true, kind: "func" });
      expect(BigInt(live.enforce.minResourceFee) + INCLUSION_FEE_ALLOWANCE_STROOPS).toBe(27_596n);
    });

    it("is refused as read_only_call: its footprint writes nothing", async () => {
      const request = validateSponsorRequest(live.request, liveCfg);
      if (!request.ok) throw new Error(request.code);
      expect(await simulate(liveCfg, request, liveRpc())).toEqual({ ok: false, code: "read_only_call" });
    });

    it("is refused as unused_auth even if its footprint did write: record mode says the call needs no auth", async () => {
      const request = validateSponsorRequest(live.request, liveCfg);
      if (!request.ok) throw new Error(request.code);
      expect(live.record.results[0].auth).toEqual([]);
      // The captured footprint, with the token's balance entry moved to read-write.
      const captured = xdr.SorobanTransactionData.fromXDR(live.enforce.transactionData, "base64").resources().footprint();
      const writes = transactionData({ readOnly: captured.readOnly().slice(1), readWrite: captured.readOnly().slice(0, 1) });
      const writing = { ...live.enforce, transactionData: writes };
      expect(await simulate(liveCfg, request, liveRpc(live.record, writing))).toEqual({ ok: false, code: "unused_auth" });
    });
  });

  it("refuses unused_auth when a supplied entry is not needed, or a needed one is missing", async () => {
    const extra = await signedEntry({ contract: TOKEN, fn: "merge", args: [addr(employer.publicKey())] }, employer);
    expect(await simulate(cfg, await funcRequest(LATEST_LEDGER + 100, [extra]), fakeSimulation())).toEqual({
      ok: false,
      code: "unused_auth",
    });
    const needsEmployerToo = (tx: string) => [...recordedAuthOf(tx), b64(extra)];
    expect(await simulate(cfg, await funcRequest(), fakeSimulation({ requiredAuth: needsEmployerToo }))).toMatchObject({
      code: "unused_auth",
    });
    const otherCall = () => [b64(sourceAccountEntry({ contract: TOKEN, fn: "withdraw", args: [addr(worker.publicKey())] }))];
    expect(await simulate(cfg, await funcRequest(), fakeSimulation({ requiredAuth: otherCall }))).toMatchObject({ code: "unused_auth" });
  });

  it("matches an envelope's source-account entry, or an address entry for the source, to what record mode needs", async () => {
    const footprint = defaultFootprint();
    const withSource = validateSponsorRequest({ xdr: envelope({ footprint }) }, cfg);
    if (!withSource.ok) throw new Error(withSource.code);
    expect(await simulate(cfg, withSource, fakeSimulation())).toMatchObject({ ok: true });
    const signed = await signedEntry(merge, worker);
    const op = xdr.Operation.fromXDR(mergeOperation().toXDR());
    op.body().invokeHostFunctionOp().auth([signed]);
    const withAddress = validateSponsorRequest({ xdr: envelope({ operations: [op], footprint }) }, cfg);
    if (!withAddress.ok) throw new Error(withAddress.code);
    expect(await simulate(cfg, withAddress, fakeSimulation())).toMatchObject({ ok: true });
    const bare = xdr.Operation.fromXDR(mergeOperation().toXDR());
    bare.body().invokeHostFunctionOp().auth([]);
    const missing = validateSponsorRequest({ xdr: envelope({ operations: [bare], footprint }) }, cfg);
    if (!missing.ok) throw new Error(missing.code);
    expect(await simulate(cfg, missing, fakeSimulation())).toMatchObject({ code: "unused_auth" });
  });

  it("refuses a simulated fee over the cap", async () => {
    expect(await simulate(cfg, await funcRequest(), fakeSimulation({ enforce: { minResourceFee: "1995000" } }))).toMatchObject({
      code: "fee_over_cap",
    });
  });

  it("refuses expired entries and entries that live more than 1,000 ledgers", async () => {
    expect(await simulate(cfg, await funcRequest(LATEST_LEDGER), fakeSimulation())).toMatchObject({ code: "auth_expired" });
    expect(await simulate(cfg, await funcRequest(LATEST_LEDGER + 1_001), fakeSimulation())).toMatchObject({
      code: "auth_expiry_too_far",
    });
    expect(await simulate(cfg, await funcRequest(LATEST_LEDGER + 1_000), fakeSimulation())).toMatchObject({ ok: true });
  });

  it("refuses an envelope whose declared footprint leaves out a key the call reads or writes, or declares a written key read-only", async () => {
    const sim = defaultFootprint();
    const check = async (declared: Footprint) => {
      const v = validateSponsorRequest({ xdr: envelope({ footprint: declared }) }, cfg);
      if (!v.ok) throw new Error(v.code);
      return simulate(cfg, v, fakeSimulation());
    };
    const temporaryTwin = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({ contract: new Address(TOKEN).toScAddress(), key: xdr.ScVal.scvU32(100), durability: xdr.ContractDataDurability.temporary() }),
    );
    expect(await check({ readOnly: [], readWrite: sim.readWrite })).toEqual({ ok: false, code: "footprint_not_declared" });
    expect(await check({ readOnly: [temporaryTwin], readWrite: sim.readWrite })).toEqual({ ok: false, code: "footprint_not_declared" });
    expect(await check({ readOnly: sim.readOnly, readWrite: [] })).toEqual({ ok: false, code: "footprint_not_declared" });
    expect(await check({ readOnly: [...sim.readOnly, ...sim.readWrite], readWrite: [] })).toEqual({ ok: false, code: "footprint_not_declared" });
    expect(await check({ readOnly: [], readWrite: [...sim.readOnly, ...sim.readWrite] })).toMatchObject({ ok: true });
    expect(await check({ readOnly: [...sim.readOnly, storageKey(TOKEN, 7)], readWrite: sim.readWrite })).toMatchObject({ ok: true });
  });

  it("refuses an envelope that declares fewer instructions, disk read bytes or write bytes than the simulation used, or less than its minimum resource fee", async () => {
    const used: Limits = { instructions: 1_000_000, diskReadBytes: 5_000, writeBytes: 1_000 };
    const check = async (limits: Limits, resourceFee = 500_000) => {
      const v = validateSponsorRequest({ xdr: envelope({ footprint: defaultFootprint(), limits, resourceFee }) }, cfg);
      if (!v.ok) throw new Error(v.code);
      return simulate(cfg, v, fakeSimulation({ limits: used }));
    };
    for (const short of [
      { ...used, instructions: used.instructions - 1 },
      { ...used, diskReadBytes: used.diskReadBytes - 1 },
      { ...used, writeBytes: used.writeBytes - 1 },
    ]) {
      expect(await check(short), JSON.stringify(short)).toEqual({ ok: false, code: "resources_not_declared" });
    }
    expect(await check(used, 489_999)).toEqual({ ok: false, code: "resources_not_declared" });
    expect(await check(used, 490_000)).toMatchObject({ ok: true });
    expect(await check({ instructions: 2_000_000, diskReadBytes: 6_000, writeBytes: 2_000 })).toMatchObject({ ok: true });
  });

  it("reserves the declared fee of an envelope when it is above the simulated estimate", async () => {
    const v = validateSponsorRequest({ xdr: envelope({ fee: "800000", footprint: defaultFootprint() }) }, cfg);
    if (!v.ok) throw new Error(v.code);
    const rpc = fakeSimulation({ enforce: { minResourceFee: "100000" } });
    expect(await simulate(cfg, v, rpc)).toMatchObject({ ok: true, chargeStroops: 1_300_000n });
    expect(rpc.simulateTransaction.mock.calls[0]![0]).toBe(v.kind === "xdr" ? v.xdr : "");
  });
});

describe("simulate: the sponsor pays only for our code, USDC's, or a pinned passkey wallet's (C20)", () => {
  const walletCall = (wallet: string): Call => ({ contract: TOKEN, fn: "merge", args: [addr(wallet)] });
  const walletMerge = (wallet = passkeyWallet, entry = contractAccountEntry(walletCall(wallet), undefined, wallet)) => {
    const v = validateSponsorRequest({ func: b64(hostCall(TOKEN, "merge", [addr(wallet)])), auth: [b64(entry)] }, cfg);
    if (!v.ok) throw new Error(v.code);
    return v;
  };
  const classicMerge = async () => {
    const v = validateSponsorRequest(await mergeFuncAuth(), cfg);
    if (!v.ok) throw new Error(v.code);
    return v;
  };
  const tokenCode = fakeCode(TOKEN)!;
  const ours = [PAYROLL, TOKEN, AUDITOR, VERIFIER].flatMap((c) => [instanceKey(c), codeKey(fakeCode(c)!)]);

  it("accepts a passkey wallet that runs the pinned wallet code, with the live M1b merge's footprint, from one code read", async () => {
    const rpc = fakeSimulation({ footprint: passkeyMergeFootprint() });
    expect(await simulate(cfg, walletMerge(), rpc)).toMatchObject({ ok: true });
    expect(rpc.getLedgerEntries).toHaveBeenCalledTimes(1);
    const asked = rpc.getLedgerEntries.mock.calls[0]![0].map(contractOfKey);
    expect([...asked].sort()).toEqual([PAYROLL, TOKEN, AUDITOR, VERIFIER, passkeyWallet].sort());
  });

  it("refuses unknown_wallet_code for a C authorizer whose instance runs another wasm, before any simulation", async () => {
    const rpc = fakeSimulation({ footprint: passkeyMergeFootprint() });
    expect(await simulate(cfg, walletMerge(contractFor("self-deployed wallet")), rpc)).toEqual({ ok: false, code: "unknown_wallet_code" });
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("refuses unknown_wallet_code for a wallet with no instance, an upgraded wallet, an asset contract, or a delegate on other code", async () => {
    const swap = (to: string | null) => fakeSimulation({ code: (c) => (c === passkeyWallet ? to : fakeCode(c)) });
    expect(await simulate(cfg, walletMerge(), swap(null))).toMatchObject({ code: "unknown_wallet_code" });
    expect(await simulate(cfg, walletMerge(), swap("ab".repeat(32)))).toMatchObject({ code: "unknown_wallet_code" });
    expect(await simulate(cfg, walletMerge(USDC), fakeSimulation())).toMatchObject({ code: "unknown_wallet_code" });

    const plain = contractAccountEntry(walletCall(passkeyWallet));
    const delegated = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: plain.credentials().addressV2(),
          delegates: [
            new xdr.SorobanDelegateSignature({
              address: new Address(contractFor("delegate")).toScAddress(),
              signature: xdr.ScVal.scvVoid(),
              nestedDelegates: [],
            }),
          ],
        }),
      ),
      rootInvocation: plain.rootInvocation(),
    });
    const rpc = fakeSimulation({ footprint: passkeyMergeFootprint() });
    expect(await simulate(cfg, walletMerge(passkeyWallet, delegated), rpc)).toMatchObject({ code: "unknown_wallet_code" });
  });

  it("refuses foreign_contract_in_footprint when a pinned wallet's __check_auth touches a third-party contract", async () => {
    const reads = passkeyMergeFootprint();
    reads.readOnly.push(instanceKey(STRANGER), codeKey(fakeCode(STRANGER)!));
    expect(await simulate(cfg, walletMerge(), fakeSimulation({ footprint: reads }))).toEqual({
      ok: false,
      code: "foreign_contract_in_footprint",
    });
    const writes = passkeyMergeFootprint();
    writes.readWrite.push(storageKey(STRANGER));
    expect(await simulate(cfg, walletMerge(), fakeSimulation({ footprint: writes }))).toMatchObject({ code: "foreign_contract_in_footprint" });
  });

  it("allows the storage and code of payroll, token, auditor, verifier and USDC, and refuses any other code, the wallet code included when no wallet signed", async () => {
    const withCode = (wasm: string) =>
      fakeSimulation({ footprint: { readOnly: [...ours, instanceKey(USDC), storageKey(USDC), codeKey(wasm)], readWrite: [storageKey(TOKEN)] } });
    expect(await simulate(cfg, await classicMerge(), withCode(tokenCode))).toMatchObject({ ok: true });
    expect(await simulate(cfg, await classicMerge(), withCode("cd".repeat(32)))).toMatchObject({ code: "foreign_contract_in_footprint" });
    expect(await simulate(cfg, await classicMerge(), withCode(PINNED_WALLET_WASM))).toMatchObject({ code: "foreign_contract_in_footprint" });
  });

  it("lets through a classic signer's own nonce and the accounts USDC moves, and nothing else under a classic account", async () => {
    const request = await classicMerge();
    const withWrites = (extra: xdr.LedgerKey[]) =>
      fakeSimulation({
        footprint: {
          readOnly: [instanceKey(TOKEN), codeKey(tokenCode), instanceKey(USDC), accountKey(employer.publicKey())],
          readWrite: [storageKey(TOKEN), accountKey(worker.publicKey()), ...extra],
        },
      });
    expect(await simulate(cfg, request, withWrites([nonceKey(worker.publicKey())]))).toMatchObject({ ok: true });
    expect(await simulate(cfg, request, withWrites([nonceKey(employer.publicKey())]))).toMatchObject({ code: "foreign_contract_in_footprint" });
    expect(await simulate(cfg, request, withWrites([storageKey(worker.publicKey())]))).toMatchObject({ code: "foreign_contract_in_footprint" });
  });

  it("applies the same rule to the footprint an envelope declares", async () => {
    const declared = envelope({ footprint: { readOnly: [instanceKey(TOKEN), instanceKey(STRANGER)], readWrite: [storageKey(TOKEN)] } });
    const v = validateSponsorRequest({ xdr: declared }, cfg);
    if (!v.ok) throw new Error(v.code);
    expect(await simulate(cfg, v, fakeSimulation())).toEqual({ ok: false, code: "foreign_contract_in_footprint" });
  });

  it("fails closed, simulating nothing, when the code read fails, garbles an entry, answers twice or answers for a contract nobody asked about", async () => {
    expect(await simulate(cfg, walletMerge(), fakeSimulation({ fail: "ledger_entries" }))).toEqual({ ok: false, code: "rpc_unavailable" });
    const answer = (extra: (keys: readonly string[]) => { key: string; xdr: string }[]) => {
      const rpc = fakeSimulation({ footprint: passkeyMergeFootprint() });
      rpc.getLedgerEntries.mockImplementationOnce(async (keys) => ({
        entries: [...instanceEntries(keys, (c) => (c === passkeyWallet ? null : fakeCode(c))), ...extra(keys)],
        latestLedger: LATEST_LEDGER,
      }));
      return rpc;
    };
    const walletKeys = (keys: readonly string[]) => keys.filter((k) => contractOfKey(k) === passkeyWallet);
    const replies = [
      answer((keys) => [
        ...instanceEntries(walletKeys(keys), () => PINNED_WALLET_WASM),
        ...instanceEntries(walletKeys(keys), () => "ef".repeat(32)),
      ]),
      answer((keys) => walletKeys(keys).map((key) => ({ key, xdr: "AAAA" }))),
      answer(() => instanceEntries([b64(instanceKey(STRANGER))], () => PINNED_WALLET_WASM)),
    ];
    for (const rpc of replies) {
      expect(await simulate(cfg, walletMerge(), rpc)).toEqual({ ok: false, code: "rpc_unavailable" });
      expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    }
  });
});

describe("authExpiryLedger", () => {
  it("is the earliest expiry among the entries, and null when only the source authorises", async () => {
    const at = (a: number, b: number) =>
      validateSponsorRequest({ func: mergeFunc(), auth: [b64(contractAccountEntry(merge, a)), b64(contractAccountEntry(merge, b))] }, cfg);
    for (const v of [at(LATEST_LEDGER + 300, LATEST_LEDGER + 200), at(LATEST_LEDGER + 200, LATEST_LEDGER + 300)]) {
      if (!v.ok) throw new Error(v.code);
      expect(authExpiryLedger(v)).toBe(LATEST_LEDGER + 200);
    }
    const source = validateSponsorRequest({ xdr: envelope() }, cfg);
    if (!source.ok) throw new Error(source.code);
    expect(authExpiryLedger(source)).toBeNull();
  });
});

describe("requestDigest", () => {
  it("is the same for the same bytes and differs when any forwarded byte differs", async () => {
    const good = await mergeFuncAuth();
    const digestOf = (body: unknown) => {
      const v = validateSponsorRequest(body, cfg);
      if (!v.ok) throw new Error(v.code);
      return requestDigest(v);
    };
    expect(digestOf(good)).toBe(digestOf(JSON.parse(JSON.stringify(good))));
    expect(digestOf(good)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(await mergeFuncAuth())).not.toBe(digestOf(good));
    const xdrBody = { xdr: envelope() };
    expect(digestOf(xdrBody)).toBe(digestOf({ xdr: xdrBody.xdr }));
    expect(digestOf(xdrBody)).not.toBe(digestOf(good));
  });
});
