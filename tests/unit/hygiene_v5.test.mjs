// Memory hygiene (SPEC_V5 section 7, src/hygiene.ts and the story-time decay in
// src/memory.ts): exact duplicates without a model, near duplicates for the model, the merge
// guard, the guesses, and the ages on her clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { factRow } from "./helpers.mjs";
import { loadSrcIfPresent, guard, clockSpan, storyClock, DAY_MS, plusMs } from "./helpers_v5.mjs";

const hy = await loadSrcIfPresent("hygiene");
const memory = await loadSrcIfPresent("memory");
const clock = await loadSrcIfPresent("clock");
const t = guard(hy, "exactDuplicateGroups", "nearDuplicateGroups", "rawKey", "factKey", "mergeGuard", "parseMergeAnswer", "parseInferredAnswer", "inferredCandidates", "proposalUserMessageId", "hygieneScope");

const him = (id, fact, extra = {}) => factRow({ id, scope: "justin", fact, ...extra });

t("exactDuplicateGroups: 'Justin is 44' and 'Justin is forty-four' are one group, oldest first; an opinion and an avelie fact never grouped", () => {
  const facts = [
    him("f_b", "Justin is forty-four", { created_at: "2026-09-25T00:00:00.000Z" }),
    him("f_a", "Justin is 44", { created_at: "2026-09-24T00:00:00.000Z" }),
    him("f_op1", "likes jazz", { subject: "opinion: music" }),
    him("f_op2", "likes jazz", { subject: "opinion: music" }),
    factRow({ id: "f_h1", scope: "avelie", fact: "she sings" }),
    factRow({ id: "f_h2", scope: "avelie", fact: "she sings" }),
  ];
  const groups = hy.exactDuplicateGroups(facts);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ["f_a", "f_b"]);
  assert.equal(groups[0].id, "g1");
  assert.equal(groups[0].reason, "same_words");
});

t("'He trusts her' and 'She trusts him' in scope shared are NOT an exact group; nearDuplicateGroups groups them for the model", () => {
  const facts = [
    factRow({ id: "f_1", scope: "shared", fact: "He trusts her" }),
    factRow({ id: "f_2", scope: "shared", fact: "She trusts him", created_at: "2026-09-25T00:00:00.000Z" }),
  ];
  assert.equal(hy.factKey(facts[0]), hy.factKey(facts[1]));
  assert.notEqual(hy.rawKey(facts[0]), hy.rawKey(facts[1]));
  assert.deepEqual(hy.exactDuplicateGroups(facts), []);
  const near = hy.nearDuplicateGroups(facts, new Set());
  assert.equal(near.length, 1);
  assert.deepEqual(near[0].ids, ["f_1", "f_2"]);
  assert.equal(near[0].reason, "near");
});

t("rawKey keeps every word in order, number words as digits, punctuation gone", () => {
  assert.equal(hy.rawKey(him("x", "Justin is forty-four!")), "justin is 44");
  assert.equal(hy.rawKey(him("x", "He, trusts... her")), "he trusts her");
});

t("nearDuplicateGroups: three wordings of an LA move grouped; a different LA fact with another subject not grouped; the cap", () => {
  const facts = [
    him("f_la1", "Justin moved to LA in 2019", { subject: "move", created_at: "2026-09-20T00:00:00.000Z" }),
    him("f_la2", "He moved to LA back in 2019", { subject: "move", created_at: "2026-09-21T00:00:00.000Z" }),
    him("f_la3", "Justin moved to LA in 2019 for work", { subject: "move", created_at: "2026-09-22T00:00:00.000Z" }),
    him("f_tr", "He hates the traffic in LA", { subject: "traffic", created_at: "2026-09-23T00:00:00.000Z" }),
    him("f_x1", "He has a dog named Ruth", { created_at: "2026-09-24T00:00:00.000Z" }),
    him("f_x2", "He has a dog called Ruth", { created_at: "2026-09-25T00:00:00.000Z" }),
  ];
  const groups = hy.nearDuplicateGroups(facts, new Set());
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].ids, ["f_la1", "f_la2", "f_la3"]);
  assert.ok(!groups.some((g) => g.ids.includes("f_tr")));
  assert.equal(hy.nearDuplicateGroups(facts, new Set(), { max: 1 }).length, 1);
  assert.equal(hy.nearDuplicateGroups(facts, new Set(["f_la1", "f_la2"])).length, 1, "excluded ids left out");
});

t("mergeGuard: a merged line adding '2019' or 'Boston' refused; one reordering the sources' words accepted", () => {
  const sources = ["Justin moved to LA", "He moved to LA for work"];
  assert.equal(hy.mergeGuard("Justin moved to LA in 2019", sources), false);
  assert.equal(hy.mergeGuard("Justin moved to Boston and LA", sources), false);
  assert.equal(hy.mergeGuard("For work, Justin moved to LA", sources), true);
  assert.equal(hy.mergeGuard("Justin is forty-four", ["Justin is 44"]), true, "number words read as digits");
});

t("parseMergeAnswer: same true, a known group, the guard; anything else dropped", () => {
  const groups = [{ id: "n1", ids: ["f_1", "f_2"], texts: ["Justin moved to LA", "He moved to LA"], reason: "near" }];
  const out = hy.parseMergeAnswer(JSON.stringify([
    { group: "n1", same: true, text: "Justin moved to LA" },
    { group: "n2", same: true, text: "x" },
    { group: "n1", same: false },
  ]), groups);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Justin moved to LA");
  assert.deepEqual(hy.parseMergeAnswer(JSON.stringify([{ group: "n1", same: true, text: "Justin moved to Boston" }]), groups), []);
  assert.deepEqual(hy.parseMergeAnswer("not json", groups), []);
});

t("parseInferredAnswer: the ids answered said false, known ids only", () => {
  const ids = new Set(["f_1", "f_2"]);
  assert.deepEqual(hy.parseInferredAnswer(JSON.stringify([{ fact: "f_1", said: false }, { fact: "f_2", said: true }, { fact: "f_9", said: false }]), ids), ["f_1"]);
});

t("proposalUserMessageId: the top level read, nested ignored, unreadable null", () => {
  assert.equal(hy.proposalUserMessageId({ payload_json: JSON.stringify({ payload: {}, user_message_id: "m_his" }) }), "m_his");
  assert.equal(hy.proposalUserMessageId({ payload_json: JSON.stringify({ payload: { user_message_id: "m_nested" } }) }), null);
  assert.equal(hy.proposalUserMessageId({ payload_json: "{nope" }), null);
  assert.equal(hy.proposalUserMessageId({ payload_json: null }), null);
});

t("inferredCandidates: a quote found in his message is no candidate, a quote from her line is, no proposal source is not, a null userMessageId is", () => {
  const facts = [
    him("f_said", "He works nights", { source: "proposal p_said" }),
    him("f_hers", "He hates mornings", { source: "proposal p_hers" }),
    him("f_owner", "He is tall", { source: "owner" }),
    him("f_nomsg", "He has a sister", { source: "proposal p_nomsg" }),
    him("f_guess", "He is shy", { source: "proposal p_guess", inferred: 1 }),
  ];
  const proposals = new Map([
    ["p_said", { evidence: "i work nights", userMessageId: "m_1" }],
    ["p_hers", { evidence: "she said so", userMessageId: "m_2" }],
    ["p_nomsg", { evidence: "my sister", userMessageId: null }],
    ["p_guess", { evidence: "x", userMessageId: "m_3" }],
  ]);
  const hisTexts = new Map([["m_1", "yeah I work nights mostly"], ["m_2", "mornings are fine"], ["m_3", "x"]]);
  const c = hy.inferredCandidates(facts, proposals, hisTexts).map((x) => x.factId).sort();
  assert.deepEqual(c, ["f_hers", "f_nomsg"]);
});

t("the system texts start with the prefixes the stub copies", () => {
  assert.ok(hy.mergeSystem().startsWith(hy.MERGE_PREFIX));
  assert.ok(hy.inferredSystem().startsWith(hy.INFERRED_PREFIX));
});

const tm = guard(memory, "scoreDetail", "memorySettings");

tm("scoreDetail with ageDaysOf: a fact touched four real days ago with three held reads one day old", () => {
  const real = "2026-10-02T14:00:00.000Z";
  const touched = plusMs(real, -4 * DAY_MS);
  const c = storyClock({ real, spans: [clockSpan({ frozen_at: plusMs(real, -3.5 * DAY_MS), resumed_at: plusMs(real, -0.5 * DAY_MS) })] });
  const ageDaysOf = (iso) => clock.storyAgeDays(c, iso);
  const withClock = memory.scoreDetail(0.5, touched, "x", null, new Date(real), { ageDaysOf });
  const without = memory.scoreDetail(0.5, touched, "x", null, new Date(real), {});
  assert.ok(Math.abs(withClock.ageDays - 1) < 1e-9, "age " + withClock.ageDays);
  assert.ok(Math.abs(without.ageDays - 4) < 1e-9);
  assert.ok(withClock.recency > without.recency);
  assert.equal(memory.memorySettings({ ageDaysOf }).ageDaysOf, ageDaysOf);
  assert.equal(memory.memorySettings({}).ageDaysOf, null);
  assert.equal(memory.scoreDetail(0.5, "not a date", "x", null, new Date(real), { ageDaysOf }).ageDays, 0, "an unreadable stamp answers 0");
});
