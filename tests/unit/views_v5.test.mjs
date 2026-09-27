// Her view of him (SPEC_V5 section 3, src/views.ts): the reads, their section, the nightly
// system text and its parser, and the promotion of a her_view proposal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, guard, scriptedD1, viewRow } from "./helpers_v5.mjs";

const views = await loadSrcIfPresent("views");
const t = guard(views, "subjectNorm", "confidenceWords", "viewsSection", "viewsSystem", "viewsUser", "parseViewOps", "applyViewProposal", "retireView");

const HEADER = "HOW YOU READ HIM (your own read, from what he has actually done with you; it colours how you take him; never recite it, never list it, never announce it as a verdict; he can change your mind by what he does)";
const IDS = new Set(["m_1", "m_2", "m_3"]);

t("subjectNorm: lowercase, non-letters to one space, trimmed, at most 80", () => {
  assert.equal(views.subjectNorm("  Dodges -- FAMILY!! "), "dodges family");
  assert.ok(views.subjectNorm("x".repeat(100)).length <= 80);
});

t("confidenceWords at the bands", () => {
  assert.equal(views.confidenceWords(0.49), "a hunch");
  assert.equal(views.confidenceWords(0.5), "fairly sure");
  assert.equal(views.confidenceWords(0.74), "fairly sure");
  assert.equal(views.confidenceWords(0.75), "sure");
});

t("viewsSection: the header's never-recite rule, the minimum confidence, the limit, the proven-wrong line, empty", () => {
  const list = [
    viewRow({ id: "a", view: "you dodge when i ask about your family", confidence: 0.6 }),
    viewRow({ id: "b", view: "you asked before you kissed me", confidence: 0.9 }),
    viewRow({ id: "c", view: "you keep saying later", confidence: 0.3 }),
    viewRow({ id: "d", view: "you are loud in the mornings", confidence: 0.45 }),
  ];
  const wrong = [viewRow({ id: "w", status: "proven_wrong", view: "you never listen" })];
  const s = views.viewsSection(list, wrong, { limit: 2, minConfidence: 0.4 });
  const lines = s.split("\n");
  assert.equal(lines[0], HEADER);
  assert.equal(lines[1], "- you asked before you kissed me (sure)");
  assert.equal(lines[2], "- you dodge when i ask about your family (fairly sure)");
  assert.equal(lines[3], "- you used to think you never listen; he proved you wrong");
  assert.equal(lines.length, 4, "the limit, and the read under the minimum left out");
  assert.equal(views.viewsSection([], [], { limit: 6, minConfidence: 0.4 }), "");
  assert.equal(views.viewsSection(list, [], { limit: 0, minConfidence: 0.4 }), "");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

t("viewsSystem: typography clean, carries the never-about-his-absence sentence and the cap", () => {
  const s = views.viewsSystem(3);
  assert.ok(s.startsWith("Read the record for how Avelie"));
  assert.ok(s.includes("of at most 3 changes"));
  assert.ok(s.includes("Never about how often, how fast or when he writes, never about him being away, busy or gone for a while: time apart is not something he does to her."));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

t("viewsUser: CURRENT READS and MESSAGES blocks, (none) when empty", () => {
  const u = views.viewsUser([], [{ id: "m_1", role: "user", content: "hey" }, { id: "m_2", role: "assistant", content: "hi" }]);
  assert.ok(u.includes("CURRENT READS:\n(none)"));
  assert.ok(u.includes("- [m_1] him: hey"));
  assert.ok(u.includes("- [m_2] her: hi"));
});

t("parseViewOps: new needs two evidence ids (one at 0.8); an unknown view id dropped; a view about his body dropped; his absence dropped; confidence clamped; the cap", () => {
  const known = new Map([["hv_a", viewRow({ id: "hv_a" })]]);
  const text = JSON.stringify([
    { op: "new", subject: "asks first", view: "you asked before you kissed me", confidence: 0.6, evidence: ["m_1"] },
    { op: "new", subject: "asks first", view: "you asked before you kissed me", confidence: 0.6, evidence: ["m_1", "m_2", "m_zz"] },
    { op: "new", subject: "keeps word", view: "you keep your word", confidence: 0.85, evidence: ["m_3"] },
    { op: "confirm", view_id: "hv_nope", subject: "x y", view: "you dodge", evidence: ["m_1"] },
    { op: "new", subject: "his body", view: "you are thin", confidence: 0.9, evidence: ["m_1"] },
    { op: "new", subject: "gone a lot", view: "you disappear for days", confidence: 0.9, evidence: ["m_1"] },
    { op: "new", subject: "slow texts", view: "you take forever to text back", confidence: 0.9, evidence: ["m_1"] },
    { op: "confirm", view_id: "hv_a", view: "you dodge when i ask about your family", confidence: 7, evidence: ["m_2"] },
  ]);
  const ops = views.parseViewOps(text, known, IDS, 6);
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0].evidence, ["m_1", "m_2"], "evidence filtered to the messages");
  assert.equal(ops[1].view, "you keep your word");
  assert.equal(ops[2].op, "confirm");
  assert.equal(ops[2].viewId, "hv_a");
  assert.equal(ops[2].confidence, 1, "clamped to 0..1");
  assert.equal(views.parseViewOps(text, known, IDS, 1).length, 1, "the cap");
  assert.deepEqual(views.parseViewOps("no json here", known, IDS, 3), []);
});

// A fake her_views table.
function viewsDb(rows) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const db = scriptedD1([
    [/SELECT \* FROM her_views WHERE status = 'active' AND subject_norm = \?1/, (b) => [...table.values()].filter((r) => r.status === "active" && r.subject_norm === b[0]).slice(0, 1)],
    [/SELECT \* FROM her_views WHERE id = \?1/, (b) => (table.has(b[0]) ? [table.get(b[0])] : [])],
    [/UPDATE her_views SET status = 'superseded'/, (b) => { const r = table.get(b[0]); if (r && r.status === "active") { r.status = "superseded"; return 1; } return 0; }],
    [/UPDATE her_views SET status = 'proven_wrong'/, (b) => { const r = table.get(b[0]); if (r && r.status === "active") { r.status = "proven_wrong"; r.wrong_note = b[1]; return 1; } return 0; }],
    [/UPDATE her_views SET status = 'retired'/, (b) => { const r = table.get(b[0]); if (r) r.status = "retired"; return 1; }],
    [/INSERT INTO her_views/, (b) => {
      const cols = ["id", "subject", "subject_norm", "view", "confidence", "evidence_json", "status", "version", "supersedes_id", "source", "wrong_note", "wrong_evidence_json", "created_at", "updated_at"];
      const row = Object.fromEntries(cols.map((c, i) => [c, b[i]]));
      table.set(row.id, row);
      return 1;
    }],
  ]);
  db.table = table;
  return db;
}

t("applyViewProposal: new inserts version 1 with confidence clamped and evidence kept", async () => {
  const db = viewsDb([]);
  const id = await views.applyViewProposal(db, { op: "new", subject: "asks first", view: "you asked before you kissed me", confidence: 0.99, evidence: ["m_1", "m_2"] }, "nightly views 2026-09-29 r", "auto");
  const row = db.table.get(id);
  assert.equal(row.version, 1);
  assert.equal(row.status, "active");
  assert.equal(row.confidence, 0.95);
  assert.deepEqual(JSON.parse(row.evidence_json), ["m_1", "m_2"]);
  assert.ok(db.log.some((e) => /INSERT INTO audit_events/.test(e.sql) && e.binds.includes("view.create")));
});

t("applyViewProposal: a new read with the same subject is treated as confirm; confirm unions evidence and keeps the higher confidence", async () => {
  const db = viewsDb([viewRow({ id: "hv_a", subject: "Dodges family", subject_norm: "dodges family", confidence: 0.6, evidence_json: JSON.stringify(["m_1"]) })]);
  const id = await views.applyViewProposal(db, { op: "new", subject: "dodges  family", view: "you dodge when i ask about your family", confidence: 0.5, evidence: ["m_2"] }, "s", "auto");
  assert.notEqual(id, "hv_a");
  const row = db.table.get(id);
  assert.equal(row.version, 2);
  assert.equal(row.supersedes_id, "hv_a");
  assert.equal(row.confidence, 0.6);
  assert.deepEqual(JSON.parse(row.evidence_json), ["m_1", "m_2"]);
  assert.equal(db.table.get("hv_a").status, "superseded");
});

t("applyViewProposal: weaken below 0.2 retires; wrong marks proven_wrong; wrong on a read no longer active is 409", async () => {
  const db = viewsDb([viewRow({ id: "hv_a", confidence: 0.3 }), viewRow({ id: "hv_b", subject: "other", subject_norm: "other", confidence: 0.7 })]);
  const id = await views.applyViewProposal(db, { op: "weaken", view_id: "hv_a" }, "s", "auto");
  const row = db.table.get(id);
  assert.ok(row.confidence < 0.2);
  assert.equal(row.status, "retired");
  const w = await views.applyViewProposal(db, { op: "wrong", view_id: "hv_b", view: "you never listen", evidence: ["m_3"] }, "s", "auto");
  assert.equal(w, "hv_b");
  assert.equal(db.table.get("hv_b").status, "proven_wrong");
  await assert.rejects(views.applyViewProposal(db, { op: "wrong", view_id: "hv_b" }, "s", "auto"), (e) => e.status === 409 && e.code === "not_active");
  await assert.rejects(views.applyViewProposal(db, { op: "confirm", view_id: "hv_zz" }, "s", "auto"), (e) => e.status === 400);
});

t("retireView: 404 for an unknown read; status retired with the note", async () => {
  const db = viewsDb([viewRow({ id: "hv_a" })]);
  const row = await views.retireView(db, "hv_a", "not true", "owner");
  assert.equal(row.status, "retired");
  assert.equal(row.wrong_note, "not true");
  await assert.rejects(views.retireView(db, "hv_zz", null, "owner"), (e) => e.status === 404);
});
