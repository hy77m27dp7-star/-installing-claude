// The promotion merge (SPEC_V4 section 8): mergeSceneState and mergeRelationshipState take
// what a payload carries and keep the rest (the v4 proof: v3.3 takes nothing), the parse of
// the new payload keys, the stub's [[SCENE:x]] and [[REL:s|n]] triggers, and the proposal
// system prompt's two new lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, relationshipState, sceneState } from "./helpers.mjs";
import { loadSrcIfPresent, guard, NOW } from "./helpers_v4.mjs";

const proposals = await loadSrcIfPresent("proposals");
const prompt = await loadSrc("prompt");
const { stubProvider } = await loadSrc("providers/stub");
const { parseProposalJson } = proposals;
const t = guard(proposals, "mergeSceneState", "mergeRelationshipState");
const promptText = prompt.proposalSystemPrompt();
const tp = /"scene" proposal describes where they are/.test(promptText) ? test : (name, fn) => test.skip(name + " [skipped: proposalSystemPrompt has no scene payload line yet (pipeline lane)]", fn);

const el = (extra) => ({ proposal: "x", evidence: "q", confidence: "high", scope: "general", ...extra });
const one = (extra) => parseProposalJson(JSON.stringify([el(extra)]))[0];

t("mergeSceneState: a payload with a location moves the scene; status and present are taken; summary and last_beat are the text", () => {
  const cur = sceneState({ status: "apart", location: null, time: "morning", present: [] });
  const next = proposals.mergeSceneState(cur, { status: "together", location: "the harbour bench", present: ["Avelie", "him"] }, "they sat on the bench");
  assert.equal(next.status, "together");
  assert.equal(next.location, "the harbour bench");
  assert.deepEqual(next.present, ["Avelie", "him"]);
  assert.equal(next.time, "morning", "a field the payload does not carry is kept");
  assert.equal(next.summary, "they sat on the bench");
  assert.equal(next.last_beat, "they sat on the bench");
  const moved = proposals.mergeSceneState(sceneState({ status: "together", location: "the harbour bench" }), { status: "together", location: "the pier" }, "they walked to the pier");
  assert.equal(moved.location, "the pier");
  const timed = proposals.mergeSceneState(sceneState(), { time: "late, past midnight" }, "x");
  assert.equal(timed.time, "late, past midnight");
});

t("mergeSceneState: an empty payload keeps status, location and present (the regression guard); a bad status, a blank location or a bad present list is ignored; together with no location keeps the previous one", () => {
  const cur = sceneState({ status: "together", location: "the pier", time: "dusk", present: ["Avelie", "him"] });
  const same = proposals.mergeSceneState(cur, {}, "the pier is kept");
  assert.equal(same.status, "together");
  assert.equal(same.location, "the pier");
  assert.deepEqual(same.present, ["Avelie", "him"]);
  assert.equal(same.time, "dusk");
  assert.equal(same.summary, "the pier is kept");
  const bad = proposals.mergeSceneState(cur, { status: "elsewhere", location: "   ", present: "him", time: "" }, "x");
  assert.equal(bad.status, "together");
  assert.equal(bad.location, "the pier");
  assert.deepEqual(bad.present, ["Avelie", "him"]);
  assert.equal(bad.time, "dusk");
  const together = proposals.mergeSceneState(cur, { status: "together" }, "still there");
  assert.equal(together.location, "the pier", "together with no location keeps the previous location");
  const none = proposals.mergeSceneState(cur, { status: "none" }, "they said goodnight");
  assert.equal(none.status, "none");
  const tooLong = proposals.mergeSceneState(cur, { location: "x".repeat(301), present: Array.from({ length: 11 }, (_, i) => "p" + i) }, "x");
  assert.equal(tooLong.location.length, 300, "a location over 300 is cut at 300");
  assert.equal(tooLong.present.length, 10, "more than ten present is cut at ten");
  const cleaned = proposals.mergeSceneState(cur, { present: ["Avelie", " him ", "", 42] }, "x");
  assert.ok(Array.isArray(cleaned.present) && cleaned.present.every((p) => typeof p === "string" && p.trim()), JSON.stringify(cleaned.present));
});

t("mergeRelationshipState: takes status, his_name, trust, affection, attraction, nicknames when present; the mood keys still stamp; the frontier appends", () => {
  const cur = relationshipState();
  const next = proposals.mergeRelationshipState(cur, { status: "seeing each other", his_name: "Justin", trust: "starting", affection: "warm", attraction: "mutual and open", nicknames: "Starbrite", mood: "warm", mood_days: 2 }, "they are seeing each other", NOW);
  assert.equal(next.status, "seeing each other");
  assert.equal(next.his_name, "Justin");
  assert.equal(next.trust, "starting");
  assert.equal(next.affection, "warm");
  assert.equal(next.attraction, "mutual and open");
  assert.equal(next.nicknames, "Starbrite");
  assert.equal(next.summary, "they are seeing each other");
  assert.equal(next.frontier, "before the first conversation | they are seeing each other");
  assert.equal(next.mood, "warm");
  assert.equal(next.mood_days, 2);
  assert.equal(next.private_language, "none", "untouched");
  assert.equal(next.friction, "none");
});

t("mergeRelationshipState: an empty payload keeps the six fields (the guard); his_name null clears it, undefined does not; over-long strings are ignored", () => {
  const cur = relationshipState({ status: "seeing each other", his_name: "Justin", trust: "starting", affection: "warm", attraction: "mutual", nicknames: "Starbrite" });
  const same = proposals.mergeRelationshipState(cur, {}, "a small fight", NOW);
  assert.equal(same.status, "seeing each other");
  assert.equal(same.his_name, "Justin");
  assert.equal(same.trust, "starting");
  assert.equal(same.affection, "warm");
  assert.equal(same.attraction, "mutual");
  assert.equal(same.nicknames, "Starbrite");
  assert.equal(same.summary, "a small fight");
  const cleared = proposals.mergeRelationshipState(cur, { his_name: null }, "x", NOW);
  assert.equal(cleared.his_name, null, "null clears");
  const kept = proposals.mergeRelationshipState(cur, { his_name: undefined, status: "" }, "x", NOW);
  assert.equal(kept.his_name, "Justin");
  assert.equal(kept.status, "seeing each other", "an empty string is not a value");
  const long = proposals.mergeRelationshipState(cur, { trust: "x".repeat(201) }, "x", NOW);
  assert.equal(long.trust.length, 200, "over 200 is cut at 200");
  const cooling = proposals.mergeRelationshipState(cur, { mood: "annoyed", cooling_off_hours: 12 }, "x", NOW);
  assert.equal(cooling.mood, "annoyed");
  assert.ok(typeof cooling.cooling_off_until === "string" && Date.parse(cooling.cooling_off_until) > NOW.getTime());
});

test("parseProposalJson reads the scene and relationship payload keys as given", () => {
  const scene = one({ kind: "scene", proposal: "they are at the pier", payload: { status: "together", location: "the pier", time: "dusk", present: ["Avelie", "him"] } });
  assert.deepEqual(scene.payload, { status: "together", location: "the pier", time: "dusk", present: ["Avelie", "him"] });
  const rel = one({ kind: "relationship", proposal: "seeing each other", payload: { status: "seeing each other", his_name: "Justin", trust: "starting", affection: "warm", attraction: "open", nicknames: "Starbrite" } });
  assert.equal(rel.payload.status, "seeing each other");
  assert.equal(rel.payload.his_name, "Justin");
  assert.equal(rel.payload.nicknames, "Starbrite");
});

// The stub's proposal pass is recognised by the first words of the system prompt.
const PROPOSAL_SYSTEM = "You read one exchange between a user and a fictional character named Avelie and extract candidate DURABLE facts.";
async function stubProposals(text) {
  const r = await stubProvider.generate({}, { system: PROPOSAL_SYSTEM, messages: [{ role: "user", content: text }], model: "stub", maxTokens: 800, temperature: 0, effort: "low", cacheable: false });
  return JSON.parse(r.text);
}

test("the stub: [[SCENE:x]] proposes a scene with status together and the location; the bare [[SCENE]] carries a summary only; [[REL:status|name]] proposes a relationship with status and his_name", async () => {
  const withPlace = await stubProposals("[[SCENE:the harbour bench]] sit here");
  assert.equal(withPlace.length, 1);
  assert.equal(withPlace[0].kind, "scene");
  assert.deepEqual(withPlace[0].payload, { status: "together", location: "the harbour bench" });
  const bare = await stubProposals("[[SCENE]] still here");
  assert.equal(bare[0].kind, "scene");
  assert.equal(bare[0].payload, undefined, "summary only");
  const rel = await stubProposals("[[REL:seeing each other|Justin]] ok");
  assert.equal(rel[0].kind, "relationship");
  assert.deepEqual(rel[0].payload, { status: "seeing each other", his_name: "Justin" });
  const noName = await stubProposals("[[REL:talking]] ok");
  assert.deepEqual(noName[0].payload, { status: "talking" });
  assert.deepEqual(await stubProposals("[[REL:]] nothing"), [], "an empty status proposes nothing");
  for (const p of [...withPlace, ...bare, ...rel]) assert.ok(parseProposalJson(JSON.stringify([p])).length === 1, "the runtime parses what the stub proposes");
});

tp("proposalSystemPrompt: the relationship payload names status, his_name, trust, affection, attraction and nicknames; the scene line names status, location, time and present", () => {
  assert.ok(/"status": one to four plain words for where they stand now/.test(promptText), "the relationship status line");
  for (const k of ['"his_name"', '"trust"', '"affection"', '"attraction"', '"nicknames"']) assert.ok(promptText.includes(k), k);
  assert.ok(/A "scene" proposal describes where they are when a shared scene starts, moves or ends/.test(promptText));
  assert.ok(/"status": "together"\|"apart"\|"none"/.test(promptText));
  assert.ok(/Never omit "location" when the scene moved somewhere new/.test(promptText));
  assert.ok(promptText.startsWith("You read one exchange"), "the stub's key stays first");
});
