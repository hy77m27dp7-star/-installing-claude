// The entry and the scripts this lane owns (SPEC_V3 sections EE and Crons, the package
// chain): the content security policy and the permissions policy for the call, the
// nightly maintenance next to the backup, the Range on /media/:id, the test chain and the
// fine-tune script. Read as text: src/index.ts imports every lane's module and cannot be
// loaded under Node until the tree is integrated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const index = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");

test("CSP: the realtime origin in connect-src, blob: in media-src and img-src, nothing else opened", () => {
  const m = /const CSP = `([^`]+)`/.exec(index) ?? /const CSP = "([^"]+)"/.exec(index);
  assert.ok(m, "a CSP constant");
  let csp = m[1].replace(/\$\{REALTIME_ORIGIN\}/g, "https://api.openai.com");
  assert.ok(/connect-src 'self' https:\/\/api\.openai\.com(;|$)/.test(csp), csp);
  assert.ok(/media-src 'self' blob:(;|$)/.test(csp), csp);
  assert.ok(/img-src 'self' data: blob:(;|$)/.test(csp), csp);
  assert.ok(/default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /base-uri 'self'/.test(csp) && /form-action 'self'/.test(csp));
  assert.ok(!/elevenlabs/i.test(csp), "no ElevenLabs origin: the page never calls it");
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), "nothing loosened");
});

test("the permissions policy grants the microphone to this origin only", () => {
  const m = /const PERMISSIONS_POLICY = "([^"]+)"/.exec(index);
  assert.ok(m, "a permissions policy constant");
  assert.ok(/microphone=\(self\)/.test(m[1]), m[1]);
  assert.ok(/camera=\(\)/.test(m[1]));
  assert.ok(/h\.set\("permissions-policy", PERMISSIONS_POLICY\)/.test(index), "set on HTML responses");
});

test("the nightly cron runs the backup and then the maintenance pass, with the pass's failure swallowed", () => {
  assert.ok(/from "\.\/maintenance"/.test(index), "maintenance imported");
  assert.ok(/nightlyMaintenance\(env, db, settings\)/.test(index), "nightly(env, db, settings)");
  const backup = index.indexOf("await runBackup(env, db)");
  const maint = index.indexOf("await runMaintenance(env, db)");
  assert.ok(backup >= 0 && maint > backup, "backup first, then maintenance");
  assert.ok(/console\.error\("maintenance failed"/.test(index), "logged by class, not thrown");
});

test("/media/:id passes the Range header through", () => {
  assert.ok(/serveMedia\(env, env\.DB, kind, range(, [^)]+)?\)/.test(index), "the range rides along (a download flag may follow it)");
});

test("package.json: build:voicebank in the test chain, finetune:run, check:deploy kept in deploy", () => {
  assert.equal(pkg.scripts["build:voicebank"], "node scripts/build_voicebank.mjs");
  assert.ok(/npm run build:canon && npm run build:voicebank && /.test(pkg.scripts.test), pkg.scripts.test);
  assert.equal(pkg.scripts["finetune:run"], "node scripts/finetune_run.mjs");
  assert.ok(/npm run check:deploy && wrangler deploy/.test(pkg.scripts.deploy), pkg.scripts.deploy);
});

test("api.ts: every v3 route of the table is registered; the client secret is never logged", () => {
  const routes = [
    ['GET', '/api/voicebank'], ['POST', '/api/voicebank'], ['PUT', '/api/voicebank/:id'], ['POST', '/api/voicebank/:id/decide'], ['POST', '/api/voicebank/decide'],
    ['GET', '/api/corrections'], ['POST', '/api/corrections'], ['POST', '/api/corrections/:id/retire'], ['POST', '/api/corrections/:id/restore'],
    ['GET', '/api/memory'], ['PUT', '/api/memory/:entity/:id'], ['GET', '/api/memory/recalls'],
    ['GET', '/api/wants'], ['POST', '/api/wants'], ['PUT', '/api/wants/:id'], ['POST', '/api/wants/:id/log'], ['GET', '/api/wants/:id/log'], ['POST', '/api/asks'], ['PUT', '/api/asks/:id'],
    ['POST', '/api/grounding/geocode'], ['GET', '/api/grounding'], ['POST', '/api/grounding/log'], ['DELETE', '/api/grounding/log/:id'], ['POST', '/api/life/threads/:id/portrait'],
    ['POST', '/api/calls/start'], ['POST', '/api/calls/:id/tick'], ['POST', '/api/calls/:id/end'], ['GET', '/api/calls'], ['GET', '/api/calls/:id'],
    ['POST', '/api/video/generate'], ['POST', '/api/video/:id/poll'],
    ['GET', '/api/tastings/:id'], ['POST', '/api/tastings/:id/pick'], ['GET', '/api/tastings/ledger'], ['POST', '/api/tastings/promote'],
    ['POST', '/api/messages/:id/mark'], ['DELETE', '/api/messages/:id/mark'],
    ['GET', '/api/finetune/status'], ['GET', '/api/finetune/export.jsonl'], ['GET', '/api/finetune/export.json'], ['POST', '/api/finetune/use'], ['POST', '/api/finetune/revert'],
  ];
  for (const [method, path] of routes) assert.ok(api.includes(`route("${method}", "${path}"`), `${method} ${path}`);
  assert.ok(/const tasting = optBool\(body, "tasting"\) === true/.test(api), "the tasting flag on the turn route");
  assert.ok(/flagQuery\(url, "stripHim"\)/.test(api), "the stripHim query");
  assert.ok(!/console\.(log|warn|error)\([^)]*clientSecret/.test(api), "the secret is never logged");
  // The literal routes are registered before the parameter routes they share a shape with.
  assert.ok(api.indexOf('route("GET", "/api/tastings/ledger"') < api.indexOf('route("GET", "/api/tastings/:id"'));
  assert.ok(api.indexOf('route("POST", "/api/voicebank/decide"') < api.indexOf('route("POST", "/api/voicebank/:id/decide"'));
  assert.ok(api.indexOf('route("GET", "/api/memory/recalls"') < api.indexOf('route("PUT", "/api/memory/:entity/:id"'));
  assert.ok(!BAD_TYPOGRAPHY.test(api) && !BAD_TYPOGRAPHY.test(index));
});
