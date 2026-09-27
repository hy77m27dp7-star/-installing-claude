// Her clock (SPEC_V5 section 1), with Justin's rule: story time runs only while the scene is
// apart; a together scene holds the moment. The pure arithmetic (storyNow, the overlap, the
// story instant, the deferred instant, the day keys, the gap words, TIME SINCE, the scene's
// own time words, the held grounding) and the database half on a scripted D1 (the sync's
// cases A to D, the stale guard, the sc_v7 id collision, the beat shift).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadSrcIfPresent, guard, clockSpan, storyClock, scriptedD1, clockScript, sceneVersion, settingsV5,
  TZ, TUE_2350_NY, WED_0030_NY, TUE_2100_NY, FRI_1000_NY, FRI_1005_NY, MIN_MS, HOUR_MS, DAY_MS, plusMs,
} from "./helpers_v5.mjs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { groundingRow, weatherNow, assetRow } from "./helpers_v3.mjs";

const clock = await loadSrcIfPresent("clock");
const grounding = await loadSrcIfPresent("grounding");
const wants = await loadSrcIfPresent("wants");
const t = guard(clock, "storyNow", "storyElapsedMs", "frozenOverlapMs", "storyInstantOf");
const tDay = guard(clock, "localDayKeyOf", "localInstant", "dayBounds", "herDayKey");
const tSync = guard(clock, "syncStoryClock");

const at = (iso) => new Date(iso);
const apartMsOfDay = (c, day) => {
  const { start, end } = clock.dayBounds(day, TZ);
  const endMs = Math.min(Date.parse(end), Date.parse(c.real));
  return clock.storyElapsedMs(c, start, new Date(endMs).toISOString());
};

// ------------------------------------------------------------------ storyNow and the span

t("storyNow: not frozen, it is the real instant; a disabled clock ignores an open span", () => {
  const c = storyClock({ spans: [], real: FRI_1000_NY });
  assert.equal(clock.storyNow(c).toISOString(), FRI_1000_NY);
  assert.equal(c.frozen, false);
  const off = storyClock({ spans: [clockSpan()], real: FRI_1000_NY, enabled: false });
  assert.equal(clock.storyNow(off).toISOString(), FRI_1000_NY);
  const d = clock.disabledClock(at(FRI_1000_NY));
  assert.deepEqual(d, { enabled: false, real: FRI_1000_NY, frozen: false, open: null, spans: [] });
  assert.equal(clock.storyElapsedMs(off, TUE_2100_NY), Date.parse(FRI_1000_NY) - Date.parse(TUE_2100_NY), "a disabled clock is real time");
});

t("FROZEN ACROSS MIDNIGHT: opened Tuesday 23:50 New York, read Wednesday 00:30: storyNow is Tuesday 23:50, the day key 2026-09-29, the grounding says Tuesday night, 5 minutes since his 23:45 message, and the 07:00Z her-day key is 2026-09-29 with 23h50m apart", () => {
  const span = clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: TUE_2350_NY, created_at: TUE_2350_NY });
  const c = storyClock({ spans: [span], real: WED_0030_NY });
  const now = clock.storyNow(c);
  assert.equal(now.toISOString(), TUE_2350_NY);
  assert.equal(clock.localDayKeyOf(now, TZ), "2026-09-29");
  if (grounding && typeof grounding.groundingSection === "function") {
    const text = grounding.groundingSection({ now, tz: TZ, city: "Portland, Maine", weather: weatherNow({ fetchedAt: TUE_2350_NY, isDay: false }), outfit: null, today: [] });
    assert.match(text, /Tuesday/);
    assert.match(text, /\bnight\b/);
    assert.ok(!/Wednesday/.test(text), text);
  }
  const his = plusMs(TUE_2350_NY, -5 * MIN_MS);
  assert.equal(clock.storyElapsedMs(c, his), 5 * MIN_MS, "held time is not time");
  const cron = "2026-09-30T07:00:00.000Z";
  assert.equal(clock.herDayKey(at(cron), TZ), "2026-09-29");
  const atCron = storyClock({ spans: [span], real: cron });
  assert.equal(apartMsOfDay(atCron, "2026-09-29"), 23 * HOUR_MS + 50 * MIN_MS);
  assert.ok(atCron.frozen, "still held at the cron: the her-day step itself is skipped (rule 2)");
});

t("FROZEN ACROSS THREE DAYS: opened Tuesday 21:00, read Friday 10:00: storyNow Tuesday 21:00, 2 minutes since his 20:58 message, a one-day mood set Tuesday noon is fresh on the clock and gone without it, no TIME SINCE, and Wednesday and Thursday each measure 0 apart", () => {
  const span = clockSpan({ frozen_at: TUE_2100_NY });
  const c = storyClock({ spans: [span], real: FRI_1000_NY });
  assert.equal(clock.storyNow(c).toISOString(), TUE_2100_NY);
  const his = plusMs(TUE_2100_NY, -2 * MIN_MS);
  assert.equal(clock.storyElapsedMs(c, his), 2 * MIN_MS);
  if (wants && typeof wants.moodNow === "function") {
    const rel = { mood: "annoyed", mood_days: 1, mood_set_at: "2026-09-29T16:00:00.000Z" };
    const onClock = wants.moodNow(rel, clock.storyNow(c), settingsV5(), null, c);
    assert.equal(onClock.phase, "fresh", "9 hours of story time");
    assert.ok(Math.abs(onClock.ageDays - 9 / 24) < 1e-9, String(onClock.ageDays));
    assert.equal(wants.moodNow(rel, at(FRI_1000_NY), settingsV5()).phase, "gone", "real time would have run it out");
  }
  if (typeof clock.timeSinceSection === "function" && typeof clock.timeSince === "function") {
    const ts = clock.timeSince(c, { hisAt: his, herAt: his, lastAt: his }, TZ);
    assert.equal(clock.timeSinceSection(ts, { mode: "together", opener: false, minMinutes: 120 }), "");
  }
  assert.equal(apartMsOfDay(c, "2026-09-30"), 0, "Wednesday was held");
  assert.equal(apartMsOfDay(c, "2026-10-01"), 0, "Thursday was held");
});

t("RESUMED: the same span resumed Friday 10:05 and read at 10:06 is real time again, 3 minutes since his Tuesday 20:58; at Saturday 07:00Z Friday measures 13h55m apart", () => {
  const span = clockSpan({ frozen_at: TUE_2100_NY, resumed_at: FRI_1005_NY, closed_version: 8 });
  const c = storyClock({ spans: [span], real: plusMs(FRI_1005_NY, MIN_MS) });
  assert.equal(c.frozen, false);
  assert.equal(clock.storyNow(c).toISOString(), plusMs(FRI_1005_NY, MIN_MS));
  assert.equal(clock.storyElapsedMs(c, plusMs(TUE_2100_NY, -2 * MIN_MS)), 3 * MIN_MS);
  if (typeof clock.timeSince === "function") {
    const last = plusMs(TUE_2100_NY, -2 * MIN_MS);
    const ts = clock.timeSince(c, { hisAt: last, herAt: null, lastAt: last }, TZ);
    assert.equal(clock.timeSinceSection(ts, { mode: "apart", opener: false, minMinutes: 120 }), "", "three minutes of story time is no gap");
  }
  const sat = "2026-10-03T07:00:00.000Z";
  const c2 = storyClock({ spans: [span], real: sat });
  assert.equal(clock.herDayKey(at(sat), TZ), "2026-10-02");
  assert.equal(apartMsOfDay(c2, "2026-10-02"), 13 * HOUR_MS + 55 * MIN_MS);
  assert.ok(apartMsOfDay(c2, "2026-10-02") >= clock.HER_DAY_MIN_APART_MS, "the her-day step writes Friday");
});

t("frozenOverlapMs sums two closed spans and an open one; an unreadable span is skipped", () => {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const s1 = clockSpan({ id: "a", frozen_at: new Date(base).toISOString(), resumed_at: new Date(base + HOUR_MS).toISOString() });
  const s2 = clockSpan({ id: "b", frozen_at: new Date(base + 3 * HOUR_MS).toISOString(), resumed_at: new Date(base + 5 * HOUR_MS).toISOString() });
  const s3 = clockSpan({ id: "c", frozen_at: new Date(base + 8 * HOUR_MS).toISOString(), resumed_at: null });
  const bad = clockSpan({ id: "d", frozen_at: "not a date" });
  const real = base + 10 * HOUR_MS;
  assert.equal(clock.frozenOverlapMs([s1, s2, s3, bad], base, real, real), 5 * HOUR_MS);
  assert.equal(clock.frozenOverlapMs([s1, s2, s3], base + 30 * MIN_MS, base + 4 * HOUR_MS, real), 30 * MIN_MS + HOUR_MS, "partial overlaps");
  assert.equal(clock.frozenOverlapMs([], base, real, real), 0);
});

t("storyInstantOf: a stamp inside a span is the moment the scene froze; outside, itself; unreadable, the real instant", () => {
  const span = clockSpan({ frozen_at: TUE_2100_NY, resumed_at: FRI_1005_NY });
  const c = storyClock({ spans: [span], real: "2026-10-03T12:00:00.000Z" });
  assert.equal(clock.storyInstantOf(c, "2026-10-01T12:00:00.000Z").toISOString(), TUE_2100_NY);
  assert.equal(clock.storyInstantOf(c, TUE_2100_NY).toISOString(), TUE_2100_NY, "the start is inside");
  assert.equal(clock.storyInstantOf(c, FRI_1005_NY).toISOString(), FRI_1005_NY, "the end is outside");
  assert.equal(clock.storyInstantOf(c, "2026-09-29T12:00:00.000Z").toISOString(), "2026-09-29T12:00:00.000Z");
  assert.equal(clock.storyInstantOf(c, "garbage").toISOString(), "2026-10-03T12:00:00.000Z");
});

const tSp = guard(clock, "spansFromVersions");
tSp("spansFromVersions: two together runs, the second open", () => {
  const versions = [
    { version: 1, status: "apart", created_at: "2026-09-29T10:00:00.000Z" },
    { version: 2, status: "together", created_at: "2026-09-29T11:00:00.000Z", location: "the pier" },
    { version: 3, status: " Together ", created_at: "2026-09-29T11:30:00.000Z", location: "the pier" },
    { version: 4, status: "apart", created_at: "2026-09-29T12:00:00.000Z" },
    { version: 6, status: "together", created_at: "2026-09-29T14:00:00.000Z", location: "her kitchen" },
    { version: 5, status: "none", created_at: "2026-09-29T13:00:00.000Z" },
  ];
  assert.deepEqual(clock.spansFromVersions(versions), [
    { openedVersion: 2, frozenAt: "2026-09-29T11:00:00.000Z", closedVersion: 4, resumedAt: "2026-09-29T12:00:00.000Z", location: "the pier" },
    { openedVersion: 6, frozenAt: "2026-09-29T14:00:00.000Z", closedVersion: null, resumedAt: null, location: "her kitchen" },
  ]);
  assert.deepEqual(clock.spansFromVersions([]), []);
});

// ------------------------------------------------------------------ words and sections

const tWords = guard(clock, "gapWords", "timeSince", "timeSinceSection");
tWords("gapWords on its table", () => {
  const cases = [
    [0, "less than an hour"], [59 * MIN_MS, "less than an hour"], [60 * MIN_MS, "about an hour"], [89 * MIN_MS, "about an hour"],
    [90 * MIN_MS, "about 2 hours"], [3 * HOUR_MS, "about 3 hours"], [19 * HOUR_MS + 59 * MIN_MS, "about 20 hours"],
    [20 * HOUR_MS, "about a day"], [35 * HOUR_MS, "about a day"], [36 * HOUR_MS, "2 days"], [3 * DAY_MS, "3 days"], [13 * DAY_MS, "13 days"],
    [14 * DAY_MS, "2 weeks"], [30 * DAY_MS, "4 weeks"], [59 * DAY_MS, "8 weeks"], [60 * DAY_MS, "2 months"], [120 * DAY_MS, "4 months"],
  ];
  for (const [ms, words] of cases) assert.equal(clock.gapWords(ms), words, String(ms));
});

tWords("timeSinceSection: empty in together, on an opener, under the minimum; a 3-hour line; the new-day line; never who wrote last", () => {
  const real = "2026-09-30T15:00:00.000Z"; // Wednesday 11:00am
  const c = storyClock({ spans: [], real });
  const threeHours = plusMs(real, -3 * HOUR_MS);
  const ts = clock.timeSince(c, { hisAt: threeHours, herAt: null, lastAt: threeHours }, TZ);
  assert.equal(ts.lastAgoMs, 3 * HOUR_MS);
  assert.equal(ts.newDay, false);
  assert.ok(!("lastRole" in ts), "no role on TimeSince (skeptic 6)");
  assert.equal(clock.timeSinceSection(ts, { mode: "together", opener: false, minMinutes: 120 }), "");
  assert.equal(clock.timeSinceSection(ts, { mode: "apart", opener: true, minMinutes: 120 }), "");
  assert.equal(clock.timeSinceSection(ts, { mode: "apart", opener: false, minMinutes: 240 }), "", "under the minimum");
  assert.equal(clock.timeSinceSection(null, { mode: "apart", opener: false, minMinutes: 120 }), "");
  const three = clock.timeSinceSection(ts, { mode: "apart", opener: false, minMinutes: 120 });
  assert.equal(three, "TIME SINCE (true, from the clock; use it or ignore it; never a complaint, never who wrote last, never where he was, never how long you waited)\nYou last talked about 3 hours ago.");
  const yesterday = "2026-09-29T23:00:00.000Z"; // Tuesday 7:00pm
  const nd = clock.timeSince(c, { hisAt: null, herAt: yesterday, lastAt: yesterday }, TZ);
  assert.equal(nd.newDay, true);
  const text = clock.timeSinceSection(nd, { mode: "apart", opener: false, minMinutes: 120 });
  assert.ok(text.endsWith("You last talked about 16 hours ago.\nIt is a new day since you last talked."), text);
  for (const who of [{ hisAt: yesterday, herAt: null }, { hisAt: null, herAt: yesterday }]) {
    const s = clock.timeSinceSection(clock.timeSince(c, { ...who, lastAt: yesterday }, TZ), { mode: "apart", opener: false, minMinutes: 120 });
    assert.equal(s, text, "the same words whoever wrote last");
    assert.ok(!/\b(?:he wrote|you wrote|his message|your message|unanswered|waited|left you|replied)\b/i.test(s.split("\n").slice(1).join("\n")), s);
  }
  assert.ok(!BAD_TYPOGRAPHY.test(text));
  assert.equal(clock.timeSinceSection(clock.timeSince(c, { hisAt: null, herAt: null, lastAt: null }, TZ), { mode: "apart", opener: false, minMinutes: 120 }), "");
});

tDay("localInstant is DST-safe across the November change; a malformed day or time is a 400", () => {
  assert.equal(clock.localInstant("2026-10-31", "12:00", TZ), "2026-10-31T16:00:00.000Z", "EDT");
  assert.equal(clock.localInstant("2026-11-01", "00:30", TZ), "2026-11-01T04:30:00.000Z", "still EDT at half past midnight");
  assert.equal(clock.localInstant("2026-11-01", "12:00", TZ), "2026-11-01T17:00:00.000Z", "EST after the change");
  assert.equal(clock.localInstant("2026-11-02", "00:00", TZ), "2026-11-02T05:00:00.000Z");
  assert.equal(clock.localInstant("2026-07-04", "20:00", "Europe/London"), "2026-07-04T19:00:00.000Z");
  const b = clock.dayBounds("2026-11-01", TZ);
  assert.equal(Date.parse(b.end) - Date.parse(b.start), 25 * HOUR_MS, "the long day");
  for (const [day, hhmm] of [["2026-02-30", "12:00"], ["2026-9-3", "12:00"], ["2026-09-30", "24:00"], ["2026-09-30", "7:5"], ["", ""]]) {
    assert.throws(() => clock.localInstant(day, hhmm, TZ), (e) => e && e.status === 400 && e.code === "validation", day + " " + hhmm);
  }
});

tDay("herDayKey names the last day that has ENDED: at 07:00Z the day that just ended, at 14:00 her time yesterday (never today), at 00:30 her time yesterday", () => {
  assert.equal(clock.herDayKey(at("2026-09-30T07:00:00.000Z"), TZ), "2026-09-29");
  assert.equal(clock.herDayKey(at("2026-09-30T18:00:00.000Z"), TZ), "2026-09-29", "2pm Wednesday names Tuesday");
  assert.equal(clock.herDayKey(at(WED_0030_NY), TZ), "2026-09-29", "just after midnight: Tuesday has ended");
  assert.equal(clock.herDayKey(at("2026-12-01T07:00:00.000Z"), TZ), "2026-11-30", "2am in winter");
  assert.equal(clock.localDayKeyOf(at(TUE_2350_NY), TZ), "2026-09-29");
});

const tDef = guard(clock, "deferredInstant");
tDef("deferredInstant: an event inside a closed span lands the same distance after resumed_at; inside the open span, before and after every span, unchanged; no clock, unchanged", () => {
  const closed = clockSpan({ id: "sc_v2", frozen_at: TUE_2100_NY, resumed_at: FRI_1005_NY });
  const open = clockSpan({ id: "sc_v9", opened_version: 9, frozen_at: "2026-10-03T20:00:00.000Z", resumed_at: null });
  const c = storyClock({ spans: [closed, open], real: "2026-10-04T12:00:00.000Z" });
  const inside = plusMs(TUE_2100_NY, 23 * HOUR_MS);
  assert.equal(clock.deferredInstant(c, inside), plusMs(FRI_1005_NY, 23 * HOUR_MS));
  assert.equal(clock.deferredInstant(c, plusMs(TUE_2100_NY, 1)), plusMs(FRI_1005_NY, 1), "to the millisecond");
  assert.equal(clock.deferredInstant(c, TUE_2100_NY), TUE_2100_NY, "the frozen moment itself is not after it");
  assert.equal(clock.deferredInstant(c, "2026-10-03T22:00:00.000Z"), "2026-10-03T22:00:00.000Z", "inside the open span: still ahead of her");
  assert.equal(clock.deferredInstant(c, "2026-09-28T12:00:00.000Z"), "2026-09-28T12:00:00.000Z");
  assert.equal(clock.deferredInstant(c, "2026-10-02T20:00:00.000Z"), "2026-10-02T20:00:00.000Z", "after the span: her calendar caught up");
  assert.equal(clock.deferredInstant(null, inside), inside);
  assert.equal(clock.deferredInstant(undefined, inside), inside);
  assert.equal(clock.deferredInstant(c, "garbage"), "garbage");
});

const tCw = guard(clock, "clockWordsFor");
tCw("clockWordsFor: the scene's own words while held; words equal to the span's prior_time ignored; apart, null", () => {
  const span = clockSpan({ prior_time: "Late, past midnight" });
  const held = storyClock({ spans: [span], real: FRI_1000_NY });
  assert.equal(clock.clockWordsFor({ status: "together", time: "late night" }, held), "late night");
  assert.equal(clock.clockWordsFor({ status: "together", time: "  late,  past midnight " }, held), null, "carried over from the scene before");
  assert.equal(clock.clockWordsFor({ status: "together", time: "x".repeat(61) }, held), null, "over 60 characters");
  assert.equal(clock.clockWordsFor({ status: "together", time: "" }, held), null);
  assert.equal(clock.clockWordsFor({ status: "apart", time: "late night" }, held), null);
  const notHeld = storyClock({ spans: [], real: FRI_1000_NY });
  assert.equal(clock.clockWordsFor({ status: "together", time: "late night" }, notHeld), null);
});

const tHg = guard(clock, "heldGrounding");
tHg("heldGrounding: the snapshot weather; a photo she sent inside the scene wins the outfit and is stamped frozen_at; a meal row inside the span is rewritten to frozen_at", () => {
  const frozenAt = TUE_2100_NY;
  const snapWeather = weatherNow({ temp: 58, words: "light rain", fetchedAt: plusMs(frozenAt, -10 * MIN_MS) });
  const snapOutfit = { text: "black jeans and the grey jacket", from: "log", at: plusMs(frozenAt, -2 * HOUR_MS), rowId: "g_old" };
  const snapMeal = groundingRow({ id: "g_lunch", kind: "meal", note: "a bagel", occurred: "2026-09-29T16:00:00.000Z", created_at: "2026-09-29T16:00:00.000Z" });
  const span = clockSpan({ frozen_at: frozenAt, weather_json: JSON.stringify(snapWeather), outfit_json: JSON.stringify(snapOutfit), today_json: JSON.stringify([snapMeal]) });
  const c = storyClock({ spans: [span], real: FRI_1000_NY });
  const photo = assetRow({ id: "img_in", role: "scene", approval_status: "approved", message_id: "m_photo", prompt: "red dress, hair up, candle light", decided_at: plusMs(frozenAt, HOUR_MS) });
  const unsent = assetRow({ id: "img_owner", role: "scene", approval_status: "approved", message_id: null, prompt: "owner fired it", decided_at: plusMs(frozenAt, 2 * HOUR_MS) });
  const meal = groundingRow({ id: "g_dinner", kind: "meal", note: "shared fries", occurred: plusMs(frozenAt, 3 * HOUR_MS), created_at: plusMs(frozenAt, 3 * HOUR_MS) });
  const before = groundingRow({ id: "g_before", kind: "meal", note: "coffee", occurred: plusMs(frozenAt, -5 * HOUR_MS), created_at: plusMs(frozenAt, -5 * HOUR_MS) });
  const h = clock.heldGrounding(span, { assets: [photo, unsent], rows: [meal, before] }, c);
  assert.equal(h.weather && h.weather.temp, 58, "the snapshot weather");
  assert.ok(h.outfit, "an outfit");
  assert.equal(h.outfit.text, "red dress, hair up, candle light");
  assert.equal(h.outfit.from, "photo");
  assert.equal(h.outfit.at, frozenAt, "stamped frozen_at");
  assert.equal(h.outfit.assetId, "img_in", "a photo fired by the owner never dresses her");
  const notes = h.today.map((r) => r.note);
  assert.ok(notes.includes("a bagel") && notes.includes("shared fries"), JSON.stringify(notes));
  assert.ok(!notes.includes("coffee"), "a live row from before the span is not added (the snapshot carries the day)");
  const dinner = h.today.find((r) => r.note === "shared fries");
  assert.equal(dinner.occurred, frozenAt, "rewritten to frozen_at");
  const none = clock.heldGrounding(clockSpan({ weather_json: "{not json", outfit_json: null, today_json: null }), { assets: [], rows: [] }, c);
  assert.equal(none.weather, null);
  assert.equal(none.outfit, null);
  assert.deepEqual(none.today, []);
});

const tView = guard(clock, "clockView");
tView("clockView: recent spans newest first with their minutes, running spans measured to real", () => {
  const a = clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: "2026-10-01T10:00:00.000Z", resumed_at: "2026-10-01T11:30:00.000Z" });
  const b = clockSpan({ id: "sc_v5", opened_version: 5, frozen_at: "2026-10-02T09:00:00.000Z", resumed_at: null, location: "the pier" });
  const v = clock.clockView(storyClock({ spans: [a, b], real: FRI_1000_NY }));
  assert.equal(v.frozen, true);
  assert.equal(v.storyNow, "2026-10-02T09:00:00.000Z");
  assert.deepEqual(v.open, { id: "sc_v5", frozenAt: "2026-10-02T09:00:00.000Z", location: "the pier" });
  assert.deepEqual(v.recent.map((r) => [r.id, r.minutes]), [["sc_v5", 5 * 60], ["sc_v2", 90]]);
});

// ------------------------------------------------------------------ the database half

// A story_clock table in memory for the sync: the close, the claim, the stale delete, the
// collision delete and the INSERT OR IGNORE all act on it, so a second sync reads what the
// first wrote.
function clockTable(initial = []) {
  const rows = initial.map((r) => ({ ...r }));
  const pairs = [
    [/^UPDATE story_clock SET closed_version = \?2, resumed_at = \?3, updated_at = \?4 WHERE id = \?1 AND resumed_at IS NULL/, (b) => {
      const r = rows.find((x) => x.id === b[0] && !x.resumed_at);
      if (!r) return 0;
      r.closed_version = b[1]; r.resumed_at = b[2]; r.updated_at = b[3];
      return 1;
    }],
    [/^UPDATE story_clock SET beats_shifted_at = \?2 WHERE id = \?1 AND beats_shifted_at IS NULL/, (b) => {
      const r = rows.find((x) => x.id === b[0] && !x.beats_shifted_at);
      if (!r) return 0;
      r.beats_shifted_at = b[1];
      return 1;
    }],
    [/^DELETE FROM story_clock WHERE id = \?1 AND resumed_at IS NULL/, (b) => {
      const i = rows.findIndex((x) => x.id === b[0] && !x.resumed_at);
      if (i < 0) return 0;
      rows.splice(i, 1);
      return 1;
    }],
    [/^DELETE FROM story_clock WHERE opened_version = \?1 AND frozen_at != \?2/, (b) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].opened_version === b[0] && rows[i].frozen_at !== b[1]) rows.splice(i, 1);
      return before - rows.length;
    }],
    [/^INSERT OR IGNORE INTO story_clock/, (b) => {
      if (rows.some((x) => x.id === b[0] || x.opened_version === b[1])) return 0;
      rows.push(clockSpan({ id: b[0], opened_version: b[1], frozen_at: b[2], location: b[3], weather_json: b[4], outfit_json: b[5], today_json: b[6], prior_time: b[7], created_at: b[8], updated_at: b[9] }));
      return 1;
    }],
  ];
  return { rows, pairs };
}

function syncDb(versions, table, extra = []) {
  return scriptedD1([...table.pairs, ...extra, ...clockScript(versions, table.rows)]);
}

const audits = (db) => db.log.filter((e) => /INSERT INTO audit_events/.test(e.sql)).map((e) => e.binds[2]);
const NOW_SYNC = at("2026-09-30T12:00:00.000Z");
const V1 = "2026-09-29T20:00:00.000Z";
const V2 = "2026-09-29T21:00:00.000Z";
const V3 = "2026-09-29T22:00:00.000Z";
const V4 = "2026-09-29T23:00:00.000Z";

tSync("syncStoryClock (A): a span open and the record still together with no break writes nothing", async () => {
  const versions = [sceneVersion(1, "apart", V1), sceneVersion(2, "together", V2, "the pier"), sceneVersion(3, "together", V3, "the pier")];
  const table = clockTable([clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: V2 })]);
  const db = syncDb(versions, table);
  const r = await clock.syncStoryClock(db, settingsV5(), NOW_SYNC);
  assert.deepEqual(r, { opened: null, closed: null, shifted: 0 });
  assert.deepEqual(db.writes(), []);
});

tSync("syncStoryClock (A): the record left together and came back: the old span closes at the first non-together version and a new one opens at the run start", async () => {
  const versions = [sceneVersion(1, "apart", V1), sceneVersion(2, "together", V2, "the pier"), sceneVersion(3, "apart", V3), sceneVersion(4, "together", V4, "her kitchen")];
  const table = clockTable([clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: V2 })]);
  const db = syncDb(versions, table);
  const r = await clock.syncStoryClock(db, settingsV5(), NOW_SYNC);
  assert.equal(r.closed, "sc_v2");
  assert.equal(r.opened, "sc_v4");
  const old = table.rows.find((x) => x.id === "sc_v2");
  assert.equal(old.closed_version, 3);
  assert.equal(old.resumed_at, V3);
  const fresh = table.rows.find((x) => x.id === "sc_v4");
  assert.equal(fresh.frozen_at, V4);
  assert.equal(fresh.location, "her kitchen");
  assert.deepEqual(audits(db), ["clock.resume", "clock.freeze"]);
});

tSync("syncStoryClock (B): together and no span: one DELETE ... frozen_at != ?2 then one INSERT OR IGNORE with the run start's created_at, location and prior_time; the snapshot weather read is bounded by frozen_at + CACHE_FRESH_MS", async () => {
  const versions = [sceneVersion(1, "apart", V1, null, "late, past midnight"), sceneVersion(2, "together", V2, "the harbour bench"), sceneVersion(3, "together", V3, "the harbour bench")];
  const table = clockTable([]);
  const db = syncDb(versions, table);
  const r = await clock.syncStoryClock(db, settingsV5(), NOW_SYNC);
  assert.equal(r.opened, "sc_v2");
  const batch = db.log.filter((e) => e.via === "batch" && /story_clock/.test(e.sql));
  assert.ok(/^DELETE FROM story_clock WHERE opened_version = \?1 AND frozen_at != \?2/.test(batch[0].sql), batch[0].sql);
  assert.deepEqual(batch[0].binds, [2, V2]);
  assert.ok(/^INSERT OR IGNORE INTO story_clock/.test(batch[1].sql));
  assert.equal(batch[1].binds[0], "sc_v2");
  const span = table.rows[0];
  assert.equal(span.frozen_at, V2);
  assert.equal(span.location, "the harbour bench");
  assert.equal(span.prior_time, "late, past midnight");
  assert.equal(span.resumed_at, null);
  const weatherRead = db.log.find((e) => /FROM weather_cache/.test(e.sql));
  assert.ok(weatherRead, "the snapshot reads the weather cache (never the network)");
  const fresh = (await loadSrcIfPresent("weather"))?.CACHE_FRESH_MS ?? 20 * MIN_MS;
  assert.ok(weatherRead.binds.includes(plusMs(V2, fresh)), "upper bound frozen_at + CACHE_FRESH_MS: " + JSON.stringify(weatherRead.binds));
  assert.ok(weatherRead.binds.includes(plusMs(V2, -clock.SNAPSHOT_WEATHER_MAX_AGE_MS)), "lower bound frozen_at - 3 hours");
  assert.deepEqual(audits(db), ["clock.freeze"]);
  const again = syncDb(versions, table);
  await clock.syncStoryClock(again, settingsV5(), NOW_SYNC);
  assert.deepEqual(again.writes(), [], "a second sync of the same run writes nothing");
});

tSync("syncStoryClock (C): apart with a span open: the close, the beats_shifted_at claim, the shift statements and the clock.resume audit in one batch; a second sync writes nothing", async () => {
  const versions = [sceneVersion(1, "apart", V1), sceneVersion(2, "together", V2, "the pier"), sceneVersion(3, "apart", V3)];
  const table = clockTable([clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: V2 })]);
  const due = plusMs(V2, 30 * MIN_MS);
  const runs = [{ id: "br_1", due_at: due, title: "the open mic", want_id: "w_1" }];
  const db = syncDb(versions, table, [[/FROM beat_runs r JOIN arc_beats b/, (b) => runs.filter((x) => x.due_at > b[0] && x.due_at <= b[1])]]);
  const r = await clock.syncStoryClock(db, settingsV5(), NOW_SYNC);
  assert.equal(r.closed, "sc_v2");
  assert.equal(r.shifted, 1);
  const iClose = db.log.findIndex((e) => /^UPDATE story_clock SET closed_version/.test(e.sql));
  const iClaim = db.log.findIndex((e) => /^UPDATE story_clock SET beats_shifted_at/.test(e.sql));
  assert.ok(iClose >= 0 && iClaim > iClose, "the close, then the claim");
  const batch = db.log.filter((e) => e.via === "batch");
  assert.ok(batch.some((e) => /^UPDATE beat_runs SET due_at/.test(e.sql)), "the shift in the batch");
  assert.ok(batch.some((e) => /^INSERT INTO want_log/.test(e.sql)), "its note in the batch");
  assert.ok(batch.some((e) => /INSERT INTO audit_events/.test(e.sql) && e.binds[2] === "clock.resume"), "the audit in the same batch");
  const shift = batch.find((e) => /^UPDATE beat_runs SET due_at/.test(e.sql));
  assert.equal(shift.binds[1], plusMs(V3, 30 * MIN_MS), "moved to resumed_at + (due_at - frozen_at)");
  const again = syncDb(versions, table);
  await clock.syncStoryClock(again, settingsV5(), NOW_SYNC);
  assert.deepEqual(again.writes(), [], "closed once");
});

tSync("syncStoryClock (D): apart and no span writes nothing; no scene rows at all writes nothing", async () => {
  const table = clockTable([]);
  const db = syncDb([sceneVersion(1, "apart", V1), sceneVersion(2, "none", V2)], table);
  assert.deepEqual(await clock.syncStoryClock(db, settingsV5(), NOW_SYNC), { opened: null, closed: null, shifted: 0 });
  assert.deepEqual(db.writes(), []);
  const empty = syncDb([], clockTable([]));
  await clock.syncStoryClock(empty, settingsV5(), NOW_SYNC);
  assert.deepEqual(empty.writes(), []);
});

tSync("syncStoryClock stale guard: an open span whose opening version is missing, is not together, or has another created_at is deleted with a clock.stale audit, then case B", async () => {
  const cases = [
    ["missing", [sceneVersion(1, "apart", V1), sceneVersion(3, "together", V3, "the pier")]],
    ["not together", [sceneVersion(1, "apart", V1), sceneVersion(2, "apart", V2), sceneVersion(3, "together", V3, "the pier")]],
    ["another created_at", [sceneVersion(1, "apart", V1), sceneVersion(2, "together", "2026-09-01T00:00:00.000Z"), sceneVersion(3, "together", V3, "the pier")]],
  ];
  for (const [why, versions] of cases) {
    const stale = clockSpan({ id: "sc_v2", opened_version: 2, frozen_at: V2 });
    const table = clockTable([stale]);
    const db = syncDb(versions, table);
    const r = await clock.syncStoryClock(db, settingsV5(), NOW_SYNC);
    const del = db.log.find((e) => /^DELETE FROM story_clock WHERE id = \?1 AND resumed_at IS NULL/.test(e.sql));
    assert.ok(del && del.binds[0] === "sc_v2", why + ": the stale span deleted");
    assert.ok(audits(db).includes("clock.stale"), why + ": audited");
    assert.ok(!table.rows.some((x) => x.id === "sc_v2" && x.frozen_at === V2), why);
    assert.ok(r.opened, why + ": case B opened the current run: " + JSON.stringify(r));
  }
});

tSync("syncStoryClock id collision: a closed stale sc_v7 with another frozen_at and a new together run starting at version 7: the stale row deleted, the new span inserted", async () => {
  const V7 = "2026-09-30T10:00:00.000Z";
  const stale = clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: "2026-09-10T10:00:00.000Z", resumed_at: "2026-09-10T12:00:00.000Z", closed_version: 8 });
  const table = clockTable([stale]);
  const versions = [sceneVersion(6, "apart", "2026-09-30T09:00:00.000Z"), sceneVersion(7, "together", V7, "the pier")];
  const db = syncDb(versions, table);
  const r = await clock.syncStoryClock(db, settingsV5(), NOW_SYNC);
  assert.equal(r.opened, "sc_v7");
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].frozen_at, V7);
  assert.equal(table.rows[0].resumed_at, null);
});

const tLoad = guard(clock, "loadStoryClock", "lastExchange", "holdWeatherStmt");
tLoad("loadStoryClock: off writes nothing and answers a disabled clock; a failed read answers a disabled clock and never throws", async () => {
  const db = scriptedD1([]);
  const off = await clock.loadStoryClock(db, settingsV5({ storyClockEnabled: false }), at(FRI_1000_NY));
  assert.equal(off.enabled, false);
  assert.deepEqual(db.log, []);
  const broken = { prepare() { throw new Error("no such table: story_clock"); }, batch: async () => { throw new Error("x"); } };
  const c = await clock.loadStoryClock(broken, settingsV5(), at(FRI_1000_NY));
  assert.equal(c.enabled, false);
  assert.equal(c.real, FRI_1000_NY);
});

tLoad("lastExchange reads across every conversation, skips the pending row and answers his, hers and the last", async () => {
  const rows = [
    { id: "m3", role: "assistant", created_at: "2026-10-02T13:00:00.000Z" },
    { id: "m2", role: "user", created_at: "2026-10-02T12:00:00.000Z" },
  ];
  const db = scriptedD1([[/FROM messages WHERE channel = 'story'/, rows]]);
  const last = await clock.lastExchange(db, "m_pending", at(FRI_1000_NY));
  assert.deepEqual(last, { hisAt: "2026-10-02T12:00:00.000Z", herAt: "2026-10-02T13:00:00.000Z", lastAt: "2026-10-02T13:00:00.000Z" });
  const read = db.log[0];
  assert.ok(!/conversation_id = /.test(read.sql), "every conversation: she is one person");
  assert.deepEqual(read.binds, [FRI_1000_NY, "m_pending"]);
  const none = await clock.lastExchange(scriptedD1([]), null, at(FRI_1000_NY));
  assert.deepEqual(none, { hisAt: null, herAt: null, lastAt: null });
});

tLoad("holdWeatherStmt writes the weather only when the span has none", () => {
  const db = scriptedD1([]);
  const s = clock.holdWeatherStmt(db, "sc_v2", weatherNow());
  assert.ok(/UPDATE story_clock SET weather_json = \?2, updated_at = \?3 WHERE id = \?1 AND weather_json IS NULL/.test(s.sql));
  assert.equal(s.binds[0], "sc_v2");
});

const tShift = guard(clock, "shiftBeatsForSpan");
tShift("shiftBeatsForSpan: a 5-hour span from 15:00 with an open mic due at 20:00 inside moves it to resumed_at plus 5 hours exactly with one want_log note; after, before, resolved runs and an empty span move nothing", async () => {
  const frozenAt = "2026-09-29T19:00:00.000Z"; // Tuesday 3:00pm
  const resumedAt = "2026-09-30T00:00:00.000Z"; // Tuesday 8:00pm
  const all = [
    { id: "br_in", due_at: "2026-09-30T00:00:00.000Z", title: "the open mic", want_id: "w_sing", status: "pending", beat: "active" },
    { id: "br_after", due_at: "2026-09-30T01:00:00.000Z", title: "later thing", want_id: "w_sing", status: "pending", beat: "active" },
    { id: "br_before", due_at: "2026-09-29T18:00:00.000Z", title: "earlier thing", want_id: "w_sing", status: "pending", beat: "active" },
    { id: "br_done", due_at: "2026-09-29T20:00:00.000Z", title: "done thing", want_id: "w_sing", status: "resolved", beat: "active" },
  ];
  const db = scriptedD1([[/FROM beat_runs r JOIN arc_beats b/, (b) => all.filter((r) => ["pending", "proposed"].includes(r.status) && r.beat === "active" && r.due_at > b[0] && r.due_at <= b[1])]]);
  const stmts = await clock.shiftBeatsForSpan(db, { frozenAt, resumedAt }, TZ);
  const read = db.log[0];
  assert.ok(/r\.status IN \('pending','proposed'\)/.test(read.sql) && /b\.status = 'active'/.test(read.sql) && /r\.due_at > \?1 AND r\.due_at <= \?2/.test(read.sql), read.sql);
  assert.deepEqual(read.binds.slice(0, 2), [frozenAt, resumedAt]);
  assert.equal(stmts.length, 2, "one run moved: its update and its note");
  const [upd, note] = stmts;
  assert.ok(/^UPDATE beat_runs SET due_at = \?2, shifted_ms = shifted_ms \+ \?3/.test(upd.sql));
  assert.equal(upd.binds[0], "br_in");
  assert.equal(upd.binds[1], plusMs(resumedAt, 5 * HOUR_MS), "resumed_at + 5 hours exactly");
  assert.equal(upd.binds[2], 5 * HOUR_MS, "shifted_ms grows by the span");
  assert.ok(/^INSERT INTO want_log/.test(note.sql) && /'note'/.test(note.sql) && /'clock'/.test(note.sql));
  assert.equal(note.binds[1], "w_sing");
  assert.equal(note.binds[2], resumedAt, "occurred at the resume");
  assert.ok(/^the open mic: moved to Wednesday 1:00am$/.test(note.binds[3]), note.binds[3]);
  const empty = await clock.shiftBeatsForSpan(scriptedD1([]), { frozenAt, resumedAt }, TZ);
  assert.deepEqual(empty, []);
  const behind = { prepare() { throw new Error("no such table: beat_runs"); } };
  assert.deepEqual(await clock.shiftBeatsForSpan(behind, { frozenAt, resumedAt }, TZ), [], "a database behind 0009 answers []");
});

test("clock.ts imports neither prompt.ts, wants.ts, arcs.ts, callbacks.ts nor memory.ts (no cycle)", async () => {
  const { repoText } = await import("./helpers_v5.mjs");
  const src = repoText("src/clock.ts");
  if (!src) return;
  for (const m of ["prompt", "wants", "arcs", "callbacks", "memory"]) assert.ok(!new RegExp(`from "\\./${m}"`).test(src), m);
  assert.ok(!BAD_TYPOGRAPHY.test(src));
});
