import { signEnvelope } from "../sandbox/accounts";
import type { Keypair } from "../sandbox/sdk";
import type { WalletPort } from "./port";

/**
 * A wallet over a keypair this page holds, for the sandbox and for tests. It signs messages the
 * way Freighter does (SEP-53: ed25519 over SHA-256 of "Stellar Signed Message:\n" and the text),
 * so a key derived through it equals the key the same account derives in Freighter.
 *
 * Never use it for a real account: the secret lives in page memory.
 */
export function throwawayWallet(keypair: Keypair): WalletPort {
  const address = keypair.publicKey();
  return {
    kind: "throwaway",
    address,
    signTransaction: async (txXdr, networkPassphrase) => signEnvelope(keypair, txXdr, networkPassphrase),
    signMessage: async (message) => {
      if (typeof message !== "string") throw new TypeError("signMessage takes the message as text");
      return Uint8Array.from(keypair.signMessage(message));
    },
  };
}
