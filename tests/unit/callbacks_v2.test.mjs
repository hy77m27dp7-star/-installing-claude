// src/callbacks.ts: pickCallbacks (pure, deterministic, capped at two) and its prompt section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, historyRow, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { TUE_1510_NY, threadRow, eventRow, personRow, arcRow, logRow } from "./helpers_v2.mjs";

const { pickCallbacks, callbacksSection } = await loadSrc("callbacks");

const DAY = 24 * 60 * 60 * 1000;
const NOW = TUE_1510_NY;
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString();

function pool() {
  return {
    history: [
      historyRow({ id: "h_bench", title: "the bench by the river", body: "they sat on the bench by the river and talked", occurred: null, created_at: daysAgo(11), updated_at: daysAgo(11) }),
      historyRow({ id: "h_diner", title: "chili fries at the diner", body: "terrible coffee, she laughed", occurred: daysAgo(6), created_at: daysAgo(6), updated_at: daysAgo(6) }),
      historyRow({ id: "h_fresh", title: "yesterday's phone call", body: "too recent to bring up", occurred: daysAgo(1), created_at: daysAgo(1), updated_at: daysAgo(1) }),
      historyRow({ id: "h_rejected", title: "a rejected entry about kites", body: "never approved", status: "rejected", created_at: daysAgo(20), updated_at: daysAgo(20) }),
    ],
    threads: [
      arcRow({ id: "arc_sing", updated_at: daysAgo(9) }),
      personRow({ id: "p_dana", updated_at: daysAgo(4) }),
      eventRow(daysAgo(5), { id: "ev_past", status: "done", schedule_json: JSON.stringify({ at: daysAgo(5), label: "the open mic" }) }),
      eventRow(daysAgo(30), { id: "ev_old", status: "done", schedule_json: JSON.stringify({ at: daysAgo(30), label: "a thing from last month" }) }),
      eventRow(new Date(NOW.getTime() + 3 * DAY).toISOString(), { id: "ev_future", schedule_json: JSON.stringify({ at: new Date(NOW.getTime() + 3 * DAY).toISOString(), label: "next week's show" }) }),
      personRow({ id: "p_dropped", title: "Nobody", status: "dropped", updated_at: daysAgo(4) }),
    ],
    log: [
      logRow({ id: "ll_rice", occurred: daysAgo(2), note: "burnt the rice again" }),
      logRow({ id: "ll_old", occurred: daysAgo(40), note: "something from ages ago about pumpkins" }),
    ],
  };
}

const pick = (over = {}) => pickCallbacks({ ...pool(), recentTexts: [], now: NOW, seed: "2026-09-29:c_test", ...over });

test("pickCallbacks: returns at most two items with text, ageDays and sourceId", () => {
  const out = pick();
  assert.ok(Array.isArray(out));
  assert.ok(out.length >= 1 && out.length <= 2, "got " + out.length);
  for (const c of out) {
    assert.equal(typeof c.text, "string");
    assert.ok(c.text.trim().length > 0);
    assert.ok(Number.isInteger(c.ageDays) && c.ageDays >= 0);
    assert.equal(typeof c.sourceId, "string");
  }
  assert.notEqual(out[0]?.sourceId, out[1]?.sourceId);
});

test("pickCallbacks: the same seed picks the same items in the same order", () => {
  const a = pick();
  const b = pick();
  assert.deepEqual(a, b);
});

test("pickCallbacks: different seeds can pick differently (a day or a conversation moves the choice)", () => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(JSON.stringify(pick({ seed: "seed-" + i }).map((c) => c.sourceId)));
  assert.ok(seen.size >= 2, "twelve seeds never changed the pick");
});

test("pickCallbacks: candidates are only history older than three days, arcs, people, events in the past 14 days, recent log notes", () => {
  const ids = new Set();
  for (let i = 0; i < 40; i++) for (const c of pick({ seed: "s" + i })) ids.add(c.sourceId);
  for (const allowed of ["h_bench", "h_diner", "arc_sing", "p_dana", "ev_past", "ll_rice"]) assert.ok(ids.has(allowed), "never picked " + allowed);
  for (const banned of ["h_fresh", "h_rejected", "ev_old", "ev_future", "p_dropped", "ll_old"]) assert.ok(!ids.has(banned), "picked " + banned);
});

test("pickCallbacks: anything whose keywords appear in the recent messages is excluded", () => {
  const recentTexts = [
    "remember the bench by the river", "dana said hi", "how was the open mic", "the singing thing", "chili fries at the diner again", "i burnt the rice",
  ];
  const out = pick({ recentTexts });
  assert.equal(out.length, 0, JSON.stringify(out));
});

test("pickCallbacks: one mention removes that candidate only", () => {
  const ids = new Set();
  for (let i = 0; i < 40; i++) for (const c of pick({ seed: "t" + i, recentTexts: ["we talked about dana yesterday"] })) ids.add(c.sourceId);
  assert.ok(!ids.has("p_dana"), "Dana was just mentioned");
  assert.ok(ids.has("h_bench") || ids.has("arc_sing"), "other candidates still offered");
});

test("pickCallbacks: ageDays is the elapsed time (history 11 days, log note 2 days)", () => {
  const byId = new Map();
  for (let i = 0; i < 40; i++) for (const c of pick({ seed: "u" + i })) byId.set(c.sourceId, c.ageDays);
  assert.equal(byId.get("h_bench"), 11);
  assert.equal(byId.get("ll_rice"), 2);
  assert.equal(byId.get("ev_past"), 5);
});

test("pickCallbacks: empty inputs -> empty", () => {
  assert.deepEqual(pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: NOW, seed: "x" }), []);
});

test("pickCallbacks: a candidate's text is short and carries the person's relation", () => {
  let dana = null;
  for (let i = 0; i < 40 && !dana; i++) dana = pick({ seed: "v" + i }).find((c) => c.sourceId === "p_dana") ?? null;
  assert.ok(dana, "Dana never picked");
  assert.ok(dana.text.includes("Dana"));
  assert.ok(dana.text.includes("best friend"));
  assert.ok(dana.text.length <= 160);
});

// ------------------------------------------------------------------ callbacksSection

test("callbacksSection: empty -> empty string", () => {
  assert.equal(callbacksSection([]), "");
  assert.equal(callbacksSection(undefined), "");
});

test("callbacksSection: heading, one line per item with elapsed time, never more than two, never an instruction to ask", () => {
  const s = callbacksSection([
    { text: "the bench by the river", ageDays: 11, sourceId: "h_bench" },
    { text: "Dana (best friend): moving apartments this month", ageDays: 4, sourceId: "p_dana" },
    { text: "a third that must not appear", ageDays: 1, sourceId: "x" },
  ]);
  assert.ok(s.startsWith("THINGS YOU COULD BRING UP (only if it fits; most turns you will not)"));
  assert.ok(s.includes("- 11 days ago: the bench by the river"));
  assert.ok(s.includes("- 4 days ago: Dana (best friend)"));
  assert.ok(!s.includes("a third that must not appear"));
  assert.equal(s.split("\n").filter((l) => l.startsWith("- ")).length, 2);
  assert.ok(!/ask him|ask a question|ask about/i.test(s));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

test("callbacksSection: today and yesterday read as words", () => {
  const s = callbacksSection([{ text: "a", ageDays: 0, sourceId: "1" }, { text: "b", ageDays: 1, sourceId: "2" }]);
  assert.ok(s.includes("- today: a"));
  assert.ok(s.includes("- yesterday: b"));
});

test("callbacksSection: items with empty text are skipped", () => {
  const s = callbacksSection([{ text: "   ", ageDays: 3, sourceId: "1" }, { text: "real", ageDays: 3, sourceId: "2" }]);
  assert.equal(s.split("\n").filter((l) => l.startsWith("- ")).length, 1);
});
