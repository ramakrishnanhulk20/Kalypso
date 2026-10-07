import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { addressOfScVal } from "../stellar.ts";

/**
 * Plain JSON for one ScVal, in the shape the confidential SDK's IndexerClient
 * decoder reads (packages/sdk/src/chain/indexer.ts, parseIndexerEvent):
 * symbols, strings and addresses as strings, bytes as lower-case hex, 32-bit
 * integers as numbers, wider integers as decimal strings, maps with symbol
 * keys as objects. Anything outside that set is passed as `{ xdr: base64 }`
 * so nothing is silently dropped.
 *
 * This is a second encoding of data the archive stores as XDR. The
 * scratchpad/m5a parity check decodes both forms of real testnet events with
 * the SDK and compares them.
 */
export function scValToPlainJson(value: xdr.ScVal): unknown {
  switch (value.switch().name) {
    case "scvBool":
      return value.b();
    case "scvVoid":
      return null;
    case "scvU32":
      return value.u32();
    case "scvI32":
      return value.i32();
    case "scvU64":
    case "scvI64":
    case "scvTimepoint":
    case "scvDuration":
    case "scvU128":
    case "scvI128":
    case "scvU256":
    case "scvI256":
      return String(scValToNative(value));
    case "scvBytes":
      return Buffer.from(value.bytes()).toString("hex");
    case "scvString":
      return value.str().toString();
    case "scvSymbol":
      return value.sym().toString();
    case "scvAddress":
      return addressOfScVal(value);
    case "scvVec":
      return (value.vec() ?? []).map(scValToPlainJson);
    case "scvMap": {
      const entries = value.map() ?? [];
      if (entries.every((e) => e.key().switch().name === "scvSymbol")) {
        const out: Record<string, unknown> = {};
        for (const e of entries) out[e.key().sym().toString()] = scValToPlainJson(e.val());
        return out;
      }
      return { map: entries.map((e) => ({ key: scValToPlainJson(e.key()), val: scValToPlainJson(e.val()) })) };
    }
    default:
      return { xdr: value.toXDR("base64") };
  }
}
