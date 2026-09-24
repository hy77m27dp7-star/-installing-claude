// public/js/bubbles.js: how her text is cut into bubbles and timed. Pure, imported as is.
import { test } from "node:test";
import assert from "node:assert/strict";

const bubbles = await import("../../public/js/bubbles.js");
const { splitBubbles, bubbleDelayMs, pauseForId, hashString, MAX_PARA, BASE_MS, PER_CHAR_MS, CAP_MS, PAUSE_ONE_IN } = bubbles;

const sentence = (n, word = "word") => (word + " ").repeat(n).trim() + ".";

test("constants match SPEC_V2 section A", () => {
  assert.equal(MAX_PARA, 240);
  assert.equal(BASE_MS, 350);
  assert.equal(PER_CHAR_MS, 35);
  assert.equal(CAP_MS, 2600);
  assert.equal(PAUSE_ONE_IN, 12);
});

test("splitBubbles: blank lines separate bubbles, single newlines stay inside one", () => {
  assert.deepEqual(splitBubbles("one.\n\ntwo."), ["one.", "two."]);
  assert.deepEqual(splitBubbles("one\nstill one.\n\n\n\ntwo."), ["one\nstill one.", "two."]);
  assert.deepEqual(splitBubbles("a.\r\n\r\nb."), ["a.", "b."]);
});

test("splitBubbles: empty and whitespace -> no bubbles; a short paragraph is one bubble", () => {
  assert.deepEqual(splitBubbles(""), []);
  assert.deepEqual(splitBubbles("   \n\n  "), []);
  assert.deepEqual(splitBubbles(null), []);
  assert.deepEqual(splitBubbles("just this."), ["just this."]);
});

test("splitBubbles: a paragraph over 240 chars splits at sentence ends into two or three bubbles", () => {
  const p = [sentence(20), sentence(20), sentence(20), sentence(20)].join(" "); // ~400 chars
  assert.ok(p.length > 240);
  const out = splitBubbles(p);
  assert.ok(out.length >= 2 && out.length <= 3, "got " + out.length);
  for (const b of out) assert.ok(/[.!?]$/.test(b), "cut at a sentence end: " + JSON.stringify(b.slice(-20)));
  assert.equal(out.join(" ").replace(/\s+/g, " "), p.replace(/\s+/g, " "), "nothing lost or added");
});

test("splitBubbles: a very long paragraph never becomes more than three bubbles", () => {
  const p = Array.from({ length: 12 }, () => sentence(15)).join(" "); // ~1000 chars
  const out = splitBubbles(p);
  assert.ok(out.length <= 3 && out.length >= 2, "got " + out.length);
});

test("splitBubbles: a long paragraph with no sentence end stays one bubble", () => {
  const p = "word ".repeat(80).trim();
  assert.ok(p.length > 240);
  assert.deepEqual(splitBubbles(p), [p]);
});

test("splitBubbles: never cuts inside a [photo: ...] or [song: ...] marker", () => {
  const marker = "[photo: me on the couch. hoodie. no makeup! lamp on? yes. half smile. messy bun. very tired. really.]";
  const p = sentence(25) + " " + marker + " " + sentence(25);
  assert.ok(p.length > 240);
  const out = splitBubbles(p);
  assert.ok(out.some((b) => b.includes(marker)), "the marker must survive whole in one bubble: " + JSON.stringify(out));
  const song = "[song: Sufjan Stevens - Fourth of July. The long one.]";
  const q = sentence(30) + " " + song + " " + sentence(30);
  assert.ok(splitBubbles(q).some((b) => b.includes(song)));
});

test("splitBubbles: a sentence end right at the end of the paragraph is not a cut", () => {
  const p = sentence(60);
  assert.ok(p.length > 240);
  assert.deepEqual(splitBubbles(p), [p]);
});

test("bubbleDelayMs: 350ms plus 35ms per character, capped at 2600ms", () => {
  assert.equal(bubbleDelayMs(""), 350);
  assert.equal(bubbleDelayMs("0123456789"), 700);
  assert.equal(bubbleDelayMs("x".repeat(64)), 2590);
  assert.equal(bubbleDelayMs("x".repeat(65)), 2600);
  assert.equal(bubbleDelayMs("x".repeat(5000)), 2600);
  assert.equal(bubbleDelayMs(undefined), 350);
});

test("hashString and pauseForId: deterministic, and about one reply in twelve pauses", () => {
  assert.equal(hashString("m_abc"), hashString("m_abc"));
  assert.notEqual(hashString("m_abc"), hashString("m_abd"));
  assert.equal(pauseForId("m_abc"), pauseForId("m_abc"));
  assert.equal(pauseForId(""), false);
  assert.equal(pauseForId(null), false);
  let paused = 0;
  const n = 2400;
  for (let i = 0; i < n; i++) if (pauseForId("m_" + i.toString(36) + "_id")) paused++;
  const share = paused / n;
  assert.ok(share > 0.05 && share < 0.12, "pause share " + share.toFixed(3) + " (expected about 1/12)");
});
