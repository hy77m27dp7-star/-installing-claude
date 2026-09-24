// Human memory (SPEC_V3 section BB): the score, the half-lives, the ranking, the
// provisional recall and its section, and the SQL of the touch and carry statements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, factRow, historyRow, fakeD1, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, guard, weightRow, settingsV3, NOW, daysAgo, DAY_MS } from "./helpers_v3.mjs";

const mem = await loadSrcIfPresent("memory");
const t = guard(mem, "score", "halfLifeDays", "rankFacts", "rankHistory", "pickProvisional", "halfRememberSection");
const { keywords } = await loadSrc("context");
const S = settingsV3();

const num = (v) => (typeof v === "number" ? v : v && typeof v === "object" && typeof v.score === "number" ? v.score : NaN);
const scoreOf = (w, ageDays, text, recent) => num(mem.score(w, daysAgo(ageDays), text, recent instanceof Set ? recent : keywords(recent ?? ""), NOW, S));
const wmap = (rows) => new Map(rows.map((r) => [r.entity + ":" + r.entity_id, r]));

t("halfLifeDays: the three bands", () => {
  assert.equal(mem.halfLifeDays(0.2, S), 10);
  assert.equal(mem.halfLifeDays(0.5, S), 45);
  assert.equal(mem.halfLifeDays(0.9, S), 400);
  assert.equal(mem.halfLifeDays(0.34, S), 45);
  assert.equal(mem.halfLifeDays(0.67, S), 400);
});

t("score: monotonic in weight, decreasing in age, and relevance rescues a faded fact", () => {
  assert.ok(scoreOf(0.2, 0, "his dog is called biscuit") < scoreOf(0.5, 0, "his dog is called biscuit"));
  assert.ok(scoreOf(0.5, 0, "his dog is called biscuit") < scoreOf(0.9, 0, "his dog is called biscuit"));
  assert.ok(scoreOf(0.5, 0, "x") > scoreOf(0.5, 30, "x"));
  assert.ok(scoreOf(0.5, 30, "x") > scoreOf(0.5, 200, "x"));
  assert.ok(scoreOf(0.9, 300, "his sister lives in maine") >= 0.2, "a 0.9 fact 300 days old stays firm");
  assert.ok(scoreOf(0.2, 30, "his sister lives in maine") < 0.2, "a 0.2 fact 30 days old fades");
  const rescued = scoreOf(0.2, 30, "his sister lives in maine", "wait your sister lives in maine right");
  assert.ok(rescued >= 0.2, "relevance brings it back: " + rescued);
});

t("score: decay off makes every score 1", () => {
  const off = settingsV3({ memoryDecayEnabled: false });
  assert.equal(num(mem.score(0.2, daysAgo(400), "x", new Set(), NOW, off)), 1);
});

t("rankFacts: the cap and the order by score; a firm heavy fact stays whatever its age", () => {
  const facts = [];
  const weights = [];
  for (let i = 0; i < 50; i++) {
    facts.push(factRow({ id: "f" + i, scope: "justin", fact: "fact number " + i + " about him", created_at: daysAgo(400) }));
    weights.push(weightRow({ entity_id: "f" + i, weight: i === 0 ? 0.9 : 0.5, last_touched: daysAgo(i === 0 ? 400 : i) }));
  }
  const result = mem.rankFacts(facts, wmap(weights), new Set(), NOW, settingsV3({ memoryFactsMax: 10 }));
  const ranked = Array.isArray(result) ? result : result.kept;
  assert.ok(ranked.length <= 10, String(ranked.length));
  assert.ok(ranked.some((f) => f.id === "f0"), "the 0.9 fact at 400 days is firm");
  const ids = ranked.map((f) => f.id);
  const scores = ranked.map((f) => num(mem.score(f.id === "f0" ? 0.9 : 0.5, weights.find((w) => w.entity_id === f.id).last_touched, f.fact, new Set(), NOW, settingsV3())));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i] - 1e-9, "ordered by score: " + ids.join(","));
  const light = mem.rankFacts([factRow({ id: "old", scope: "justin", fact: "a passing detail", created_at: daysAgo(400) })], wmap([weightRow({ entity_id: "old", weight: 0.2, last_touched: daysAgo(400) })]), new Set(), NOW, S);
  const faded = Array.isArray(light) ? light : light.kept;
  assert.equal(faded.length, 0, "a light, old fact is not shown");
  if (!Array.isArray(light)) assert.equal(light.faded.length, 1, "it is faded, never gone");
});

t("rankHistory: the newest six always, older entries only when they score, capped at 12, in seq order", () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) rows.push(historyRow({ id: "h" + i, seq: i, title: "entry " + i, body: "something that happened, take " + i, created_at: daysAgo(400 - i) }));
  const result = mem.rankHistory(rows, new Map(), new Set(), NOW, S);
  const ranked = Array.isArray(result) ? result : result.kept;
  assert.ok(ranked.length <= 12, String(ranked.length));
  for (let i = 15; i <= 20; i++) assert.ok(ranked.some((h) => h.id === "h" + i), "newest six kept: h" + i);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].seq < ranked[i].seq, "seq order");
});

t("pickProvisional: the bounds (weight, recency, relevance, rate, cooling, no history, opener, setting 0 returns null)", () => {
  const fact = factRow({ id: "fx", scope: "justin", fact: "his cousin plays drums in a wedding band", created_at: daysAgo(40) });
  const map = wmap([weightRow({ entity_id: "fx", weight: 0.2, last_touched: daysAgo(40) })]);
  const recent = keywords("does your cousin still play drums");
  const on = settingsV3({ provisionalRecallEvery: 8 });
  const pick = mem.pickProvisional([fact], map, recent, NOW, on, 0, false, true, false);
  assert.ok(pick && (pick.entityId === "fx" || pick.entity_id === "fx"), JSON.stringify(pick));
  assert.equal(mem.pickProvisional([fact], map, recent, NOW, S, 0, false, true, false), null, "setting 0: never");
  assert.equal(mem.pickProvisional([fact], map, recent, NOW, on, 1, false, true, false), null, "a recall in the window: rate bound");
  assert.equal(mem.pickProvisional([fact], map, recent, NOW, on, 0, true, true, false), null, "cooling off");
  assert.equal(mem.pickProvisional([fact], map, recent, NOW, on, 0, false, false, false), null, "no shared history");
  assert.equal(mem.pickProvisional([fact], map, recent, NOW, on, 0, false, true, true), null, "an opener never half-remembers");
  assert.equal(mem.pickProvisional([fact], map, new Set(), NOW, on, 0, false, true, false), null, "relevance 0: nothing to check");
  const heavy = wmap([weightRow({ entity_id: "fx", weight: 0.8, last_touched: daysAgo(40) })]);
  assert.equal(mem.pickProvisional([fact], heavy, recent, NOW, on, 0, false, true, false), null, "never for anything that mattered");
  const fresh = wmap([weightRow({ entity_id: "fx", weight: 0.2, last_touched: daysAgo(1) })]);
  assert.equal(mem.pickProvisional([fact], fresh, recent, NOW, on, 0, false, true, false), null, "recent: nothing fuzzy about it");
});

t("halfRememberSection: the wording asks her to check once, lightly, and never to use it to get him talking", () => {
  const s = mem.halfRememberSection({ entity: "fact", entityId: "fx", score: 0.15, text: "his cousin plays drums in a wedding band" });
  assert.ok(s.startsWith("THINGS YOU HALF REMEMBER"));
  assert.ok(/wait, your sister or your cousin\?/.test(s));
  assert.ok(/never use this to get him talking/.test(s));
  assert.ok(/take it, once, no apology loop/.test(s));
  assert.ok(s.includes("- his cousin plays drums in a wedding band (you think)"));
  assert.ok(!/memory system|the app|prompt/i.test(s));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
  assert.equal(mem.halfRememberSection(null), "");
});

test("carryStmt and touchStmts build the expected SQL", (tc) => {
  if (!mem || typeof mem.carryStmt !== "function" || typeof mem.touchStmts !== "function") {
    tc.skip("memory.ts carryStmt/touchStmts not in this tree yet");
    return;
  }
  const db = fakeD1();
  const carry = mem.carryStmt(db, "fact", "f_old", "f_new");
  assert.ok(/memory_weights/i.test(carry.sql), carry.sql);
  assert.ok(carry.binds.includes("f_old") && carry.binds.includes("f_new") && carry.binds.includes("fact"));
  const touches = mem.touchStmts(db, [{ entity: "fact", entityId: "f1" }, { entity: "history", entityId: "h1" }], NOW);
  assert.ok(Array.isArray(touches) && touches.length >= 2);
  for (const s of touches) {
    assert.ok(/memory_weights/i.test(s.sql), s.sql);
    assert.ok(/touches\s*\+\s*1|touches = touches \+ 1|touches\s*=\s*.*\+ 1/i.test(s.sql), "touches + 1: " + s.sql);
    assert.ok(/last_touched/i.test(s.sql));
  }
  const many = mem.touchStmts(db, Array.from({ length: 30 }, (_, i) => ({ entity: "fact", entityId: "f" + i })), NOW);
  assert.ok(many.length <= 10, "at most 10 rows touched per turn: " + many.length);
});

test("memory_v3: the fixture clock and day arithmetic agree", () => {
  assert.equal(new Date(daysAgo(1)).getTime(), NOW.getTime() - DAY_MS);
});
