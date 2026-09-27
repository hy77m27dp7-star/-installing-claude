// The nightly story pass (SPEC_V5 section 1): the shared paid call and filing helpers
// (src/storycall.ts), the her-day text, its parse and its step, and the runner on a scripted
// D1 with the stub provider (off, frozen, already done, force, the budget line, the audit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { threadRow } from "./helpers_v2.mjs";
import { factRow } from "./helpers.mjs";
import {
  loadSrcIfPresent, guard, scriptedD1, clockScript, sceneVersion, clockSpan, storyClock, settingsV5, TZ, HOUR_MS, MIN_MS, plusMs,
} from "./helpers_v5.mjs";

const nightly = await loadSrcIfPresent("nightly");
const storycall = await loadSrcIfPresent("storycall");
const tS = guard(storycall, "newNightlyBudget", "parseJsonArray", "parseJsonObject", "cleanLine", "fileNightlyProposals", "paidJsonCall");
const tN = guard(nightly, "herDaySystem", "herDayUser", "parseHerDay", "runNightlyStory", "listNightlyRuns", "NIGHTLY_STEPS");

const ENV = { APP_ENV: "unit" };
const DAY = "2026-10-01"; // Thursday
const NOW = new Date("2026-10-02T11:00:00.000Z"); // Friday 7:00am New York
const nowMs = NOW.getTime();

// ------------------------------------------------------------------ storycall

tS("newNightlyBudget clamps to 0..5 and falls back to 0.25", () => {
  assert.deepEqual(storycall.newNightlyBudget(0.1), { limitUsd: 0.1, spentUsd: 0, stopped: null, runIds: [] });
  assert.equal(storycall.newNightlyBudget(9).limitUsd, 5);
  assert.equal(storycall.newNightlyBudget(-1).limitUsd, 0);
  assert.equal(storycall.newNightlyBudget("0.3").limitUsd, 0.25);
  assert.equal(storycall.newNightlyBudget(undefined).limitUsd, 0.25);
});

tS("parseJsonArray and parseJsonObject are tolerant: fences stripped, the outermost value parsed, anything else empty", () => {
  assert.deepEqual(storycall.parseJsonArray("```json\n[{\"a\":1}]\n```"), [{ a: 1 }]);
  assert.deepEqual(storycall.parseJsonArray("here: [1, 2] done"), [1, 2]);
  assert.deepEqual(storycall.parseJsonArray("not json"), []);
  assert.deepEqual(storycall.parseJsonArray("{\"a\":1}"), []);
  assert.deepEqual(storycall.parseJsonObject("```\n{\"outcome\":\"went\"}\n```"), { outcome: "went" });
  assert.equal(storycall.parseJsonObject("[1]"), null);
  assert.equal(storycall.parseJsonObject("nothing"), null);
});

tS("cleanLine: plain, capped, at least three characters, never a tech leak or a dependency phrase", () => {
  assert.equal(storycall.cleanLine("  burnt the rice again  ", 280), "burnt the rice again");
  assert.equal(storycall.cleanLine("ok", 280), null);
  assert.equal(storycall.cleanLine("the system prompt said so", 280), null);
  assert.equal(storycall.cleanLine("she missed you all day", 280), null);
  assert.equal(storycall.cleanLine(42, 280), null);
  assert.ok(storycall.cleanLine("x".repeat(400), 280).length <= 280);
});

tS("fileNightlyProposals: one entry per row; null for a refile of the same night; the same words on two days are both filed", async () => {
  const existing = [{ kind: "life_update", proposal: "Thursday 2026-10-01, the shop: stub day note" }];
  const db = scriptedD1([[/SELECT kind, proposal FROM proposals/, existing]]);
  const rows = [
    { kind: "life_update", proposal: "Thursday 2026-10-01, the shop: stub day note", evidence: "her day 2026-10-01", confidence: "medium", payload: { a: 1 }, weight: 0.3, source: "nightly her_day 2026-10-01 r1" },
    { kind: "life_update", proposal: "Wednesday 2026-09-30, the shop: stub day note", evidence: "her day 2026-09-30", confidence: "medium", payload: { a: 2 }, weight: 0.3, source: "nightly her_day 2026-09-30 r1" },
    { kind: "life_update", proposal: "Friday 2026-10-02, the shop: stub day note", evidence: "her day 2026-10-02", confidence: "medium", payload: { a: 3 }, source: "nightly her_day 2026-10-02 r1" },
    { kind: "life_update", proposal: "Friday 2026-10-02, the shop: stub day note", evidence: "dup in the same call", confidence: "medium", payload: {}, source: "x" },
  ];
  const ids = await storycall.fileNightlyProposals(db, rows);
  assert.equal(ids.length, 4, "one entry per row");
  assert.equal(ids[0], null, "a refile of the same night");
  assert.ok(typeof ids[1] === "string" && typeof ids[2] === "string", "another day is never a duplicate");
  assert.equal(ids[3], null);
  const inserts = db.log.filter((e) => /^INSERT INTO proposals/.test(e.sql));
  assert.equal(inserts.length, 2);
  const p = inserts[0].binds;
  assert.equal(p[1], null, "no conversation");
  assert.equal(p[2], null, "no message");
  assert.equal(p[7], "general");
  assert.equal(p[9], "pending");
  assert.deepEqual(JSON.parse(p[8]), { payload: { a: 2 }, weight: 0.3, source: "nightly her_day 2026-09-30 r1", raw: null });
  const read = db.log.find((e) => /SELECT kind, proposal FROM proposals/.test(e.sql));
  assert.ok(/status IN \('pending','approved','edited'\)/.test(read.sql));
  assert.deepEqual(await storycall.fileNightlyProposals(scriptedD1([]), []), []);
});

tS("paidJsonCall: a stopped budget, an unpriced model, the night's own line and the caps all refuse before any call; a stub call records a nightly run", async () => {
  const s = settingsV5();
  const call = { tag: "her_day", provider: "stub", model: "claude-sonnet-5", system: "Write what happened in Avelie's day", user: "THREADS:\n(none)", maxTokens: 500 };
  const stopped = { ...storycall.newNightlyBudget(0.25), stopped: "nightly budget" };
  assert.deepEqual(await storycall.paidJsonCall(ENV, scriptedD1([]), s, stopped, call), { ok: false, reason: "nightly budget" });
  assert.deepEqual(await storycall.paidJsonCall(ENV, scriptedD1([]), s, storycall.newNightlyBudget(0.25), { ...call, model: "unpriced-model" }), { ok: false, reason: "price_unknown" });
  assert.deepEqual(await storycall.paidJsonCall(ENV, scriptedD1([]), s, storycall.newNightlyBudget(0.25), { ...call, provider: "anthropic" }), { ok: false, reason: "provider_not_configured" }, "no key: nothing is called");
  const tiny = storycall.newNightlyBudget(0.000001);
  assert.deepEqual(await storycall.paidJsonCall(ENV, scriptedD1([]), s, tiny, call), { ok: false, reason: "nightly budget" });
  assert.equal(tiny.stopped, "nightly budget", "the rest of the night is stopped too");
  const capped = storycall.newNightlyBudget(0.25);
  assert.deepEqual(await storycall.paidJsonCall(ENV, scriptedD1([]), settingsV5({ dailyCapUsd: 0 }), capped, call), { ok: false, reason: "caps" });
  assert.equal(capped.stopped, "caps");
  const db = scriptedD1([]);
  const budget = storycall.newNightlyBudget(0.25);
  const r = await storycall.paidJsonCall(ENV, db, s, budget, call);
  assert.equal(r.ok, true);
  assert.equal(r.text, "[]", "the stub's her-day answer for no threads");
  assert.deepEqual(budget.runIds, [r.runId]);
  const run = db.log.find((e) => /^INSERT INTO model_runs/.test(e.sql));
  assert.ok(run, "a model_runs row");
  assert.ok(run.binds.includes("nightly"), "kind nightly");
  assert.ok(run.binds.includes(JSON.stringify(["nightly:her_day"])), "the step in flags_json");
  assert.ok(db.log.some((e) => e.via === "batch" && /usage/i.test(e.sql)), "its usage row in the same batch");
});

// ------------------------------------------------------------------ the her-day text

tN("herDaySystem: the fixed text with the day, the weekday and the max; nothing about him beyond the never lines; typography clean", () => {
  const s = nightly.herDaySystem(DAY, "Thursday", 2);
  assert.ok(s.startsWith(nightly.HER_DAY_PREFIX + " on 2026-10-01 (Thursday): one to 2 small, ordinary things"), s.slice(0, 120));
  assert.ok(s.includes("Never anything about him"));
  assert.ok(!/\bJustin\b/.test(s));
  for (const m of s.matchAll(/\bhim\b/g)) assert.ok(/about $/.test(s.slice(Math.max(0, m.index - 6), m.index)), "every him is 'about him': " + s.slice(m.index - 30, m.index + 5));
  assert.ok(!/\b(?:song|artist|band|album)\b/i.test(s), "names no artist");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
  assert.ok(s.endsWith('[{"thread": the exact thread title or "none", "note": one plain line, past tense, lowercase is fine, "time": "HH:MM" in her day}].'));
});

tN("herDayUser: the six blocks in order, (none) for an empty block, (unknown) weather", () => {
  const u = nightly.herDayUser({
    threads: [threadRow({ title: "the shop", kind: "place", detail: "she does the windows\nsecond line" }), threadRow({ title: "Dana", kind: "person", relation: "best friend" })],
    her: ["she sings"], weather: null, sheSaid: [], already: ["burnt the rice"], steps: [],
  });
  const order = ["THREADS:", "HER:", "WEATHER:", "SHE SAID:", "ALREADY:", "STEPS:"].map((h) => u.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i >= 0));
  assert.ok(u.includes("THREADS:\n- the shop (place): she does the windows\n- Dana (person, best friend)"), u);
  assert.ok(u.includes("WEATHER: (unknown)"));
  assert.ok(u.includes("SHE SAID:\n(none)"));
  assert.ok(u.includes("STEPS:\n(none)"));
  const w = nightly.herDayUser({ threads: [], her: [], weather: { day: DAY, code: 61, words: "rain", maxTemp: 61.4, minTemp: 50.2, precip: 3, units: "fahrenheit" }, sheSaid: [], already: [], steps: [] });
  assert.ok(w.includes("WEATHER: rain, high 61, low 50, rain"), w);
  assert.ok(w.startsWith("THREADS:\n(none)"));
});

tN("parseHerDay: an unknown thread dropped, none kept as null, a leak dropped, a line naming him dropped, a bad time read as 12:00, an item after nowMs dropped, duplicates dropped, the cap", () => {
  const threads = [threadRow({ title: "the shop", kind: "place" }), threadRow({ title: "Dana", kind: "person" })];
  const items = [
    { thread: "the laundromat", note: "folded everything", time: "10:00" },
    { thread: "none", note: "burnt the rice again", time: "09:15" },
    { thread: "The Shop", note: "moved the mannequin twice", time: "25:99" },
    { thread: "none", note: "argued with the app about it", time: "11:00" },
    { thread: "none", note: "texted justin a photo", time: "11:30" },
    { thread: "none", note: "thought about Sam all day", time: "12:30" },
    { thread: "Dana", note: "Burnt the rice again!", time: "13:00" },
  ];
  const got = nightly.parseHerDay(JSON.stringify(items), threads, DAY, TZ, 5, "Sam", nowMs);
  assert.deepEqual(got.map((g) => [g.thread, g.note]), [[null, "burnt the rice again"], ["the shop", "moved the mannequin twice"]]);
  assert.equal(got[0].occurred, "2026-10-01T13:15:00.000Z");
  assert.equal(got[1].occurred, "2026-10-01T16:00:00.000Z", "a bad time reads 12:00");
  const late = nightly.parseHerDay(JSON.stringify([{ thread: "none", note: "stayed up late", time: "23:00" }]), threads, "2026-10-02", TZ, 2, null, nowMs);
  assert.deepEqual(late, [], "an hour that has not happened is never written");
  const many = [1, 2, 3, 4].map((i) => ({ thread: "none", note: "small thing number " + ["one", "two", "three", "four"][i - 1], time: "0" + i + ":00" }));
  assert.equal(nightly.parseHerDay(JSON.stringify(many), threads, DAY, TZ, 2, null, nowMs).length, 2, "the cap");
  assert.deepEqual(nightly.parseHerDay("not json", threads, DAY, TZ, 2, null, nowMs), []);
  assert.deepEqual(nightly.parseHerDay(JSON.stringify(many), threads, DAY, TZ, 0, null, nowMs), []);
});

// ------------------------------------------------------------------ the runner

// A database for the runner: an apart scene (or a held one), one active place thread, one
// plain fact of hers, a relationship row, and nightly_runs answering `done` for the steps
// named. Everything else reads as empty.
function runnerDb({ held = false, doneSteps = [], threads = [threadRow({ id: "lt_shop", title: "the shop", kind: "place", detail: "she does the windows" })] } = {}) {
  const versions = held
    ? [sceneVersion(1, "apart", "2026-10-01T10:00:00.000Z"), sceneVersion(2, "together", "2026-10-02T09:00:00.000Z", "the pier")]
    : [sceneVersion(1, "apart", "2026-09-28T10:00:00.000Z")];
  const spans = held ? [clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: "2026-10-02T09:00:00.000Z" })] : [];
  return scriptedD1([
    [/SELECT status FROM nightly_runs WHERE day = \?1 AND step = \?2/, (b) => (doneSteps.includes(b[1]) ? [{ status: "done" }] : [])],
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "relationship" ? [{ id: "st1", entity: "relationship", version: 1, state_json: JSON.stringify({ status: "talking", his_name: "Justin" }), source: "seed", note: null, created_at: "2026-09-24T00:00:00.000Z" }] : [])],
    [/FROM life_threads WHERE status = \?1/, (b) => (b[0] === "active" ? threads : [])],
    [/FROM facts WHERE scope = \?1/, (b) => (b[0] === "avelie" ? [factRow({ id: "f_sing", fact: "she sings" })] : [])],
    ...clockScript(versions, spans),
  ]);
}

const stepOf = (r, step) => r.steps.find((s) => s.step === step);
const proposalInserts = (db) => db.log.filter((e) => /^INSERT INTO proposals/.test(e.sql));

tN("runNightlyStory: off answers skipped off and touches nothing", async () => {
  const db = runnerDb();
  const r = await nightly.runNightlyStory(ENV, db, settingsV5({ nightlyStoryEnabled: false }), { now: NOW });
  assert.equal(r.skipped, "off");
  assert.deepEqual(r.steps, []);
  assert.equal(r.day, DAY);
  assert.deepEqual(db.log, []);
});

tN("runNightlyStory: the her-day step files one life_update for the day that ended, with her_day true, the occurred on that day and the day in the text; every step recorded; the audit row", async () => {
  const db = runnerDb();
  const r = await nightly.runNightlyStory(ENV, db, settingsV5(), { now: NOW });
  assert.equal(r.day, DAY);
  assert.equal(r.frozen, false);
  assert.deepEqual(r.steps.map((s) => s.step), ["her_day", "arcs", "views", "hygiene"], "the fixed order");
  const her = stepOf(r, "her_day");
  assert.equal(her.status, "done", JSON.stringify(her));
  assert.equal(her.proposalIds.length, 1);
  const ins = proposalInserts(db)[0];
  assert.equal(ins.binds[3], "life_update");
  assert.equal(ins.binds[4], "Thursday 2026-10-01, the shop: stub day note");
  const pj = JSON.parse(ins.binds[8]);
  assert.equal(pj.payload.her_day, true);
  assert.equal(pj.payload.thread, "the shop");
  assert.equal(pj.payload.day, DAY);
  assert.equal(pj.payload.occurred, "2026-10-01T17:00:00.000Z", "13:00 her time on the day");
  assert.ok(/^nightly her_day 2026-10-01 /.test(pj.source));
  const recorded = db.log.filter((e) => /^INSERT OR REPLACE INTO nightly_runs/.test(e.sql)).map((e) => [e.binds[0], e.binds[1]]);
  assert.deepEqual(recorded, [[DAY, "her_day"], [DAY, "arcs"], [DAY, "views"], [DAY, "hygiene"]]);
  const audit = db.log.find((e) => /INSERT INTO audit_events/.test(e.sql) && e.binds[2] === "nightly.story");
  assert.ok(audit, "one nightly.story audit row");
  assert.equal(audit.binds[1], "nightly");
  assert.ok(r.spentUsd > 0, "the call was metered");
});

tN("runNightlyStory while a together scene is held: her_day and arcs skipped 'frozen', views and hygiene run", async () => {
  const db = runnerDb({ held: true });
  const r = await nightly.runNightlyStory(ENV, db, settingsV5(), { now: NOW, force: true });
  assert.equal(r.frozen, true);
  assert.equal(stepOf(r, "her_day").reason, "frozen: a together scene is held");
  assert.equal(stepOf(r, "arcs").reason, "frozen: a together scene is held");
  assert.notEqual(stepOf(r, "views").reason, "frozen: a together scene is held");
  assert.notEqual(stepOf(r, "hygiene").reason, "frozen: a together scene is held");
  assert.equal(proposalInserts(db).length, 0, "nothing happens to her while held");
});

tN("runNightlyStory: a step already done that day is skipped (and not re-recorded) unless forced", async () => {
  const db = runnerDb({ doneSteps: ["her_day"] });
  const r = await nightly.runNightlyStory(ENV, db, settingsV5(), { now: NOW, steps: ["her_day"] });
  assert.deepEqual(r.steps.map((s) => [s.step, s.status, s.reason]), [["her_day", "skipped", "already done"]]);
  assert.equal(db.log.filter((e) => /INTO nightly_runs/.test(e.sql)).length, 0);
  const forced = runnerDb({ doneSteps: ["her_day"] });
  const f = await nightly.runNightlyStory(ENV, forced, settingsV5(), { now: NOW, steps: ["her_day"], force: true });
  assert.equal(stepOf(f, "her_day").status, "done");
});

tN("runNightlyStory: the budget line stops a paid step; the off switches skip their steps", async () => {
  const db = runnerDb();
  const r = await nightly.runNightlyStory(ENV, db, settingsV5({ nightlyBudgetUsd: 0.000001 }), { now: NOW, steps: ["her_day"], force: true });
  assert.equal(stepOf(r, "her_day").status, "skipped");
  assert.equal(stepOf(r, "her_day").reason, "nightly budget");
  assert.equal(db.log.filter((e) => /^INSERT INTO model_runs/.test(e.sql)).length, 0, "no call was made");
  const off = await nightly.runNightlyStory(ENV, runnerDb(), settingsV5({ herDayItemsMax: 0, nightlyBeatsMax: 0, viewsPerNight: 0, hygieneEnabled: false }), { now: NOW, force: true });
  assert.deepEqual(off.steps.map((s) => s.reason), ["off", "off", "off", "off"]);
});

tN("runHerDay: skipped 'no threads' when she has no thread and no plain fact; the day inside a held scene is skipped", async () => {
  const db = scriptedD1([...clockScript([sceneVersion(1, "apart", "2026-09-28T10:00:00.000Z")], [])]);
  const r = await nightly.runNightlyStory(ENV, db, settingsV5(), { now: NOW, steps: ["her_day"], force: true });
  assert.equal(stepOf(r, "her_day").reason, "no threads");
  const span = clockSpan({ frozen_at: "2026-10-01T04:30:00.000Z", resumed_at: "2026-10-01T23:00:00.000Z" });
  const c = storyClock({ spans: [span], real: NOW.toISOString() });
  const budget = storycall.newNightlyBudget(0.25);
  const held = await nightly.runHerDay(ENV, runnerDb(), settingsV5(), c, budget, DAY);
  assert.equal(held.status, "skipped");
  assert.equal(held.reason, "the day was mostly inside a held scene");
});

tN("listNightlyRuns clamps the limit to 1..200 and reads newest first", async () => {
  const db = scriptedD1([[/FROM nightly_runs ORDER BY ran_at DESC/, [{ day: DAY, step: "her_day", ran_at: "x", status: "done", result_json: null }]]]);
  const rows = await nightly.listNightlyRuns(db, 999);
  assert.equal(rows.length, 1);
  assert.deepEqual(db.log[0].binds, [200]);
  await nightly.listNightlyRuns(db, 0);
  assert.deepEqual(db.log[1].binds, [1]);
});

test("the nightly modules import neither each other in a cycle nor anything that writes a story table directly", async () => {
  const { repoText } = await import("./helpers_v5.mjs");
  const sc = repoText("src/storycall.ts");
  if (sc) {
    assert.ok(!/from "\.\/proposals"/.test(sc), "storycall.ts never imports proposals.ts");
    for (const pass of ["nightly", "arcs", "views", "hygiene"]) assert.ok(!new RegExp(`from "\\./${pass}"`).test(sc), pass);
  }
  const n = repoText("src/nightly.ts");
  if (n) assert.ok(!/INSERT INTO (?:life_log|facts|her_views|beat_runs|world_facts)/.test(n), "the runner writes no story table");
  for (const t of [sc, n]) if (t) assert.ok(!BAD_TYPOGRAPHY.test(t));
});
