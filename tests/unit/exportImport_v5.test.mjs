// Export and import in v5 (SPEC_V5 "Export, import, the character export..."): every new
// table exported and round-tripped, facts.inferred and messages.song_told_at in the
// whitelists, the story_clock delete rules of an import, the character package carrying
// nothing of him, and the fine-tune strip dropping the Friction line and the his-part sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, loadSrc, factRow, relationshipState, sceneState } from "./helpers.mjs";
import { fakeDb, secretEnv, messageRow } from "./helpers_v2.mjs";
import { clockSpan, beatRow, beatRunRow, viewRow, personRow, worldFactRow, knownArtistRow, placeRow } from "./helpers_v5.mjs";

const { exportAll, importAll } = await loadSrc("exportImport");
const { exportCharacterJson } = await loadSrc("exportCharacter");
const { stripHimFromState } = await loadSrc("finetune");
const { hisPartSentence } = await loadSrc("arcs");
const ACTOR = "justin@newsomeprojects.com";
const D = "2026-09-26T12:00:00.000Z";

const NIGHTLY = { day: "2026-09-29", step: "her_day", ran_at: D, status: "done", result_json: "{}" };
const V5 = {
  storyClock: ["story_clock", clockSpan({ id: "sc_v3", opened_version: 3, resumed_at: D, closed_version: 4 })],
  nightlyRuns: ["nightly_runs", NIGHTLY],
  arcBeats: ["arc_beats", beatRow()],
  beatRuns: ["beat_runs", beatRunRow({ status: "resolved", outcome: "went_well", his_part: "came", his_note: "stood at the back", resolved_at: D })],
  herViews: ["her_views", viewRow()],
  people: ["people", personRow()],
  worldFacts: ["world_facts", worldFactRow()],
  knownArtists: ["known_artists", knownArtistRow()],
};

function tables() {
  const base = {
    settings: [], facts: [{ ...factRow({ id: "f_guess", scope: "justin", fact: "he works nights" }), inferred: 1 }], history: [], unknowns: [], state_versions: [], conversations: [], proposals: [],
    usage_daily: [], audit_events: [], model_runs: [],
    messages: [messageRow({ id: "m_nf", song_json: JSON.stringify({ artist: "Nobody Real", title: "Notfound Song" }), spotify_status: "not_found", song_told_at: D })],
    visual_assets: [], places: [], life_threads: [], life_log: [], message_context: [], drift_reports: [], first_texts_daily: [], media_library: [], voiceprints: [],
    voice_lines: [], voice_line_uses: [], corrections: [], memory_weights: [], memory_recalls: [], wants: [], want_log: [], asks: [], grounding_log: [], calls: [],
    tastings: [], tasting_candidates: [], message_marks: [],
  };
  for (const [table, row] of Object.values(V5)) base[table] = [row];
  return base;
}

test("exportAll carries every new table, facts.inferred and messages.song_told_at", async () => {
  const payload = await exportAll(fakeDb(tables()), secretEnv());
  for (const [key, [, row]] of Object.entries(V5)) {
    assert.ok(Array.isArray(payload[key]) && payload[key].length === 1, key);
    const id = row.id ?? row.day;
    assert.equal(payload[key][0].id ?? payload[key][0].day, id, key);
  }
  assert.equal(payload.facts.find((f) => f.id === "f_guess").inferred, 1);
  assert.equal(payload.messages.find((m) => m.id === "m_nf").song_told_at, D);
});

const inserts = (d, table) => d.log.filter((s) => s.via === "batch" && new RegExp("^INSERT (OR IGNORE )?INTO " + table + " ").test(s.sql));
const deletes = (d, table) => d.log.filter((s) => s.via === "batch" && new RegExp("^DELETE FROM " + table + "\\b").test(s.sql));

test("importAll round-trips one row of each new table; inferred and song_told_at land in their inserts", async () => {
  const payload = await exportAll(fakeDb(tables()), secretEnv());
  const d = fakeD1(() => []);
  const r = await importAll(d, { ...payload, conversations: [{ id: "c_1" }], messages: [{ id: "m_nf", conversation_id: "c_1", role: "assistant", content: "found it again", seq: 1, song_told_at: D }] }, ACTOR);
  for (const [key, [table, row]] of Object.entries(V5)) {
    assert.equal(r.counts[key], 1, key + " counted");
    const ins = inserts(d, table);
    assert.equal(ins.length, 1, table + " inserted");
    assert.ok(ins[0].binds.includes(row.id ?? row.day), table + " id");
  }
  const fact = inserts(d, "facts").find((s) => s.binds.includes("f_guess"));
  assert.ok(/\binferred\b/.test(fact.sql));
  const msg = inserts(d, "messages")[0];
  assert.ok(/song_told_at/.test(msg.sql) && msg.binds.includes(D));
});

const sceneVersions = [{ id: "st_1", entity: "scene", version: 1, state_json: JSON.stringify(sceneState()), source: "seed", note: null, created_at: D }];

test("importAll: replacing the scene versions with no storyClock key clears story_clock in the same batch", async () => {
  const d = fakeD1(() => []);
  const r = await importAll(d, { version: 1, stateVersions: sceneVersions }, ACTOR);
  assert.equal(deletes(d, "story_clock").length, 1);
  assert.equal(inserts(d, "story_clock").length, 0);
  assert.equal(r.counts.storyClockCleared, 1);
});

test("importAll: a payload with a storyClock key replaces the spans", async () => {
  const d = fakeD1(() => []);
  const span = clockSpan({ id: "sc_v1", opened_version: 1 });
  const r = await importAll(d, { version: 1, stateVersions: sceneVersions, storyClock: [span] }, ACTOR);
  assert.equal(inserts(d, "story_clock").length, 1);
  assert.ok(!r.counts.storyClockCleared);
});

test("importAll: a payload that leaves the scene versions alone keeps the spans", async () => {
  const d = fakeD1(() => []);
  const rel = [{ id: "st_r", entity: "relationship", version: 1, state_json: JSON.stringify(relationshipState()), source: "seed", note: null, created_at: D }];
  await importAll(d, { version: 1, stateVersions: rel }, ACTOR);
  assert.equal(deletes(d, "story_clock").length, 0);
});

test("the character package carries arcBeats and world, and nothing of him: no her_views, no known_artists, no nightly_runs, no his-part fields", async () => {
  const t = tables();
  t.arc_beats = [{ ...beatRow(), want_title: "sing in front of people", run_status: "resolved", outcome: "went_well", outcome_note: "they clapped", resolved_at: D, his_part: "came", his_note: "stood at the back" }];
  t.places = [placeRow({ id: "pl_shop", title: "the shop" })];
  t.state_versions = [
    { id: "s1", entity: "relationship", version: 1, state_json: JSON.stringify(relationshipState()), source: "seed", note: null, created_at: D },
    { id: "s2", entity: "scene", version: 1, state_json: JSON.stringify(sceneState()), source: "seed", note: null, created_at: D },
  ];
  const db = fakeDb(t);
  const pkg = await exportCharacterJson(db, secretEnv());
  assert.ok(Array.isArray(pkg.arcBeats) && pkg.arcBeats.length === 1);
  assert.equal(pkg.arcBeats[0].run.outcome, "went_well");
  assert.ok(pkg.world && Array.isArray(pkg.world.people));
  const text = JSON.stringify(pkg);
  for (const needle of ["his_part", "his_note", "hisPart", "hisNote", "stood at the back", "herViews", "her_views", "knownArtists", "known_artists", "nightly"]) assert.ok(!text.includes(needle), needle);
  assert.ok(!db.queries.some((q) => /her_views|known_artists|nightly_runs/.test(q.sql)), "those tables are never read");
});

test("stripHimFromState drops the Friction line and the his-part sentence of a Lately beat line; her outcome and note stay", () => {
  const lately = "  Lately: the open mic (yesterday): you went and it went well: they clapped.";
  const state = [
    "CURRENT STATE\nRelationship: {\"status\":\"friends\"}\nScene: {}\nFriction: the photo thing (fresh; it colours things between you, it is not a way to treat him)\nThe live conversation carries the immediate scene forward; this record moves only when it is updated.",
    "WHAT YOU WANT (yours)\n- sing in front of people: 20%.\n" + lately + hisPartSentence("came", "stood at the back"),
    "HOW YOU READ HIM (your own read)\n- you asked before you kissed me (sure)",
    "SONGS AND HIM (so what you send him is new to him and yours)\nHe already knows: X.",
    "TIME SINCE (true, from the clock)\nYou last talked 3 days ago.",
  ].join("\n\n" + "-".repeat(60) + "\n\n"); // the prompt's section separator
  const out = stripHimFromState(state);
  assert.ok(!out.includes("Friction:"));
  assert.ok(out.includes(lately));
  assert.ok(!out.includes("He came"));
  assert.ok(!out.includes("stood at the back"));
  for (const h of ["HOW YOU READ HIM", "SONGS AND HIM", "TIME SINCE"]) assert.ok(!out.includes(h), h);
});
