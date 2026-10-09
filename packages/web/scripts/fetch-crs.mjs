// Downloads the proving data bb.js needs into public/crs, once, and prints the sha256 of each
// file. lib/prover-data.ts records those hashes and the app refuses any file that does not match.
// Run it again at any time: files already present are not downloaded again, only re-checked
// against the sizes below and the hashes in lib/prover-data.ts.
//
//   node scripts/fetch-crs.mjs
//
// The sizes follow bb.js 0.87.0, which asks for the circuit's subgroup size plus one point at
// 64 bytes a point. The largest circuit (transfer and withdraw) has a 32,768-row subgroup.
// A circuit that grows past that needs a new download and new hashes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const POINTS = 32_769;
const FILES = [
  { name: "g1.dat", bytes: POINTS * 64, constant: "CRS_G1_SHA256", range: true },
  { name: "g2.dat", bytes: 128, constant: "CRS_G2_SHA256", range: false },
];
const SOURCE = "https://crs.aztec.network/";
const outDir = path.join(import.meta.dirname, "../public/crs");
const moduleFile = path.join(import.meta.dirname, "../lib/prover-data.ts");

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

// g1.dat upstream is 6.4 GB, so anything but a 206 for exactly the bytes asked for is refused
// before the body is read, and the read stops the moment it passes the expected size.
async function download(file) {
  const headers = file.range ? { Range: `bytes=0-${file.bytes - 1}` } : {};
  const response = await fetch(SOURCE + file.name, { headers, redirect: "error", signal: AbortSignal.timeout(120_000) });
  const expectedStatus = file.range ? 206 : 200;
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    fail(`${file.name}: expected HTTP ${expectedStatus}, got ${response.status}`);
  }
  if (file.range && !response.headers.get("content-range")?.startsWith(`bytes 0-${file.bytes - 1}/`)) {
    await response.body?.cancel();
    fail(`${file.name}: the server did not return the byte range asked for`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > file.bytes) {
      await response.body.cancel().catch(() => {});
      fail(`${file.name}: the response is longer than ${file.bytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function recordedHashes() {
  if (!existsSync(moduleFile)) return null;
  const source = readFileSync(moduleFile, "utf8");
  const hashes = {};
  for (const file of FILES) {
    const match = source.match(new RegExp(`export const ${file.constant} = "([0-9a-f]{64})";`));
    if (!match) fail(`lib/prover-data.ts exists but has no ${file.constant}`);
    hashes[file.name] = match[1];
  }
  return hashes;
}

mkdirSync(outDir, { recursive: true });
const recorded = recordedHashes();

for (const file of FILES) {
  const target = path.join(outDir, file.name);
  const present = existsSync(target);
  const bytes = present ? readFileSync(target) : await download(file);
  if (bytes.byteLength !== file.bytes) fail(`${file.name}: ${bytes.byteLength} bytes, expected ${file.bytes}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (recorded && recorded[file.name] !== sha256) {
    fail(`${file.name}: sha256 ${sha256} does not match ${file.constant} ${recorded[file.name]} in lib/prover-data.ts`);
  }
  if (!present) writeFileSync(target, bytes);
  const state = present ? "already present" : "downloaded";
  const check = recorded ? ", matches lib/prover-data.ts" : "";
  console.log(`${file.name}: ${state}, ${file.bytes} bytes, sha256 ${sha256}${check}`);
}
