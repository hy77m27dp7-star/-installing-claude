#!/usr/bin/env node
// Verifies the five master images and the frozen constitution files against their
// recorded SHA-256 hashes. Any drift fails the build: the hashes are the identity.
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("canon/ASSET_MANIFEST.json", "utf8"));
let failed = 0;

for (const m of manifest.masters) {
  const buf = readFileSync(m.path);
  const sha = createHash("sha256").update(buf).digest("hex");
  const ok = sha === m.sha256 && statSync(m.path).size === m.bytes;
  console.log(`${ok ? "PASS" : "FAIL"} ${m.path} ${sha.slice(0, 16)}`);
  if (!ok) failed++;
}

const sums = readFileSync(manifest.constitution_sums, "utf8").trim().split("\n");
for (const line of sums) {
  const [hash, name] = line.split(/\s+/);
  const buf = readFileSync(join(manifest.constitution_dir, name));
  const sha = createHash("sha256").update(buf).digest("hex");
  const ok = sha === hash;
  console.log(`${ok ? "PASS" : "FAIL"} ${manifest.constitution_dir}/${name}`);
  if (!ok) failed++;
}

if (failed) { console.error(`assets: ${failed} FAILED`); process.exit(1); }
console.log("assets: all hashes match");
