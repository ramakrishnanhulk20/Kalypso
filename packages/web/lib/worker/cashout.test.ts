// Covers moving pay to the cash-out account: "Moved" comes only from a chain read showing the
// balance the withdraw proof left (C55), so a relayer that names an unrelated successful hash ends
// in WITHDRAW_NOT_CONFIRMED. When the sponsor refuses, the worker pays the fee themselves: a passkey
// worker's cash-out account is the source and fee payer while the passkey still signs the wallet's
// approval, the merge included; a wallet worker's own account signs and pays. A relay that went
// quiet is read on chain first, and a retry is built on the same balance, so pay never moves twice.
// Does NOT cover: real proofs or the token contract (a fake prover and a fake chain stand in, and
// core's balance reads are stubbed), the cash-out account's setup, or the anchor (anchor.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, SorobanDataBuilder, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import * as core from "@kalypso/core";
import type { KalypsoKeys, Opening, SimResult } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { withdraw } from "./cashout";
import { workerConfig } from "./config";
import { H, commit, scalarMul } from "./sdk";
import { openSession, type WorkerRuntime, type WorkerSession } from "./session";
import { SponsorError, type SponsorBody, type SponsorErrorCode, type SponsorPort } from "./sponsor";

vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  confidentialBalance: vi.fn(),
  loadWorkerBalance: vi.fn(),
  getAuditorKey: vi.fn(),
  buildWorkerWithdraw: vi.fn(),
  buildWorkerMerge: vi.fn(),
}));
vi.mock("./payslips", () => ({ historyStart: async () => 1, historyFrom: () => ({}) }));

const config = workerConfig();
const HASH = "ab".repeat(32);
const OTHER_HASH = "cd".repeat(32);
const WALLET = "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL";
const KEYS = { PVK: scalarMul(5n, H) } as unknown as KalypsoKeys;
const AMOUNT = 20_000_000n;
const randomScalar = () => BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`);
const opening = (v: bigint, r: bigint): Opening => ({ v, r, commitment: commit(v, r) });

/** The contract call an envelope or sponsor body carries: merge or withdraw. */
function callName(source: SponsorBody | string): string {
  let func: xdr.HostFunction;
  if (typeof source !== "string" && "func" in source) func = xdr.HostFunction.fromXDR(source.func, "base64");
  else {
    const tx = TransactionBuilder.fromXDR(typeof source === "string" ? source : source.xdr, config.networkPassphrase) as Transaction;
    func = (tx.operations[0] as { func: xdr.HostFunction }).func;
  }
  return func.invokeContract().functionName().toString();
}

function walletEntry(address: string): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(address).toScAddress(), nonce: new xdr.Int64(42), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(config.contracts.token).toScAddress(), functionName: "withdraw", args: [] }),
      ),
      subInvocations: [],
    }),
  }).toXDR("base64");
}

interface Setup {
  kind?: "passkey" | "wallet";
  /** The worker's openings at the start; spendable defaults to 5 USDC and receiving to nothing. */
  spendable?: bigint;
  receiving?: bigint;
  /** The XLM the fee payer holds, as Horizon writes it. */
  xlm?: string;
  /** What RPC says about a hash, by default SUCCESS. */
  final?: (hash: string) => "SUCCESS" | "FAILED";
  /** Runs when an envelope is submitted directly, before RPC is asked about it; by default the call lands. */
  onSubmit?: (name: string, land: (name: string, proof?: { next: Opening }) => void) => void;
}

/** A fake chain holding the worker's commitments, a fake prover, and RPC and Horizon answers. */
function setup(opts: Setup = {}) {
  const openings = { spendable: opening(opts.spendable ?? 50_000_000n, 777n), receiving: opening(opts.receiving ?? 0n, 0n) };
  const proofs: { v: bigint; r: bigint; next: Opening }[] = [];
  const submitted: string[] = [];
  const cash = Keypair.random();
  const own = Keypair.random();
  const signedEntries: string[] = [];

  /** The chain applying a call that landed: a merge folds incoming pay in, a withdraw leaves its proof's balance. */
  const land = (name: string, proof: { next: Opening } | undefined = proofs.at(-1)) => {
    if (name === "merge") {
      openings.spendable = opening(openings.spendable.v + openings.receiving.v, openings.spendable.r + openings.receiving.r);
      openings.receiving = opening(0n, 0n);
    } else if (proof) openings.spendable = proof.next;
  };

  vi.mocked(core.confidentialBalance).mockImplementation(async () => ({
    auditorId: 1,
    spendable: openings.spendable.commitment,
    receiving: openings.receiving.commitment,
    pvk: KEYS.PVK,
  }));
  vi.mocked(core.loadWorkerBalance).mockImplementation(async () => ({ complete: true, spendable: openings.spendable, receiving: openings.receiving }) as never);
  vi.mocked(core.getAuditorKey).mockResolvedValue(H);

  const prover = {
    async proveWithdraw(p: { v: bigint; r: bigint; amount: bigint }) {
      const next = opening(p.v - p.amount, randomScalar());
      proofs.push({ v: p.v, r: p.r, next });
      return { payload: Uint8Array.of(1, 2, 3), next: { v: next.v, r: next.r, cSpend: next.commitment } };
    },
  };
  vi.mocked(core.buildWorkerWithdraw).mockImplementation(async (base, p) => {
    const proved = await prover.proveWithdraw({ v: p.spendable.v, r: p.spendable.r, amount: p.amount });
    return { xdr: core.buildWithdraw(base, { from: p.worker, to: p.to, amount: p.amount, data: { payload: proved.payload } }), next: opening(proved.next.v, proved.next.r) };
  });
  vi.mocked(core.buildWorkerMerge).mockImplementation(async (base, p) => core.buildMerge(base, { account: p.worker }));

  const data = new SorobanDataBuilder().setResources(2_000_000, 0, 500).setResourceFee(90_000).build().toXDR("base64");
  const answer = (address: string): SimResult => ({ ok: true, latestLedger: 500, minResourceFee: "90000", transactionDataXdr: data, authXdr: [walletEntry(address)], retvalXdr: xdr.ScVal.scvVoid().toXDR("base64") });

  const funded = { balances: [{ asset_type: "native", balance: opts.xlm ?? "10000.0000000", selling_liabilities: "0.0000000" }], subentry_count: 1, num_sponsoring: 0, num_sponsored: 0 };
  const rt = {
    config,
    storage: null,
    ledger: { classicAccount: async () => ({ exists: true, usdcTrustline: true }) },
    port: {
      simulate: async () => answer(worker.kind === "passkey" ? WALLET : own.publicKey()),
      sourceAccount: async () => ({ sequence: "4294967296" }),
      submit: async (signed: string) => {
        submitted.push(signed);
        if (opts.onSubmit) opts.onSubmit(callName(signed), land);
        else land(callName(signed));
        return { hash: core.transactionHash(signed, config.networkPassphrase) };
      },
      waitFor: async (hash: string) => ({ status: opts.final?.(hash) ?? "SUCCESS", ledger: 10 }),
    },
    prover: async () => prover,
    fetch: async (url: string) => {
      const path = new URL(url).pathname;
      const body = path === "/ledgers" ? { _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } } : funded;
      return new Response(JSON.stringify(body), { status: 200 });
    },
    sleep: async () => undefined,
    now: () => Date.now(),
    exclusive: <T>(_name: string, work: () => Promise<T>) => work(),
  } as unknown as WorkerRuntime;

  let worker: WorkerSession;
  if ((opts.kind ?? "passkey") === "passkey") {
    worker = openSession(
      { kind: "passkey", address: WALLET, cashOutAddress: cash.publicKey(), keys: KEYS, auditorId: 1 },
      {
        kind: "passkey",
        keyId: "a",
        publicKey: new Uint8Array(65),
        cashOutSeed: new Uint8Array(cash.rawSecretKey()),
        signEntry: async (entryXdr, expirationLedger) => {
          const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
          entry.credentials().address().signatureExpirationLedger(expirationLedger);
          entry.credentials().address().signature(xdr.ScVal.scvBytes(Buffer.from("passkey")));
          signedEntries.push(entry.toXDR("base64"));
          return entry.toXDR("base64");
        },
        deployFunc: null,
        proven: true,
        deployed: true,
      },
    );
  } else {
    const wallet: WalletPort = {
      kind: "throwaway",
      address: own.publicKey(),
      signMessage: async () => new Uint8Array(64),
      signTransaction: async (txXdr, passphrase) => {
        const tx = TransactionBuilder.fromXDR(txXdr, passphrase);
        tx.sign(own);
        return tx.toXDR();
      },
    };
    worker = openSession({ kind: "wallet", address: own.publicKey(), cashOutAddress: own.publicKey(), keys: KEYS, auditorId: 1 }, { kind: "wallet", wallet });
  }
  return { rt, worker, openings, proofs, submitted, cash, own, signedEntries, land };
}

/**
 * A sponsor stub. By default its relay lands the call; `refuse` throws that code instead (after
 * landing it anyway when `landAnyway` is set, as a relay that went quiet can), and `namedHash`
 * is the hash its status names.
 */
function stubSponsor(chain: ReturnType<typeof setup>, behaviour: { refuse?: SponsorErrorCode; landAnyway?: boolean; land?: boolean; namedHash?: string } = {}) {
  const sent: SponsorBody[] = [];
  const sponsor: SponsorPort = {
    async send(body) {
      sent.push(body);
      if (behaviour.refuse) {
        if (behaviour.landAnyway) chain.land(callName(body));
        throw new SponsorError(behaviour.refuse);
      }
      if (behaviour.land !== false) chain.land(callName(body));
      return { transactionId: "tx_1", status: "pending" };
    },
    status: async () => ({ status: "confirmed", hash: behaviour.namedHash ?? HASH }),
  };
  return { sponsor, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a withdraw through the sponsor", () => {
  it("reports the move only once the chain holds the balance its proof left", async () => {
    const chain = setup();
    const { sponsor, sent } = stubSponsor(chain);
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, sponsor)).resolves.toEqual({ hash: HASH, mergeHash: null, setup: [] });
    expect(sent).toHaveLength(1);
    expect(chain.openings.spendable.v).toBe(50_000_000n - AMOUNT);
  });

  it("refuses to confirm when the relayer names an unrelated successful hash and the balance never changed", async () => {
    const chain = setup();
    const { sponsor } = stubSponsor(chain, { land: false, namedHash: OTHER_HASH });
    const err = await withdraw(chain.rt, chain.worker, AMOUNT, sponsor).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "WITHDRAW_NOT_CONFIRMED", hash: OTHER_HASH });
    expect((err as Error).message).toBe("The network took the move, but your balance did not change as expected, so Kalypso cannot confirm it. Check your payslips in a minute before you try again.");
    expect(chain.openings.spendable.v).toBe(50_000_000n);
  });
});

describe("paying the fee yourself", () => {
  const name = (signed: string) => callName(signed);
  const parse = (signed: string) => new Transaction(signed, config.networkPassphrase);

  it("has a passkey worker's cash-out account pay and sign, while the passkey still approves the wallet's call", async () => {
    const chain = setup();
    const refusing = stubSponsor(chain, { refuse: "rate_limited" });
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, refusing.sponsor)).rejects.toMatchObject({ code: "rate_limited" });
    expect(chain.submitted).toEqual([]);

    const result = await withdraw(chain.rt, chain.worker, AMOUNT, refusing.sponsor, { payFee: "self" });
    expect(refusing.sent).toHaveLength(1);
    expect(chain.submitted).toHaveLength(1);
    const tx = parse(chain.submitted[0]!);
    expect(tx.source).toBe(chain.cash.publicKey());
    expect(tx.signatures).toHaveLength(1);
    expect(chain.cash.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
    const auth = (tx.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? [];
    expect(auth).toHaveLength(1);
    expect(Address.fromScAddress(auth[0]!.credentials().address().address()).toString()).toBe(WALLET);
    expect(auth[0]!.toXDR("base64")).toBe(chain.signedEntries.at(-1));
    expect(result.hash).toBe(core.transactionHash(chain.submitted[0]!, config.networkPassphrase));
    expect(chain.openings.spendable.v).toBe(50_000_000n - AMOUNT);
  });

  it("pays for the merge the same way when incoming pay has to move in first", async () => {
    const chain = setup({ spendable: 0n, receiving: 50_000_000n });
    const refusing = stubSponsor(chain, { refuse: "daily_budget_spent" });
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, refusing.sponsor)).rejects.toMatchObject({ code: "daily_budget_spent" });
    await withdraw(chain.rt, chain.worker, AMOUNT, refusing.sponsor, { payFee: "self" });
    expect(chain.submitted.map(name)).toEqual(["merge", "withdraw"]);
    expect(chain.submitted.map((signed) => parse(signed).source)).toEqual([chain.cash.publicKey(), chain.cash.publicKey()]);
    expect(chain.openings.spendable.v).toBe(50_000_000n - AMOUNT);
  });

  it("has a wallet worker's own account sign and pay, with the sponsor never asked", async () => {
    const chain = setup({ kind: "wallet" });
    const { sponsor, sent } = stubSponsor(chain);
    await withdraw(chain.rt, chain.worker, AMOUNT, sponsor, { payFee: "self" });
    expect(sent).toEqual([]);
    expect(chain.submitted).toHaveLength(1);
    const tx = parse(chain.submitted[0]!);
    expect(tx.source).toBe(chain.own.publicKey());
    expect(chain.own.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
    expect(chain.openings.spendable.v).toBe(50_000_000n - AMOUNT);
  });

  it("refuses before submitting when the fee payer cannot cover the fee", async () => {
    const chain = setup({ xlm: "1.0000000" });
    const { sponsor } = stubSponsor(chain);
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, sponsor, { payFee: "self" })).rejects.toMatchObject({ code: "CASHOUT_NO_XLM" });
    expect(chain.submitted).toEqual([]);
    expect(chain.openings.spendable.v).toBe(50_000_000n);
  });
});

describe("a relay that went quiet", () => {
  it("counts as moved when the chain shows it landed, with nothing sent again", async () => {
    const chain = setup();
    const quiet = stubSponsor(chain, { refuse: "timeout", landAnyway: true });
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, quiet.sponsor)).resolves.toEqual({ hash: null, mergeHash: null, setup: [] });
    expect(chain.submitted).toEqual([]);
    expect(chain.openings.spendable.v).toBe(50_000_000n - AMOUNT);
  });

  it("leaves paying yourself safe: the retry is proved on the same balance, so the first landing late makes it fail, not move pay twice", async () => {
    const box: { chain?: ReturnType<typeof setup> } = {};
    const chain = setup({ final: () => "FAILED", onSubmit: (_name, land) => land("withdraw", box.chain!.proofs[0]) });
    box.chain = chain;
    const quiet = stubSponsor(chain, { refuse: "relay_timeout" });
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, quiet.sponsor)).rejects.toMatchObject({ code: "relay_timeout" });
    const result = await withdraw(chain.rt, chain.worker, AMOUNT, quiet.sponsor, { payFee: "self" });
    expect(chain.proofs).toHaveLength(2);
    expect({ v: chain.proofs[1]!.v, r: chain.proofs[1]!.r }).toEqual({ v: chain.proofs[0]!.v, r: chain.proofs[0]!.r });
    expect(core.loadWorkerBalance).toHaveBeenCalledTimes(1);
    expect(chain.openings.spendable).toEqual(chain.proofs[0]!.next);
    expect(chain.openings.spendable.v).toBe(50_000_000n - AMOUNT);
    expect(result.hash).toBeNull();
  });

  it("reports the earlier move without sending again when it landed before the worker chose to pay", async () => {
    const chain = setup();
    const quiet = stubSponsor(chain, { refuse: "network" });
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, quiet.sponsor)).rejects.toMatchObject({ code: "network" });
    chain.land("withdraw", chain.proofs[0]);
    await expect(withdraw(chain.rt, chain.worker, AMOUNT, quiet.sponsor, { payFee: "self" })).resolves.toEqual({ hash: null, mergeHash: null, setup: [] });
    expect(chain.submitted).toEqual([]);
    expect(chain.proofs).toHaveLength(1);
  });
});
