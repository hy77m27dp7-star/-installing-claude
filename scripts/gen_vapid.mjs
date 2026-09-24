#!/usr/bin/env node
// Generates a VAPID key pair for Web Push (SPEC_V2 section U) and hands it to the two
// Worker secrets. Nothing is written to disk by this script, ever.
//
//   node scripts/gen_vapid.mjs            prints the public key, shows the private key
//                                         once, and prints the two `wrangler secret put`
//                                         commands to run (paste each value at its prompt)
//   node scripts/gen_vapid.mjs --apply    runs the two `wrangler secret put` commands
//                                         itself, feeding each value on stdin, so the
//                                         private key never reaches the screen, a shell
//                                         history line or a file
//
// Key form (what src/push.ts reads): the public key is the base64url of the 65-byte
// uncompressed P-256 point, the private key the base64url of the 32-byte scalar. For
// local `wrangler dev` the same two names may go into .dev.vars (gitignored).
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
const scalar = Buffer.from(jwk.d, "base64url");
if (point.length !== 65 || scalar.length !== 32) {
  console.error("unexpected key size; nothing was applied");
  process.exit(1);
}
const pub = point.toString("base64url");
const priv = scalar.toString("base64url");

console.log("VAPID public key (base64url, 65-byte uncompressed P-256 point):");
console.log("  " + pub);
console.log("");

if (apply) {
  const wrangler = process.platform === "win32" ? "npx.cmd" : "npx";
  let failed = false;
  for (const [name, value] of [["VAPID_PUBLIC_KEY", pub], ["VAPID_PRIVATE_KEY", priv]]) {
    console.log(`wrangler secret put ${name} ...`);
    const r = spawnSync(wrangler, ["--no-install", "wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "inherit", "inherit"] });
    if (r.status !== 0) {
      failed = true;
      console.error(`  ${name}: wrangler exited with ${r.status ?? "a signal"}`);
      break;
    }
  }
  if (failed) {
    console.error("not applied. Run the script again without --apply to paste the values by hand.");
    process.exit(1);
  }
  console.log("");
  console.log("Both secrets are set. The private key was never shown or stored here.");
  console.log("Deploy (npm run deploy), then switch Notifications on from the Model page on the phone.");
} else {
  console.log("VAPID private key (base64url, 32-byte scalar; shown once, stored nowhere):");
  console.log("  " + priv);
  console.log("");
  console.log("Set the two secrets on the Worker (paste the matching value at each prompt):");
  console.log("  npx wrangler secret put VAPID_PUBLIC_KEY");
  console.log("  npx wrangler secret put VAPID_PRIVATE_KEY");
  console.log("");
  console.log("Or let this script do it without showing the private key: node scripts/gen_vapid.mjs --apply");
  console.log("Then deploy (npm run deploy) and switch Notifications on from the Model page on the phone.");
}
