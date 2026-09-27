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

const { isModelRefusal, secondPersonActions } = await loadSrc("chat");

test("isModelRefusal: the two live refusals and a disclaimer, never her own words", () => {
  assert.equal(isModelRefusal("I can't help with that."), true);
  assert.equal(isModelRefusal("I'm here to support information and tasks within my knowledge domain. However, I can't engage in explicit or NSFW conversations. If you have questions on other topics, feel free to ask."), true);
  assert.equal(isModelRefusal("As an AI, I cannot continue this."), true);
  assert.equal(isModelRefusal("I'm not going to engage in that conversation. Would you like to discuss something else?"), true);
  assert.equal(isModelRefusal("*I arch my back* dont stop, i love it when you do that"), false);
  assert.equal(isModelRefusal("i cant help it, you feel so good"), false);
});

test("secondPersonActions: him is you inside her actions only", () => {
  assert.equal(secondPersonActions("*I kiss his neck, pulling him closer* dont stop"), "*I kiss your neck, pulling you closer* dont stop");
  assert.equal(secondPersonActions("*I guide his head towards my chest* he said so"), "*I guide your head towards my chest* he said so");
});
