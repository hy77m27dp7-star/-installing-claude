// v3.2 named snapshots: the key shape and the restore guard (the rest is the export and
// import the suite already covers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const backup = await loadSrc("backup");

test("snapshotKey: its own prefix, the day and time, a slug from the label, a fallback when the label is empty", () => {
  const now = new Date("2026-09-25T23:41:07.000Z");
  assert.equal(backup.snapshotKey("Before explicit test!", now), "snapshots/avelie-2026-09-25-2341-before-explicit-test.json");
  assert.equal(backup.snapshotKey("", now), "snapshots/avelie-2026-09-25-2341-snapshot.json");
  assert.ok(backup.snapshotKey("x".repeat(80), now).length < 100, "the slug is capped");
  assert.ok(!backup.snapshotKey("a", now).startsWith(backup.BACKUP_PREFIX), "never under backups/, so the nightly pruning cannot touch it");
});

test("restoreSnapshot: refuses a key outside the two prefixes before touching storage", async () => {
  const env = { MEDIA: { get: async () => { throw new Error("storage must not be read"); } } };
  for (const key of ["him/x.json", "../backups/avelie.json", "backups/../snapshots/x.json", "", 42]) {
    await assert.rejects(() => backup.restoreSnapshot(env, {}, key, "test"), /snapshot or a backup/);
  }
});
