// Access JWT verification against a locally generated RSA key, and the local-actor rule.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, makeRsaKeys, signJwt, b64url } from "./helpers.mjs";

const { verifyAccessJwt, requireOwner, localActor } = await loadSrc("auth");

const TEAM = "team.example.cloudflareaccess.com";
const AUD = "aud-1234567890abcdef";
const OWNER = "justin@newsomeprojects.com";
const NOW = 1_800_000_000;

const keys = makeRsaKeys("kid-a");
const otherKeys = makeRsaKeys("kid-a"); // same kid, different key: signature must fail
const jwks = { keys: [keys.jwk] };
const fetchJwks = async () => jwks;

function claims(overrides = {}) {
  return { iss: "https://" + TEAM, aud: [AUD], exp: NOW + 600, iat: NOW - 10, email: OWNER, ...overrides };
}

function token(payload = claims(), key = keys.privateKey, header = { alg: "RS256", kid: "kid-a", typ: "JWT" }) {
  return signJwt(key, header, payload);
}

function opts(overrides = {}) {
  return { teamDomain: TEAM, aud: AUD, ownerEmail: OWNER, now: NOW, fetchJwks, ...overrides };
}

// ------------------------------------------------------------------ verifyAccessJwt

test("valid token: resolves with the email", async () => {
  const r = await verifyAccessJwt(token(), opts());
  assert.equal(r.email, OWNER);
});

test("valid token: email comparison is case-insensitive, aud may be a plain string", async () => {
  const r = await verifyAccessJwt(token(claims({ email: "Justin@NewsomeProjects.com", aud: AUD })), opts());
  assert.equal(r.email.toLowerCase(), OWNER);
});

test("JWKS are fetched from the team domain certs URL", async () => {
  let seen = null;
  await verifyAccessJwt(token(), opts({ fetchJwks: async (url) => { seen = url; return jwks; } }));
  assert.equal(seen, "https://" + TEAM + "/cdn-cgi/access/certs");
});

test("wrong aud is rejected", async () => {
  await assert.rejects(verifyAccessJwt(token(claims({ aud: ["someone-else"] })), opts()), (e) => e instanceof Error && /aud/i.test(e.message));
  await assert.rejects(verifyAccessJwt(token(claims({ aud: [] })), opts()), Error);
});

test("wrong iss is rejected", async () => {
  await assert.rejects(verifyAccessJwt(token(claims({ iss: "https://other.cloudflareaccess.com" })), opts()), (e) => e instanceof Error && /iss/i.test(e.message));
});

test("expired token is rejected", async () => {
  await assert.rejects(verifyAccessJwt(token(claims({ exp: NOW - 1 })), opts()), (e) => e instanceof Error && /expir/i.test(e.message));
  await assert.rejects(verifyAccessJwt(token(claims({ exp: undefined })), opts()), Error);
});

test("wrong email is rejected", async () => {
  await assert.rejects(verifyAccessJwt(token(claims({ email: "stranger@example.com" })), opts()), (e) => e instanceof Error && /email/i.test(e.message));
  await assert.rejects(verifyAccessJwt(token(claims({ email: undefined })), opts()), Error);
});

test("bad signature is rejected: signed by another key, or payload tampered after signing", async () => {
  await assert.rejects(verifyAccessJwt(token(claims(), otherKeys.privateKey), opts()), (e) => e instanceof Error && /signature/i.test(e.message));
  const [h, , s] = token().split(".");
  const tampered = h + "." + b64url(JSON.stringify(claims({ email: "stranger@example.com" }))) + "." + s;
  await assert.rejects(verifyAccessJwt(tampered, opts()), Error);
});

test("malformed tokens are rejected without throwing anything but an Error", async () => {
  for (const bad of ["garbage", "a.b", "a.b.c", "", "..", b64url("{}") + "." + b64url("{}") + ".sig"]) {
    await assert.rejects(verifyAccessJwt(bad, opts()), Error, "expected rejection for " + JSON.stringify(bad));
  }
});

test("unknown kid and non-RS256 algorithms are rejected", async () => {
  await assert.rejects(verifyAccessJwt(token(claims(), keys.privateKey, { alg: "RS256", kid: "kid-unknown" }), opts()), Error);
  await assert.rejects(verifyAccessJwt(token(claims(), keys.privateKey, { alg: "HS256", kid: "kid-a" }), opts()), Error);
});

test("verification is pure: no network, the fetchJwks stub is the only key source", async () => {
  await assert.rejects(verifyAccessJwt(token(), opts({ fetchJwks: async () => ({ keys: [] }) })), Error);
});

// ------------------------------------------------------------------ requireOwner (the local-actor rule)

function env(overrides = {}) {
  return {
    DB: {}, MEDIA: {}, ASSETS: {}, AI: {},
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: "",
    OWNER_EMAIL: OWNER,
    APP_ENV: "test",
    DEV_ACTOR_EMAIL: OWNER,
    ...overrides,
  };
}

async function denied(promise) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof Response, "requireOwner must throw a Response");
    return e;
  }
  assert.fail("expected requireOwner to throw");
}

test("local dev: DEV_ACTOR_EMAIL, a local host and empty ACCESS_AUD yield the dev actor", async () => {
  for (const url of ["http://127.0.0.1:8790/api/me", "http://localhost:8787/"]) {
    const r = await requireOwner(new Request(url), env());
    assert.equal(r.email, OWNER);
    assert.equal(r.mode, "dev");
  }
});

test("local dev: a non-local host is never the dev actor (fails closed with 503 while Access is unconfigured)", async () => {
  const res = await denied(requireOwner(new Request("http://avelie.example/api/me"), env()));
  assert.equal(res.status, 503);
});

test("local dev: without DEV_ACTOR_EMAIL even localhost is refused", async () => {
  const res = await denied(requireOwner(new Request("http://127.0.0.1:8790/api/me"), env({ DEV_ACTOR_EMAIL: undefined })));
  assert.equal(res.status, 503);
});

test("production: the dev actor is never granted, even on localhost with DEV_ACTOR_EMAIL set (503)", async () => {
  const prod = env({ APP_ENV: "production" });
  for (const url of ["http://127.0.0.1:8790/api/me", "http://localhost:8787/"]) {
    assert.equal(localActor(new Request(url), prod), null);
    const res = await denied(requireOwner(new Request(url), prod));
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes(OWNER));
  }
  // Any other APP_ENV keeps the local rule.
  assert.equal(localActor(new Request("http://localhost:8787/"), env({ APP_ENV: "development" })), OWNER);
});

test("with Access configured: no token is 401, a garbage token is 403, localhost gets no shortcut", async () => {
  const withAud = env({ ACCESS_AUD: AUD });
  const none = await denied(requireOwner(new Request("http://127.0.0.1:8790/api/me"), withAud));
  assert.equal(none.status, 401);
  const garbage = await denied(requireOwner(new Request("http://127.0.0.1:8790/api/me", { headers: { "cf-access-jwt-assertion": "garbage" } }), withAud));
  assert.equal(garbage.status, 403);
});

test("an email header from the client never grants identity", async () => {
  const headers = { "cf-access-authenticated-user-email": OWNER, "x-user-email": OWNER };
  const res = await denied(requireOwner(new Request("http://avelie.example/api/me", { headers }), env({ ACCESS_AUD: AUD })));
  assert.ok(res.status === 401 || res.status === 403);
  const local = await denied(requireOwner(new Request("http://avelie.example/api/me", { headers }), env()));
  assert.equal(local.status, 503);
});

test("denials are JSON bodies with a code and never echo the token", async () => {
  const res = await denied(requireOwner(new Request("http://127.0.0.1:8790/api/me", { headers: { "cf-access-jwt-assertion": "secret-token-value" } }), env({ ACCESS_AUD: AUD })));
  const body = await res.json();
  assert.equal(typeof body.code, "string");
  assert.ok(!JSON.stringify(body).includes("secret-token-value"));
});

test("a 403 never says why: a fixed body, no detail; the reason goes to console.warn as a class-level message without the token", async () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    for (const token of ["secret-token-value", "a.b.c", "..", b64url("{}") + "." + b64url("{}") + ".sig"]) {
      const res = await denied(requireOwner(new Request("http://127.0.0.1:8790/api/me", { headers: { "cf-access-jwt-assertion": token } }), env({ ACCESS_AUD: AUD })));
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.deepEqual(body, { error: "forbidden", code: "forbidden" });
      assert.ok(!("detail" in body));
    }
    assert.ok(warn.mock.callCount() >= 1, "the reason is logged");
    for (const call of warn.mock.calls) {
      const line = call.arguments.map(String).join(" ");
      assert.ok(!line.includes("secret-token-value") && !line.includes("sig"), "log must not carry the token: " + line);
      assert.ok(/^access denied (malformed token|unsupported algorithm|unusable key|unknown key id|bad signature|wrong (issuer|audience|email)|expired|not yet valid|verification failed)$/.test(line), "log names the class: " + line);
    }
  } finally {
    warn.mock.restore();
  }
});
