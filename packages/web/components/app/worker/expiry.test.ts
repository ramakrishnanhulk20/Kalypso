import { Account, Asset, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { approvalWindowClosed } from "./expiry";

const ACCOUNT = "GDG33P5FV5F5A2JDU5O2C4SXVBXWVAZRFY2DNVZZKHIKY2DO4R26QSAZ";

function payment(seconds: number): { xdr: string; maxTime: number } {
  const tx = new TransactionBuilder(new Account(ACCOUNT, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: ACCOUNT, asset: Asset.native(), amount: "1" }))
    .setTimeout(seconds)
    .build();
  return { xdr: tx.toXDR(), maxTime: Number(tx.timeBounds?.maxTime) };
}

describe("the approval window of a payment", () => {
  const { xdr, maxTime } = payment(300);

  it("is open well before it ends", () => {
    expect(approvalWindowClosed(xdr, Networks.TESTNET, (maxTime - 120) * 1000)).toBe(false);
  });

  it("counts as closed once it has ended, and a little before to allow for a fast clock", () => {
    expect(approvalWindowClosed(xdr, Networks.TESTNET, (maxTime + 1) * 1000)).toBe(true);
    expect(approvalWindowClosed(xdr, Networks.TESTNET, (maxTime - 10) * 1000)).toBe(true);
  });

  it("is never closed for something that is not a transaction", () => {
    expect(approvalWindowClosed("not xdr", Networks.TESTNET, Date.now())).toBe(false);
  });
});
