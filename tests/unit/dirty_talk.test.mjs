// Dirty talk mode (2026-09-27): the intimate performer in a bed scene, and her lines spoken
// with her actions narrated in the first person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const { spokenText, narrateAction, firstPersonVerb } = await loadSrc("narrate");
const { pickPerformer } = await loadSrc("chat");

test("firstPersonVerb", () => {
  for (const [a, b] of [["pulls", "pull"], ["pushes", "push"], ["kisses", "kiss"], ["tries", "try"], ["reaches", "reach"], ["is", "am"], ["doesn't", "don't"], ["goes", "go"], ["bites", "bite"], ["press", "press"], ["into", "into"]]) assert.equal(firstPersonVerb(a), b, a);
});

test("narrateAction", () => {
  assert.equal(narrateAction("pulls you closer"), "I pull you closer.");
  assert.equal(narrateAction("laughs into your shirt, doesn't move"), "I laugh into your shirt, don't move.");
  assert.equal(narrateAction("slowly pushes my hair back"), "I slowly push my hair back.");
  assert.equal(narrateAction("presses my face back into your jacket"), "I press my face back into your jacket.");
});

test("spokenText: actions narrated, speech kept, markers never spoken", () => {
  assert.equal(spokenText("*presses my face back into your jacket* okay... keep me then", true), "I press my face back into your jacket. okay... keep me then");
  assert.equal(spokenText("*pulls you closer* dont stop\n[photo: me in your shirt]", true), "I pull you closer. dont stop");
  assert.equal(spokenText("*pulls you closer* dont stop", false), "dont stop");
  assert.equal(spokenText("*pulls you closer*", true, { tags: true }), "[whispers] I pull you closer.");
  assert.equal(spokenText("*pulls you closer*", false), "");
});

test("pickPerformer: the intimate performer only in an intimate scene, on, named and configured", () => {
  const env = { AI: {}, ANTHROPIC_API_KEY: "x" };
  const s = { provider: "anthropic", model: "claude-opus-5-5", intimateEnabled: true, intimateProvider: "workersai", intimateModel: "@cf/meta/llama-4-scout-17b-16e-instruct" };
  assert.deepEqual(pickPerformer(env, s, false), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.deepEqual(pickPerformer(env, s, true), { provider: "workersai", model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
  assert.deepEqual(pickPerformer(env, { ...s, intimateEnabled: false }, true), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.deepEqual(pickPerformer(env, { ...s, intimateModel: "" }, true), { provider: "anthropic", model: "claude-opus-5-5" });
});
