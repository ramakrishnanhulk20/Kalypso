// Covers readSignerVal, the strict decoder for the passkey signer a wallet holds, on the exact bytes
// read from testnet for the fixture wallet (scratchpad/attacks/birth-squat/step2-shapes.out) and on
// the shapes a wallet must not be trusted with.
// Does NOT cover: the ledger read itself (rpcLedger needs RPC; the live repro in
// scratchpad/attacks/birth-squat runs it), or which durability is in force when both exist.
import "./sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { readSignerVal } from "./session";

// The fixture wallet CBSDDY2N...GKSK's SignerVal for its passkey, as RPC served it on 9 Oct 2026.
const LIVE_SIGNER_VAL =
  "AAAAEAAAAAEAAAAEAAAADwAAAAlTZWNwMjU2cjEAAAAAAAANAAAAQQSWVIf+EEbRDOUqBSQcdufzd8hTtMmXs8vU+NluQuYf2Uk6Ef2km9DuRlh0nDB+sppGQZd78MZlHCRpC+d988dlAAAAAAAAEAAAAAEAAAABAAAAAQAAABAAAAABAAAAAQAAAAE=";

const fixture = JSON.parse(readFileSync(new URL("../../../server/test/sponsor/live-wallet-creation.json", import.meta.url), "utf8")) as { func: string };
const deployedKey = xdr.HostFunction.fromXDR(fixture.func, "base64").createContractV2().constructorArgs()[0]!.vec()![2]!.bytes();

const signerVal = (expiry: xdr.ScVal, limits: xdr.ScVal, tag = "Secp256r1") =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(tag), xdr.ScVal.scvBytes(Buffer.from(deployedKey)), xdr.ScVal.scvVec([expiry]), xdr.ScVal.scvVec([limits])]);

describe("readSignerVal", () => {
  it("reads the live wallet's signer as the key its deploy wrote, never expiring, unlimited", () => {
    const read = readSignerVal(xdr.ScVal.fromXDR(LIVE_SIGNER_VAL, "base64"), true);
    expect(read).toEqual({ publicKey: new Uint8Array(deployedKey), expiry: null, limited: false, persistent: true });
  });

  it("reports an expiry and limits as they are, and reads any other shape as no signer", () => {
    const limits = xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("any"), val: xdr.ScVal.scvVoid() })]);
    expect(readSignerVal(signerVal(nativeToScVal(1_900_000_000n, { type: "u64" }), xdr.ScVal.scvVoid()), false)).toMatchObject({ expiry: 1_900_000_000, limited: false, persistent: false });
    expect(readSignerVal(signerVal(xdr.ScVal.scvVoid(), limits), true)).toMatchObject({ expiry: null, limited: true });
    expect(readSignerVal(signerVal(xdr.ScVal.scvVoid(), xdr.ScVal.scvVoid(), "Ed25519"), true)).toBeNull();
    expect(readSignerVal(signerVal(xdr.ScVal.scvU32(5), xdr.ScVal.scvVoid()), true)).toBeNull();
    expect(readSignerVal(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Secp256r1"), xdr.ScVal.scvBytes(Buffer.from(deployedKey))]), true)).toBeNull();
    expect(readSignerVal(xdr.ScVal.scvVoid(), true)).toBeNull();
  });
});
