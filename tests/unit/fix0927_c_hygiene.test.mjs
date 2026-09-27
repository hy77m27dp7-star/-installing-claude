// Fix 2026-09-27 (lane C3): the hygiene guess-marker never marks a fact he said himself. Live case:
// fact f_0ec5355b8a5c4b0aad66 "Justin is 44 years old" was filed from proposal
// p_37a9c3d5ed914b4ea9ce, whose quote was HER line ("you're forty four, you're not dying") in a
// turn where his own message did not state it, so the model answered said=false; but he had said
// it in an earlier turn (proposal p_8ab08878a31a44b28b8b, kind justin_fact, "He is 44 years old",
// quote "44", his message "im 44").
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, factRow } from "./helpers.mjs";
import { scriptedD1, settingsV5 } from "./helpers_v5.mjs";

const hy = await loadSrc("hygiene");
const storycall = await loadSrc("storycall");

const ENV = { APP_ENV: "unit" };
const NOW = new Date("2026-10-02T11:00:00.000Z");

const him = (id, fact, extra = {}) => ({ ...factRow({ id, scope: "justin", fact, created_at: "2026-09-26T00:00:00.000Z" }), ...extra });

const FACT = him("f_0ec5355b8a5c4b0aad66", "Justin is 44 years old", { source: "proposal p_37a9c3d5ed914b4ea9ce" });
const HER_QUOTE = { id: "p_37a9c3d5ed914b4ea9ce", kind: "justin_fact", proposal: "Justin is 44 years old", evidence: "you're forty four, you're not dying", payload_json: JSON.stringify({ payload: {}, user_message_id: "m_later" }) };
const HIS_QUOTE = { id: "p_8ab08878a31a44b28b8b", kind: "justin_fact", proposal: "He is 44 years old", evidence: "44", payload_json: JSON.stringify({ payload: {}, user_message_id: "m_im44" }) };
const HIS_MESSAGES = { m_im44: "im 44", m_later: "i feel old today" };

test("saidKeysFrom: a proposal whose quote is in his own message gives its key; her quote gives none", () => {
  const rows = [HIS_QUOTE, HER_QUOTE].map((p) => ({ proposal: p.proposal, evidence: p.evidence, userMessageId: hy.proposalUserMessageId(p) }));
  const said = hy.saidKeysFrom(rows, new Map(Object.entries(HIS_MESSAGES)));
  assert.deepEqual([...said], ["44 old years"]);
});

test("the live case: 'Justin is 44 years old' is no guess candidate once he said 'im 44' in an earlier turn", () => {
  const proposals = new Map([[HER_QUOTE.id, { evidence: HER_QUOTE.evidence, userMessageId: "m_later" }]]);
  const hisTexts = new Map(Object.entries(HIS_MESSAGES));
  // Before the fix (no said keys): the fact was asked about, and the model marked it.
  assert.deepEqual(hy.inferredCandidates([FACT], proposals, hisTexts).map((c) => c.factId), [FACT.id]);
  const said = hy.saidKeysFrom([{ proposal: HIS_QUOTE.proposal, evidence: HIS_QUOTE.evidence, userMessageId: "m_im44" }], hisTexts);
  const names = hy.nameWords("Justin");
  assert.deepEqual(hy.inferredCandidates([FACT], proposals, hisTexts, new Set(), said, names), []);
});

test("saidCovered: equal keys and a subset are his words; his name never counts; a fact adding a detail is still asked", () => {
  const said = new Set(["44 old years"]);
  const names = hy.nameWords("Justin");
  assert.equal(hy.saidCovered("He is 44 years old", said), true);
  assert.equal(hy.saidCovered("He is forty-four", said), true, "number words fold, and a subset is covered");
  assert.equal(hy.saidCovered("Justin is 44 years old", said, names), true);
  assert.equal(hy.saidCovered("Justin is 44 years old", said), false, "without his name the name word is a detail");
  assert.equal(hy.saidCovered("He is 44 years old and lonely", said, names), false);
  assert.equal(hy.saidCovered("Justin", said, names), false, "an empty key is never covered");
  assert.equal(hy.saidCovered("He is 44", new Set(), names), false);
});

test("every proposal in a merged source counts: one quote in his message keeps the fact out", () => {
  const f = him("f_m", "He works nights", { source: "proposal p_a | proposal p_b" });
  const proposals = new Map([
    ["p_a", { evidence: "she guessed it", userMessageId: "m_1" }],
    ["p_b", { evidence: "i work nights", userMessageId: "m_2" }],
  ]);
  const hisTexts = new Map([["m_1", "hey"], ["m_2", "yeah i work nights mostly"]]);
  assert.deepEqual(hy.proposalIdsOf(f), ["p_a", "p_b"]);
  assert.deepEqual(hy.proposalIdsOf({ source: "merged: proposal p_1; proposal p_2; proposal p_1" }), ["p_1", "p_2"]);
  assert.deepEqual(hy.inferredCandidates([f], proposals, hisTexts), []);
  const guessed = new Map([["p_a", { evidence: "she guessed it", userMessageId: "m_1" }]]);
  const c = hy.inferredCandidates([f], guessed, hisTexts);
  assert.equal(c.length, 1);
  assert.equal(c[0].quote, "she guessed it", "the first proposal's quote is shown");
});

test("inferredSystem: said true when unsure, false only when she plainly worked it out", () => {
  const s = hy.inferredSystem();
  assert.ok(s.startsWith(hy.INFERRED_PREFIX));
  assert.ok(s.includes("true whenever you are unsure"));
  assert.ok(s.includes("false only when the quote plainly shows she worked it out from hints or guessed it"));
});

test("runHygienePass on the live rows: the fact is never asked about, so no guess mark is filed", async () => {
  const db = scriptedD1([
    [/FROM facts WHERE status = \?1/, [FACT]],
    [/FROM nightly_runs WHERE step = 'hygiene'/, []],
    [/SELECT id, evidence, payload_json FROM proposals WHERE id IN/, (b) => [HER_QUOTE, HIS_QUOTE].filter((p) => b.includes(p.id))],
    [/FROM proposals WHERE kind = 'justin_fact' ORDER BY created_at DESC LIMIT \?1/, (b) => (b[0] === 500 ? [HER_QUOTE, HIS_QUOTE] : [])],
    [/SELECT id, content FROM messages WHERE role = 'user' AND id IN/, (b) => b.filter((id) => HIS_MESSAGES[id]).map((id) => ({ id, content: HIS_MESSAGES[id] }))],
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "relationship" ? [{ id: "st1", entity: "relationship", version: 13, state_json: JSON.stringify({ status: "seeing each other", his_name: "Justin" }), source: "owner", note: null, created_at: "2026-09-25T00:00:00.000Z" }] : [])],
  ]);
  const r = await hy.runHygienePass(ENV, db, settingsV5(), storycall.newNightlyBudget(0.25), NOW);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(r.detail.marked, 0);
  assert.deepEqual(r.proposalIds, []);
  assert.ok(!db.log.some((e) => /INSERT INTO model_runs/.test(e.sql) && JSON.stringify(e.binds).includes("hygiene_inferred")), "no paid call: nothing to ask");
  const read = db.log.find((e) => /kind = 'justin_fact'/.test(e.sql));
  assert.ok(read, "the said proposals were read, bounded");
});

test("runHygienePass: without his earlier words the same fact is still asked (the stub answers not said)", async () => {
  const db = scriptedD1([
    [/FROM facts WHERE status = \?1/, [FACT]],
    [/FROM nightly_runs WHERE step = 'hygiene'/, []],
    [/SELECT id, evidence, payload_json FROM proposals WHERE id IN/, [HER_QUOTE]],
    [/SELECT id, content FROM messages WHERE role = 'user' AND id IN/, [{ id: "m_later", content: "i feel old today" }]],
  ]);
  const r = await hy.runHygienePass(ENV, db, settingsV5(), storycall.newNightlyBudget(0.25), NOW);
  assert.equal(r.detail.marked, 1, JSON.stringify(r));
});
