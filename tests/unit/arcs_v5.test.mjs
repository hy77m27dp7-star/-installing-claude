// Arcs that go somewhere (SPEC_V5 section 2, src/arcs.ts): dated beats on her wants, their
// lines in WHAT YOU WANT, the nightly arc text and its parser, the guard on a refiled beat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { wantRow } from "./helpers_v3.mjs";
import {
  loadSrcIfPresent, guard, scriptedD1, beatView, clockSpan, storyClock, TZ, DAY_MS, HOUR_MS, plusMs,
} from "./helpers_v5.mjs";

const arcs = await loadSrcIfPresent("arcs");
const t = guard(arcs, "validateVariants", "dueAtFor", "beatIsDue", "outcomeWords", "hisPartSentence", "beatLines", "arcSystem", "parseArcAnswer", "HIS_PART_RE", "createBeatFromProposal");

const NOW = new Date("2026-09-29T19:10:00.000Z"); // Tuesday 3:10pm New York
const OPTS = { horizonDays: 7, memoryDays: 7 };
const lines = (view, opts = OPTS, clock = null, now = NOW) => arcs.beatLines(view, now, TZ, clock, opts);

// ------------------------------------------------------------------ pure

t("validateVariants: a step outcome on an event refused, five variants refused, ids assigned in order", () => {
  assert.throws(() => arcs.validateVariants([{ outcome: "did_it", note: "x" }], "event"), (e) => e.status === 400);
  const five = Array.from({ length: 5 }, () => ({ outcome: "went", note: "x" }));
  assert.throws(() => arcs.validateVariants(five, "event"), (e) => e.status === 400);
  const ok = arcs.validateVariants([{ id: "zz", outcome: "went_badly", note: "her voice cracked" }, { outcome: "went_well", note: "they clapped" }], "event");
  assert.deepEqual(ok.map((v) => v.id), ["v1", "v2"]);
  assert.deepEqual(arcs.validateVariants(null, "step"), []);
});

t("dueAtFor on a summer and a winter date (her timezone)", () => {
  assert.equal(arcs.dueAtFor("2026-07-10", "20:00", TZ), "2026-07-11T00:00:00.000Z");
  assert.equal(arcs.dueAtFor("2026-12-10", "20:00", TZ), "2026-12-11T01:00:00.000Z");
  assert.equal(arcs.dueAtFor("2026-12-10", null, TZ), "2026-12-11T04:59:00.000Z", "no time reads 23:59");
});

t("beatIsDue at the hour", () => {
  const run = beatView().run;
  const due = Date.parse(run.due_at);
  assert.equal(arcs.beatIsDue(run, due + HOUR_MS - 1), false);
  assert.equal(arcs.beatIsDue(run, due + HOUR_MS), true);
  assert.equal(arcs.beatIsDue({ ...run, status: "proposed" }, due + 2 * HOUR_MS), false);
});

t("outcomeWords and hisPartSentence for every value; the forgot sentence says it is not a debt", () => {
  const words = {
    did_it: "you did it", missed: "you missed it", went: "you went", went_well: "you went and it went well",
    went_badly: "you went and it went badly", chickened_out: "you got scared and did not go", postponed: "it got moved",
  };
  for (const [k, v] of Object.entries(words)) assert.equal(arcs.outcomeWords(k), v);
  assert.equal(arcs.hisPartSentence("encouraged", "a text before"), " He encouraged you before it: a text before.");
  assert.equal(arcs.hisPartSentence("encouraged", null), " He encouraged you before it.");
  assert.equal(arcs.hisPartSentence("asked", null), " He asked how it went.");
  assert.equal(arcs.hisPartSentence("came", "stood at the back"), " He came: stood at the back.");
  assert.equal(arcs.hisPartSentence("forgot", null), " He knew about it and never asked; you noticed, and it is not a debt.");
  assert.equal(arcs.hisPartSentence("none", "x"), "");
  assert.equal(arcs.hisPartSentence(null, null), "");
});

t("beatLines: coming today with a time, tomorrow, a weekday, in N days, past the horizon omitted", () => {
  const at = (due_at, due_time = "20:00") => beatView({ beat: { due_at, due_time }, run: { due_at } });
  assert.deepEqual(lines(at("2026-09-30T00:00:00.000Z")), ["  Coming up: the open mic, today at 8:00pm."]);
  assert.deepEqual(lines(at("2026-10-01T03:59:00.000Z", null)), ["  Coming up: the open mic, tomorrow."]);
  assert.deepEqual(lines(at("2026-10-03T00:00:00.000Z")), ["  Coming up: the open mic, Friday at 8:00pm."]);
  assert.deepEqual(lines(at("2026-10-07T00:00:00.000Z")), ["  Coming up: the open mic, in 7 days at 8:00pm."]);
  assert.deepEqual(lines(at("2026-10-09T00:00:00.000Z")), [], "past the horizon");
});

t("beatLines: a passed pending run's 'yours to say' line", () => {
  const v = beatView({ beat: { due_at: "2026-09-29T00:00:00.000Z" }, run: { due_at: "2026-09-29T00:00:00.000Z" } });
  assert.deepEqual(lines(v), ["  the open mic was yesterday. How it went is yours to say if he asks; once you say it, that is what happened."]);
});

t("beatLines: a resolved run within memory with the his-part sentence; on an opener without it; past memory omitted", () => {
  const resolved = { status: "resolved", outcome: "went_well", outcome_note: "they clapped", his_part: "encouraged", his_note: "a text before" };
  const v = beatView({ beat: { due_at: "2026-09-29T00:00:00.000Z" }, run: { due_at: "2026-09-29T00:00:00.000Z", ...resolved } });
  assert.deepEqual(lines(v), ["  Lately: the open mic (yesterday): you went and it went well: they clapped. He encouraged you before it: a text before."]);
  assert.deepEqual(lines(v, { ...OPTS, opener: true }), ["  Lately: the open mic (yesterday): you went and it went well: they clapped."]);
  const old = beatView({ beat: { due_at: "2026-09-19T00:00:00.000Z" }, run: { due_at: "2026-09-19T00:00:00.000Z", ...resolved } });
  assert.deepEqual(lines(old), []);
});

t("beatLines: ages in story time with a held span", () => {
  const due = plusMs(NOW.toISOString(), -5 * DAY_MS);
  const v = beatView({ beat: { due_at: due }, run: { due_at: due, status: "resolved", outcome: "did_it" } });
  const clock = storyClock({ real: NOW.toISOString(), spans: [clockSpan({ frozen_at: plusMs(due, DAY_MS), resumed_at: plusMs(due, 4 * DAY_MS) })] });
  const opts = { horizonDays: 7, memoryDays: 3 };
  assert.deepEqual(lines(v, opts, null), [], "five real days is past a 3-day memory");
  assert.deepEqual(lines(v, opts, clock), ["  Lately: the open mic (2 days ago): you did it."], "two story days is within it");
});

t("arcSystem with and without variants; typography clean; never a coin", () => {
  const a = arcs.arcSystem(true);
  const b = arcs.arcSystem(false);
  assert.ok(a.startsWith(arcs.ARC_PREFIX));
  assert.ok(a.includes("VARIANTS are listed: pick exactly one variant id; its outcome is the outcome."));
  assert.ok(!b.includes("VARIANTS are listed"));
  assert.ok(b.includes("Never a coin toss"));
  assert.ok(b.includes("him not writing at all is never \"forgot\""));
  assert.ok(!BAD_TYPOGRAPHY.test(a + b));
});

t("parseArcAnswer: a variant id wins over a contradicting outcome; an unknown variant id or an outcome outside the kind is null", () => {
  const variants = [{ id: "v1", outcome: "went_badly", note: "her voice cracked on the bridge" }];
  const withV = beatView({ variants });
  const r = arcs.parseArcAnswer(JSON.stringify({ variant_id: "v1", outcome: "went_well", note: "", his_part: "none", evidence: [] }), withV, new Set(), false, new Map());
  assert.equal(r.outcome, "went_badly");
  assert.equal(r.variantId, "v1");
  assert.equal(r.note, "her voice cracked on the bridge", "the variant's note when the answer's is empty");
  assert.equal(arcs.parseArcAnswer(JSON.stringify({ variant_id: "v9", outcome: "went" }), withV, new Set(), false, new Map()), null);
  const noV = beatView();
  assert.equal(arcs.parseArcAnswer(JSON.stringify({ outcome: "did_it" }), noV, new Set(), false, new Map()), null, "a step outcome on an event");
  assert.equal(arcs.parseArcAnswer("no json", noV, new Set(), false, new Map()), null);
});

t("parseArcAnswer: 'came' without togetherness is none; evidence filtered; 'forgot' needs a message of his after the evidence", () => {
  const v = beatView();
  const ids = new Set(["m_1", "m_2"]);
  const came = arcs.parseArcAnswer(JSON.stringify({ outcome: "went", note: "fine", his_part: "came", his_note: "he was there", evidence: ["m_1", "m_zz"] }), v, ids, false, new Map());
  assert.equal(came.hisPart, "none");
  assert.equal(came.hisNote, "");
  assert.deepEqual(came.evidence, ["m_1"]);
  const forgot = (evidence, hisAfter) => arcs.parseArcAnswer(JSON.stringify({ outcome: "went", note: "fine", his_part: "forgot", his_note: "he never asked", evidence }), v, ids, true, hisAfter);
  const never = forgot(["m_1"], new Map([["m_1", 0]]));
  assert.equal(never.hisPart, "none", "he never opened the app");
  assert.equal(never.hisNote, "");
  assert.equal(forgot([], new Map()).hisPart, "none", "no evidence");
  const real = forgot(["m_1"], new Map([["m_1", 1]]));
  assert.equal(real.hisPart, "forgot");
  assert.equal(real.hisNote, "he never asked");
});

t("HIS_PART_RE cuts each his-part sentence from a Lately line and leaves an outcome note that says 'nobody came' alone", () => {
  const base = "  Lately: the open mic (yesterday): you went: nobody came.";
  for (const p of ["encouraged", "asked", "came", "forgot"]) {
    const line = base + arcs.hisPartSentence(p, p === "came" || p === "encouraged" ? "a note" : null);
    assert.equal(line.replace(arcs.HIS_PART_RE, ""), base, p);
  }
  assert.equal(base.replace(arcs.HIS_PART_RE, ""), base);
});

// ------------------------------------------------------------------ the guard on a refiled beat

t("createBeatFromProposal twice with the same want, title and date: one beat", async () => {
  const beats = [];
  const want = wantRow({ id: "w_mic", title: "sing in front of people" });
  const db = scriptedD1([
    [/SELECT \* FROM wants WHERE id = \?1/, (b) => (b[0] === want.id ? [want] : [])],
    [/SELECT \* FROM wants WHERE lower\(title\) = lower\(\?1\)/, (b) => (b[0].toLowerCase() === want.title ? [want] : [])],
    [/SELECT id FROM arc_beats WHERE want_id = \?1 AND status = 'active'/, (b) => beats.filter((x) => x.want_id === b[0] && x.title.trim().toLowerCase() === String(b[1]).trim().toLowerCase() && x.due_on === b[2]).map((x) => ({ id: x.id }))],
    [/INSERT INTO arc_beats/, (b) => { beats.push({ id: b[0], want_id: b[1], title: b[2], due_on: b[4] }); return 1; }],
  ]);
  const payload = { want: "sing in front of people", title: "sign up", due_on: "2026-10-01", kind: "step" };
  const a = await arcs.createBeatFromProposal(db, payload, "sign up by Thursday", "proposal p_1", "auto", TZ);
  const b = await arcs.createBeatFromProposal(db, { ...payload, title: "Sign Up " }, "sign up by Thursday", "proposal p_2", "auto", TZ);
  assert.equal(a, b);
  assert.equal(beats.length, 1);
  await assert.rejects(arcs.createBeatFromProposal(db, { ...payload, want: "nothing" }, "x", "s", "auto", TZ), (e) => e.status === 400 && /no active want/.test(e.message));
});
