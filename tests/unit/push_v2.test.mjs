// src/push.ts: the VAPID JWT (SPEC_V2 section U). Header alg ES256, aud is the push
// endpoint's origin, exp at most 24 hours out, and the signature verifies against the
// public key. Keys are handed over in the standard Web Push form: the public key as the
// base64url of the 65-byte uncompressed P-256 point, the private key as the base64url of
// the 32-byte scalar (what scripts/gen_vapid.mjs prints).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { loadSrc } from "./helpers.mjs";

const push = await loadSrc("push");

// The builder may carry one of these names; the first one found is used.
const NAMES = ["vapidJwt", "signVapidJwt", "buildVapidJwt", "createVapidJwt", "makeVapidJwt", "vapidToken", "vapidAuthorization", "vapidHeaders"];
const builder = NAMES.map((n) => push[n]).find((f) => typeof f === "function");

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: raw.toString("base64url"), privateKey: Buffer.from(jwk.d, "base64url").toString("base64url"), verifyKey: publicKey };
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const SUBJECT = "mailto:owner@example.com";

// Tries the call shapes a builder could reasonably have, in order, and returns the token.
async function build(k, endpoint, now) {
  const env = { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, OWNER_EMAIL: "owner@example.com" };
  const shapes = [
    () => builder({ publicKey: k.publicKey, privateKey: k.privateKey, subject: SUBJECT }, endpoint, now),
    () => builder(endpoint, { publicKey: k.publicKey, privateKey: k.privateKey, subject: SUBJECT }, now),
    () => builder(env, endpoint, now),
    () => builder(endpoint, env, now),
    () => builder(k.privateKey, k.publicKey, endpoint, SUBJECT, now),
  ];
  let lastError = null;
  for (const shape of shapes) {
    try {
      const r = await shape();
      const t = tokenOf(r);
      if (t) return t;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error("no call shape produced a JWT" + (lastError ? ": " + lastError.message : ""));
}

// A compact JWT, or an object / header value that carries one.
function tokenOf(r) {
  if (typeof r === "string") {
    const m = /(?:^|t=)([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(r);
    return m ? m[1] : null;
  }
  if (r && typeof r === "object") {
    for (const key of ["jwt", "token", "t", "authorization", "Authorization"]) if (typeof r[key] === "string") return tokenOf(r[key]);
    if (r.headers) return tokenOf(r.headers);
  }
  return null;
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("push.ts exports a VAPID JWT builder under one of the expected names", () => {
  assert.ok(builder, "src/push.ts exports none of: " + NAMES.join(", ") + "; export the JWT builder under one of them (or update this test)");
});

test("VAPID JWT: header alg ES256 and typ JWT", async () => {
  const k = keys();
  const token = await build(k, ENDPOINT, new Date("2026-09-29T14:30:00Z"));
  const header = decode(token.split(".")[0]);
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "JWT");
});

test("VAPID JWT: aud is the endpoint's origin (scheme and host only), sub is the owner contact", async () => {
  const k = keys();
  const token = await build(k, ENDPOINT, new Date("2026-09-29T14:30:00Z"));
  const payload = decode(token.split(".")[1]);
  assert.equal(payload.aud, "https://fcm.googleapis.com");
  assert.ok(typeof payload.sub === "string" && /^(mailto:|https:\/\/)/.test(payload.sub), "sub: " + payload.sub);
});

test("VAPID JWT: exp is in the future and at most 24 hours out", async () => {
  const k = keys();
  const now = new Date("2026-09-29T14:30:00Z");
  const token = await build(k, ENDPOINT, now);
  const payload = decode(token.split(".")[1]);
  assert.ok(Number.isInteger(payload.exp), "exp is a unix time in seconds");
  const nowSec = Math.floor(now.getTime() / 1000);
  // The builder may read the clock itself; allow either the passed instant or "now".
  const base = Math.abs(payload.exp - nowSec) < 25 * 3600 ? nowSec : Math.floor(Date.now() / 1000);
  assert.ok(payload.exp > base, "exp must be in the future");
  assert.ok(payload.exp - base <= 24 * 3600, "exp must be within 24 hours: " + (payload.exp - base) + " s");
});

test("VAPID JWT: the ES256 signature verifies against the public key (raw r||s, not DER)", async () => {
  const k = keys();
  const token = await build(k, ENDPOINT, new Date("2026-09-29T14:30:00Z"));
  const [h, p, s] = token.split(".");
  const sig = Buffer.from(s, "base64url");
  assert.equal(sig.length, 64, "JWS ES256 signatures are 64 raw bytes");
  const ok = createVerify("SHA256").update(`${h}.${p}`).verify({ key: k.verifyKey, dsaEncoding: "ieee-p1363" }, sig);
  assert.equal(ok, true, "signature does not verify");
});

test("VAPID JWT: a different endpoint origin gets a different aud and a different token", async () => {
  const k = keys();
  const now = new Date("2026-09-29T14:30:00Z");
  const a = await build(k, ENDPOINT, now);
  const b = await build(k, "https://updates.push.services.mozilla.com/wpush/v2/xyz", now);
  assert.notEqual(a, b);
  assert.equal(decode(b.split(".")[1]).aud, "https://updates.push.services.mozilla.com");
});
