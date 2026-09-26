// The v4 migration (SPEC_V4 "Migration 0008_v4.sql"): 0008 carries the three tables, the
// index, the three ADD COLUMN lines and the thirteen INSERT OR IGNORE settings rows with the
// fixed stamp; nothing destructive; every table and index IF NOT EXISTS; the NOT NULL column
// carries a default; 0001 to 0007 still match git HEAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const read = (f) => readFileSync(join(DIR, f), "utf8");
const present = existsSync(join(DIR, "0008_v4.sql"));
const t = present ? test : (name, fn) => test.skip(name + " [skipped: migrations/0008_v4.sql not in this tree yet]", fn);

const STAMP = "2026-09-26T00:00:00.000Z";
// The nine of the spec table plus amendment A's four (the integrator added those rows so
// `npm run db:remote` is the whole settings step; each value is the shipped default).
const THIRTEEN = {
  avatarAssetId: '"master-05"', callFaceProvider: '"clips"', callFaceSourceAssetId: '"master-00"', hisFaceInPhotos: "true",
  spotifyEnabled: "false", spotifyPlaylistId: '""', spotifyPlaylistName: '"songs from avelie"', placeCostUsd: "0.08", listeningLineEnabled: "true",
  spotifyPlayer: '"sdk"', elevenLabsModel: '"eleven_multilingual_v2"', elevenLabsTtsPricePer1kChars: "0.3", videoMarkerEnabled: "true",
};

t("0008_v4.sql: the places, spotify_auth and panel_cache tables, the title_norm index, every one IF NOT EXISTS", () => {
  const sql = read("0008_v4.sql");
  for (const table of ["places", "spotify_auth", "panel_cache"]) assert.ok(new RegExp("CREATE TABLE IF NOT EXISTS\\s+" + table + "\\s*\\(", "i").test(sql), table);
  assert.ok(/CREATE INDEX IF NOT EXISTS\s+idx_places_title_norm\s+ON places\(title_norm\)/i.test(sql), "the index");
  assert.equal((sql.match(/CREATE TABLE/gi) ?? []).length, 3);
  assert.equal((sql.match(/CREATE INDEX/gi) ?? []).length, 1);
  assert.ok(!/CREATE (TABLE|INDEX)(?! IF NOT EXISTS)/i.test(sql), "nothing without IF NOT EXISTS");
});

t("0008_v4.sql: the places columns and checks, the one-row Spotify table with its checks, the cache's three columns", () => {
  const sql = read("0008_v4.sql");
  const places = /CREATE TABLE IF NOT EXISTS places \(([^;]*)\);/i.exec(sql)[1];
  for (const col of ["id TEXT PRIMARY KEY", "thread_id TEXT UNIQUE", "title TEXT NOT NULL", "title_norm TEXT NOT NULL", "detail TEXT", "lat REAL", "lon REAL", "geocoded_by TEXT CHECK (geocoded_by IN ('owner','openmeteo','map'))", "picture_key TEXT", "picture_sha256 TEXT", "picture_bytes INTEGER", "picture_light TEXT CHECK (picture_light IN ('day','night'))", "picture_season TEXT", "picture_prompt TEXT", "picture_provider TEXT", "picture_model TEXT", "picture_made_at TEXT", "last_used_at TEXT", "created_at TEXT NOT NULL", "updated_at TEXT NOT NULL"]) {
    assert.ok(places.includes(col), "places: " + col);
  }
  const spotify = /CREATE TABLE IF NOT EXISTS spotify_auth \(([^;]*)\);/i.exec(sql)[1];
  assert.ok(/id TEXT PRIMARY KEY CHECK \(id = 'owner'\)/.test(spotify), "one row, id owner");
  assert.ok(/status TEXT NOT NULL CHECK \(status IN \('pending','connected'\)\)/.test(spotify));
  for (const col of ["state TEXT", "refresh_token TEXT", "access_token TEXT", "access_expires_at TEXT", "scope TEXT", "spotify_user_id TEXT", "display_name TEXT", "created_at TEXT NOT NULL", "updated_at TEXT NOT NULL"]) assert.ok(spotify.includes(col), "spotify_auth: " + col);
  const cache = /CREATE TABLE IF NOT EXISTS panel_cache \(([^;]*)\);/i.exec(sql)[1];
  assert.equal(cache.trim(), "k TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL");
});

t("0008_v4.sql: the three ADD COLUMN lines, with_him NOT NULL DEFAULT 0", () => {
  const sql = read("0008_v4.sql");
  assert.ok(/ALTER TABLE visual_assets ADD COLUMN with_him INTEGER NOT NULL DEFAULT 0;/.test(sql));
  assert.ok(/ALTER TABLE messages ADD COLUMN spotify_status TEXT;/.test(sql));
  assert.ok(/ALTER TABLE messages ADD COLUMN pushed_at TEXT;/.test(sql));
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 3);
});

t("0008_v4.sql: the thirteen INSERT OR IGNORE settings rows with the fixed stamp, JSON text values, and no other insert", () => {
  const sql = read("0008_v4.sql");
  const rows = Array.from(sql.matchAll(/INSERT OR IGNORE INTO settings \(key, value, updated_at\) VALUES \('([A-Za-z0-9]+)', '([^']*)', '([^']+)'\);/g));
  assert.equal(rows.length, 13, "thirteen rows");
  const seen = {};
  for (const r of rows) {
    seen[r[1]] = r[2];
    assert.equal(r[3], STAMP, r[1] + " stamp");
    assert.doesNotThrow(() => JSON.parse(r[2]), r[1] + " value is JSON text");
  }
  assert.deepEqual(seen, THIRTEEN);
  assert.equal((sql.match(/INSERT/g) ?? []).length, 13, "no other insert");
  assert.ok(!/INSERT INTO/.test(sql), "OR IGNORE on every row: a seeded table is untouched");
});

t("0008_v4.sql never UPDATEs, DELETEs or DROPs; every statement ends in a semicolon; clean typography; the header names the deploy order", () => {
  const sql = read("0008_v4.sql");
  const body = sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
  assert.ok(!/^\s*(UPDATE|DELETE|DROP|TRUNCATE|REPLACE)\b/im.test(body.join("\n")), "found a destructive statement");
  assert.ok(!/ADD COLUMN[^;]*NOT NULL(?![^;]*DEFAULT)/i.test(sql), "a NOT NULL column needs a default on a table with rows");
  for (const l of body) assert.ok(/;\s*$/.test(l), "statement without a semicolon: " + l.slice(0, 60));
  assert.equal(body.length, 3 + 1 + 3 + 13, "3 tables, 1 index, 3 columns, 13 rows");
  assert.ok(!BAD_TYPOGRAPHY.test(sql));
  assert.ok(/Apply REMOTELY BEFORE the deploy/.test(sql), "the header carries the deploy order");
  assert.ok(sql.length < 100_000, "under the 100 KB statement limit, whole");
});

test("the ledger's order: 0008 sorts after 0007 and nothing sorts after 0008", () => {
  const idx = files.indexOf("0008_v4.sql");
  if (idx < 0) return;
  assert.equal(files[idx - 1], "0007_his_face.sql");
  assert.equal(idx, files.length - 1, "0008 is the last migration");
});

test("the frozen migrations 0001 to 0007 match git HEAD", (tc) => {
  for (const f of ["0001_init.sql", "0003_messages_seq_unique.sql", "0004_life.sql", "0004b_push.sql", "0004c_voiceprint.sql", "0004d_media.sql", "0005_v3.sql", "0005b_voicebank_seed.sql", "0006_tasting_context.sql", "0007_his_face.sql"]) {
    if (!files.includes(f)) continue;
    let committed;
    try {
      committed = execFileSync("git", ["show", "HEAD:migrations/" + f], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      tc.diagnostic("git not available or no HEAD; skipping the frozen check for " + f);
      continue;
    }
    assert.equal(read(f), committed, f + " differs from HEAD");
  }
});

test("0002_seed.sql is byte for byte the v3.3 file (35e9ce5): build:canon leaves the v4 settings to 0008's INSERT OR IGNORE rows, so an applied migration is never edited", (tc) => {
  let v33;
  try {
    v33 = execFileSync("git", ["show", "35e9ce5:migrations/0002_seed.sql"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    tc.diagnostic("git or commit 35e9ce5 not available; skipping the 0002 pin");
    return;
  }
  assert.equal(read("0002_seed.sql"), v33, "0002_seed.sql differs from v3.3");
  for (const key of Object.keys(THIRTEEN)) assert.ok(!read("0002_seed.sql").includes("('" + key + "'"), key + " belongs to 0008, not 0002");
});
