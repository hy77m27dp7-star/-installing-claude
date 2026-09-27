// Fix 2026-09-27 (lane C2): the nightly views step no longer duplicates her reads of him on a
// forced rerun. Live case: "you asked before you kissed me" was confirmed three times in one night
// from the SAME two evidence messages (m_112694a4a96f4c27be3b, m_394324dc2f0743babfdb), each rerun
// raising the confidence (0.8, 0.9, 0.95) and writing a version, the third leaving a second
// active row with the same subject_norm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { scriptedD1, viewRow, settingsV5 } from "./helpers_v5.mjs";

const views = await loadSrc("views");
const storycall = await loadSrc("storycall");

const ENV = { APP_ENV: "unit" };
const NOW = new Date("2026-10-02T11:00:00.000Z");
const M1 = "m_112694a4a96f4c27be3b";
const M2 = "m_394324dc2f0743babfdb";

const KISS = viewRow({
  id: "hv_kiss",
  subject: "asks first",
  subject_norm: "asks first",
  view: "you asked before you kissed me",
  confidence: 0.8,
  evidence_json: JSON.stringify([M1, M2]),
});

// A her_views table that answers every statement views.ts sends, both supersede forms included.
function viewsDb(rows, extra = []) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const active = () => [...table.values()].filter((r) => r.status === "active");
  const db = scriptedD1([
    ...extra,
    [/SELECT \* FROM her_views WHERE status = 'active' AND subject_norm = \?1/, (b) => active().filter((r) => r.subject_norm === b[0]).slice(0, 1)],
    [/SELECT \* FROM her_views WHERE status = 'active' ORDER BY/, () => active()],
    [/SELECT \* FROM her_views WHERE status = 'retired'/, () => [...table.values()].filter((r) => r.status === "retired")],
    [/SELECT \* FROM her_views WHERE id = \?1/, (b) => (table.has(b[0]) ? [table.get(b[0])] : [])],
    [/UPDATE her_views SET status = 'superseded', updated_at = \?2 WHERE status = 'active' AND subject_norm = \?1 AND id != \?3/, (b) => {
      let n = 0;
      for (const r of table.values()) if (r.status === "active" && r.subject_norm === b[0] && r.id !== b[2]) { r.status = "superseded"; n++; }
      return n;
    }],
    [/UPDATE her_views SET status = 'superseded', updated_at = \?2 WHERE id = \?1 AND status = 'active'/, (b) => {
      const r = table.get(b[0]);
      if (r && r.status === "active") { r.status = "superseded"; return 1; }
      return 0;
    }],
    [/INSERT INTO her_views/, (b) => {
      const cols = ["id", "subject", "subject_norm", "view", "confidence", "evidence_json", "status", "version", "supersedes_id", "source", "wrong_note", "wrong_evidence_json", "created_at", "updated_at"];
      const row = Object.fromEntries(cols.map((c, i) => [c, b[i]]));
      table.set(row.id, row);
      return 1;
    }],
  ]);
  db.table = table;
  db.active = active;
  return db;
}

const her = (id, content, at) => ({ id, role: "assistant", content, created_at: at });
const him = (id, content, at) => ({ id, role: "user", content, created_at: at });

// The window of the night: the two kiss messages carry the stub's [[VIEW]] trigger, so the stub
// answers a "new" read with those two ids as evidence (src/providers/stub.ts viewsReply).
function windowOf(extra = []) {
  return [
    him(M1, "can i kiss you [[VIEW]]", "2026-10-01T20:00:00.000Z"),
    her(M2, "you asked. nobody asks. [[VIEW]]", "2026-10-01T20:01:00.000Z"),
    him("m_3", "the record store was perfect", "2026-10-01T20:05:00.000Z"),
    her("m_4", "it was. dont make it weird", "2026-10-01T20:06:00.000Z"),
    ...extra,
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function passDb(rows, messages) {
  return viewsDb(rows, [
    [/FROM nightly_runs WHERE step = 'views'/, []],
    [/FROM messages WHERE channel = 'story'/, messages],
    [/SELECT kind, proposal FROM proposals WHERE/, []],
  ]);
}

const stubRead = (overrides = {}) => viewRow({ ...KISS, id: "hv_stub", subject: "stub read", subject_norm: "stub read", view: "you answer fast when it matters", ...overrides });
const proposalInserts = (db) => db.log.filter((e) => /^INSERT INTO proposals/.test(e.sql));

test("runViewPass: a forced rerun over the same window files nothing new (the read already holds that evidence)", async () => {
  const db = passDb([stubRead()], windowOf());
  const r = await views.runViewPass(ENV, db, settingsV5({ nightlyProvider: "stub" }), storycall.newNightlyBudget(0.25), NOW);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.deepEqual(r.proposalIds, []);
  assert.equal(proposalInserts(db).length, 0);
  assert.equal(r.detail.settled, 1, "the model's op was settled away");
});

test("runViewPass: a real new message still confirms the read (a new op on the same subject becomes a confirm of it)", async () => {
  const msgs = windowOf([him("m_5", "can i hold your hand [[VIEW]]", "2026-10-01T21:00:00.000Z")]);
  const db = passDb([stubRead()], msgs);
  const r = await views.runViewPass(ENV, db, settingsV5({ nightlyProvider: "stub" }), storycall.newNightlyBudget(0.25), NOW);
  assert.equal(r.proposalIds.length, 1, JSON.stringify(r));
  const ins = proposalInserts(db)[0];
  const pj = JSON.parse(ins.binds[8]);
  assert.equal(pj.payload.op, "confirm");
  assert.equal(pj.payload.view_id, "hv_stub");
  assert.equal(pj.payload.view, "you answer fast when it matters", "her existing words kept");
  assert.ok(pj.payload.evidence.includes("m_5"));
});

test("settleViewOps: confirm or weaken with only known evidence dropped; new evidence kept; a new of a held subject becomes a confirm or goes", () => {
  const reads = [KISS];
  const ops = [
    { op: "confirm", viewId: "hv_kiss", subject: "asks first", view: "you asked before you kissed me", confidence: 0.9, evidence: [M1, M2] },
    { op: "weaken", viewId: "hv_kiss", subject: "asks first", view: "you asked before you kissed me", confidence: 0.5, evidence: [M2] },
    { op: "new", subject: "Asks first!", view: "you ask before you kiss", confidence: 0.95, evidence: [M1, M2] },
    { op: "new", subject: "kiss question", view: "You asked before you kissed me.", confidence: 0.95, evidence: [M1] },
  ];
  assert.deepEqual(views.settleViewOps(ops, reads), [], "the three live reruns: nothing new was seen");
  const fresh = views.settleViewOps([{ op: "confirm", viewId: "hv_kiss", subject: "asks first", view: "you asked before you kissed me", confidence: 0.95, evidence: [M1, "m_new"] }], reads);
  assert.equal(fresh.length, 1);
  const turned = views.settleViewOps([{ op: "new", subject: "asks first", view: "you always ask first", confidence: 0.7, evidence: ["m_new"] }], reads);
  assert.equal(turned.length, 1);
  assert.equal(turned[0].op, "confirm");
  assert.equal(turned[0].viewId, "hv_kiss");
  assert.equal(turned[0].view, "you asked before you kissed me");
  const other = views.settleViewOps([{ op: "new", subject: "dodges family", view: "you dodge when i ask about your family", confidence: 0.6, evidence: ["m_a", "m_b"] }], reads);
  assert.equal(other.length, 1);
  assert.equal(other[0].op, "new", "a different subject is a new read");
});

test("settleViewOps: one op per read and one new per subject in a night", () => {
  const reads = [KISS];
  const out = views.settleViewOps([
    { op: "confirm", viewId: "hv_kiss", subject: "asks first", view: "you asked before you kissed me", confidence: 0.85, evidence: ["m_a"] },
    { op: "new", subject: "asks first", view: "x y", confidence: 0.9, evidence: ["m_b"] },
    { op: "weaken", viewId: "hv_kiss", subject: "asks first", view: "you asked before you kissed me", confidence: 0.4, evidence: ["m_c"] },
    { op: "new", subject: "keeps word", view: "you keep your word", confidence: 0.6, evidence: ["m_1", "m_2"] },
    { op: "new", subject: "keeps  word", view: "you keep your word", confidence: 0.7, evidence: ["m_3"] },
  ], reads);
  assert.equal(out.length, 2);
  assert.equal(out[0].op, "confirm");
  assert.deepEqual(out[0].evidence, ["m_a", "m_b"], "the converted new folded into the confirm");
  assert.equal(out[0].confidence, 0.9);
  assert.equal(out[1].op, "new");
  assert.deepEqual(out[1].evidence, ["m_1", "m_2", "m_3"]);
  assert.equal(out[1].confidence, 0.7);
});

test("applyViewProposal: a confirm with no new evidence and the same words writes nothing and answers the read's id", async () => {
  const db = viewsDb([KISS]);
  const id = await views.applyViewProposal(db, { op: "confirm", view_id: "hv_kiss", view: "you asked before you kissed me", confidence: 0.95, evidence: [M1, M2] }, "nightly views 2026-10-01 r", "auto");
  assert.equal(id, "hv_kiss");
  assert.equal(db.writes().length, 0, "no version, no audit");
  assert.equal(db.table.get("hv_kiss").confidence, 0.8, "the confidence did not creep up");
  const again = await views.applyViewProposal(db, { op: "new", subject: "asks first", view: "you asked before you kissed me", confidence: 0.95, evidence: [M2] }, "s", "auto");
  assert.equal(again, "hv_kiss", "a new of the same subject with nothing new is the same read");
  assert.equal(db.writes().length, 0);
});

test("applyViewProposal: a confirm with new evidence writes a version and the read stays single", async () => {
  const db = viewsDb([KISS]);
  const id = await views.applyViewProposal(db, { op: "confirm", view_id: "hv_kiss", evidence: ["m_new"], confidence: 0.9 }, "s", "auto");
  assert.notEqual(id, "hv_kiss");
  assert.equal(db.table.get(id).version, 2);
  assert.deepEqual(JSON.parse(db.table.get(id).evidence_json), [M1, M2, "m_new"]);
  assert.equal(db.active().length, 1);
});

test("two active reads of one subject cannot exist: two confirms that both read the old row active leave one", async () => {
  const db = viewsDb([KISS]);
  // Both proposals are decided against the same active row (the race the live night hit): the
  // second one's own supersede finds the row already superseded, and the subject supersede
  // retires the first one's new version.
  const a = views.applyViewProposal(db, { op: "confirm", view_id: "hv_kiss", evidence: ["m_x"] }, "s", "auto");
  const b = views.applyViewProposal(db, { op: "confirm", view_id: "hv_kiss", evidence: ["m_y"] }, "s", "auto");
  const [ia, ib] = await Promise.all([a, b]);
  assert.notEqual(ia, ib);
  const act = db.active();
  assert.equal(act.length, 1, JSON.stringify(act.map((r) => r.id)));
  assert.equal(act[0].subject_norm, "asks first");
});

test("two active reads of one subject cannot exist: a new read clears a stray active duplicate of its subject", async () => {
  // The state the live night left behind: two active rows of one subject.
  const stray = { ...KISS, id: "hv_stray", confidence: 0.95 };
  const db = viewsDb([KISS, stray]);
  const id = await views.applyViewProposal(db, { op: "confirm", view_id: "hv_kiss", evidence: ["m_z"] }, "s", "auto");
  const act = db.active();
  assert.equal(act.length, 1);
  assert.equal(act[0].id, id);
  assert.equal(db.table.get("hv_stray").status, "superseded");
  const sup = db.log.filter((e) => /subject_norm = \?1 AND id != \?3/.test(e.sql));
  assert.equal(sup.length, 1);
  assert.equal(sup[0].via, "batch", "in the same batch as the insert");
});

test("a weaken that retires the read does not supersede the other rows of the subject by subject (no new active row)", async () => {
  const db = viewsDb([{ ...KISS, confidence: 0.3 }]);
  await views.applyViewProposal(db, { op: "weaken", view_id: "hv_kiss", evidence: ["m_w"] }, "s", "auto");
  assert.equal(db.log.filter((e) => /subject_norm = \?1 AND id != \?3/.test(e.sql)).length, 0);
});
