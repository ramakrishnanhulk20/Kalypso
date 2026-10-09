// Covers a wallet worker's sponsored envelope: it declares the resources of the simulation that runs
// with its authorisation in place (the one the sponsor repeats and checks against), and it is
// refused when the wallet signs something else or signs too late for the relayer.
// Does NOT cover: the passkey path (passkey.test.ts and the live run), or the sponsor itself.
import { describe, expect, it } from "vitest";
import { Address, Keypair, Networks, SorobanDataBuilder, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { buildAcceptInvite, type KalypsoKeys, type SimResult } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import { workerConfig } from "./config";
import { prepareCall } from "./send";
import { openSession, type WorkerRuntime } from "./session";

const config = workerConfig();
const keypair = Keypair.random();

const dataXdr = (instructions: number, resourceFee: number) => new SorobanDataBuilder().setResources(instructions, 0, 500).setResourceFee(resourceFee).build().toXDR("base64");

const sourceAuth = new xdr.SorobanAuthorizationEntry({
  credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
  rootInvocation: new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: new Address(config.contracts.payroll).toScAddress(), functionName: "accept_invite", args: [] }),
    ),
    subInvocations: [],
  }),
}).toXDR("base64");

function setup(opts: { sign?: (txXdr: string) => string; now?: () => number } = {}) {
  const simulated: string[] = [];
  const signed: string[] = [];
  const answers: SimResult[] = [
    { ok: true, latestLedger: 100, minResourceFee: "500", transactionDataXdr: dataXdr(1_000_000, 500), authXdr: [sourceAuth], retvalXdr: xdr.ScVal.scvVoid().toXDR("base64") },
    { ok: true, latestLedger: 101, minResourceFee: "520", transactionDataXdr: dataXdr(1_007_615, 520), authXdr: [], retvalXdr: xdr.ScVal.scvVoid().toXDR("base64") },
  ];
  const rt = {
    config,
    now: opts.now ?? (() => Date.now()),
    port: {
      sourceAccount: async () => ({ sequence: "4294967296" }),
      simulate: async (txXdr: string) => {
        simulated.push(txXdr);
        return answers[simulated.length - 1]!;
      },
    },
  } as unknown as WorkerRuntime;
  const wallet: WalletPort = {
    kind: "throwaway",
    address: keypair.publicKey(),
    signMessage: async () => new Uint8Array(64),
    signTransaction: async (txXdr, passphrase) => {
      signed.push(txXdr);
      if (opts.sign) return opts.sign(txXdr);
      const tx = TransactionBuilder.fromXDR(txXdr, passphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
  const worker = openSession({ kind: "wallet", address: keypair.publicKey(), cashOutAddress: keypair.publicKey(), keys: {} as KalypsoKeys, auditorId: null }, { kind: "wallet", wallet });
  const call = { contractId: config.contracts.payroll, build: (base: Parameters<typeof buildAcceptInvite>[0]) => buildAcceptInvite(base, { companyId: 7n, worker: keypair.publicKey() }) };
  return { rt, worker, call, simulated, signed };
}

describe("a wallet worker's sponsored envelope", () => {
  it("declares the second simulation's limits and fee, the one run with its authorisation in place", async () => {
    const { rt, worker, call, simulated, signed } = setup();
    const body = await prepareCall(rt, worker, call);
    expect(simulated).toHaveLength(2);
    const second = new Transaction(simulated[1]!, Networks.TESTNET);
    expect(second.operations[0]).toMatchObject({ type: "invokeHostFunction" });
    expect((second.operations[0] as { auth?: unknown[] }).auth).toHaveLength(1);

    expect(Object.keys(body)).toEqual(["xdr"]);
    const sent = new Transaction((body as { xdr: string }).xdr, Networks.TESTNET);
    const data = sent.toEnvelope().v1().tx().ext().sorobanData();
    expect(data.resources().instructions()).toBe(1_007_615);
    expect(data.resourceFee().toString()).toBe("520");
    // Base fee plus the resource fee: the relayer refuses more than the resource fee plus 201.
    expect(sent.fee).toBe("620");
    expect((sent.operations[0] as { auth?: unknown[] }).auth).toHaveLength(1);
    expect(Number(sent.timeBounds!.maxTime) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    expect(signed).toHaveLength(1);
  });

  it("refuses when the wallet signs a different transaction", async () => {
    const other = (txXdr: string) => {
      const tx = TransactionBuilder.cloneFrom(TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as Transaction, { fee: "99999" }).build();
      tx.sign(keypair);
      return tx.toXDR();
    };
    const { rt, worker, call } = setup({ sign: other });
    await expect(prepareCall(rt, worker, call)).rejects.toMatchObject({ code: "WALLET_CHANGED_TRANSACTION" });
  });

  it("refuses an approval that came back too late for the relayer's one-minute window", async () => {
    const { rt, worker, call } = setup({ now: () => Date.now() + 58_000 });
    await expect(prepareCall(rt, worker, call)).rejects.toMatchObject({ code: "SIGNING_TOO_SLOW" });
  });
});
