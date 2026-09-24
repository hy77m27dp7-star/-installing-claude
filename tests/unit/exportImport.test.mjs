// importAll: what a payload may put in the database. Driven against the fake D1, so every
// statement the import would run is inspected and nothing is written anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, loadSrc } from "./helpers.mjs";

const { importAll } = await loadSrc("exportImport");

const ACTOR = "justin@newsomeprojects.com";
const FIXED_ID = "seed-fixed-age";

// An empty database that already holds one fixed-canon fact.
function db() {
  return fakeD1((sql) => (/SELECT id FROM facts WHERE scope = 'fixed'/.test(sql) ? [{ id: FIXED_ID }] : []));
}

function payload(overrides = {}) {
  return { version: 1, ...overrides };
}

async function rejected(p, re) {
  await assert.rejects(p, (e) => {
    assert.equal(e.status, 400, "status: " + e.status + " " + e.message);
    assert.equal(e.code, "validation");
    assert.ok(re.test(e.message), "message: " + e.message);
    return true;
  });
}

const inserts = (d, table) => d.log.filter((s) => s.via === "batch" && s.sql.startsWith(`INSERT INTO ${table} `));

// ------------------------------------------------------------------ (1) state_json is a plain object

test("stateVersions: state_json must parse to a plain JSON object, as a string or as an object", async () => {
  const row = (state_json) => payload({ stateVersions: [{ id: "st_1", entity: "relationship", version: 7, state_json }] });
  for (const bad of ["null", "[1,2]", "\"text\"", "42", "not json", null, [1], "true"]) {
    await rejected(importAll(db(), row(bad), ACTOR), /state_json/);
  }
  const asString = db();
  const r1 = await importAll(asString, row("{\"summary\":\"ok\"}"), ACTOR);
  assert.equal(r1.counts.stateVersions, 1);
  assert.equal(inserts(asString, "state_versions")[0].binds[3], "{\"summary\":\"ok\"}");
  const asObject = db();
  await importAll(asObject, row({ summary: "ok" }), ACTOR);
  assert.equal(inserts(asObject, "state_versions")[0].binds[3], "{\"summary\":\"ok\"}");
});

// ------------------------------------------------------------------ (2) length caps

test("caps: facts 4000, history body 20000, message content 20000, state JSON 100000 (the API's own ceilings)", async () => {
  const fact = (fact) => payload({ facts: [{ id: "f_1", scope: "avelie", fact }] });
  await rejected(importAll(db(), fact("x".repeat(4001)), ACTOR), /fact exceeds 4000/);
  assert.equal((await importAll(db(), fact("x".repeat(4000)), ACTOR)).counts.facts, 1);

  const entry = (body) => payload({ history: [{ id: "h_1", seq: 1, title: "t", body }] });
  await rejected(importAll(db(), entry("x".repeat(20001)), ACTOR), /body exceeds 20000/);
  assert.equal((await importAll(db(), entry("x".repeat(20000)), ACTOR)).counts.history, 1);

  const message = (content, role = "assistant") => payload({
    conversations: [{ id: "c_1" }],
    messages: [{ id: "m_1", conversation_id: "c_1", role, content, seq: 1 }],
  });
  await rejected(importAll(db(), message("x".repeat(20001)), ACTOR), /content exceeds 20000/);
  assert.equal((await importAll(db(), message("x".repeat(20000)), ACTOR)).counts.messages, 1);
  // A user line is capped where the turn and operator routes cap it (4000); only her
  // replies may run to the column's ceiling.
  await rejected(importAll(db(), message("x".repeat(4001), "user"), ACTOR), /messages\[0\]: content exceeds 4000 characters for a user message/);
  assert.equal((await importAll(db(), message("x".repeat(4000), "user"), ACTOR)).counts.messages, 1);

  const big = { pad: "x".repeat(100_000) };
  const state = (state_json) => payload({ stateVersions: [{ id: "st_1", entity: "scene", version: 2, state_json }] });
  await rejected(importAll(db(), state(JSON.stringify(big)), ACTOR), /state_json exceeds 100000/);
  await rejected(importAll(db(), state(big), ACTOR), /state_json exceeds 100000/);
  assert.equal((await importAll(db(), state({ pad: "x".repeat(99_000) }), ACTOR)).counts.stateVersions, 1);
});

test("caps: the smaller fields keep their API limits too (subject 200, title 300, topic 500, proposal 1000, ids 120)", async () => {
  await rejected(importAll(db(), payload({ facts: [{ id: "f_1", scope: "avelie", fact: "f", subject: "s".repeat(201) }] }), ACTOR), /subject exceeds 200/);
  await rejected(importAll(db(), payload({ history: [{ id: "h_1", seq: 1, title: "t".repeat(301), body: "b" }] }), ACTOR), /title exceeds 300/);
  await rejected(importAll(db(), payload({ unknowns: [{ id: "u_1", topic: "t".repeat(501) }] }), ACTOR), /topic exceeds 500/);
  await rejected(importAll(db(), payload({ proposals: [{ id: "p_1", kind: "avelie_fact", proposal: "p".repeat(1001) }] }), ACTOR), /proposal exceeds 1000/);
  await rejected(importAll(db(), payload({ conversations: [{ id: "c".repeat(121) }] }), ACTOR), /id exceeds 120/);
});

// ------------------------------------------------------------------ (3) fixed canon stays

test("fixed canon: payload rows with scope fixed are ignored and counted; the fixed rows on file are never deleted", async () => {
  const d = db();
  const r = await importAll(d, payload({
    facts: [
      { id: "f_evil", scope: "fixed", subject: "age", fact: "She is 24." },
      { id: FIXED_ID, scope: "fixed", subject: "age", fact: "She is 22 but louder." },
      { id: "f_ok", scope: "avelie", fact: "she keeps a plant alive out of spite" },
    ],
  }), ACTOR);
  assert.equal(r.counts.fixedIgnored, 2);
  assert.equal(r.counts.facts, 1);
  const factInserts = inserts(d, "facts");
  assert.equal(factInserts.length, 1);
  assert.equal(factInserts[0].binds[1], "avelie");
  assert.ok(!factInserts.some((s) => s.binds[1] === "fixed"), "no fixed row is ever inserted");
  const deletes = d.log.filter((s) => s.via === "batch" && /^DELETE FROM facts/.test(s.sql));
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].sql, "DELETE FROM facts WHERE scope != 'fixed'");
  assert.ok(!d.log.some((s) => /UPDATE facts/.test(s.sql)), "fixed rows are not updated either");
});

test("fixed canon: a payload row of another scope may not take a fixed row's id or claim to supersede it", async () => {
  await rejected(importAll(db(), payload({ facts: [{ id: FIXED_ID, scope: "avelie", fact: "She is 24." }] }), ACTOR), /belongs to fixed canon/);
  await rejected(importAll(db(), payload({ facts: [{ id: "f_2", scope: "avelie", fact: "She is 24.", version: 2, supersedes_id: FIXED_ID }] }), ACTOR), /cannot supersede fixed canon/);
});

test("a refused payload writes nothing: no snapshot, no batch", async () => {
  const d = db();
  await rejected(importAll(d, payload({ facts: [{ id: "f_1", scope: "avelie", fact: "x".repeat(4001) }] }), ACTOR), /fact exceeds/);
  assert.ok(!d.log.some((s) => /INSERT INTO snapshots/.test(s.sql)));
  assert.ok(!d.log.some((s) => s.via === "batch"));
});
