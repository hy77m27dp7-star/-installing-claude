// Bounded context assembly: keywords, history selection and the message window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, historyRow } from "./helpers.mjs";

const { keywords, selectHistory, boundMessages } = await loadSrc("context");

// ------------------------------------------------------------------ keywords

test("keywords: lowercases, drops stop words, punctuation and short tokens", () => {
  const k = keywords("The Dog, and the Park! It was OK, so we went.");
  assert.ok(k.has("dog"));
  assert.ok(k.has("park"));
  assert.ok(k.has("went"));
  for (const stop of ["the", "and", "it", "was", "ok", "so", "we"]) assert.ok(!k.has(stop), "stop word kept: " + stop);
  assert.ok(!k.has("dog,"));
});

test("keywords: returns a Set and handles empty text", () => {
  assert.ok(keywords("") instanceof Set);
  assert.equal(keywords("").size, 0);
  assert.equal(keywords("a an the").size, 0);
});

test("keywords: strips wrapping apostrophes and keeps inner ones", () => {
  const k = keywords("'quoted' don't");
  assert.ok(k.has("quoted"));
  assert.ok(k.has("don't"));
});

// ------------------------------------------------------------------ selectHistory

function ledger(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push(historyRow({ id: "h" + i, seq: i, title: "entry " + i, body: "nothing in particular happened on day " + i }));
  }
  return rows;
}

test("selectHistory: twelve or fewer entries are all kept, in order", () => {
  const all = ledger(12);
  const out = selectHistory(all, "anything");
  assert.equal(out.length, 12);
  assert.deepEqual(out.map((h) => h.seq), all.map((h) => h.seq));
  assert.equal(selectHistory([], "anything").length, 0);
});

test("selectHistory: beyond twelve, the newest six stay and older entries need keyword overlap", () => {
  const all = ledger(15);
  all[1] = historyRow({ id: "h2", seq: 2, title: "Rosie diner", body: "chili fries at the diner, terrible coffee, she laughed" });
  const out = selectHistory(all, "remember the chili fries at that diner? terrible coffee");
  const seqs = out.map((h) => h.seq);
  assert.deepEqual(seqs.slice(-6), [10, 11, 12, 13, 14, 15]);
  assert.ok(seqs.includes(2), "matching older entry should be kept");
  assert.ok(!seqs.includes(3), "non-matching older entry should be dropped");
  assert.equal(out.length, 7);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], "sorted by seq");
});

test("selectHistory: one shared word is not enough to pull an older entry in", () => {
  const all = ledger(15);
  all[0] = historyRow({ id: "h1", seq: 1, title: "coffee", body: "coffee only" });
  const out = selectHistory(all, "coffee sounds nice");
  assert.equal(out.length, 6);
});

// ------------------------------------------------------------------ boundMessages

const msg = (role, n, ch = "x") => ({ role, content: ch.repeat(n) });

test("boundMessages: keeps the most recent messages inside the character bound", () => {
  const rows = [msg("user", 100, "a"), msg("assistant", 100, "b"), msg("user", 100, "c"), msg("assistant", 100, "d"), msg("user", 100, "e")];
  const out = boundMessages(rows, 350);
  assert.equal(out.length, 3);
  assert.equal(out[0].content[0], "c");
  assert.equal(out[2].content[0], "e");
});

test("boundMessages: the first kept message is always from the user", () => {
  const rows = [msg("user", 100, "a"), msg("assistant", 100, "b"), msg("user", 100, "c"), msg("assistant", 100, "d"), msg("user", 100, "e")];
  const out = boundMessages(rows, 250);
  assert.ok(out.length >= 1);
  assert.equal(out[0].role, "user");
  for (const m of boundMessages(rows, 24000)) assert.ok(m.role === "user" || m.role === "assistant");
  assert.equal(boundMessages(rows, 24000)[0].role, "user");
});

test("boundMessages: a generous bound keeps everything; an all-assistant list yields nothing", () => {
  const rows = [msg("user", 10), msg("assistant", 10), msg("user", 10)];
  assert.equal(boundMessages(rows, 1000).length, 3);
  assert.equal(boundMessages([msg("assistant", 10), msg("assistant", 10)], 1000).length, 0);
  assert.equal(boundMessages([], 1000).length, 0);
});

test("boundMessages: the newest message is kept even when it alone exceeds the bound", () => {
  const out = boundMessages([msg("user", 10), msg("user", 5000)], 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].content.length, 5000);
});
