// The v5 proposal machinery (SPEC_V5 "Proposals", sections 1, 4, 7): the seven new kinds
// parse and promote on fakes, the nightly-only kinds are dropped from a per-turn reading, the
// extractor carries its day, her day with no thread, the occurred stamp while held, the ladder
// note on a relationship promotion, and the auto-keep's exemption for dated beats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { factRow, relationshipState, sceneState, testSettings } from "./helpers.mjs";
import { wantRow } from "./helpers_v3.mjs";
import {
  loadSrcIfPresent, guard, scriptedD1, clockScript, sceneVersion, clockSpan, personRow, plusMs, MIN_MS,
} from "./helpers_v5.mjs";

const proposals = await loadSrcIfPresent("proposals");
const prompt = await loadSrcIfPresent("prompt");
const t = guard(proposals, "PROPOSAL_KINDS", "NIGHTLY_ONLY_KINDS", "parseProposalJson", "decideProposal", "extractProposals", "duplicateKey", "keepAutomatically");

const NEW_KINDS = ["want_beat", "beat_outcome", "her_view", "fact_merge", "fact_mark", "world_fact", "known_artist"];
const T0 = "2026-09-26T12:00:00.000Z";

function proposalRow(kind, proposal, payload, overrides = {}) {
  return {
    id: "p_" + kind, conversation_id: null, message_id: null, kind, proposal, evidence: "x", confidence: "medium", scope: "general",
    payload_json: JSON.stringify({ payload, weight: null, raw: null }), status: "pending", decision_note: null, promoted_id: null,
    created_at: T0, decided_at: null, ...overrides,
  };
}

// A scripted database around one pending proposal: the decide statements succeed, the state
// rows read as given, the settings table is empty (the defaults), and `extra` answers the rest.
function decideDb(p, extra = [], { rel = relationshipState(), scene = sceneState({ status: "apart" }) } = {}) {
  return scriptedD1([
    [/SELECT \* FROM proposals WHERE id = \?1/, (b) => (b[0] === p.id ? [p] : [])],
    [/UPDATE proposals SET status = \?2/, 1],
    [/SELECT key, value FROM settings/, []],
    ...extra,
    [/SELECT \* FROM state_versions WHERE entity = \?1 ORDER BY version DESC LIMIT 1/, (b) => [{ id: "st_x", entity: b[0], version: 3, state_json: JSON.stringify(b[0] === "relationship" ? rel : scene), source: "owner", note: null, created_at: T0 }]],
  ]);
}

// ------------------------------------------------------------------ kinds and parsing

t("PROPOSAL_KINDS gains the seven kinds; NIGHTLY_ONLY_KINDS is her_view, fact_merge, fact_mark", () => {
  for (const k of NEW_KINDS) assert.ok(proposals.PROPOSAL_KINDS.includes(k), k);
  assert.deepEqual([...proposals.NIGHTLY_ONLY_KINDS].sort(), ["fact_mark", "fact_merge", "her_view"]);
});

t("the seven kinds parse with their payloads", () => {
  const items = NEW_KINDS.map((kind, i) => ({ kind, proposal: "p" + i, evidence: "e", confidence: "high", scope: "general", payload: { n: i } }));
  const out = proposals.parseProposalJson(JSON.stringify(items));
  assert.deepEqual(out.map((p) => p.kind), NEW_KINDS);
  assert.deepEqual(out[3].payload, { n: 3 });
});

t("duplicateKey folds number words: 'Justin is 44' and 'Justin is forty-four' are one", () => {
  assert.equal(proposals.duplicateKey("justin_fact", "Justin is 44"), proposals.duplicateKey("justin_fact", "Justin is forty-four"));
});

// ------------------------------------------------------------------ the extractor

const ENV_AI = (answer, seen) => ({
  APP_ENV: "test",
  AI: { async run(model, inputs) { seen.push(inputs); return { response: answer }; } },
});

t("extractProposals: the nightly-only kinds are dropped from a per-turn reading; the system text carries its day", async () => {
  const answer = JSON.stringify([
    { kind: "her_view", proposal: "a read of him", evidence: "e", confidence: "high", payload: { op: "new" } },
    { kind: "fact_merge", proposal: "same fact", evidence: "e", confidence: "high", payload: {} },
    { kind: "fact_mark", proposal: "a guess", evidence: "e", confidence: "high", payload: {} },
    { kind: "world_fact", proposal: "her mother is a nurse", evidence: "e", confidence: "high", payload: { entity: "her mother", fact: "a nurse" } },
  ]);
  const seen = [];
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => [{ id: "st", entity: b[0], version: 1, state_json: JSON.stringify({ summary: "x" }), source: "seed", note: null, created_at: T0 }]],
    [/SUM\(cost_usd_micro\)/, [{ s: 0 }]],
    ...clockScript([sceneVersion(1, "apart", T0)]),
  ]);
  const user = { id: "m_u", conversation_id: "c_1", channel: "story", role: "user", content: "hi", created_at: T0, seq: 1 };
  const her = { id: "m_a", conversation_id: "c_1", channel: "story", role: "assistant", content: "my mom is a nurse", created_at: T0, seq: 2 };
  const n = await proposals.extractProposals(ENV_AI(answer, seen), db, testSettings({ proposalProvider: "workersai", timezone: "America/New_York" }), "c_1", user, her);
  assert.equal(n, 1);
  const inserted = db.log.filter((e) => /^INSERT INTO proposals /.test(e.sql));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].binds[3], "world_fact");
  const system = seen[0].messages[0].content;
  assert.match(system, /Today, in her timezone, is [A-Z][a-z]+day \d{4}-\d{2}-\d{2}\./);
});

const tp = guard(prompt, "proposalSystemPrompt");

tp("proposalSystemPrompt: the new kinds, the relationship ladder words, the five new lines, and today's line only when given", () => {
  const text = prompt.proposalSystemPrompt({ today: "2026-09-29", weekday: "Tuesday" });
  assert.ok(text.startsWith("You read one exchange"));
  assert.ok(text.includes("| \"grounding\" | \"want_beat\" | \"beat_outcome\" | \"world_fact\" | \"known_artist\""));
  assert.ok(text.includes("\"status\": where they stand, one of strangers, talking, friends, seeing each other, together, cooling off, on a break, over, only when something actually moved it and never more than one step, or omitted"));
  assert.ok(text.includes("\"friction\": one to four plain words for a sore spot between them now"));
  assert.ok(text.includes("A \"justin_fact\" carries the payload {\"said_by\": \"him\"|\"inferred\"}"));
  assert.ok(text.includes("is a \"want_beat\". Its payload:"));
  assert.ok(text.includes("When SHE tells him how one of her dated steps went, that is a \"beat_outcome\""));
  assert.ok(text.includes("is a \"world_fact\". Its payload:"));
  assert.ok(text.includes("that is a \"known_artist\". Its payload:"));
  assert.ok(text.includes("Today, in her timezone, is Tuesday 2026-09-29."));
  assert.ok(!prompt.proposalSystemPrompt().includes("Today, in her timezone"));
  assert.ok(!/her_view|fact_merge|fact_mark/.test(text), "the nightly-only kinds are never offered to the extractor");
});

// ------------------------------------------------------------------ the promotions

t("justin_fact with said_by inferred is stored as a guess (inferred 1); said_by him is not", async () => {
  const p = proposalRow("justin_fact", "he works nights", { said_by: "inferred" });
  const db = decideDb(p);
  const r = await proposals.decideProposal(db, p.id, "approve", "owner");
  assert.ok(r.promotedId);
  const ins = db.log.find((e) => /INSERT INTO facts/.test(e.sql));
  assert.match(ins.sql, /inferred\)/);
  const q = proposalRow("justin_fact", "he hates mornings", { said_by: "him" });
  const db2 = decideDb(q);
  await proposals.decideProposal(db2, q.id, "approve", "owner");
  assert.ok(!/inferred/.test(db2.log.find((e) => /INSERT INTO facts/.test(e.sql)).sql));
});

t("known_artist promotes through setKnownArtist with source proposal", async () => {
  const p = proposalRow("known_artist", "he already knows Some Artist", { artist: "Some Artist", kind: "disliked" });
  const db = decideDb(p);
  await proposals.decideProposal(db, p.id, "approve", "owner");
  const ins = db.log.find((e) => /INSERT INTO known_artists/.test(e.sql));
  assert.equal(ins.binds[1], "Some Artist");
  assert.equal(ins.binds[3], "disliked");
  assert.equal(ins.binds[4], "proposal");
});

t("her_view promotes through applyViewProposal", async () => {
  const p = proposalRow("her_view", "her read (2026-09-29): you asked before you kissed me", { op: "new", subject: "asks first", view: "you asked before you kissed me", confidence: 0.7, evidence: ["m_1", "m_2"] });
  const db = decideDb(p);
  const r = await proposals.decideProposal(db, p.id, "approve", "auto");
  assert.match(r.promotedId, /^hv/);
  assert.ok(db.log.some((e) => /INSERT INTO her_views/.test(e.sql)));
});

t("fact_merge and fact_mark promote through mergeFacts and setFactInferred", async () => {
  const facts = {
    f_a: factRow({ id: "f_a", scope: "justin", fact: "Justin is 44", source: "proposal p_1" }),
    f_b: factRow({ id: "f_b", scope: "justin", fact: "Justin is forty-four", source: "proposal p_2" }),
  };
  const byId = [/SELECT \* FROM facts WHERE id = \?1/, (b) => (facts[b[0]] ? [facts[b[0]]] : [])];
  const merge = proposalRow("fact_merge", "same fact: Justin is 44 = Justin is forty-four", { keep: "f_a", merge: ["f_b"], text: "Justin is 44" });
  const db = decideDb(merge, [byId]);
  const r = await proposals.decideProposal(db, merge.id, "approve", "auto");
  assert.match(r.promotedId, /^f/);
  assert.ok(db.log.some((e) => /INSERT INTO memory_weights/.test(e.sql) && /HAVING/.test(e.sql)));
  const mark = proposalRow("fact_mark", "a guess, not his words: he hates mornings", { fact_id: "f_a", inferred: true });
  const db2 = decideDb(mark, [byId]);
  await proposals.decideProposal(db2, mark.id, "approve", "auto");
  assert.match(db2.log.find((e) => /INSERT INTO facts/.test(e.sql)).sql, /inferred\)/);
});

t("world_fact promotes onto the person she has by name", async () => {
  const mason = personRow({ id: "pe_mason" });
  const facts = [];
  const p = proposalRow("world_fact", "Mason: he plays at the Big Easy", { entity: "Mason", fact: "he plays at the Big Easy" });
  const db = decideDb(p, [
    [/SELECT \* FROM life_threads WHERE status != 'superseded'/, []],
    [/SELECT \* FROM people ORDER BY/, [mason]],
    [/SELECT \* FROM places ORDER BY/, []],
    [/SELECT id FROM people WHERE id = \?1/, (b) => (b[0] === "pe_mason" ? [{ id: "pe_mason" }] : [])],
    [/FROM world_facts WHERE entity_kind = \?1/, () => facts],
    [/INSERT INTO world_facts/, (b) => { facts.push({ id: b[0] }); return 1; }],
  ]);
  const r = await proposals.decideProposal(db, p.id, "approve", "auto");
  assert.match(r.promotedId, /^wf/);
  const ins = db.log.find((e) => /INSERT INTO world_facts/.test(e.sql));
  assert.equal(ins.binds[1], "person");
  assert.equal(ins.binds[2], "pe_mason");
});

t("want_beat promotes through createBeatFromProposal; beat_outcome through applyBeatOutcome", async () => {
  const want = wantRow({ id: "w_mic", title: "sing in front of people" });
  const beats = [];
  const wantPairs = [
    [/SELECT \* FROM wants WHERE id = \?1/, (b) => (b[0] === want.id ? [want] : [])],
    [/SELECT \* FROM wants WHERE lower\(title\)/, [want]],
  ];
  const wb = proposalRow("want_beat", "sign up on 2026-10-01", { want: "sing in front of people", title: "sign up", due_on: "2026-10-01", kind: "step" });
  const db = decideDb(wb, [
    ...wantPairs,
    [/SELECT id FROM arc_beats WHERE want_id/, () => beats.map((x) => ({ id: x }))],
    [/INSERT INTO arc_beats/, (b) => { beats.push(b[0]); return 1; }],
  ]);
  const r = await proposals.decideProposal(db, wb.id, "approve", "auto");
  assert.equal(r.promotedId, beats[0]);
  assert.ok(db.log.some((e) => /INSERT INTO beat_runs/.test(e.sql)));

  const beat = { id: "ab_1", want_id: want.id, title: "sign up", kind: "step", due_on: "2026-10-01", due_time: null, due_at: "2026-10-02T03:59:00.000Z", variants_json: null, status: "active", source: null, created_at: T0, updated_at: T0, want_title: want.title, want_status: "active" };
  const run = { id: "br_1", beat_id: "ab_1", reader: "owner", status: "pending", due_at: beat.due_at, outcome: null, variant_id: null, outcome_note: null, his_part: null, his_note: null, evidence_json: null, proposal_id: null, attempts: 0, shifted_ms: 0, resolved_at: null, created_at: T0, updated_at: T0 };
  const bo = proposalRow("beat_outcome", "sign up: did_it", { run_id: "br_1", outcome: "did_it", note: "stub" });
  const db2 = decideDb(bo, [
    ...wantPairs,
    [/SELECT id, beat_id FROM beat_runs WHERE id = \?1/, [{ id: "br_1", beat_id: "ab_1" }]],
    [/FROM arc_beats b JOIN wants w ON w.id = b.want_id WHERE b.id = \?1/, [beat]],
    [/SELECT \* FROM beat_runs WHERE beat_id = \?1 AND reader = \?2/, [run]],
    [/UPDATE beat_runs SET status = 'resolved'/, 1],
  ]);
  const r2 = await proposals.decideProposal(db2, bo.id, "approve", "auto");
  assert.equal(r2.promotedId, "br_1");
  assert.ok(db2.log.some((e) => /INSERT INTO want_log/.test(e.sql)), "the outcome moves the want");
});

t("life_update with her_day and no thread logs a note in her day with no thread, at payload.occurred", async () => {
  const occurred = "2026-09-29T17:00:00.000Z";
  const p = proposalRow("life_update", "Tuesday 2026-09-29, her day: bought new strings", { thread: null, note: "bought new strings", occurred, her_day: true, day: "2026-09-29" });
  const db = decideDb(p);
  await proposals.decideProposal(db, p.id, "approve", "auto");
  const ins = db.log.find((e) => /INSERT INTO life_log/.test(e.sql));
  assert.equal(ins.binds[1], null);
  assert.equal(ins.binds[2], occurred);
  assert.equal(ins.binds[3], "bought new strings");
});

t("the occurred stamp while held: a grounding filed inside a held scene and approved later is dated at the moment the scene froze", async () => {
  // The promotion reads the clock at the real now, so the span is placed in the real past:
  // held since two days ago, the meal filed forty minutes into it, approved today.
  const frozenAt = new Date(Date.now() - 2 * 24 * 60 * MIN_MS).toISOString();
  const filed = plusMs(frozenAt, 40 * MIN_MS);
  const p = proposalRow("grounding", "meal: a bagel", { kind: "meal", note: "a bagel" }, { created_at: filed });
  const versions = [sceneVersion(2, "apart", plusMs(frozenAt, -60 * MIN_MS)), sceneVersion(3, "together", frozenAt, "the pier")];
  const db = decideDb(p, [...clockScript(versions, [clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: frozenAt, created_at: frozenAt })])]);
  await proposals.decideProposal(db, p.id, "approve", "owner");
  const ins = db.log.find((e) => /INSERT INTO grounding_log/.test(e.sql));
  assert.ok(ins, "a grounding row");
  assert.equal(ins.binds[3], frozenAt, "occurred = frozen_at, not the filing or the approval instant");
});

t("a relationship promotion moves one rung and the state version's note says so; the decision note stays 'kept automatically'", async () => {
  const p = proposalRow("relationship", "they are seeing each other", { status: "seeing each other" });
  const db = decideDb(p);
  const r = await proposals.decideProposal(db, p.id, "approve", "auto", undefined, "kept automatically");
  const st = db.log.find((e) => /INSERT INTO state_versions/.test(e.sql));
  assert.equal(JSON.parse(st.binds[3]).status, "talking");
  assert.match(st.binds[5], /moved one step/);
  assert.equal(r.proposal.decision_note, "kept automatically");
});

t("keepAutomatically never rejects a want_beat or beat_outcome as a text duplicate", async () => {
  const done = proposalRow("want_beat", "sign up on 2026-10-01", { want: "w" }, { id: "p_old", status: "approved" });
  const pending = proposalRow("want_beat", "sign up on 2026-10-01", { want: "sing in front of people", title: "sign up", due_on: "2026-10-01" }, { id: "p_new" });
  const want = wantRow({ id: "w_mic", title: "sing in front of people" });
  const db = scriptedD1([
    [/FROM proposals WHERE status = \?1/, (b) => (b[0] === "approved" ? [done] : [])],
    [/SELECT \* FROM proposals WHERE id = \?1/, (b) => (b[0] === "p_new" ? [pending] : [])],
    [/UPDATE proposals SET status = \?2/, 1],
    [/SELECT key, value FROM settings/, []],
    [/SELECT \* FROM wants WHERE id = \?1/, []],
    [/SELECT \* FROM wants WHERE lower\(title\)/, [want]],
    [/SELECT id FROM arc_beats WHERE want_id/, [{ id: "ab_existing" }]],
  ]);
  const r = await proposals.keepAutomatically(db, ["p_new"]);
  assert.deepEqual(r, { kept: 1, duplicates: 0 });
  assert.ok(!db.log.some((e) => /status = 'rejected'/.test(e.sql)));
});
