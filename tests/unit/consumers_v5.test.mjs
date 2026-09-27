// The clock's consumers (SPEC_V5 section 1, skeptic 23): her first texts stop on a together
// scene or a held clock BEFORE the day's count and the cap, and read the last message's age
// in story time; the delayed-reply push sends nothing while held; her life reads an event that
// fell inside a closed span through deferAt; the callback picker's ages are story time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRow } from "./helpers_v2.mjs";
import { wantRow, askRow } from "./helpers_v3.mjs";
import {
  loadSrcIfPresent, guard, scriptedD1, clockScript, sceneVersion, clockSpan, storyClock, settingsV5,
  TZ, TUE_2100_NY, FRI_1005_NY, MIN_MS, HOUR_MS, DAY_MS, plusMs,
} from "./helpers_v5.mjs";

const herfirst = await loadSrcIfPresent("herfirst");
const deliveries = await loadSrcIfPresent("deliveries");
const life = await loadSrcIfPresent("life");
const callbacks = await loadSrcIfPresent("callbacks");
const clock = await loadSrcIfPresent("clock");

const ENV = { APP_ENV: "unit" };
const FRI_1015_NY = plusMs(FRI_1005_NY, 10 * MIN_MS);

function sceneRow(state, version = 3) {
  return { id: "st_s" + version, entity: "scene", version, state_json: JSON.stringify(state), source: "owner", note: null, created_at: TUE_2100_NY };
}

const tH = guard(herfirst, "maybeTextFirst");

tH("maybeTextFirst: a together scene answers the together reason even with the day's cap already reached (the gate comes before the count)", async () => {
  const versions = [sceneVersion(2, "apart", "2026-09-29T20:00:00.000Z"), sceneVersion(3, "together", TUE_2100_NY, "the pier")];
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "scene" ? [sceneRow({ status: "together", location: "the pier" })] : [])],
    [/FROM first_texts_daily/, [{ count: 99 }]],
    ...clockScript(versions, [clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: TUE_2100_NY })]),
  ]);
  const r = await herfirst.maybeTextFirst(ENV, db, settingsV5({ herFirstTextsPerDay: 2 }), new Date(FRI_1015_NY));
  assert.equal(r.sent, false);
  assert.equal(r.reason, "together: they are in the same place");
  assert.ok(!db.log.some((e) => /first_texts_daily/.test(e.sql)), "the count was never read");
  assert.ok(!db.log.some((e) => /FROM conversations|INSERT INTO conversations/.test(e.sql)), "no conversation opened");
});

tH("maybeTextFirst: a held clock (the record says apart but the span is still open) answers the frozen reason before the count", async () => {
  // The scene row reads "Apart " (so not together by the first gate), the story_clock has an
  // open span whose opening version is still together (the sync sees no close yet because
  // the scripted versions stop at the together run): the clock is frozen.
  const versions = [sceneVersion(2, "apart", "2026-09-29T20:00:00.000Z"), sceneVersion(3, "together", TUE_2100_NY, "the pier")];
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "scene" ? [sceneRow({ status: "none" })] : [])],
    [/FROM first_texts_daily/, [{ count: 99 }]],
    ...clockScript(versions, [clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: TUE_2100_NY })]),
  ]);
  const r = await herfirst.maybeTextFirst(ENV, db, settingsV5({ herFirstTextsPerDay: 2 }), new Date(FRI_1015_NY));
  assert.equal(r.reason, "frozen: a together scene is held");
  assert.ok(!db.log.some((e) => /first_texts_daily/.test(e.sql)));
});

tH("maybeTextFirst: apart, ten minutes after a three-day held span ended with the last exchange inside it, the recent gate reads story time", async () => {
  const versions = [sceneVersion(2, "apart", "2026-09-29T20:00:00.000Z"), sceneVersion(3, "together", TUE_2100_NY, "the pier"), sceneVersion(4, "apart", FRI_1005_NY)];
  const span = clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: TUE_2100_NY, closed_version: 4, resumed_at: FRI_1005_NY, beats_shifted_at: FRI_1005_NY });
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "scene" ? [sceneRow({ status: "apart" }, 4)] : [])],
    [/FROM first_texts_daily/, [{ count: 0 }]],
    [/FROM conversations/, [{ id: "c_1", status: "active", title: "x", created_at: "2026-09-29T00:00:00.000Z", last_message_at: null }]],
    [/SELECT role, created_at FROM messages WHERE conversation_id = \?1/, [
      { role: "assistant", created_at: plusMs(TUE_2100_NY, 30 * MIN_MS) },
      { role: "user", created_at: plusMs(TUE_2100_NY, 29 * MIN_MS) },
    ]],
    ...clockScript(versions, [span]),
  ]);
  const r = await herfirst.maybeTextFirst(ENV, db, settingsV5({ herFirstTextsPerDay: 10, herFirstQuietHours: "23:30-08:30" }), new Date(FRI_1015_NY));
  assert.equal(r.sent, false);
  assert.ok(/^recent: /.test(r.reason), r.reason + " (real time would read three days of quiet)");
});

const tD = guard(deliveries, "pushDueReplies");
tD("pushDueReplies with frozen: no push is sent, every due row is stamped as under quiet, the result carries frozen", async () => {
  const now = new Date("2026-10-02T14:00:00.000Z");
  const due = [
    { id: "m1", created_at: plusMs(now.toISOString(), -10 * MIN_MS), deliver_at: plusMs(now.toISOString(), -1 * MIN_MS), pushed_at: null },
    { id: "m2", created_at: plusMs(now.toISOString(), -20 * MIN_MS), deliver_at: plusMs(now.toISOString(), -2 * MIN_MS), pushed_at: null },
  ];
  const run = async (opts) => {
    const db = scriptedD1([[/FROM messages WHERE role = 'assistant' AND channel = 'story' AND deliver_at IS NOT NULL/, due]]);
    const res = await deliveries.pushDueReplies(ENV, db, now, opts);
    return { res, db };
  };
  const frozen = await run({ frozen: true });
  assert.equal(frozen.res.frozen, true);
  assert.equal(frozen.res.pushed, false);
  assert.equal(frozen.res.result, null);
  assert.ok(!frozen.db.log.some((e) => /push_subscriptions/.test(e.sql)), "no push read or sent");
  const quiet = await run({ quiet: true });
  const stamps = (db) => db.log.filter((e) => /^UPDATE messages SET pushed_at/.test(e.sql)).map((e) => e.binds[0]).sort();
  assert.deepEqual(stamps(frozen.db), stamps(quiet.db), "stamped exactly as under quiet");
  assert.ok(stamps(frozen.db).length >= 1);
});

const tL = guard(life, "lifeSection");
tL("lifeSection with a deferAt built from a clock shows an event that fell inside a closed span as Next up", () => {
  if (!clock) return;
  // The open mic was due Wednesday 8pm, inside a span held Tuesday 9pm to Friday 10:05am;
  // read on Friday at 10:30 it lies 23 hours after the resume: Saturday 9:05am.
  const openMic = "2026-10-01T00:00:00.000Z";
  const span = clockSpan({ frozen_at: TUE_2100_NY, resumed_at: FRI_1005_NY });
  const c = storyClock({ spans: [span], real: plusMs(FRI_1005_NY, 25 * MIN_MS) });
  const now = clock.storyNow(c);
  const ev = eventRow(openMic);
  const without = life.lifeSection([ev], [], now, TZ);
  assert.ok(!/Next up/.test(without), "without the clock the event is in the past");
  const withDefer = life.lifeSection([ev], [], now, TZ, { deferAt: (iso) => clock.deferredInstant(c, iso) });
  assert.ok(/Next up: Saturday 9:05am/.test(withDefer), withDefer);
  assert.ok(/\(tomorrow\)/.test(withDefer), withDefer);
});

tL("lifeSection in together mode drops the schedule halves of the first line and reads the scene's own clock words", () => {
  const now = new Date("2026-09-29T19:10:00.000Z");
  const work = { id: "lt_work", kind: "routine", title: "the shop", detail: null, status: "active", relation: null, source: null, version: 1, supersedes_id: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", schedule_json: JSON.stringify({ tz: TZ, blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", label: "at work" }] }) };
  const apart = life.lifeSection([work], [], now, TZ);
  assert.ok(/You are at work until 5:30pm\./.test(apart), apart);
  const together = life.lifeSection([work], [], now, TZ, { together: true, clockWords: "late night" });
  assert.ok(/It is Tuesday, late night\./.test(together), together);
  assert.ok(!/You are at work|Nothing on your schedule/.test(together), together);
});

const tC = guard(callbacks, "pickCallbacks");
tC("pickCallbacks with a clock: a want still for one real day plus three held days is not offered; an ask asked four real days ago with three held is not offered; without the clock both are", () => {
  if (!clock) return;
  const real = "2026-10-06T12:00:00.000Z";
  // Held for three days, ending one real day ago.
  const span = clockSpan({ frozen_at: "2026-10-02T12:00:00.000Z", resumed_at: "2026-10-05T12:00:00.000Z" });
  const c = storyClock({ spans: [span], real });
  const want = wantRow({ id: "w_still", title: "finish the bridge", last_moved: "2026-10-02T12:00:00.000Z", created_at: "2026-09-20T00:00:00.000Z" });
  const ask = askRow({ id: "ask_old", text: "send me the song you meant", asked_at: "2026-10-02T12:00:00.000Z" });
  const base = { history: [], threads: [], log: [], recentTexts: [], now: new Date(real), seed: "s", wants: [want], wantLog: [], asks: [ask] };
  const real4 = callbacks.pickCallbacks(base).map((x) => x.sourceId).sort();
  assert.deepEqual(real4, ["ask_old", "w_still"], "real time: four days");
  const story = callbacks.pickCallbacks({ ...base, clock: c }).map((x) => x.sourceId);
  assert.deepEqual(story, [], "story time: one day");
});

tC("pickCallbacks with a clock: every age it reports is story time; an event inside a closed span is read through deferredInstant", () => {
  if (!clock) return;
  const real = "2026-10-06T12:00:00.000Z";
  const span = clockSpan({ frozen_at: "2026-09-26T12:00:00.000Z", resumed_at: "2026-10-01T12:00:00.000Z" });
  const c = storyClock({ spans: [span], real });
  const hist = { id: "h1", seq: 1, title: "the first coffee", occurred: "2026-09-25T12:00:00.000Z", body: "x", what_changed: null, keep_consistent: null, source: null, status: "approved", version: 1, supersedes_id: null, created_at: "2026-09-25T12:00:00.000Z", updated_at: "2026-09-25T12:00:00.000Z" };
  const out = callbacks.pickCallbacks({ history: [hist], threads: [], log: [], recentTexts: [], now: new Date(real), seed: "s", clock: c });
  assert.equal(out.length, 1);
  assert.equal(out[0].ageDays, 6, "11 real days minus 5 held");
  // An event due inside the span (Sep 28) is read 2 days after the resume (Oct 3): past, and inside the window.
  const ev = eventRow("2026-09-28T12:00:00.000Z", { id: "lt_ev", title: "the gig", status: "done" });
  const got = callbacks.pickCallbacks({ history: [], threads: [ev], log: [], recentTexts: [], now: new Date(real), seed: "s", clock: c });
  assert.equal(got.length, 1);
  assert.equal(got[0].ageDays, 3, "Oct 3 to Oct 6");
});

test("maybeTextFirst's gates are in the spec order in the source: off/quiet, together, frozen, then the count", async () => {
  const { repoText } = await import("./helpers_v5.mjs");
  const src = repoText("src/herfirst.ts");
  if (!src) return;
  const body = src.slice(src.indexOf("export async function maybeTextFirst"));
  const i = (s) => body.indexOf(s);
  assert.ok(i("gateReason(neutral)") >= 0);
  assert.ok(i("isTogether(") > i("gateReason(neutral)"), "together after the off and quiet gate");
  assert.ok(i("loadStoryClock(") > i("isTogether("), "then the clock");
  assert.ok(i("countFor(") > i("loadStoryClock("), "then the count");
});
