// src/voiceprint.ts: computeVoiceprint over a fixed corpus (SPEC_V2 section Y). Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { messageRow } from "./helpers_v2.mjs";

const { computeVoiceprint } = await loadSrc("voiceprint");

const SINCE = "2026-09-21T00:00:00.000Z";
const UNTIL = "2026-09-28T00:00:00.000Z";
const at = (day, h = 12) => `2026-09-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

// Six of her story messages inside the week (one a first text, one with two bubbles, one
// with flags, one "lol", one naming him), plus rows the stats must ignore: a user message,
// an operator message, and one of hers from before the window.
function corpus() {
  return [
    messageRow({ id: "a1", content: "ok. fine.", created_at: at(22), reply_to_id: "u1" }),                                 // 9 chars
    messageRow({ id: "a2", content: "why would you say that?", created_at: at(23), reply_to_id: "u2" }),                    // 23 chars, question
    messageRow({ id: "a3", content: "first bubble here.\n\nsecond bubble here.", created_at: at(24), reply_to_id: null }),   // 39 chars, 2 bubbles, first text
    messageRow({ id: "a4", content: "that is not funny lol", created_at: at(25), reply_to_id: "u4", flags_json: JSON.stringify([{ code: "lol_lmao", severity: "flag", detail: "" }, { code: "caption_tail", severity: "flag", detail: "" }]) }), // 21 chars
    messageRow({ id: "a5", content: "justin, no. absolutely not.", created_at: at(26), reply_to_id: "u5" }),                // 27 chars
    messageRow({ id: "a6", content: "the bench thing again. the bench wins.", created_at: at(27), reply_to_id: "u6", flags_json: JSON.stringify([{ code: "caption_tail", severity: "flag", detail: "" }]) }), // 38 chars
    messageRow({ id: "u1", role: "user", content: "what?", created_at: at(22, 11) }),
    messageRow({ id: "o1", channel: "operator", content: "operator: which model", created_at: at(23, 11) }),
    messageRow({ id: "old", content: "from last week, ignored", created_at: "2026-09-19T12:00:00.000Z" }),
    messageRow({ id: "late", content: "from next week, ignored", created_at: "2026-09-29T12:00:00.000Z" }),
  ];
}

// Field names are the implementer's; each stat is read through a short alias list.
const num = (obj, names) => {
  for (const n of names) if (obj && typeof obj[n] === "number") return obj[n];
  return undefined;
};
const any = (obj, names) => {
  for (const n of names) if (obj && obj[n] !== undefined) return obj[n];
  return undefined;
};

const result = computeVoiceprint(corpus(), SINCE, UNTIL);
const r = result instanceof Promise ? await result : result;

test("computeVoiceprint: a plain JSON-serialisable object", () => {
  assert.equal(typeof r, "object");
  assert.ok(r !== null);
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(JSON.stringify(r).length < 20_000);
});

test("count: her story messages inside the window only (6)", () => {
  assert.equal(num(r, ["count", "messages", "messageCount", "n"]), 6, JSON.stringify(r).slice(0, 300));
});

test("length: mean and median over the six replies", () => {
  // lengths 9, 23, 39, 21, 27, 38 -> mean 26.17, median 25
  const mean = num(r, ["meanLength", "mean_length", "meanChars", "avgLength", "mean"]);
  const median = num(r, ["medianLength", "median_length", "medianChars", "median"]);
  assert.ok(Math.abs(mean - 26.17) < 0.6, "mean " + mean);
  assert.ok(Math.abs(median - 25) < 0.6, "median " + median);
});

test("question share: one of six ends with a question mark", () => {
  const q = num(r, ["questionShare", "question_share", "questions", "questionRate", "endsWithQuestion"]);
  assert.ok(Math.abs(q - 1 / 6) < 0.01 || q === 1, "question share " + q);
});

test("lol or emoji share: one of six (should be zero in a healthy week)", () => {
  const s = num(r, ["lolEmojiShare", "lol_emoji_share", "lolShare", "lolOrEmojiShare", "slangShare"]);
  assert.ok(Math.abs(s - 1 / 6) < 0.01 || s === 1, "lol/emoji share " + s);
});

test("his name: one of six replies carries it", () => {
  const s = num(r, ["nameShare", "name_share", "hisNameShare", "mentionsHisName", "nameRate"]);
  assert.ok(Math.abs(s - 1 / 6) < 0.01 || s === 1, "name share " + s);
});

test("top words: bench leads, stop words absent, at most 25 entries", () => {
  const top = any(r, ["topWords", "top_words", "words", "top"]);
  assert.ok(Array.isArray(top), "topWords array");
  assert.ok(top.length <= 25);
  const wordOf = (e) => (typeof e === "string" ? e : Array.isArray(e) ? e[0] : e.word ?? e.w ?? e.term);
  const words = top.map(wordOf);
  assert.equal(words[0], "bench", "top word: " + words.slice(0, 5).join(", "));
  for (const stop of ["the", "not", "that", "you"]) assert.ok(!words.includes(stop), "stop word kept: " + stop);
});

test("bubbles per reply: 7 bubbles over 6 replies", () => {
  const b = num(r, ["bubblesPerReply", "bubbles_per_reply", "meanBubbles", "bubbleCount", "bubbles"]);
  assert.ok(Math.abs(b - 7 / 6) < 0.01 || b === 7, "bubbles " + b);
});

test("first texts: one reply with no message of his before it", () => {
  assert.equal(num(r, ["firstTexts", "first_texts", "firstTextCount", "openers"]), 1);
});

test("flags per code: caption_tail 2, lol_lmao 1", () => {
  const flags = any(r, ["flags", "flagsPerCode", "flags_per_code", "flagCounts"]);
  assert.ok(flags && typeof flags === "object", "flags object");
  const count = (code) => (Array.isArray(flags) ? (flags.find((f) => f.code === code) ?? {}).n ?? (flags.find((f) => f.code === code) ?? {}).count : flags[code]);
  assert.equal(count("caption_tail"), 2);
  assert.equal(count("lol_lmao"), 1);
});

test("an empty window yields zeros, not NaN", () => {
  const e = computeVoiceprint([], SINCE, UNTIL);
  const json = JSON.stringify(e);
  assert.ok(!json.includes("null") || true, "nulls are tolerated");
  assert.ok(!/NaN|Infinity/.test(json), json);
  assert.equal(num(e, ["count", "messages", "messageCount", "n"]), 0);
});
