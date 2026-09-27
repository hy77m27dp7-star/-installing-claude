// State that moves and memory hygiene in the store (SPEC_V5 sections 4 and 7, src/state.ts):
// the six new relationship keys, the friction stamp, the strict scene PUT, facts that are her
// guesses, mergeFacts and setFactInferred.
import { test } from "node:test";
import assert from "node:assert/strict";
import { factRow, relationshipState, sceneState } from "./helpers.mjs";
import { loadSrcIfPresent, guard, scriptedD1 } from "./helpers_v5.mjs";

const state = await loadSrcIfPresent("state");
const t = guard(state, "normalizeRelationshipFields", "putState", "createFact", "updateFact", "mergeFacts", "setFactInferred");

const SET = "2026-09-25T12:00:00.000Z";

function stateDb(entity, cur) {
  return scriptedD1([
    [/FROM state_versions WHERE entity = \?1 ORDER BY version DESC LIMIT 1/, (b) => (b[0] === entity ? [{ id: "st_1", entity, version: 4, state_json: JSON.stringify(cur), source: "owner", note: null, created_at: SET }] : [])],
  ]);
}
const stored = (db) => JSON.parse(db.log.find((e) => /INSERT INTO state_versions/.test(e.sql)).binds[3]);

t("normalizeRelationshipFields: the six new keys validated", () => {
  const ok = state.normalizeRelationshipFields({ friction: " the photo thing ", friction_set_at: SET, friction_days: 3, cooling_off_set_at: SET, cooling_off_hours: 24, status_before: " friends " });
  assert.equal(ok.friction, "the photo thing");
  assert.equal(ok.friction_days, 3);
  assert.equal(ok.cooling_off_hours, 24);
  assert.equal(ok.status_before, "friends");
  assert.throws(() => state.normalizeRelationshipFields({ friction: "x".repeat(201) }), (e) => e.status === 400);
  assert.throws(() => state.normalizeRelationshipFields({ friction: "x", friction_days: 15 }), (e) => e.status === 400);
  assert.throws(() => state.normalizeRelationshipFields({ cooling_off_hours: 337 }), (e) => e.status === 400);
  assert.throws(() => state.normalizeRelationshipFields({ friction: "x", friction_set_at: "not a time" }), (e) => e.status === 400);
  assert.throws(() => state.normalizeRelationshipFields({ status_before: 3 }), (e) => e.status === 400);
  const empty = state.normalizeRelationshipFields({ friction: "", friction_set_at: SET });
  assert.ok(!("friction" in empty) && !("friction_set_at" in empty), "an empty friction removes it and its clock");
  assert.equal(state.normalizeRelationshipFields({ cooling_off_hours: null }).cooling_off_hours, null);
});

t("putState relationship: a new friction is stamped now; the same friction keeps its stamp; 'none' carries no stamp", async () => {
  const cur = relationshipState({ friction: "the photo thing", friction_set_at: SET });
  const same = stateDb("relationship", cur);
  await state.putState(same, "relationship", { ...cur, friction_set_at: undefined }, null, "owner");
  assert.equal(stored(same).friction_set_at, SET);
  const changed = stateDb("relationship", cur);
  await state.putState(changed, "relationship", { ...cur, friction: "the call" }, null, "owner");
  assert.notEqual(stored(changed).friction_set_at, SET);
  assert.ok(Date.parse(stored(changed).friction_set_at) > Date.parse(SET));
  const healed = stateDb("relationship", cur);
  await state.putState(healed, "relationship", { ...cur, friction: "none" }, null, "owner");
  assert.ok(!("friction_set_at" in stored(healed)));
});

t("putState relationship: the owner's cooling-off clear (cooling_off_until only) drops the story-time pair; his new deadline becomes the pair; a write that sets the pair keeps it", async () => {
  const cur = relationshipState({ mood: "annoyed", cooling_off_until: "2026-09-26T00:00:00.000Z", cooling_off_set_at: SET, cooling_off_hours: 12 });
  const cleared = stateDb("relationship", cur);
  await state.putState(cleared, "relationship", { ...cur, cooling_off_until: null }, null, "owner");
  assert.equal(stored(cleared).cooling_off_until, null);
  assert.equal(stored(cleared).cooling_off_set_at, null);
  assert.equal(stored(cleared).cooling_off_hours, null);
  // Review fix: his own deadline runs on story time too (held days never run it out): it is
  // written as the pair, set now, for the hours until it.
  const before = Date.now();
  const deadline = new Date(before + 48 * 3600 * 1000).toISOString();
  const moved = stateDb("relationship", cur);
  await state.putState(moved, "relationship", { ...cur, cooling_off_until: deadline }, null, "owner");
  assert.equal(stored(moved).cooling_off_until, deadline);
  const setAt = Date.parse(stored(moved).cooling_off_set_at);
  assert.ok(setAt >= before && setAt <= Date.now(), "set when he saved it, not the pair he overrode");
  assert.ok(Math.abs(stored(moved).cooling_off_hours - 48) < 0.01, "the hours until his deadline");
  const past = stateDb("relationship", cur);
  await state.putState(past, "relationship", { ...cur, cooling_off_until: new Date(before - 3600 * 1000).toISOString() }, null, "owner");
  assert.equal(stored(past).cooling_off_set_at, null, "a deadline already past is no cooling off");
  assert.equal(stored(past).cooling_off_hours, null);
  const proposal = stateDb("relationship", cur);
  const later = "2026-09-26T06:00:00.000Z";
  await state.putState(proposal, "relationship", { ...cur, cooling_off_until: "2026-09-26T18:00:00.000Z", cooling_off_set_at: later, cooling_off_hours: 12 }, null, "auto", "proposal");
  assert.equal(stored(proposal).cooling_off_set_at, later);
  assert.equal(stored(proposal).cooling_off_hours, 12);
  const untouched = stateDb("relationship", cur);
  await state.putState(untouched, "relationship", { ...cur, mood: "fine" }, null, "owner");
  assert.equal(stored(untouched).cooling_off_set_at, SET);
});

t("putState scene: the owner's together scene with no place is 400; every scene version carries the four keys", async () => {
  const db = stateDb("scene", sceneState({ status: "apart" }));
  await assert.rejects(state.putState(db, "scene", { status: "together" }, null, "owner"), (e) => e.status === 400 && /a together scene needs a place/.test(e.message));
  const ok = stateDb("scene", sceneState({ status: "apart", time: "late, past midnight" }));
  await state.putState(ok, "scene", { status: "together", location: "the harbour bench", time: "late, past midnight" }, null, "owner");
  const s = stored(ok);
  for (const k of ["status", "location", "time", "present"]) assert.ok(k in s, k);
  assert.equal(s.time, null, "the chat's toggle sends the old time back; a new scene never inherits it");
});

t("createFact: inferred writes the column only when the row is a guess", async () => {
  const db = scriptedD1();
  const guess = await state.createFact(db, { scope: "justin", fact: "he works nights", inferred: true }, "auto");
  assert.equal(guess.inferred, 1);
  const plain = await state.createFact(db, { scope: "justin", fact: "he is 44" }, "auto");
  assert.equal(plain.inferred, 0);
  const inserts = db.log.filter((e) => /INSERT INTO facts/.test(e.sql));
  assert.match(inserts[0].sql, /, inferred\)/);
  assert.ok(!/inferred/.test(inserts[1].sql), "a database behind 0009 keeps working");
});

t("updateFact carries old.inferred; setFactInferred marks the guess and appends the reason to the source", async () => {
  const old = { ...factRow({ id: "f_1", scope: "justin", fact: "he hates mornings", source: "proposal p_1" }), inferred: 1 };
  const db = scriptedD1([[/SELECT \* FROM facts WHERE id = \?1/, (b) => (b[0] === "f_1" ? [old] : [])]]);
  const up = await state.updateFact(db, "f_1", { fact: "he hates early mornings" }, "owner");
  assert.equal(up.inferred, 1);
  const plainOld = factRow({ id: "f_1", scope: "justin", fact: "he hates mornings", source: "proposal p_1" });
  const db2 = scriptedD1([[/SELECT \* FROM facts WHERE id = \?1/, (b) => (b[0] === "f_1" ? [plainOld] : [])]]);
  const marked = await state.setFactInferred(db2, "f_1", true, "nightly hygiene 2026-09-29 r", "auto");
  assert.equal(marked.inferred, 1);
  assert.equal(marked.source, "proposal p_1 | nightly hygiene 2026-09-29 r");
  assert.equal(marked.supersedes_id, "f_1");
});

t("mergeFacts: the batch shape (keep superseded, new head with the joined source, each merged head rejected 'merged into', the weight upsert with HAVING)", async () => {
  const facts = {
    f_keep: factRow({ id: "f_keep", scope: "justin", fact: "Justin is 44", source: "proposal p_1" }),
    f_dup: factRow({ id: "f_dup", scope: "justin", fact: "Justin is forty-four", source: "proposal p_2" }),
    f_her: factRow({ id: "f_her", scope: "avelie", fact: "she is 22" }),
    f_fixed: factRow({ id: "f_fixed", scope: "fixed", fact: "She is 22." }),
    f_old: factRow({ id: "f_old", scope: "justin", fact: "x", status: "superseded" }),
  };
  const db = scriptedD1([[/SELECT \* FROM facts WHERE id = \?1/, (b) => (facts[b[0]] ? [facts[b[0]]] : [])]]);
  const head = await state.mergeFacts(db, { keepId: "f_keep", mergeIds: ["f_dup"], text: "Justin is 44", source: "nightly hygiene 2026-09-29 exact" }, "auto");
  assert.equal(head.supersedes_id, "f_keep");
  assert.equal(head.version, 2);
  assert.equal(head.source, "merged: proposal p_1; proposal p_2");
  assert.equal(head.inferred, 0);
  const batch = db.log.filter((e) => e.via === "batch").map((e) => e.sql);
  assert.match(batch[0], /UPDATE facts SET status = 'superseded'/);
  assert.match(batch[1], /INSERT INTO facts/);
  const rejectedInsert = db.log.filter((e) => e.via === "batch" && /INSERT INTO facts/.test(e.sql))[1];
  assert.ok(rejectedInsert.binds.includes("rejected"));
  assert.ok(rejectedInsert.binds.includes("merged into " + head.id));
  const weight = db.log.find((e) => /INSERT INTO memory_weights/.test(e.sql) && /HAVING COUNT\(\*\) > 0/.test(e.sql));
  assert.ok(weight, "the weight upsert with HAVING");
  assert.deepEqual(weight.binds.slice(2), ["f_keep", "f_dup"]);
  assert.ok(db.log.some((e) => /INSERT INTO audit_events/.test(e.sql) && e.binds.includes("fact.merge")));
  await assert.rejects(state.mergeFacts(db, { keepId: "f_keep", mergeIds: ["f_her"], text: "x", source: "s" }, "auto"), (e) => e.status === 400);
  await assert.rejects(state.mergeFacts(db, { keepId: "f_keep", mergeIds: ["f_fixed"], text: "x", source: "s" }, "auto"), (e) => e.status === 403);
  await assert.rejects(state.mergeFacts(db, { keepId: "f_keep", mergeIds: ["f_old"], text: "x", source: "s" }, "auto"), (e) => e.status === 409);
  await assert.rejects(state.mergeFacts(db, { keepId: "f_keep", mergeIds: ["f_keep"], text: "x", source: "s" }, "auto"), (e) => e.status === 400);
  await assert.rejects(state.mergeFacts(db, { keepId: "f_nope", mergeIds: ["f_dup"], text: "x", source: "s" }, "auto"), (e) => e.status === 404);
});
