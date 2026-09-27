// The v5 migration (SPEC_V5 "Migration 0009_v5.sql"): 0009 is the spec's SQL verbatim, carries
// every table, index and column, the two guarded canon people and the twenty INSERT OR IGNORE
// settings rows, nothing destructive; 0001 to 0008 unchanged (the generated 0002 and 0005b
// are the build's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { V5_SETTINGS_TABLE } from "./helpers_v5.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const read = (f) => readFileSync(join(DIR, f), "utf8");
const present = existsSync(join(DIR, "0009_v5.sql"));
const t = present ? test : (name, fn) => test.skip(name + " [skipped: migrations/0009_v5.sql not in this tree yet]", fn);
const sql = present ? read("0009_v5.sql") : "";
const STAMP = "2026-09-26T00:00:00.000Z";
const TABLES = ["story_clock", "nightly_runs", "arc_beats", "beat_runs", "her_views", "people", "world_facts", "known_artists"];
const INDEXES = ["idx_story_clock_resumed", "idx_arc_beats_want", "idx_beat_runs_status", "idx_her_views_status", "idx_world_facts_live", "idx_world_facts_entity", "idx_messages_channel_created"];

t("0009_v5.sql is the spec's SQL block verbatim", () => {
  const spec = readFileSync(join(ROOT, "SPEC_V5.md"), "utf8");
  const at = spec.indexOf("## Migration 0009_v5.sql");
  const block = spec.slice(at).split("```sql\n")[1].split("\n```")[0];
  const norm = (s) => s.replace(/[ \t]+$/gm, "").trim();
  assert.equal(norm(sql), norm(block));
});

t("0009_v5.sql: the eight tables and the seven indexes, every one IF NOT EXISTS; the partial unique index on live world facts", () => {
  for (const table of TABLES) assert.ok(new RegExp("CREATE TABLE IF NOT EXISTS " + table + " \\(").test(sql), table);
  for (const idx of INDEXES) assert.ok(new RegExp("CREATE (UNIQUE )?INDEX IF NOT EXISTS " + idx + " ON ").test(sql), idx);
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 8);
  assert.equal((sql.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length, 7);
  assert.ok(!/CREATE (UNIQUE )?(TABLE|INDEX)(?! IF NOT EXISTS)/.test(sql), "nothing without IF NOT EXISTS");
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_world_facts_live ON world_facts\(entity_kind, entity_id, fact_norm\) WHERE status = 'approved';/.test(sql));
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages\(channel, created_at\);/.test(sql));
});

t("0009_v5.sql: story_clock carries prior_time and the deterministic key; the CHECK lists of the spec", () => {
  const clock = /CREATE TABLE IF NOT EXISTS story_clock \(([^;]*)\);/.exec(sql)[1];
  for (const col of ["id TEXT PRIMARY KEY", "opened_version INTEGER NOT NULL UNIQUE", "frozen_at TEXT NOT NULL", "closed_version INTEGER", "resumed_at TEXT", "weather_json TEXT", "outfit_json TEXT", "today_json TEXT", "prior_time TEXT", "beats_shifted_at TEXT"]) assert.ok(clock.includes(col), col);
  assert.ok(sql.includes("step TEXT NOT NULL CHECK (step IN ('her_day','arcs','views','hygiene'))"));
  assert.ok(sql.includes("PRIMARY KEY (day, step)"));
  assert.ok(sql.includes("outcome TEXT CHECK (outcome IN ('did_it','missed','went','went_well','went_badly','chickened_out','postponed'))"));
  assert.ok(sql.includes("his_part TEXT CHECK (his_part IN ('encouraged','asked','came','forgot','none'))"));
  assert.ok(sql.includes("UNIQUE (beat_id, reader)"));
  assert.ok(sql.includes("confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1)"));
  assert.ok(sql.includes("name_norm TEXT NOT NULL UNIQUE"));
  assert.ok(sql.includes("source TEXT NOT NULL CHECK (source IN ('button','proposal','owner'))"));
});

t("0009_v5.sql: the two ADD COLUMN lines; facts.inferred NOT NULL with a default", () => {
  assert.ok(sql.includes("ALTER TABLE facts ADD COLUMN inferred INTEGER NOT NULL DEFAULT 0;"));
  assert.ok(sql.includes("ALTER TABLE messages ADD COLUMN song_told_at TEXT;"));
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 2);
  assert.ok(!/ADD COLUMN[^;]*NOT NULL(?![^;]*DEFAULT)/i.test(sql), "a NOT NULL column needs a default on a table with rows");
});

t("0009_v5.sql: the two guarded canon people, her mother active and unnamed, Mason done, each WHERE NOT EXISTS with a fixed id", () => {
  // Statements end at a semicolon at the end of a line (her mother's detail carries one inside).
  const inserts = sql.split(/;\s*\n/).filter((s) => /INSERT INTO life_threads/.test(s));
  assert.equal(inserts.length, 2);
  const [mother, mason] = inserts;
  assert.ok(mother.includes("'lt_v5_canon_mother', 'person', 'her mother'"));
  assert.ok(/'active', 'mother'/.test(mother));
  assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM life_threads WHERE id = 'lt_v5_canon_mother' OR/.test(mother));
  assert.ok(mason.includes("'lt_v5_canon_mason', 'person', 'Mason'"));
  assert.ok(/'done', 'ex'/.test(mason), "Mason is her past: status done");
  assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM life_threads WHERE id = 'lt_v5_canon_mason' OR \(kind = 'person' AND lower\(trim\(title\)\) = 'mason'\)\)/.test(mason));
  assert.ok(!/Diane|Linda/.test(sql), "no name for her mother");
});

t("0009_v5.sql: the twenty INSERT OR IGNORE settings rows with the fixed stamp, JSON text values, the spec's defaults", () => {
  const rows = Array.from(sql.matchAll(/INSERT OR IGNORE INTO settings \(key, value, updated_at\) VALUES \('([A-Za-z0-9]+)', '([^']*)', '([^']+)'\);/g));
  assert.equal(rows.length, 20);
  const seen = {};
  for (const r of rows) {
    assert.equal(r[3], STAMP, r[1]);
    seen[r[1]] = JSON.parse(r[2]);
  }
  for (const [key, [def]] of Object.entries(V5_SETTINGS_TABLE)) assert.deepEqual(seen[key], def, key);
  assert.equal((sql.match(/INSERT/g) ?? []).length, 22, "twenty settings rows and the two canon people, nothing else");
});

t("0009_v5.sql never UPDATEs, DELETEs or DROPs; every statement ends in a semicolon; clean typography; the header names the deploy order", () => {
  const body = sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
  assert.ok(!/^\s*(UPDATE|DELETE|DROP|TRUNCATE|REPLACE)\b/im.test(body.join("\n")));
  assert.ok(!/INSERT OR REPLACE/i.test(sql));
  const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 8 + 7 + 2 + 2 + 20, "8 tables, 7 indexes, 2 columns, 2 people, 20 settings");
  assert.ok(!BAD_TYPOGRAPHY.test(sql));
  assert.ok(/Apply REMOTELY BEFORE the deploy/.test(sql));
  assert.ok(sql.length < 100_000);
});

test("the ledger's order: 0009 sorts after 0008; only 0010 (dirty talk, settings only) follows it", () => {
  const idx = files.indexOf("0009_v5.sql");
  if (idx < 0) return;
  assert.equal(files[idx - 1], "0008_v4.sql");
  assert.deepEqual(files.slice(idx + 1), files.includes("0010_dirty_talk.sql") ? ["0010_dirty_talk.sql"] : []);
});

test("0001 to 0008 match git HEAD (the generated 0002 and 0005b are the build's)", (tc) => {
  for (const f of files) {
    if (f === "0009_v5.sql" || f === "0010_dirty_talk.sql" || f === "0002_seed.sql" || f === "0005b_voicebank_seed.sql") continue;
    let committed;
    try {
      committed = execFileSync("git", ["show", "HEAD:migrations/" + f], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      tc.diagnostic("git not available or no HEAD; skipping the frozen check for " + f);
      continue;
    }
    assert.equal(read(f), committed, f + " differs from HEAD");
  }
  for (const key of Object.keys(V5_SETTINGS_TABLE)) assert.ok(!read("0002_seed.sql").includes("('" + key + "'"), key + " belongs to 0009, not 0002");
});
