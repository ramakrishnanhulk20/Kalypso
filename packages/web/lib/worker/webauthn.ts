// Before passkey-kit, so the Buffer global it reads at load time exists.
import "./sdk";
import { compactSignature, type PasskeyKitConfig } from "passkey-kit";
import { PrfUnavailableError } from "@kalypso/core";
import { WorkerError } from "./errors";

/** What a page gives the portal for passkeys: the browser's credential store and where the page is. */
export interface WebAuthnEnv {
  credentials: {
    create(options: CredentialCreationOptions): Promise<Credential | null>;
    get(options: CredentialRequestOptions): Promise<Credential | null>;
  };
  /** The relying party id, this page's host name. The browser scopes every passkey, and its PRF output, to it. */
  rpId: string;
  origin: string;
  signalUserDetails?(details: { rpId: string; userId: string; name: string; displayName: string }): Promise<void>;
  signalUnknownCredential?(details: { rpId: string; credentialId: string }): Promise<void>;
}

type WebAuthnClient = NonNullable<PasskeyKitConfig["WebAuthn"]>;
type RegistrationJSON = Awaited<ReturnType<WebAuthnClient["startRegistration"]>>;
type AuthenticationJSON = Awaited<ReturnType<WebAuthnClient["startAuthentication"]>>;

/** Shown in the passkey manager until the wallet address is known (passkey-kit's own default carries an em-dash). */
export const PROVISIONAL_PASSKEY_NAME = "Kalypso";
const RP_NAME = "Kalypso";
const ES256 = -7;
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const CEREMONY_TIMEOUT_MS = 120_000;

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @throws WorkerError PASSKEY_FAILED for anything that is not base64url. */
export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new WorkerError("PASSKEY_FAILED");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** One assertion, as raw bytes. extensions holds the PRF output when it was asked for. */
export interface Assertion {
  credentialId: string;
  rawId: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** DER, as the authenticator made it. */
  signature: Uint8Array;
  userHandle: Uint8Array | null;
  extensions: AuthenticationExtensionsClientOutputs;
  authenticatorAttachment: string | null;
}

/** A failed or dismissed prompt in plain words. NotAllowedError is what browsers give for both a cancel and a timeout. */
function ceremonyError(err: unknown): WorkerError {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new WorkerError("PASSKEY_CANCELLED");
  if (name === "SecurityError") return new WorkerError("PASSKEY_WRONG_SITE");
  return new WorkerError("PASSKEY_FAILED");
}

function flagsOf(authenticatorData: Uint8Array): number {
  if (authenticatorData.length < 37) throw new WorkerError("PASSKEY_FAILED");
  return authenticatorData[32]!;
}

/**
 * One assertion with user verification required. Refuses an answer whose authenticator data does
 * not carry both the presence and verification flags: CTAP2 keeps one PRF secret for prompts with
 * verification and another for prompts without, so an unverified answer would derive a different root.
 */
export async function getAssertion(
  env: WebAuthnEnv,
  p: { challenge: Uint8Array<ArrayBuffer>; credentialIds?: Uint8Array<ArrayBuffer>[]; prfSalt?: Uint8Array; timeoutMs?: number },
): Promise<Assertion> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: p.challenge,
    rpId: env.rpId,
    userVerification: "required",
    timeout: p.timeoutMs ?? CEREMONY_TIMEOUT_MS,
    ...(p.credentialIds ? { allowCredentials: p.credentialIds.map((id) => ({ type: "public-key" as const, id })) } : {}),
    ...(p.prfSalt ? { extensions: { prf: { eval: { first: new Uint8Array(p.prfSalt) } } } } : {}),
  };
  let credential: Credential | null;
  try {
    credential = await env.credentials.get({ publicKey });
  } catch (err) {
    throw ceremonyError(err);
  }
  const pk = credential as PublicKeyCredential | null;
  const response = pk?.response as AuthenticatorAssertionResponse | undefined;
  if (!pk || pk.type !== "public-key" || !response?.authenticatorData || !response.signature) throw new WorkerError("PASSKEY_FAILED");
  const authenticatorData = new Uint8Array(response.authenticatorData);
  const flags = flagsOf(authenticatorData);
  if ((flags & USER_PRESENT) === 0 || (flags & USER_VERIFIED) === 0) throw new WorkerError("NO_USER_VERIFICATION");
  return {
    credentialId: b64url(pk.rawId),
    rawId: new Uint8Array(pk.rawId),
    authenticatorData,
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    signature: new Uint8Array(response.signature),
    userHandle: response.userHandle ? new Uint8Array(response.userHandle) : null,
    extensions: pk.getClientExtensionResults(),
    authenticatorAttachment: pk.authenticatorAttachment ?? null,
  };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function originOf(value: unknown): string | null {
  try {
    return typeof value === "string" ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

/**
 * True only when the assertion was made on this page, for this challenge, with user verification,
 * by the private key behind `publicKey` (65-byte uncompressed P-256): the checks a wallet's own
 * signer check would make, done here so connecting never trusts a credential id alone. Origins are
 * compared after URL().origin on both sides.
 */
export async function verifyAssertion(env: WebAuthnEnv, assertion: Assertion, p: { publicKey: Uint8Array; challenge: Uint8Array }): Promise<boolean> {
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    clientData = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(assertion.clientDataJSON));
  } catch {
    return false;
  }
  const expectedOrigin = originOf(env.origin);
  if (clientData.type !== "webauthn.get" || clientData.challenge !== b64url(p.challenge)) return false;
  if (expectedOrigin === null || originOf(clientData.origin) !== expectedOrigin) return false;
  const authData = assertion.authenticatorData;
  if (authData.length < 37 || !sameBytes(authData.subarray(0, 32), await sha256(new TextEncoder().encode(env.rpId)))) return false;
  const flags = authData[32]!;
  if ((flags & USER_PRESENT) === 0 || (flags & USER_VERIFIED) === 0) return false;
  if (p.publicKey.length !== 65 || p.publicKey[0] !== 0x04) return false;
  let signature: Uint8Array;
  try {
    signature = compactSignature(Buffer.from(assertion.signature));
  } catch {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(p.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const clientHash = await sha256(assertion.clientDataJSON);
    const signed = new Uint8Array(authData.length + clientHash.length);
    signed.set(authData);
    signed.set(clientHash, authData.length);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(signature), signed);
  } catch {
    return false;
  }
}

/**
 * The WebAuthn ceremonies passkey-kit runs, done by this module instead of the kit's default so that
 * every prompt requires user verification, registration asks for PRF, passkey names never take the
 * kit's default (it writes an em-dash into the passkey manager), and a PRF output requested for one
 * prompt is kept here and never handed to the kit.
 */
export interface Ceremonies extends WebAuthnClient {
  /** The next assertion also evaluates PRF with this salt. */
  requestPrf(salt: Uint8Array): void;
  /** The PRF extension results the requested assertion returned, once. */
  takePrfResults(): AuthenticationExtensionsClientOutputs | null;
  /** The first refusal this object raised during the current kit call; it outranks the kit's own wrapping. */
  readonly failure: WorkerError | PrfUnavailableError | null;
  /** Clears failure before the next kit call. */
  reset(): void;
  /** The last registration's user handle and credential id, base64url, for the Signal API. */
  readonly registered: { userId: string; credentialId: string } | null;
}

export function createCeremonies(env: WebAuthnEnv): Ceremonies {
  let prfSalt: Uint8Array | null = null;
  let prfResults: AuthenticationExtensionsClientOutputs | null = null;
  let failure: WorkerError | PrfUnavailableError | null = null;
  let registered: { userId: string; credentialId: string } | null = null;
  const fail = (err: WorkerError | PrfUnavailableError): never => {
    failure ??= err;
    throw err;
  };

  return {
    get failure() {
      return failure;
    },
    get registered() {
      return registered;
    },
    reset() {
      failure = null;
    },
    requestPrf(salt) {
      prfSalt = new Uint8Array(salt);
    },
    takePrfResults() {
      const out = prfResults;
      prfResults = null;
      return out;
    },

    async startRegistration({ optionsJSON }): Promise<RegistrationJSON> {
      const publicKey: PublicKeyCredentialCreationOptions = {
        rp: { id: env.rpId, name: RP_NAME },
        user: { id: fromB64url(optionsJSON.user.id), name: PROVISIONAL_PASSKEY_NAME, displayName: PROVISIONAL_PASSKEY_NAME },
        challenge: fromB64url(optionsJSON.challenge),
        pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
        timeout: CEREMONY_TIMEOUT_MS,
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        // Without the extension at registration a CTAP2 authenticator may make the credential with
        // no PRF secret, and every later PRF request for it comes back empty (M1b).
        extensions: { prf: {} },
      };
      let credential: Credential | null;
      try {
        credential = await env.credentials.create({ publicKey });
      } catch (err) {
        return fail(ceremonyError(err));
      }
      const pk = credential as PublicKeyCredential | null;
      const response = pk?.response as AuthenticatorAttestationResponse | undefined;
      if (!pk || pk.type !== "public-key" || !response?.attestationObject) return fail(new WorkerError("PASSKEY_FAILED"));
      const extensions = pk.getClientExtensionResults();
      registered = { userId: optionsJSON.user.id, credentialId: b64url(pk.rawId) };
      // Only an explicit "no" stops here; some providers leave enabled out and still answer PRF later.
      if (extensions.prf?.enabled === false) return fail(new PrfUnavailableError("MISSING"));
      const spki = typeof response.getPublicKey === "function" ? response.getPublicKey() : null;
      const authData = typeof response.getAuthenticatorData === "function" ? response.getAuthenticatorData() : null;
      return {
        id: b64url(pk.rawId),
        rawId: b64url(pk.rawId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(response.clientDataJSON),
          attestationObject: b64url(response.attestationObject),
          ...(authData ? { authenticatorData: b64url(authData) } : {}),
          ...(spki ? { publicKey: b64url(spki) } : {}),
          ...(typeof response.getPublicKeyAlgorithm === "function" ? { publicKeyAlgorithm: response.getPublicKeyAlgorithm() } : {}),
          ...(typeof response.getTransports === "function" ? { transports: response.getTransports() as AuthenticatorTransport[] } : {}),
        },
        clientExtensionResults: {},
        ...(pk.authenticatorAttachment ? { authenticatorAttachment: pk.authenticatorAttachment as AuthenticatorAttachment } : {}),
      } as RegistrationJSON;
    },

    async startAuthentication({ optionsJSON }): Promise<AuthenticationJSON> {
      const salt = prfSalt;
      prfSalt = null;
      let assertion: Assertion;
      try {
        assertion = await getAssertion(env, {
          challenge: fromB64url(optionsJSON.challenge),
          ...(optionsJSON.allowCredentials ? { credentialIds: optionsJSON.allowCredentials.map((c) => fromB64url(c.id)) } : {}),
          ...(salt ? { prfSalt: salt } : {}),
        });
      } catch (err) {
        return fail(err instanceof WorkerError ? err : new WorkerError("PASSKEY_FAILED"));
      }
      if (salt) {
        const results = assertion.extensions;
        if (!results.prf?.results?.first) return fail(new PrfUnavailableError("MISSING"));
        prfResults = results;
      }
      return {
        id: assertion.credentialId,
        rawId: assertion.credentialId,
        type: "public-key",
        response: {
          authenticatorData: b64url(assertion.authenticatorData),
          clientDataJSON: b64url(assertion.clientDataJSON),
          signature: b64url(assertion.signature),
          ...(assertion.userHandle ? { userHandle: b64url(assertion.userHandle) } : {}),
        },
        clientExtensionResults: {},
        ...(assertion.authenticatorAttachment ? { authenticatorAttachment: assertion.authenticatorAttachment as AuthenticatorAttachment } : {}),
      } as AuthenticationJSON;
    },
  };
}
