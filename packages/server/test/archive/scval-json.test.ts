// Not covered here: decoding by the SDK itself. scratchpad/m5a/parity.mjs runs
// the SDK's IndexerClient over this encoding of real testnet events.
import { describe, expect, it } from "vitest";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { scValToPlainJson } from "../../src/archive/scval-json.ts";
import { keypairFor } from "../helpers.ts";

describe("scValToPlainJson", () => {
  it("encodes every kind the SDK decoder reads", () => {
    const g = keypairFor("json").publicKey();
    expect(scValToPlainJson(xdr.ScVal.scvBool(true))).toBe(true);
    expect(scValToPlainJson(xdr.ScVal.scvVoid())).toBeNull();
    expect(scValToPlainJson(xdr.ScVal.scvU32(7))).toBe(7);
    expect(scValToPlainJson(xdr.ScVal.scvI32(-7))).toBe(-7);
    expect(scValToPlainJson(nativeToScVal(2n ** 70n, { type: "u128" }))).toBe("1180591620717411303424");
    expect(scValToPlainJson(nativeToScVal(-5n, { type: "i128" }))).toBe("-5");
    expect(scValToPlainJson(xdr.ScVal.scvBytes(Buffer.from([0, 1, 0xab])))).toBe("0001ab");
    expect(scValToPlainJson(xdr.ScVal.scvString("hi"))).toBe("hi");
    expect(scValToPlainJson(xdr.ScVal.scvSymbol("transfer"))).toBe("transfer");
    expect(scValToPlainJson(new Address(g).toScVal())).toBe(g);
    expect(scValToPlainJson(xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvVoid()]))).toEqual([1, null]);
    expect(
      scValToPlainJson(xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(9n, { type: "i128" }) })])),
    ).toEqual({ amount: "9" });
  });

  it("keeps maps with non-symbol keys as key and value pairs, and anything else as XDR", () => {
    const pairs = xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvU32(1), val: xdr.ScVal.scvBool(false) })]);
    expect(scValToPlainJson(pairs)).toEqual({ map: [{ key: 1, val: false }] });
    const odd = xdr.ScVal.scvLedgerKeyContractInstance();
    expect(scValToPlainJson(odd)).toEqual({ xdr: odd.toXDR("base64") });
  });
});
