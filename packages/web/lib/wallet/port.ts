import type { SignerPort } from "@kalypso/core";

/**
 * A wallet a person signs with in the browser: Freighter for G accounts, a throwaway keypair in
 * the sandbox and in tests. It extends core's SignerPort, so anything that signs a transaction
 * for core also signs messages for key derivation.
 *
 * signMessage must return the 64-byte ed25519 signature over SEP-53's prefixed digest of the
 * exact text it was given, from an interface that shows the text to the person (threat model
 * non-goals: a raw-hash signing API would reproduce the key root without showing the message).
 * Key derivation asks for two signatures over the same text and refuses if they differ (C40).
 */
export interface WalletPort extends SignerPort {
  kind: "freighter" | "throwaway";
  signMessage(message: string): Promise<Uint8Array>;
}
