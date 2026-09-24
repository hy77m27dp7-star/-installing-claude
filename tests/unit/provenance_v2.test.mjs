// src/provenance.ts: one context row per assistant message, ids and counts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { fakeDb } from "./helpers_v2.mjs";

const { writeContext, readContext, contextStmt } = await loadSrc("provenance");

const CTX = {
  promptVersion: "c-test-p4",
  provider: "stub",
  model: "claude-opus-5",
  historyIds: ["h1"],
  factIds: { avelie: ["f1", "f2"], justin: [] },
  threadIds: ["lt1"],
  callbacks: [{ sourceId: "h1", ageDays: 11, text: "the bench" }],
  unknownIds: [],
  recentMessageCount: 7,
  flags: ["caption_tail"],
};

test("writeContext: an upsert keyed by message id with the JSON and a timestamp", async () => {
  const db = fakeDb();
  await writeContext(db, "m_1", CTX);
  assert.equal(db.writes.length, 1);
  const w = db.writes[0];
  assert.ok(/INSERT INTO message_context/i.test(w.sql));
  assert.ok(/ON CONFLICT\s*\(\s*message_id\s*\)/i.test(w.sql), "a retried commit replaces, never duplicates");
  assert.equal(w.binds[0], "m_1");
  assert.deepEqual(JSON.parse(w.binds[1]), CTX);
  assert.ok(Number.isFinite(Date.parse(w.binds[2])));
});

test("contextStmt: the same insert as a statement for the turn's batch", () => {
  const db = fakeDb();
  const stmt = contextStmt(db, "m_2", CTX);
  assert.equal(typeof stmt.run, "function");
  assert.equal(stmt.binds[0], "m_2");
});

test("writeContext: refuses an empty message id and an oversized context", async () => {
  const db = fakeDb();
  await assert.rejects(() => writeContext(db, "", CTX));
  await assert.rejects(() => writeContext(db, "m_big", { pad: "x".repeat(70 * 1024) }), /exceeds/);
  assert.equal(db.writes.length, 0);
});

test("readContext: returns the parsed object, null when missing, null for bad JSON or a non-object", async () => {
  const hit = fakeDb({ message_context: [{ message_id: "m_1", json: JSON.stringify(CTX), created_at: "2026-09-24T00:00:00.000Z" }] });
  assert.deepEqual(await readContext(hit, "m_1"), CTX);
  assert.equal(await readContext(fakeDb({ message_context: [] }), "m_1"), null);
  assert.equal(await readContext(hit, ""), null);
  assert.equal(await readContext(fakeDb({ message_context: [{ json: "{not json" }] }), "m_1"), null);
  assert.equal(await readContext(fakeDb({ message_context: [{ json: "[1,2]" }] }), "m_1"), null);
});

test("provenance never carries prompt text or a secret", async () => {
  const db = fakeDb();
  await writeContext(db, "m_3", CTX);
  const json = db.writes[0].binds[1];
  assert.ok(!json.includes("sk-"));
  assert.ok(!/FIXED CANON|YOUR LIFE RIGHT NOW/.test(json));
});
