// src/drift.ts and src/backup.ts, the parts that need no Worker: the embedded drift
// scenarios must be the five tagged in tests/behavior/scenarios.json (same turns, same
// checks), and the backup key is one object per day under backups/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc } from "./helpers.mjs";

const { DRIFT_SCENARIOS } = await loadSrc("drift");
const { backupKey, BACKUP_PREFIX, BACKUP_KEEP } = await loadSrc("backup");
const all = JSON.parse(readFileSync(new URL("../../tests/behavior/scenarios.json", import.meta.url), "utf8"));
const tagged = all.filter((s) => s.drift === true);

test("the Worker embeds exactly the five scenarios tagged drift in scenarios.json, in order", () => {
  assert.ok(Array.isArray(DRIFT_SCENARIOS));
  assert.equal(DRIFT_SCENARIOS.length, 5);
  assert.deepEqual(DRIFT_SCENARIOS.map((s) => s.id), tagged.map((s) => s.id));
});

test("each embedded scenario carries the same title, turns and checks as its scenarios.json row", () => {
  for (const s of DRIFT_SCENARIOS) {
    const row = tagged.find((t) => t.id === s.id);
    assert.ok(row, s.id + " not tagged drift in scenarios.json");
    assert.equal(s.title, row.title, s.id + " title");
    assert.deepEqual(s.turns, row.turns, s.id + " turns");
    assert.deepEqual(s.checks, row.autoChecks, s.id + " checks");
  }
});

test("drift scenarios are story turns only and cheap", () => {
  for (const s of DRIFT_SCENARIOS) assert.ok(!s.turns.some((t) => t.startsWith("OPERATOR: ")), s.id);
  assert.ok(DRIFT_SCENARIOS.reduce((n, s) => n + s.turns.length, 0) <= 20);
});

test("backupKey: backups/avelie-<YYYY-MM-DD>.json, one per day, 30 kept", () => {
  assert.equal(backupKey(new Date("2026-09-24T07:00:00Z")), "backups/avelie-2026-09-24.json");
  assert.equal(backupKey(new Date("2026-09-24T23:59:59Z")), "backups/avelie-2026-09-24.json");
  assert.equal(BACKUP_PREFIX, "backups/");
  assert.equal(BACKUP_KEEP, 30);
  assert.match(backupKey(), /^backups\/avelie-\d{4}-\d{2}-\d{2}\.json$/);
});
