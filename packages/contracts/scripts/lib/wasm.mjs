import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { contract } from "@stellar/stellar-sdk";

export const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Reads a wasm file and refuses it unless its sha256 equals `expectedHash`. */
export function loadPinnedWasm({ file, hash, label }) {
  if (!existsSync(file)) throw new Error(`${label} is missing`);
  const bytes = readFileSync(file);
  const actual = sha256hex(bytes);
  if (actual !== hash) throw new Error(`${label} has sha256 ${actual}, expected the pin ${hash}`);
  return { bytes, hash, label };
}

// Cargo writes kalypso_auditor.wasm; the attested GitHub release names the same
// build kalypso-auditor_v0.1.0.wasm. Both spellings reduce to one stem here.
function packageStem(fileName) {
  return fileName
    .replace(/\.wasm$/, "")
    .replace(/_v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "")
    .replace(/-/g, "_");
}

/**
 * Finds the one wasm in `dir` built from cargo package `pkg`. Two candidates
 * (say a local build and a release asset side by side) is ambiguous, so it
 * refuses rather than guess which one to deploy.
 */
export function findBuiltWasm(dir, pkg) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`wasm directory ${dir} does not exist. Build first or pass --wasm-dir`);
  }
  const stem = pkg.replace(/-/g, "_");
  const matches = readdirSync(dir).filter((f) => f.endsWith(".wasm") && packageStem(f) === stem);
  if (matches.length === 0) throw new Error(`no wasm for package ${pkg} in ${dir}`);
  if (matches.length > 1) throw new Error(`more than one wasm for package ${pkg} in ${dir}: ${matches.join(", ")}`);
  const file = path.join(dir, matches[0]);
  const bytes = readFileSync(file);
  return { bytes, hash: sha256hex(bytes), label: matches[0], file };
}

/**
 * Parses `sha256sum` output ("<64 hex>  <name>" or "<64 hex> *<name>").
 * Any line that is not in that shape stops the deploy: a half-read sums file
 * must never pass as a checked one.
 */
export function parseSha256Sums(file) {
  const sums = new Map();
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (line.trim() === "") return;
      const m = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
      if (!m) throw new Error(`${file} line ${i + 1} is not a sha256sum line`);
      const name = path.basename(m[2].trim());
      if (sums.has(name)) throw new Error(`${file} lists ${name} twice`);
      sums.set(name, m[1].toLowerCase());
    });
  return sums;
}

export function requireListedInSums(wasm, sums) {
  const listed = sums.get(wasm.label);
  if (!listed) throw new Error(`${wasm.label} is not listed in the sha256sums file`);
  if (listed !== wasm.hash) throw new Error(`${wasm.label} has sha256 ${wasm.hash}, the sums file says ${listed}`);
}

/**
 * What a contract can actually do, read with the engine's own wasm parser:
 * the functions it exports, whether it imports the host call that replaces a
 * contract's own code (`update_current_contract_wasm`, module "l" export "6"
 * in soroban-env-common 27 env.json), and its declared function signatures.
 *
 * Covers: any upgrade path at all, whatever the function is called. Does not
 * cover: what the exported functions do with their arguments.
 */
export function inspectWasm(bytes) {
  const mod = new WebAssembly.Module(bytes);
  const exportedFunctions = WebAssembly.Module.exports(mod)
    .filter((e) => e.kind === "function")
    .map((e) => e.name)
    .sort();
  const canReplaceOwnCode = WebAssembly.Module.imports(mod).some(
    (i) => i.kind === "function" && i.module === "l" && i.name === "6",
  );
  const specFunctions = contract.Spec.fromWasm(Buffer.from(bytes))
    .funcs()
    .map((f) => ({
      name: f.name().toString(),
      inputs: f.inputs().map((i) => ({ name: i.name().toString(), type: i.type().switch().name })),
    }));
  return { exportedFunctions, canReplaceOwnCode, specFunctions };
}

/**
 * A function whose name speaks of an admin or an owner is acceptable only if
 * its first parameter scopes it to one tenant record (`scopeParam`), so it can
 * never govern the contract as a whole. Upgrade and setter names are refused
 * outright, and so is any code that imports the host call able to replace it.
 * Returns what is wrong; an empty list means nothing is.
 */
export function privilegeFindings(inspected, scopeParam) {
  const findings = [];
  if (inspected.canReplaceOwnCode) findings.push("imports update_current_contract_wasm");
  for (const fn of inspected.specFunctions) {
    if (!inspected.exportedFunctions.includes(fn.name)) continue;
    if (/upgrade/i.test(fn.name) || /^set_/i.test(fn.name)) findings.push(`exports ${fn.name}`);
    if (/admin|owner/i.test(fn.name) && fn.inputs[0]?.name !== scopeParam) {
      findings.push(`${fn.name} is not scoped by ${scopeParam}`);
    }
  }
  const declared = new Set(inspected.specFunctions.map((f) => f.name));
  for (const name of inspected.exportedFunctions) {
    if (!declared.has(name)) findings.push(`${name} is exported but not declared in the contract spec`);
  }
  return findings;
}
