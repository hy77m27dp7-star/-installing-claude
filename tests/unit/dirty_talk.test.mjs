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

const promptMod = await loadSrc("prompt");
test("a kiss is not a bed scene; a bed or undressing is", () => {
  const base = { status: "together", location: "the record store on Congress Street", summary: "They remain close together, staying in the moment after the kiss", last_beat: "after the kiss" };
  assert.equal(promptMod.intimateScene(base), false);
  assert.equal(promptMod.intimateScene({ ...base, location: "her apartment, in her bed" }), true);
  assert.equal(promptMod.intimateScene({ ...base, summary: "clothes coming off on the couch" }), true);
  assert.equal(promptMod.intimateScene({ ...base, intimate: true }), true);
});

const voiceMod = await loadSrc("voice");
test("isWhisperJunk: what Whisper invents from silence is no line", () => {
  for (const t of ["Продолжение следует...", "ん ん ん ん", "Thanks for watching!", "", "   ", "字幕"]) assert.equal(voiceMod.isWhisperJunk(t), true, t);
  for (const t of ["I pull you closer", "Can we watch the Lions game together today?", "da fuck?", "hey"]) assert.equal(voiceMod.isWhisperJunk(t), false, t);
});

test("padMp3Silence: silent MPEG-1 Layer III frames after the ID3 tag, in the file's format", () => {
  const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0xaa, 0xbb];
  const frame = new Array(417).fill(1); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0xc0;
  const input = new Uint8Array([...id3, ...frame]);
  const out = voiceMod.padMp3Silence(input, 500);
  const frames = Math.round(0.5 * 44100 / 1152);
  assert.equal(out.length, input.length + frames * 417);
  assert.deepEqual([...out.slice(0, 12)], id3, "the tag stays first");
  assert.deepEqual([...out.slice(12, 16)], [0xff, 0xfb, 0x90, 0xc0], "a silent frame in the same format");
  assert.equal(out[16], 0);
  assert.deepEqual([...out.slice(12 + frames * 417, 16 + frames * 417)], [0xff, 0xfb, 0x90, 0xc0], "her audio follows");
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  assert.deepEqual(voiceMod.padMp3Silence(junk), junk, "not an mp3: unchanged");
});
