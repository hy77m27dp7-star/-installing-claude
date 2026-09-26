// The entry and the router in v4 (SPEC_V4 header, section 8, "Routes added", amendment A1
// and A2, A4): src/index.ts read as text (the AMENDED content security policy: the Spotify
// SDK script and frames, the Spotify and ElevenLabs connect origins, nothing loosened; the
// place media path; the cron order, deliveries before her first texts), src/api.ts (every v4
// route registered; existence only, the router matches by segment count), and
// package.json's script chain (the file itself is L10's for the one dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const index = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const routerLanded = api.includes('route("GET", "/api/avatar"');
const entryLanded = /pushDueReplies/.test(index);
const cspLanded = /sdk\.scdn\.co/.test(index);
const ta = routerLanded ? test : (name, fn) => test.skip(name + " [skipped: src/api.ts has no v4 routes yet (pipeline lane)]", fn);
const te = entryLanded ? test : (name, fn) => test.skip(name + " [skipped: src/index.ts has no v4 entry changes yet (pipeline lane)]", fn);
const tc = cspLanded ? test : (name, fn) => test.skip(name + " [skipped: src/index.ts still carries the v3 CSP (pipeline lane applies A1 and A2)]", fn);

function cspOf() {
  const m = /const CSP = `([^`]+)`/.exec(index) ?? /const CSP = "([^"]+)"/.exec(index);
  assert.ok(m, "a CSP constant");
  // The constants the template names, read from the same file (const NAME = "...").
  return m[1].replace(/\$\{([A-Z_]+)\}/g, (whole, name) => {
    const c = new RegExp("const " + name + ' = "([^"]+)"').exec(index);
    return c ? c[1] : whole;
  });
}

const directive = (csp, name) => {
  const part = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));
  return part ? part.slice(name.length).trim().split(/\s+/) : null;
};

tc("CSP (amended): script-src self and the Spotify SDK; frame-src the SDK and the embed; connect-src self, the realtime origin, the Spotify API and dealer, the ElevenLabs API; img and media as before; nothing loosened", () => {
  const csp = cspOf();
  assert.deepEqual(directive(csp, "default-src"), ["'self'"]);
  assert.deepEqual(directive(csp, "script-src"), ["'self'", "https://sdk.scdn.co"]);
  assert.deepEqual(directive(csp, "frame-src"), ["https://sdk.scdn.co", "https://open.spotify.com"]);
  const connect = directive(csp, "connect-src");
  assert.ok(connect, "connect-src");
  for (const origin of ["'self'", "https://api.openai.com", "https://api.spotify.com", "https://*.spotify.com", "wss://*.spotify.com", "https://api.elevenlabs.io", "wss://api.elevenlabs.io"]) assert.ok(connect.includes(origin), "connect-src " + origin + " in " + connect.join(" "));
  const known = new Set(["'self'", "https://api.openai.com", "https://api.spotify.com", "https://*.spotify.com", "wss://*.spotify.com", "https://api.elevenlabs.io", "wss://api.elevenlabs.io"]);
  for (const o of connect) assert.ok(known.has(o) || /elevenlabs|livekit/.test(o), "an origin the spec does not name: " + o + " (the integrator adds only what docs/ELEVENLABS.md records)");
  assert.deepEqual(directive(csp, "img-src"), ["'self'", "data:", "blob:"]);
  assert.deepEqual(directive(csp, "media-src"), ["'self'", "blob:"]);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "base-uri"), ["'self'"]);
  assert.deepEqual(directive(csp, "form-action"), ["'self'"]);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), "nothing loosened");
  assert.ok(!/ \*(;|$)/.test(csp) && !/'\*'/.test(csp), "no bare wildcard");
  assert.ok(!/style-src/.test(csp), "no style-src: styles come from the one stylesheet and the CSSOM");
});

test("the permissions policy still grants the microphone to this origin only", () => {
  const m = /const PERMISSIONS_POLICY = "([^"]+)"/.exec(index);
  assert.ok(m, "a permissions policy constant");
  assert.ok(/microphone=\(self\)/.test(m[1]) && /camera=\(\)/.test(m[1]));
});

te("the place media path: GET /media/place/:id serves through servePlacePicture; /media/:id keeps its Range", () => {
  assert.ok(/from "\.\/places"/.test(index), "places imported");
  assert.ok(/parts\.length === 2 && kind === "place"/.test(index), "the two-segment place path");
  assert.ok(/servePlacePicture\(env, env\.DB, a\)/.test(index), "servePlacePicture(env, env.DB, a)");
  assert.ok(/serveMedia\(env, env\.DB, kind, range(, [^)]+)?\)/.test(index), "the range rides along on /media/:id");
});

te("the */20 cron runs pushDueReplies before maybeTextFirst and returns both", () => {
  assert.ok(/from "\.\/deliveries"/.test(index), "deliveries imported");
  const push = index.indexOf("pushDueReplies(env, db, at)");
  const first = index.indexOf("maybeTextFirst(env, db, settings, at)");
  assert.ok(push >= 0, "pushDueReplies(env, db, at)");
  assert.ok(first > push, "deliveries first, then her first texts");
  assert.ok(index.indexOf("await runBackup(env, db)") < index.indexOf("await runMaintenance(env, db)"), "the nightly order is unchanged");
});

ta("api.ts: every v4 route of the table is registered (existence only: matchRoute matches on segment count)", () => {
  const routes = [
    ["GET", "/api/avatar"],
    ["GET", "/api/phone"], ["GET", "/api/places"], ["POST", "/api/places"], ["PUT", "/api/places/:id"], ["POST", "/api/places/:id/geocode"], ["POST", "/api/places/:id/picture"], ["DELETE", "/api/places/:id/picture"],
    ["GET", "/api/callface"], ["POST", "/api/callface/make"],
    ["GET", "/api/album"], ["GET", "/api/memory/map"],
    ["GET", "/api/spotify"], ["GET", "/api/spotify/connect"], ["GET", "/api/spotify/callback"], ["POST", "/api/spotify/disconnect"], ["POST", "/api/messages/:id/spotify"],
    ["GET", "/api/spotify/token"],
  ];
  for (const [method, path] of routes) assert.ok(api.includes(`route("${method}", "${path}"`), `${method} ${path}`);
  assert.ok(/AVATAR_FOCUS/.test(api), "the focus table copy");
  assert.ok(/V4_EXTRA_KEYS/.test(api), "a stored table without the v4 keys still validates");
  assert.ok(/placeCostUsd must be above 0/.test(api), "the place price rule");
  assert.ok(!/console\.(log|warn|error)\([^)]*(refresh_token|access_token|accessToken|clientSecret)/.test(api), "no token is ever logged");
  assert.ok(!BAD_TYPOGRAPHY.test(api) && !BAD_TYPOGRAPHY.test(index));
});

test("package.json: the script chain is unchanged (test, deploy, db:remote, dev); the one v4 dependency, when present, is the ElevenLabs client", () => {
  assert.ok(/npm run build:canon && npm run build:voicebank && npm run check:typography && npm run check:assets && npm run typecheck && npm run test:unit/.test(pkg.scripts.test), pkg.scripts.test);
  assert.ok(/npm test && npm run check:deploy && wrangler deploy/.test(pkg.scripts.deploy), pkg.scripts.deploy);
  assert.equal(pkg.scripts["db:remote"], "wrangler d1 migrations apply avelie --remote");
  assert.equal(pkg.scripts["test:integration"], "node tests/integration/run.mjs");
  assert.ok(/wrangler dev --port 8787 --var ACCESS_AUD:/.test(pkg.scripts.dev));
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const d of deps) assert.ok(d === "@anthropic-ai/sdk" || d === "@elevenlabs/client", "an unexpected dependency: " + d);
});
