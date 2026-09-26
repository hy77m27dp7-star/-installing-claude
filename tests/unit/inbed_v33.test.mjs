// v3.3 (2026-09-26): the IN BED section rides LAST when the scene record says she is in an
// intimate scene she chose, and nowhere else; the turn-passing marker a small performer
// appends is a mechanical repair. Gated on -p7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, promptState, sceneState, checkCtx, BAD_TYPOGRAPHY } from "./helpers.mjs";

const prompt = await loadSrc("prompt");
const checks = await loadSrc("checks");

const couch = () => sceneState({
  status: "together",
  location: "her apartment, on the couch, lamps low",
  time: "late night",
  present: ["Justin"],
  summary: "Her apartment late at night after their fourth date. They have been kissing on the couch for a while, hot and heavy.",
  last_beat: "kissing on the couch, her on his lap",
});

test("prompt version is -p7", () => {
  assert.ok(prompt.PROMPT_VERSION.endsWith("-p7"), prompt.PROMPT_VERSION);
});

test("intimateScene: a together scene that reads as one", () => {
  assert.equal(prompt.intimateScene(couch()), true);
  assert.equal(prompt.intimateScene(sceneState({ status: "together", location: "the bench", summary: "coffee at her regular place", last_beat: "she handed him the cup" })), false);
});

test("intimateScene: never from apart, whatever the words", () => {
  assert.equal(prompt.intimateScene(sceneState({ status: "apart", summary: "texting about last night, the kissing on the couch" })), false);
  assert.equal(prompt.intimateScene(sceneState()), false);
});

test("intimateScene: the explicit flag wins either way", () => {
  assert.equal(prompt.intimateScene(sceneState({ status: "together", summary: "the kitchen", intimate: true })), true);
  assert.equal(prompt.intimateScene({ ...couch(), intimate: false }), false);
});

test("IN BED rides last inside the scene, with the cue before it, and is absent otherwise", () => {
  const sep = prompt.SECTION_SEPARATOR;
  const on = prompt.stateSections(promptState({ scene: couch(), hasSharedHistory: true }));
  const parts = on.split(sep);
  assert.ok(parts[parts.length - 1].startsWith("IN BED, RIGHT NOW"), parts[parts.length - 1].slice(0, 40));
  assert.equal(on.split("IN BED, RIGHT NOW").length, 2, "exactly one IN BED section");
  assert.ok(!BAD_TYPOGRAPHY.test(on));

  const off = prompt.stateSections(promptState({ hasSharedHistory: true }));
  assert.ok(!off.includes("IN BED, RIGHT NOW"));

  const apart = prompt.stateSections(promptState({ scene: sceneState({ status: "apart", summary: "kissing on the couch" }), hasSharedHistory: true }));
  assert.ok(!apart.includes("IN BED, RIGHT NOW"));
});

test("IN BED says what it must: desire answered with desire, no braking, no turn marker", () => {
  const t = prompt.IN_BED_SECTION;
  for (const must of ["answer desire with desire", "No slowing him down", "first-time and crude-compliment rules in your files are off", "Never end with *your turn*", "nothing he says about your body"]) {
    assert.ok(t.includes(must), must);
  }
});

test("turn_marker: flagged and repaired away, the rest untouched", () => {
  for (const tail of ["*your turn*", "*Your turn*", "(your move)", "[your go]", "*you're up*", "*over to you*"]) {
    const r = checks.runChecks("ok. i saw it.\n" + tail, checkCtx());
    assert.ok(r.flags.some((f) => f.code === "turn_marker"), tail);
    assert.equal(r.action, "repair", tail);
    assert.equal(r.repaired, "ok. i saw it.", tail);
  }
});

test("turn_marker: a marker in the middle goes too, and clean text is not flagged", () => {
  assert.equal(checks.repairText("*i kiss you slowly* *your turn*\nsee?"), "*i kiss you slowly*\nsee?");
  const r = checks.runChecks("*i kiss you slowly* ok", checkCtx());
  assert.ok(!r.flags.some((f) => f.code === "turn_marker"));
  assert.equal(checks.repairText("it was your turn to pick the place"), "it was your turn to pick the place");
});
