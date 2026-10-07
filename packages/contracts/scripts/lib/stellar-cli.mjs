// The deployer's secret stays inside the stellar CLI's identity store. This
// module only ever hands the CLI an identity name and reads back public keys
// and signed envelopes, so no secret passes through argv, our files or logs.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_NAME, NETWORK_PASSPHRASE, STELLAR_CONFIG_DIR } from "./network.mjs";

function resolveStellarBin() {
  if (process.env.STELLAR_BIN) return process.env.STELLAR_BIN;
  if (spawnSync("stellar", ["--version"], { encoding: "utf8" }).status === 0) return "stellar";
  // Where the official install script puts it.
  const installed = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "stellar.exe" : "stellar");
  if (existsSync(installed)) return installed;
  throw new Error("stellar CLI not found on PATH or in ~/.local/bin. Install it or set STELLAR_BIN");
}

// --sign-with-key also accepts a raw secret or a seed phrase. Only a plain
// identity name may reach the command line, so anything shaped like a secret
// is refused before it can be passed.
function requireIdentityName(name) {
  if (/^S[A-Z2-7]{55}$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("DEPLOYER must be a stellar CLI identity name (letters, digits, - or _), never a key");
  }
  return name;
}

export function stellarCli() {
  const bin = resolveStellarBin();

  function run(args, { input, allowFailure = false, showStderr = true } = {}) {
    const res = spawnSync(bin, [...args, "--config-dir", STELLAR_CONFIG_DIR], { encoding: "utf8", input });
    if (res.error) throw new Error(`stellar ${args[0]} ${args[1] ?? ""} could not start: ${res.error.message}`);
    if (res.status !== 0 && !allowFailure) {
      const detail = showStderr ? `: ${res.stderr.trim().slice(0, 400)}` : "";
      throw new Error(`stellar ${args[0]} ${args[1] ?? ""} exited ${res.status}${detail}`);
    }
    return res;
  }

  const version = () => spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim();

  function publicKeyOf(name) {
    const res = run(["keys", "public-key", requireIdentityName(name)], { allowFailure: true });
    if (res.status !== 0) return null;
    const g = res.stdout.trim();
    if (!StrKey.isValidEd25519PublicKey(g)) throw new Error(`identity ${name} returned something that is not a public key`);
    return g;
  }

  /** Returns the identity's public key, creating the identity first if needed. */
  function ensureIdentity(name) {
    const existing = publicKeyOf(name);
    if (existing) return { publicKey: existing, created: false };
    // Output is discarded unread, even on failure: nothing from the command
    // that creates key material is ever echoed.
    run(["keys", "generate", requireIdentityName(name)], { showStderr: false });
    const created = publicKeyOf(name);
    if (!created) throw new Error(`stellar keys generate ${name} did not create an identity`);
    return { publicKey: created, created: true };
  }

  /**
   * Signs `tx` as identity `name` and returns the signed transaction. The CLI's
   * output is checked like any untrusted input: it must be the same
   * transaction, with one valid signature from `expectedSigner`.
   */
  function sign(tx, name, expectedSigner) {
    const res = run(
      ["tx", "sign", "--sign-with-key", requireIdentityName(name), "--network", NETWORK_NAME, "--quiet"],
      { input: tx.toEnvelope().toXDR("base64") },
    );
    const signed = TransactionBuilder.fromXDR(res.stdout.trim(), NETWORK_PASSPHRASE);
    if (!signed.hash().equals(tx.hash())) throw new Error("stellar tx sign returned a different transaction");
    const signer = Keypair.fromPublicKey(expectedSigner);
    if (signed.signatures.length !== 1 || !signer.verify(tx.hash(), signed.signatures[0].signature())) {
      throw new Error(`stellar tx sign did not return exactly one valid signature from ${expectedSigner}`);
    }
    return signed;
  }

  return { bin, version, publicKeyOf, ensureIdentity, sign };
}

export function deployerName() {
  return requireIdentityName(process.env.DEPLOYER || "kalypso-deployer");
}
