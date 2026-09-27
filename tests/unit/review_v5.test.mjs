// The v5 review fixes (four reviewers: the clock, retention hooks, the data pipeline, the UI).
// One test per confirmed finding, or a test that proves a plausible one and holds the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc, factRow, relationshipState, sceneState, historyRow } from "./helpers.mjs";
import { threadRow } from "./helpers_v2.mjs";
import { TUE_1510_NY, promptStateV2 } from "./helpers_v2.mjs";
import {
  scriptedD1, clockScript, sceneVersion, clockSpan, storyClock, settingsV5, beatView, viewRow,
  TZ, TUE_2100_NY, FRI_1000_NY, HOUR_MS, MIN_MS, DAY_MS, plusMs,
} from "./helpers_v5.mjs";

const clock = await loadSrc("clock");
const nightly = await loadSrc("nightly");
const storycall = await loadSrc("storycall");
const life = await loadSrc("life");
const arcs = await loadSrc("arcs");
const proposals = await loadSrc("proposals");
const standing = await loadSrc("standing");
const views = await loadSrc("views");
const hygiene = await loadSrc("hygiene");
const honest = await loadSrc("honest");
const deliveries = await loadSrc("deliveries");
const state = await loadSrc("state");
const prompt = await loadSrc("prompt");
const songs = await loadSrc("songs");

const ENV = { APP_ENV: "unit" };
const at = (e) => e.binds;
const audits = (db, action) => db.log.filter((e) => /INSERT INTO audit_events/.test(e.sql) && e.binds.includes(action));

// ------------------------------------------------------------------ the clock

test("clock 1: her day never writes an hour she spent inside a held scene (the item at 13:00 falls in a span 12:00 to 15:00)", async () => {
  const DAY = "2026-10-01";
  const NOW = new Date("2026-10-02T11:00:00.000Z");
  const span = clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: "2026-10-01T16:00:00.000Z", resumed_at: "2026-10-01T19:00:00.000Z", closed_version: 3 });
  const c = storyClock({ spans: [span], real: NOW.toISOString() });
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "relationship" ? [{ id: "st1", entity: "relationship", version: 1, state_json: JSON.stringify({ status: "talking" }), source: "seed", note: null, created_at: "2026-09-24T00:00:00.000Z" }] : [])],
    [/FROM life_threads WHERE status = \?1/, (b) => (b[0] === "active" ? [threadRow({ id: "lt_shop", title: "the shop", kind: "place" })] : [])],
    [/FROM facts WHERE scope = \?1/, (b) => (b[0] === "avelie" ? [factRow({ id: "f_sing", fact: "she sings" })] : [])],
  ]);
  const r = await nightly.runHerDay(ENV, db, settingsV5(), c, storycall.newNightlyBudget(0.25), DAY);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(r.proposalIds.length, 0, "the stub's 13:00 note is inside the held span");
  assert.equal(db.log.filter((e) => /^INSERT INTO proposals/.test(e.sql)).length, 0);
  // The same day with the span elsewhere files it.
  const away = storyClock({ spans: [clockSpan({ frozen_at: "2026-10-01T22:00:00.000Z", resumed_at: "2026-10-02T00:00:00.000Z", closed_version: 3 })], real: NOW.toISOString() });
  const r2 = await nightly.runHerDay(ENV, db, settingsV5(), away, storycall.newNightlyBudget(0.25), DAY);
  assert.equal(r2.proposalIds.length, 1);
});

test("clock 3: a failed beat move releases its claim; the next sync retries a closed span whose beats were never moved", async () => {
  const versions = [sceneVersion(6, "apart", "2026-09-29T10:00:00.000Z"), sceneVersion(7, "together", TUE_2100_NY, "the pier"), sceneVersion(8, "apart", FRI_1000_NY)];
  const open = clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: TUE_2100_NY });
  const run = [{ id: "br_mic", due_at: plusMs(TUE_2100_NY, DAY_MS), title: "the open mic", want_id: "w_mic" }];
  const db = scriptedD1(clockScript(versions, [open], [[/FROM beat_runs r JOIN arc_beats b/, run]]));
  const batch = db.batch.bind(db);
  db.batch = async (stmts) => {
    if (stmts.some((s) => /INSERT INTO audit_events/.test(s.sql) && s.binds.includes("clock.resume"))) throw new Error("batch failed");
    return batch(stmts);
  };
  const r = await clock.syncStoryClock(db, settingsV5(), new Date(plusMs(FRI_1000_NY, MIN_MS)));
  assert.equal(r.closed, "sc_v7");
  assert.equal(r.shifted, 0);
  const release = db.log.find((e) => /SET beats_shifted_at = NULL WHERE id = \?1 AND beats_shifted_at = \?2/.test(e.sql));
  assert.ok(release, "the claim is released");
  assert.equal(at(release)[0], "sc_v7");

  const closed = clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: TUE_2100_NY, closed_version: 8, resumed_at: FRI_1000_NY, beats_shifted_at: null });
  const retry = scriptedD1(clockScript(versions, [closed], [
    [/WHERE resumed_at IS NOT NULL AND beats_shifted_at IS NULL/, [closed]],
    [/FROM beat_runs r JOIN arc_beats b/, run],
  ]));
  const r2 = await clock.syncStoryClock(retry, settingsV5(), new Date(plusMs(FRI_1000_NY, HOUR_MS)));
  assert.equal(r2.shifted, 1, "the retry moved the run");
  const moved = retry.log.find((e) => /^UPDATE beat_runs SET due_at/.test(e.sql));
  assert.equal(at(moved)[1], new Date(Date.parse(FRI_1000_NY) + DAY_MS).toISOString(), "the same distance after the span");
  assert.equal(audits(retry, "clock.shift").length, 1);
});

test("clock 4: the clock loads the NEWEST spans and reads them oldest first", async () => {
  const older = clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: "2026-09-20T01:00:00.000Z", resumed_at: "2026-09-20T02:00:00.000Z", closed_version: 4 });
  const open = clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: TUE_2100_NY });
  const versions = [sceneVersion(6, "apart", "2026-09-29T10:00:00.000Z"), sceneVersion(7, "together", TUE_2100_NY, "the pier")];
  const db = scriptedD1(clockScript(versions, [open, older]));
  const c = await clock.loadStoryClock(db, settingsV5(), new Date(FRI_1000_NY));
  const read = db.log.find((e) => /resumed_at IS NULL OR resumed_at >= \?1/.test(e.sql));
  assert.match(read.sql, /ORDER BY frozen_at DESC LIMIT \?2/);
  assert.deepEqual(c.spans.map((s) => s.id), ["sc_v3", "sc_v7"]);
  assert.equal(c.open.id, "sc_v7");
  assert.equal(c.frozen, true);
});

test("clock 5: the sent window is story time: a week after a three-day held scene reaches ten real days back; listSent reads from that instant", async () => {
  const real = "2026-10-20T12:00:00.000Z";
  const span = clockSpan({ frozen_at: plusMs(real, -5 * DAY_MS), resumed_at: plusMs(real, -2 * DAY_MS), closed_version: 9 });
  const c = storyClock({ spans: [span], real });
  assert.equal(clock.storyWindowStart(c, 7 * DAY_MS).toISOString(), plusMs(real, -10 * DAY_MS));
  assert.equal(clock.storyWindowStart(storyClock({ spans: [], real }), 7 * DAY_MS).toISOString(), plusMs(real, -7 * DAY_MS));
  assert.equal(clock.storyWindowStart(storyClock({ spans: [clockSpan({ frozen_at: plusMs(real, -2 * DAY_MS) })], real }), 1 * DAY_MS).toISOString(), plusMs(real, -3 * DAY_MS), "an open span reaches to now");
  const db = scriptedD1([[/FROM messages WHERE channel = 'story' AND role = 'assistant'/, []]]);
  await honest.listSent(db, { now: new Date(real), windowDays: 7, limit: 12, since: clock.storyWindowStart(c, 7 * DAY_MS) });
  assert.equal(db.log[0].binds[0], plusMs(real, -10 * DAY_MS));
  const plain = scriptedD1([]);
  await honest.listSent(plain, { now: new Date(real), windowDays: 7, limit: 12 });
  assert.equal(plain.log[0].binds[0], plusMs(real, -7 * DAY_MS), "no clock: seven real days");
});

test("clock 6: no 'new day' three story hours after a scene held from Tuesday night to Friday", () => {
  const span = clockSpan({ frozen_at: TUE_2100_NY, resumed_at: FRI_1000_NY, closed_version: 8 });
  const real = plusMs(FRI_1000_NY, 3 * HOUR_MS);
  const last = { hisAt: plusMs(TUE_2100_NY, 30 * MIN_MS), herAt: plusMs(TUE_2100_NY, 30 * MIN_MS), lastAt: plusMs(TUE_2100_NY, 30 * MIN_MS) };
  const t = clock.timeSince(storyClock({ spans: [span], real }), last, TZ);
  assert.equal(t.lastAgoMs, 3 * HOUR_MS);
  assert.equal(t.newDay, false);
  const long = clock.timeSince(storyClock({ spans: [], real }), last, TZ);
  assert.equal(long.newDay, true, "without the held span it is days later");
});

test("clock 7: YOUR LIFE RIGHT NOW reads a note's age on story time with ageOf", () => {
  const span = clockSpan({ frozen_at: TUE_2100_NY, resumed_at: FRI_1000_NY, closed_version: 8 });
  const real = plusMs(FRI_1000_NY, 3 * HOUR_MS);
  const c = storyClock({ spans: [span], real });
  const log = [{ id: "ll_1", thread_id: null, occurred: plusMs(TUE_2100_NY, -HOUR_MS), note: "burnt the rice again", source: null, created_at: plusMs(TUE_2100_NY, -HOUR_MS) }];
  const withClock = life.lifeSection([], log, new Date(real), TZ, { ageOf: (iso) => clock.storyAgeDays(c, iso) });
  assert.match(withClock, /- today: burnt the rice again/);
  const without = life.lifeSection([], log, new Date(real), TZ);
  assert.match(without, /- 2 days ago: burnt the rice again/);
});

test("clock 8: a life event pushed out of one held span that lands in the next is pushed past it too", () => {
  const T0 = "2026-10-05T12:00:00.000Z";
  const s1 = clockSpan({ id: "sc_v1", opened_version: 1, frozen_at: T0, resumed_at: plusMs(T0, 2 * HOUR_MS), closed_version: 2 });
  const s2 = clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: plusMs(T0, 3 * HOUR_MS), resumed_at: plusMs(T0, 5 * HOUR_MS), closed_version: 4 });
  const c = storyClock({ spans: [s2, s1], real: plusMs(T0, 10 * HOUR_MS) });
  assert.equal(clock.deferredInstant(c, plusMs(T0, 90 * MIN_MS)), plusMs(T0, 5.5 * HOUR_MS));
  assert.equal(clock.deferredInstant(c, plusMs(T0, 150 * MIN_MS)), plusMs(T0, 150 * MIN_MS), "between the spans: unchanged");
  assert.equal(clock.deferredInstant(c, plusMs(T0, 4 * HOUR_MS)), plusMs(T0, 6 * HOUR_MS));
});

test("clock 9: walking into a together scene lands a reply still held for her day now, stamped so it never buzzes", async () => {
  const db = scriptedD1([]);
  const now = new Date("2026-10-02T14:00:00.000Z");
  await deliveries.deliverHeldRepliesStmt(db, now).run();
  const w = db.log[0];
  assert.match(w.sql, /^UPDATE messages SET deliver_at = \?1, pushed_at = COALESCE\(pushed_at, \?1\) WHERE channel = 'story' AND deliver_at IS NOT NULL AND deliver_at > \?1$/);
  assert.deepEqual(w.binds, [now.toISOString()]);
  const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /r\.state\.status === "together"[\s\S]{0,200}deliverHeldRepliesStmt/, "the scene route runs it on a together write");
});

test("clock 10: a beat outcome named by title resolves the step in her past on STORY time, not one inside a held scene", async () => {
  const storyNowMs = Date.now() - 2 * DAY_MS;
  const rows = [
    { beat_id: "ab_past", run_id: "br_past", due_at: new Date(storyNowMs - DAY_MS).toISOString() },
    { beat_id: "ab_held", run_id: "br_held", due_at: new Date(storyNowMs + HOUR_MS).toISOString() },
  ];
  const run = async (nowMs) => {
    const db = scriptedD1([[/FROM arc_beats b JOIN beat_runs r ON r.beat_id = b.id AND r.reader = \?2/, rows]]);
    await assert.rejects(arcs.applyBeatOutcome(db, { beat: "the open mic", outcome: "went" }, "proposal p_1", "auto", nowMs), (e) => e.status === 404);
    return db.log.find((e) => /WHERE b\.id = \?1/.test(e.sql)).binds[0];
  };
  assert.equal(await run(storyNowMs), "ab_past");
  assert.equal(await run(Date.now()), "ab_held", "the real clock would have picked the held one");
});

test("clock 11: after an import that carried no clock, every closed together run of the restored record is written back, marked shifted", async () => {
  const versions = [
    { version: 1, created_at: "2026-09-20T00:00:00.000Z", status: "apart", location: null },
    { version: 2, created_at: "2026-09-21T00:00:00.000Z", status: "together", location: "the pier" },
    { version: 3, created_at: "2026-09-22T00:00:00.000Z", status: "apart", location: null },
    { version: 4, created_at: "2026-09-23T00:00:00.000Z", status: "together", location: "her couch" },
  ];
  const db = scriptedD1([[/WHERE entity = 'scene' AND version > \?1 ORDER BY version ASC LIMIT \?2/, (b) => versions.filter((v) => v.version > Number(b[0]))]]);
  const n = await clock.backfillClosedSpans(db, { after: 0, upTo: null, shiftedAt: "2026-10-01T00:00:00.000Z", now: "2026-10-01T00:00:00.000Z" });
  assert.equal(n, 1, "the open run is left to the sync");
  const ins = db.log.filter((e) => /^INSERT OR IGNORE INTO story_clock/.test(e.sql));
  assert.equal(ins.length, 1);
  assert.deepEqual(ins[0].binds.slice(0, 7), ["sc_v2", 2, "2026-09-21T00:00:00.000Z", 3, "2026-09-22T00:00:00.000Z", "the pier", "2026-10-01T00:00:00.000Z"]);
  const src = readFileSync(new URL("../../src/exportImport.ts", import.meta.url), "utf8");
  assert.match(src, /storyClockCleared\)[\s\S]{0,300}backfillClosedSpans\(db, \{ after: 0, upTo: null, shiftedAt: at, now: at \}\)/);
});

test("clock 12: two breaks between reads: the old span closes, the middle run is written closed, the current run opens", async () => {
  const versions = [
    sceneVersion(5, "apart", "2026-09-28T10:00:00.000Z"),
    sceneVersion(7, "together", TUE_2100_NY, "the pier"),
    sceneVersion(8, "apart", plusMs(TUE_2100_NY, HOUR_MS)),
    sceneVersion(9, "together", plusMs(TUE_2100_NY, 2 * HOUR_MS), "her couch"),
    sceneVersion(10, "apart", plusMs(TUE_2100_NY, 3 * HOUR_MS)),
    sceneVersion(11, "together", plusMs(TUE_2100_NY, 4 * HOUR_MS), "the pier"),
  ];
  const open = clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: TUE_2100_NY });
  const range = [/WHERE entity = 'scene' AND version > \?1 AND version <= \?2/, (b) => versions.filter((v) => v.version > Number(b[0]) && v.version <= Number(b[1]))];
  const db = scriptedD1(clockScript(versions, [open], [range]));
  const r = await clock.syncStoryClock(db, settingsV5(), new Date(plusMs(TUE_2100_NY, 5 * HOUR_MS)));
  assert.equal(r.closed, "sc_v7");
  assert.equal(r.opened, "sc_v11");
  const close = db.log.find((e) => /^UPDATE story_clock SET closed_version = \?2/.test(e.sql));
  assert.equal(close.binds[1], 8);
  const ins = db.log.filter((e) => /^INSERT OR IGNORE INTO story_clock/.test(e.sql)).map((e) => [e.binds[0], e.binds[3] ?? null]);
  assert.deepEqual(ins.map((x) => x[0]), ["sc_v9", "sc_v11"]);
  const middle = db.log.find((e) => /^INSERT OR IGNORE INTO story_clock/.test(e.sql) && e.binds[0] === "sc_v9");
  assert.equal(middle.binds[3], 10, "closed at the second break");
  assert.equal(middle.binds[6], null, "its beats are left to the retry");
});

// ------------------------------------------------------------------ retention hooks

test("hooks 1: 'forgot' counts only his messages after BOTH the evidence and the step, by the day after", () => {
  const due = Date.parse("2026-10-01T00:00:00.000Z"); // Thursday 8pm New York
  const evidence = [{ id: "m_mon", created_at: "2026-09-28T20:00:00.000Z" }];
  const goodLuckMonday = Date.parse("2026-09-28T20:05:00.000Z");
  assert.equal(arcs.hisAfterCounts(evidence, [goodLuckMonday], due).get("m_mon"), 0, "good luck on Monday, then away: never forgetting");
  assert.equal(arcs.hisAfterCounts(evidence, [goodLuckMonday, due + 2 * HOUR_MS], due).get("m_mon"), 1, "he wrote after it and never asked");
  assert.equal(arcs.hisAfterCounts(evidence, [due + 3 * DAY_MS], due).get("m_mon"), 0, "back on Saturday: past the day after");
  const src = readFileSync(new URL("../../src/arcs.ts", import.meta.url), "utf8");
  assert.match(src, /hisAfterCounts\(withHim, times, dueMs\)/, "the arc step builds hisAfter through it");
});

test("hooks 2: a per-turn beat_outcome never carries his part; the nightly arc step's does", () => {
  const payload = { beat: "the open mic", outcome: "went", note: "fine", his_part: "forgot", his_note: "he never asked, she missed him" };
  const perTurn = proposals.beatOutcomePayload({ payload_json: JSON.stringify({ payload, weight: 0.5, raw: null, user_message_id: "m_u" }) }, payload);
  assert.equal(perTurn.his_part, undefined);
  assert.equal(perTurn.his_note, undefined);
  assert.equal(perTurn.outcome, "went");
  const night = proposals.beatOutcomePayload({ payload_json: JSON.stringify({ payload, weight: 0.6, source: "nightly arcs 2026-10-01 r_1", raw: null }) }, payload);
  assert.equal(night.his_part, "forgot");
});

test("hooks 3 and 11: her day never carries him, waiting, her phone, or a new name", () => {
  const threads = [threadRow({ id: "lt_shop", title: "the shop", kind: "place" }), threadRow({ id: "lt_mom", title: "Diane", kind: "person", relation: "mother" })];
  const now = Date.parse("2026-10-02T11:00:00.000Z");
  const parse = (note) => nightly.parseHerDay(JSON.stringify([{ thread: "none", note, time: "10:00" }]), threads, "2026-10-01", TZ, 3, "Justin", now);
  assert.deepEqual(parse("checked her phone all evening, nothing from him"), []);
  assert.deepEqual(parse("he never texted back"), []);
  assert.deepEqual(parse("kept looking at her messages"), []);
  assert.deepEqual(parse("got coffee with Priya after work"), [], "a new person with a name");
  assert.equal(parse("called Diane about sunday").length, 1, "a person she has");
  assert.equal(parse("Burnt the rice again").length, 1, "a capitalised first word is not a name");
  assert.equal(parse("burnt the rice. Then fixed it with butter").length, 1);
  assert.equal(parse("walked down to the shop on Friday").length, 1);
  const known = nightly.parseHerDay(JSON.stringify([{ thread: "none", note: "sang along to Casco Bay radio", time: "10:00" }]), threads, "2026-10-01", TZ, 3, null, now, ["she listens to casco bay radio"]);
  assert.equal(known.length, 1, "words from her facts are hers");
});

test("hooks 4: an empty WITH HIM decides from her alone", () => {
  assert.ok(arcs.arcSystem(false).includes("An empty WITH HIM means decide from her alone: his absence never makes it go worse."));
});

test("hooks 5: a person titled by what she is to Avelie is a placeholder, never a locked name", () => {
  for (const n of ["her mum", "my mama", "her stepmom", "her step-mom", "the landlord", "my grandma", "Her Mom", "mom"]) assert.equal(life.isPlaceholderName(n), true, n);
  for (const n of ["Diane", "Mason", "Mum Jones", "Priya"]) assert.equal(life.isPlaceholderName(n), false, n);
});

test("hooks 6: restoring an older version of a named person keeps the name (only Rename changes it)", async () => {
  const v1 = threadRow({ id: "lt_m1", kind: "person", title: "her mother", relation: "mother", status: "superseded", version: 1 });
  const v2 = threadRow({ id: "lt_m2", kind: "person", title: "Diane", relation: "mother", status: "superseded", version: 2, supersedes_id: "lt_m1", detail: "a bad detail" });
  const v3 = threadRow({ id: "lt_m3", kind: "person", title: "Diane", relation: "mother", status: "active", version: 3, supersedes_id: "lt_m2", detail: "a worse detail" });
  const make = () => scriptedD1([
    [/SELECT \* FROM life_threads WHERE id = \?1/, (b) => [v1, v2, v3].filter((x) => x.id === b[0])],
    [/WITH RECURSIVE up/, [{ id: "lt_m1" }]],
    [/WITH RECURSIVE down/, [v1, v2, v3]],
  ]);
  const db = make();
  const row = await life.restoreThread(db, "lt_m1", "owner");
  assert.equal(row.title, "Diane");
  const ins = db.log.find((e) => /^INSERT INTO life_threads/.test(e.sql));
  assert.equal(ins.binds[2], "Diane");
  const renamed = await life.restoreThread(make(), "lt_m1", "owner", { allowRename: true });
  assert.equal(renamed.title, "her mother", "the owner's own rename path");
});

test("hooks 7 and pipeline 5, 6, 11: the cooling off a status step starts is visible and clearable; leaving it by a step ends it; an expired one restarts", () => {
  const NOW = new Date("2026-10-02T14:00:00.000Z");
  const into = standing.moveRelationship(relationshipState({ status: "friends" }), { status: "cooling off" }, "a fight", NOW, { auto: true }).next;
  assert.equal(into.cooling_off_hours, 24);
  assert.equal(into.cooling_off_until, plusMs(NOW.toISOString(), 24 * HOUR_MS), "the Now tab's field reads it");
  assert.equal(standing.coolingOffNow(into, NOW, null), true);
  const out = standing.moveRelationship(into, { status: "friends" }, "made up", new Date(plusMs(NOW.toISOString(), HOUR_MS)), { auto: true }).next;
  assert.equal(out.status, "friends");
  assert.equal(out.cooling_off_set_at, null);
  assert.equal(out.cooling_off_hours, null);
  assert.equal(out.cooling_off_until, null);
  assert.equal(standing.coolingOffNow(out, new Date(plusMs(NOW.toISOString(), 2 * HOUR_MS)), null), false, "friends is friends");
  const later = new Date(plusMs(NOW.toISOString(), 30 * HOUR_MS));
  assert.equal(standing.coolingOffNow(into, later, null), false, "ran out");
  const again = standing.moveRelationship(into, { status: "cooling off" }, "another fight", later, { auto: true });
  assert.equal(again.next.cooling_off_set_at, later.toISOString());
  assert.equal(again.next.cooling_off_hours, 24);
  assert.ok(again.notes.includes("cooling off again"));
  const still = standing.moveRelationship(into, { status: "cooling off" }, "still sore", new Date(plusMs(NOW.toISOString(), HOUR_MS)), { auto: true });
  assert.equal(still.next.cooling_off_set_at, into.cooling_off_set_at, "a running one is not restarted");
  // Held days of a together scene do not run it out, so it is not restarted inside one.
  const held = storyClock({ real: later.toISOString(), spans: [clockSpan({ frozen_at: plusMs(NOW.toISOString(), HOUR_MS), resumed_at: plusMs(NOW.toISOString(), 29 * HOUR_MS), closed_version: 9 })] });
  const inHeld = standing.moveRelationship(into, { status: "cooling off" }, "x", later, { auto: true, clock: held });
  assert.equal(inHeld.next.cooling_off_set_at, into.cooling_off_set_at);
});

test("hooks 7: the Now tab ends a cooling off with an empty field (the pair goes too) and shows one that runs on the pair", () => {
  const js = readFileSync(new URL("../../public/js/state.js", import.meta.url), "utf8");
  assert.match(js, /if \(until === null\) remove\.push\("cooling_off_set_at", "cooling_off_hours"\)/);
  assert.match(js, /const cooling = live \? live\.coolingOff === true : coolingLocal\(st\)/);
});

test("hooks 8: frequency and waiting reads never become her read of him", () => {
  const IDS = new Set(["m_1", "m_2"]);
  for (const v of ["you never text first", "you go quiet for days", "you leave me hanging", "you make me wait", "you keep me waiting"]) {
    const text = JSON.stringify([{ op: "new", subject: "how he writes", view: v, confidence: 0.9, evidence: ["m_1", "m_2"] }]);
    assert.deepEqual(views.parseViewOps(text, new Map(), IDS, 3), [], v);
  }
  const ok = JSON.stringify([{ op: "new", subject: "asks first", view: "you asked before you kissed me", confidence: 0.9, evidence: ["m_1", "m_2"] }]);
  assert.equal(views.parseViewOps(ok, new Map(), IDS, 3).length, 1);
});

test("hooks 9 and pipeline 9: his rejection of a merge, a guess mark or a read sticks; a read he said is not true never comes back", async () => {
  const db = scriptedD1([[/SELECT kind, proposal FROM proposals/, [{ kind: "fact_merge", proposal: "same fact: a = b" }]]]);
  const ids = await storycall.fileNightlyProposals(db, [{ kind: "fact_merge", proposal: "same fact: a = b", evidence: "x", confidence: "high", payload: {}, source: "s" }]);
  assert.deepEqual(ids, [null]);
  const sql = db.log[0].sql;
  assert.match(sql, /status = 'rejected' AND kind IN \('fact_merge','fact_mark','her_view'\)/);
  const u = views.viewsUser([], [{ id: "m_1", role: "user", content: "hey" }], [viewRow({ status: "retired", view: "you dodge when i ask about your family" })]);
  assert.match(u, /NOT TRUE \(he said so, or it faded; never bring one back as a new read\):\n- you dodge when i ask about your family/);
  assert.ok(!views.viewsUser([], []).includes("NOT TRUE"), "no block without retired reads");
  const text = JSON.stringify([{ op: "new", subject: "dodges family", view: "you dodge my family questions", confidence: 0.9, evidence: ["m_1", "m_2"] }]);
  assert.deepEqual(views.parseViewOps(text, new Map(), new Set(["m_1", "m_2"]), 3, new Set(["dodges family"])), []);
  assert.equal(views.parseViewOps(text, new Map(), new Set(["m_1", "m_2"]), 3).length, 1);
});

test("hooks 10: an opener never carries a setback of hers or a sore spot", () => {
  const NOW = new Date("2026-10-02T14:00:00.000Z");
  const bad = beatView({ run: { status: "resolved", outcome: "went_badly", outcome_note: "her voice cracked", due_at: plusMs(NOW.toISOString(), -DAY_MS) } });
  const opts = { horizonDays: 7, memoryDays: 7 };
  assert.equal(arcs.beatLines(bad, NOW, TZ, null, opts).length, 1);
  assert.deepEqual(arcs.beatLines(bad, NOW, TZ, null, { ...opts, opener: true }), []);
  const good = beatView({ run: { status: "resolved", outcome: "went_well", due_at: plusMs(NOW.toISOString(), -DAY_MS) } });
  assert.equal(arcs.beatLines(good, NOW, TZ, null, { ...opts, opener: true }).length, 1);
  const rel = relationshipState({ friction: "the photo thing", friction_set_at: new Date(TUE_1510_NY.getTime() - HOUR_MS).toISOString() });
  const s = (opener) => prompt.stateSections(promptStateV2({ relationship: rel, history: [historyRow()], opener }));
  assert.match(s(false), /Friction: the photo thing/);
  assert.ok(!/Friction: /.test(s(true)));
});

// ------------------------------------------------------------------ the data pipeline

test("pipeline 1: the facts asked on the last nights are skipped, so each night walks further into the backlog", async () => {
  const words = { a: "he has a dog named biscuit", b: "he works nights at the port", c: "he grew up in ohio" };
  const facts = ["a", "b", "c"].map((x, i) => factRow({ id: "f_" + x, scope: "justin", fact: words[x], source: "proposal p_" + x, created_at: `2026-09-2${i}T00:00:00.000Z` }));
  const props = facts.map((f) => ({ id: "p_" + f.id.slice(2), evidence: "she said so", payload_json: JSON.stringify({ user_message_id: "m_u" }) }));
  const hist = [{ day: "2026-09-30", result_json: JSON.stringify({ step: "hygiene", detail: { checked: ["f_c"], judged: [] } }) }];
  const db = scriptedD1([
    [/FROM facts WHERE status = \?1/, facts],
    [/FROM nightly_runs WHERE step = 'hygiene'/, hist],
    [/SELECT id, evidence, payload_json FROM proposals WHERE id IN/, props],
    [/SELECT id, content FROM messages WHERE role = 'user' AND id IN/, [{ id: "m_u", content: "hi" }]],
  ]);
  const r = await hygiene.runHygienePass(ENV, db, settingsV5(), storycall.newNightlyBudget(0.25), new Date("2026-10-02T11:00:00.000Z"));
  assert.deepEqual([...r.detail.checked].sort(), ["f_a", "f_b"], "f_c was asked last night");
  const marks = await hygiene.recentHygieneMarks(db, "2026-10-01");
  assert.deepEqual([...marks.checked], ["f_c"]);
  const window = db.log.find((e) => /FROM nightly_runs WHERE step = 'hygiene'/.test(e.sql));
  assert.deepEqual(window.binds.slice(0, 2), ["2026-09-01", "2026-10-01"]);
});

test("pipeline 2: a judged near group gives way; a big group shows its later members in the next window", () => {
  const words = ["moving to los angeles next spring", "moving to los angeles next year", "moving to los angeles soon", "moving to los angeles in spring", "moving to los angeles eventually", "moving to los angeles someday", "moving to los angeles for work"];
  const facts = words.map((w, i) => factRow({ id: "f_la" + i, scope: "justin", fact: "he is " + w, created_at: `2026-09-1${i}T00:00:00.000Z` }));
  const first = hygiene.nearDuplicateGroups(facts, new Set());
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].ids, ["f_la0", "f_la1", "f_la2", "f_la3", "f_la4"]);
  const judged = new Set([hygiene.groupKey(first[0].ids)]);
  const next = hygiene.nearDuplicateGroups(facts, new Set(), { judged });
  assert.deepEqual(next[0].ids, ["f_la0", "f_la5", "f_la6"], "the oldest with the ones never shown");
  const both = new Set([...judged, hygiene.groupKey(next[0].ids)]);
  assert.deepEqual(hygiene.nearDuplicateGroups(facts, new Set(), { judged: both }), [], "every window judged: nothing to ask");
  assert.equal(hygiene.groupKey(["b", "a"]), hygiene.groupKey(["a", "b"]));
});

test("pipeline 3: a merged head is still a guess candidate; a fact a merge takes tonight is not", () => {
  const merged = factRow({ id: "f_head", scope: "justin", fact: "he works nights", source: "merged: proposal p_1; proposal p_2" });
  const other = factRow({ id: "f_x", scope: "justin", fact: "he has a dog", source: "proposal p_3" });
  const props = new Map([["p_1", { evidence: "she guessed", userMessageId: null }], ["p_3", { evidence: "she guessed", userMessageId: null }]]);
  const all = hygiene.inferredCandidates([merged, other], props, new Map()).map((c) => c.factId).sort();
  assert.deepEqual(all, ["f_head", "f_x"]);
  assert.deepEqual(hygiene.inferredCandidates([merged, other], props, new Map(), new Set(["f_x"])).map((c) => c.factId), ["f_head"]);
});

test("pipeline 4: his own words make her guess his (no second fact); the Guess box and PUT /api/facts/:id clear it; only a fact about him can be a guess", async () => {
  const guess = { ...factRow({ id: "f_guess", scope: "justin", fact: "he works nights", source: "proposal p_old" }), inferred: 1 };
  const p = { id: "p_new", conversation_id: "c_1", message_id: "m_1", kind: "justin_fact", proposal: "He works nights.", evidence: "i work nights", confidence: "high", scope: "general", payload_json: JSON.stringify({ payload: { said_by: "him" }, raw: null }), status: "pending", decision_note: null, promoted_id: null, created_at: "2026-10-01T00:00:00.000Z", decided_at: null };
  const db = scriptedD1([
    [/SELECT \* FROM proposals WHERE id = \?1/, (b) => (b[0] === p.id ? [p] : [])],
    [/FROM facts WHERE scope = \?1 AND status = \?2/, (b) => (b[0] === "justin" ? [guess] : [])],
    [/SELECT \* FROM facts WHERE id = \?1/, (b) => (b[0] === guess.id ? [guess] : [])],
  ]);
  const r = await proposals.decideProposal(db, p.id, "approve", "owner");
  const inserts = db.log.filter((e) => /^INSERT INTO facts/.test(e.sql));
  assert.equal(inserts.length, 1, "one new head, no second fact");
  assert.ok(!/inferred/.test(inserts[0].sql), "the head is no guess");
  assert.equal(inserts[0].binds[9], "f_guess", "it supersedes the guess");
  assert.equal(r.promotedId, inserts[0].binds[0]);
  const her = scriptedD1([[/SELECT \* FROM facts WHERE id = \?1/, [factRow({ id: "f_her", scope: "avelie" })]]]);
  await assert.rejects(state.updateFact(her, "f_her", { inferred: true }, "owner"), (e) => e.status === 400);
  const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /const inferred = optBool\(body, "inferred"\);\n  if \(inferred !== undefined\) patch\.inferred = inferred;/);
  const js = readFileSync(new URL("../../public/js/state.js", import.meta.url), "utf8");
  assert.match(js, /if \(guess\) body\.inferred = guess\.checked;/);
  const src = readFileSync(new URL("../../src/proposals.ts", import.meta.url), "utf8");
  assert.match(src, /\(her guess\)/, "the extractor sees which kept facts are guesses");
});

test("pipeline 10: an exact-duplicate group is cut to a keep and ten merged ids (mergeFacts' limit)", () => {
  const facts = Array.from({ length: 14 }, (_, i) => factRow({ id: "f_d" + String(i).padStart(2, "0"), scope: "justin", fact: "he is 44", created_at: `2026-09-${String(10 + i)}T00:00:00.000Z` }));
  const g = hygiene.exactDuplicateGroups(facts);
  assert.equal(g.length, 1);
  assert.equal(g[0].ids.length, 11);
});

test("pipeline 13: leaving a together scene drops its carried place; a restored scene version is written in the v5 shape", async () => {
  const cur = sceneState({ status: "together", location: "her couch", time: "late" });
  const toggled = standing.normalizeSceneFields({ ...cur, status: "apart" }, cur, { strict: true });
  assert.equal(toggled.location, null, "the toggle sent the old place back");
  const named = standing.normalizeSceneFields({ ...cur, status: "apart", location: "her apartment" }, cur, { strict: true });
  assert.equal(named.location, "her apartment");
  const stay = standing.normalizeSceneFields({ ...cur, summary: "still here" }, cur, { strict: true });
  assert.equal(stay.location, "her couch", "still together keeps it");
  const old = { id: "st_2", entity: "scene", version: 2, state_json: JSON.stringify({ status: "apart", summary: "pre-v5" }), source: "owner", note: null, created_at: "2026-09-20T00:00:00.000Z" };
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1 AND version = \?2/, [old]],
    [/FROM state_versions WHERE entity = \?1 ORDER BY version DESC LIMIT 1/, [{ id: "st_5", entity: "scene", version: 5, state_json: JSON.stringify(cur), source: "owner", note: null, created_at: "2026-10-01T00:00:00.000Z" }]],
  ]);
  const r = await state.restoreState(db, "scene", 2, "owner");
  for (const k of ["status", "location", "time", "present"]) assert.ok(k in r.state, k);
  assert.equal(r.state.location, null);
});

// ------------------------------------------------------------------ the UI

test("ui 2: 'all' reads never list the superseded versions behind a read", async () => {
  const db = scriptedD1([]);
  await views.listViews(db, "all", 100);
  assert.match(db.log[0].sql, /WHERE status != 'superseded'/);
});

test("ui 1 and 4: GET /api/state and PUT /api/state/relationship carry the server's live read; the page uses it", () => {
  const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /return json\(\{ \.\.\.bundle, relationship: \{ \.\.\.bundle\.relationship, live \} \}\);/);
  assert.match(api, /if \(entity !== "scene"\) return json\(\{ \.\.\.r, live: await relationshipLive\(/);
  const js = readFileSync(new URL("../../public/js/state.js", import.meta.url), "utf8");
  assert.match(js, /const phase = live \? \(typeof live\.friction === "string"/);
});

test("ui 3, 5 and 8: beats read once with her timezone; a variant without a note is refused on the page", () => {
  const js = readFileSync(new URL("../../public/js/state.js", import.meta.url), "utf8");
  const load = js.slice(js.indexOf("async function loadWants()"), js.indexOf("function progressBar("));
  assert.match(load, /loadSettingsOnce\(\)/);
  assert.match(load, /\/api\/beats\?status=all/);
  assert.match(load, /lifeTz = settings\.timezone/);
  assert.match(js, /if \(variants\.missingNote\(\)\) \{ flash\(slot, "note", "danger"\); return; \}/);
});

test("ui 6: the chat's artist key is the server's artist_norm, the all-punctuation fallback included", () => {
  const js = readFileSync(new URL("../../public/js/chat.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function artistNorm(a) {"), js.indexOf("const FEEDBACK"));
  const artistNorm = new Function(src + "\nreturn artistNorm;")();
  for (const a of ["The !!!", "The National", "national", "Simon & Garfunkel", "  the   Beatles ", "!!!", "Sigur Rós"]) {
    assert.equal(artistNorm(a), songs.artistNorm(a), a);
  }
});

test("ui 7: a card's Save shows its result beside the button pressed", () => {
  const html = readFileSync(new URL("../../public/model.html", import.meta.url), "utf8");
  assert.equal((html.match(/data-save-status/g) ?? []).length, 3);
  const js = readFileSync(new URL("../../public/js/model.js", import.meta.url), "utf8");
  assert.match(js, /e\.submitter/);
  assert.match(js, /querySelector\("\[data-save-status\]"\)/);
});
