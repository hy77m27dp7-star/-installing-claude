// The entry in v5 (SPEC_V5 "Crons" and "Routes added"), read as text: the 0 7 cron runs the
// nightly story pass after the maintenance, the */20 cron reads the clock once and passes
// frozen to the delayed-reply push, the CSP is v4's amended one unchanged, and every v5 route
// is registered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { repoText } from "./helpers_v5.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const index = repoText("src/index.ts");
const api = repoText("src/api.ts");

const V5_ROUTES = [
  ["GET", "/api/clock"], ["POST", "/api/nightly/run"], ["GET", "/api/nightly"],
  ["GET", "/api/beats"], ["GET", "/api/wants/:id/beats"], ["POST", "/api/wants/:id/beats"], ["PUT", "/api/beats/:id"], ["POST", "/api/beats/:id/resolve"],
  ["GET", "/api/views"], ["POST", "/api/views/:id/retire"],
  ["GET", "/api/world"], ["POST", "/api/world/facts"], ["DELETE", "/api/world/facts/:id"], ["POST", "/api/people/:id/rename"],
  ["GET", "/api/sent"],
  ["POST", "/api/messages/:id/song-feedback"], ["GET", "/api/known-artists"], ["POST", "/api/known-artists"], ["DELETE", "/api/known-artists/:id"],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("the 0 7 * * * handler runs the backup, then the maintenance, then runNightlyStory; the result carries nightly", () => {
  assert.ok(/import \{ runNightlyStory \} from "\.\/nightly";/.test(index));
  const handler = index.slice(index.indexOf("if (cron === CRON_BACKUP)"));
  const backup = handler.indexOf("runBackup(");
  const maintenance = handler.indexOf("runMaintenance(");
  const story = handler.indexOf("runStoryPass(");
  assert.ok(backup >= 0 && maintenance > backup && story > maintenance, `${backup} ${maintenance} ${story}`);
  assert.ok(/return \{ \.\.\.backup, maintenance, nightly \};/.test(handler));
  assert.ok(/runNightlyStory\(env, db, settings, \{ now: at \}\)/.test(index));
  assert.ok(/const CRON_BACKUP = "0 7 \* \* \*";/.test(index));
});

test("the */20 handler reads the clock once and passes frozen to pushDueReplies", () => {
  const tick = index.slice(index.indexOf("if (cron === CRON_HER_FIRST)"));
  assert.ok(/const clock = await loadStoryClock\(db, settings, at\);/.test(tick));
  assert.ok(/pushDueReplies\(env, db, at, \{ quiet, frozen: clock\.frozen \}\)/.test(tick));
  assert.ok(tick.indexOf("loadStoryClock(") < tick.indexOf("pushDueReplies("));
});

test("no new cron trigger in wrangler.jsonc", () => {
  const w = repoText("wrangler.jsonc");
  const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(w);
  assert.ok(crons);
  assert.deepEqual(crons[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean).sort(), ["*/20 * * * *", "0 13 * * 1", "0 14 * * 1", "0 7 * * *"].sort());
});

test("the CSP string and its origins are v4's amended ones, unchanged", (tc) => {
  let v4;
  try {
    v4 = execFileSync("git", ["show", "b0e1f35:src/index.ts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    tc.diagnostic("git or the v4 head b0e1f35 not available; skipping the CSP comparison");
    return;
  }
  const lines = (src) => src.split("\n").filter((l) => /^const (CSP|REALTIME_ORIGIN|SPOTIFY_SDK_ORIGIN|SPOTIFY_EMBED_ORIGIN|SPOTIFY_CONNECT|ELEVENLABS_CONNECT|PERMISSIONS_POLICY) = /.test(l));
  assert.equal(lines(v4).length, 7);
  assert.deepEqual(lines(index), lines(v4));
  assert.ok(/default-src 'self';/.test(index));
});

test("src/api.ts registers every v5 route", () => {
  for (const [method, path] of V5_ROUTES) {
    assert.ok(new RegExp('route\\("' + method + '", "' + esc(path) + '"').test(api), method + " " + path);
  }
});

test("src/api.ts: the edited.kind check reads PROPOSAL_KINDS from src/proposals.ts, not a local v1 list", () => {
  assert.ok(/import \{[^}]*\bPROPOSAL_KINDS\b[^}]*\} from "\.\/proposals";/.test(api));
  assert.ok(!/const PROPOSAL_KINDS\s*[:=]/.test(api));
});
