// src/lockscreen.ts (DESIGN_EXPERIENCE 8.4 and 8.5): the daily wallpaper and her lock screen.
// Beats made the way createBeat makes them (the beat and its pending run in one batch); the
// notifications are lines of the record, never invented; the held story clock holds the lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, relationshipState } from "./helpers.mjs";
import { fakeDb, messageRow, secretEnv } from "./helpers_v2.mjs";
import { assetRow, wantRow } from "./helpers_v3.mjs";
import { TZ, FRI_1000_NY, TUE_2100_NY, HOUR_MS, plusMs, beatView, clockSpan, storyClock, settingsV5 } from "./helpers_v5.mjs";

const lock = await loadSrc("lockscreen");

const FALLBACK = { id: "master-05", file: "images/masters/05.png", focus: [50, 24] };
const NOW = new Date(FRI_1000_NY); // Friday 2026-10-02 10:00am New York

// ------------------------------------------------------------------ the wallpaper

test("fnv1a32: the 32-bit FNV-1a offset basis for the empty string, the known value for 'a'", () => {
  assert.equal(lock.fnv1a32(""), 2166136261);
  assert.equal(lock.fnv1a32("a"), 0xe40c292c);
  assert.equal(lock.fnv1a32("2026-09-26"), lock.fnv1a32("2026-09-26"));
});

test("pickWallpaper: the master with its focus when she has no photo; else the photo at fnv1a32(day) % n of the newest-first list, the same all day, not the same every day", () => {
  const master = lock.pickWallpaper("2026-09-26", [], FALLBACK);
  assert.deepEqual(master, { kind: "master", id: "master-05", url: "/images/masters/05.png", focus: [50, 24], day: "2026-09-26" });
  const photos = [
    { id: "img_c", created_at: "2026-09-25T12:00:00.000Z" },
    { id: "img_a", created_at: "2026-09-26T12:00:00.000Z" },
    { id: "img_b", created_at: "2026-09-25T18:00:00.000Z" },
  ];
  const newest = ["img_a", "img_b", "img_c"];
  const picks = new Set();
  for (let d = 1; d <= 30; d++) {
    const day = "2026-09-" + String(d).padStart(2, "0");
    const w = lock.pickWallpaper(day, photos, FALLBACK);
    assert.equal(w.kind, "photo");
    assert.equal(w.id, newest[lock.fnv1a32(day) % 3], day);
    assert.equal(w.url, "/media/" + w.id);
    assert.equal(w.focus, null);
    assert.equal(w.day, day);
    assert.deepEqual(lock.pickWallpaper(day, [...photos].reverse(), FALLBACK), w, "deterministic whatever the input order");
    picks.add(w.id);
  }
  assert.ok(picks.size > 1, "a different picture on different days");
  assert.equal(lock.pickWallpaper("2026-09-26", [photos[0]], FALLBACK).id, "img_c", "one photo: always it");
});

test("wallpaperNow: her approved solo photos with bytes (never with him, never a candidate, never a byte-less row), the day on the real clock in her timezone", async () => {
  const db = fakeDb({
    visual_assets: [
      { ...assetRow({ id: "img_solo", created_at: "2026-09-26T12:00:00.000Z" }), with_him: 0 },
      { ...assetRow({ id: "img_us", created_at: "2026-09-26T13:00:00.000Z" }), with_him: 1 },
      { ...assetRow({ id: "img_cand", approval_status: "candidate", role: "candidate", created_at: "2026-09-26T14:00:00.000Z" }), with_him: 0 },
      { ...assetRow({ id: "img_nobytes", bytes: null, created_at: "2026-09-26T15:00:00.000Z" }), with_him: 0 },
      { ...assetRow({ id: "vid_1", role: "video", created_at: "2026-09-26T16:00:00.000Z" }), with_him: 0 },
    ],
  });
  const w = await lock.wallpaperNow(db, settingsV5({ timezone: TZ }), new Date("2026-09-27T03:00:00.000Z"), FALLBACK);
  assert.equal(w.kind, "photo");
  assert.equal(w.id, "img_solo");
  assert.equal(w.day, "2026-09-26", "11pm in New York is still the 26th");
  const none = await lock.wallpaperNow(fakeDb({ visual_assets: [] }), settingsV5({ timezone: TZ }), NOW, FALLBACK);
  assert.equal(none.kind, "master");
});

// ------------------------------------------------------------------ beats and day words

test("upcomingBeats: a beat made with its pending run IS listed with the run's due_at (a shift included); a proposed or resolved run is not; soonest first; the local day of dueAt", () => {
  const shifted = beatView({ beat: { id: "ab_shift", due_at: "2026-10-02T00:00:00.000Z" }, run: { due_at: "2026-10-02T02:00:00.000Z", shifted_ms: 2 * HOUR_MS } });
  const pending = beatView({ beat: { id: "ab_pend", want_id: "w2", title: "sign up at the bar", due_at: "2026-10-01T16:00:00.000Z" } });
  const proposed = beatView({ beat: { id: "ab_prop", due_at: "2026-10-01T17:00:00.000Z" }, run: { status: "proposed" } });
  const resolved = beatView({ beat: { id: "ab_res", due_at: "2026-10-01T18:00:00.000Z" }, run: { status: "resolved", outcome: "went" } });
  const noRun = beatView({ beat: { id: "ab_norun", due_at: "2026-10-03T16:00:00.000Z" }, run: null });
  const list = lock.upcomingBeats([shifted, noRun, proposed, pending, resolved], TZ);
  assert.deepEqual(list.map((b) => b.id), ["ab_pend", "ab_shift", "ab_norun"]);
  const s = list.find((b) => b.id === "ab_shift");
  assert.equal(s.dueAt, "2026-10-02T02:00:00.000Z", "from the run, shift included");
  assert.equal(s.dueOn, "2026-10-01", "10pm New York on the 1st");
  assert.equal(s.wantId, "w_test");
  const p = list.find((b) => b.id === "ab_pend");
  assert.deepEqual(p, { id: "ab_pend", wantId: "w2", title: "sign up at the bar", dueOn: "2026-10-01", dueAt: "2026-10-01T16:00:00.000Z" });
  assert.equal(list.find((b) => b.id === "ab_norun").dueAt, "2026-10-03T16:00:00.000Z", "no run: the beat's own due_at");
  assert.deepEqual(lock.upcomingBeats([], TZ), []);
});

test("dayWord: Today, Tomorrow, the weekday 2 to 6 days ahead, else the short date", () => {
  const today = "2026-10-02"; // Friday
  assert.equal(lock.dayWord("2026-10-02", today), "Today");
  assert.equal(lock.dayWord("2026-10-03", today), "Tomorrow");
  assert.equal(lock.dayWord("2026-10-04", today), "Sunday");
  assert.equal(lock.dayWord("2026-10-08", today), "Thursday");
  assert.equal(lock.dayWord("2026-10-09", today), "Oct 9");
  assert.equal(lock.dayWord("2026-10-01", today), "Oct 1", "a day already gone is its date");
  assert.equal(lock.dayWord("2026-12-31", "2026-12-30"), "Tomorrow", "across a month");
  assert.equal(lock.dayWord("2027-01-01", "2026-12-31"), "Tomorrow", "across a year");
});

// ------------------------------------------------------------------ notifications

const beat = (id, dueAt, title = "the open mic") => ({ id, wantId: "w_test", title, dueOn: new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(dueAt)), dueAt });

test("lockNotes: his last text within 48 h titled with his name (untitled without it); outside 48 h, or no message, nothing; nothing invented", () => {
  const his = { id: "m1", text: "see ya\ntomorrow   starbrite", at: plusMs(FRI_1000_NY, -3 * HOUR_MS) };
  const one = lock.lockNotes({ now: NOW, tz: TZ, his, hisName: " Justin ", song: null, beats: [] });
  assert.deepEqual(one, [{ id: "msg:m1", app: "messages", title: "Justin", text: "see ya tomorrow starbrite", at: his.at }]);
  const untitled = lock.lockNotes({ now: NOW, tz: TZ, his, hisName: null, song: null, beats: [] });
  assert.equal(untitled[0].title, "");
  const old = lock.lockNotes({ now: NOW, tz: TZ, his: { ...his, at: plusMs(FRI_1000_NY, -49 * HOUR_MS) }, hisName: "Justin", song: null, beats: [] });
  assert.deepEqual(old, []);
  assert.deepEqual(lock.lockNotes({ now: NOW, tz: TZ, his: null, hisName: "Justin", song: null, beats: [] }), []);
  const long = lock.lockNotes({ now: NOW, tz: TZ, his: { ...his, text: "word ".repeat(60) }, hisName: "Justin", song: null, beats: [] });
  assert.ok(long[0].text.length <= 160 && long[0].text.endsWith("..."), long[0].text);
});

test("lockNotes: the song she sent within 72 h (the title, the artist); outside it nothing", () => {
  const song = { messageId: "m_song", artist: "Some Artist", title: "Some Title", at: plusMs(FRI_1000_NY, -71 * HOUR_MS) };
  assert.deepEqual(lock.lockNotes({ now: NOW, tz: TZ, his: null, hisName: null, song, beats: [] }), [{ id: "song:m_song", app: "music", title: "Some Title", text: "Some Artist", at: song.at }]);
  assert.deepEqual(lock.lockNotes({ now: NOW, tz: TZ, his: null, hisName: null, song: { ...song, at: plusMs(FRI_1000_NY, -73 * HOUR_MS) }, beats: [] }), []);
});

test("lockNotes: calendar first (soonest, at most two, today or the next two days, a past one left out), then the rest newest first; at most four; no other app", () => {
  const beats = [
    beat("b_past", "2026-10-02T12:00:00.000Z", "coffee with Mara"), // Fri 8am: already past at 10am
    beat("b_tonight", "2026-10-03T00:00:00.000Z", "the open mic"), // Fri 8pm
    beat("b_sat", "2026-10-03T16:00:00.000Z", "record store shift"), // Sat noon
    beat("b_sun", "2026-10-04T16:00:00.000Z", "laundry"), // Sun
    beat("b_mon", "2026-10-05T16:00:00.000Z", "too far"), // Mon: outside the window
  ];
  const his = { id: "m1", text: "hey", at: plusMs(FRI_1000_NY, -1 * HOUR_MS) };
  const song = { messageId: "m_song", artist: "Some Artist", title: "Some Title", at: plusMs(FRI_1000_NY, -2 * HOUR_MS) };
  const notes = lock.lockNotes({ now: NOW, tz: TZ, his, hisName: "Justin", song, beats });
  assert.deepEqual(notes.map((n) => n.id), ["beat:b_tonight", "beat:b_sat", "msg:m1", "song:m_song"]);
  assert.deepEqual(notes[0], { id: "beat:b_tonight", app: "calendar", title: "Today", text: "the open mic", at: "2026-10-03T00:00:00.000Z" });
  assert.equal(notes[1].title, "Tomorrow");
  assert.ok(notes.every((n) => ["messages", "music", "calendar"].includes(n.app)));
  const onlyCal = lock.lockNotes({ now: NOW, tz: TZ, his: null, hisName: null, song: null, beats: [beats[3], beats[1]] });
  assert.deepEqual(onlyCal.map((n) => [n.id, n.title]), [["beat:b_tonight", "Today"], ["beat:b_sun", "Sunday"]], "sorted soonest first whatever the input order");
  const many = lock.lockNotes({ now: NOW, tz: TZ, his, hisName: "Justin", song, beats: [beats[1], beats[2], beats[3]] });
  assert.equal(many.length, 4, "at most four");
  assert.equal(many.filter((n) => n.app === "calendar").length, 2, "at most two calendar entries");
});

// ------------------------------------------------------------------ the lock

function rollItem(id, extra = {}) {
  return { id, kind: "photo", url: "/media/" + id, poster: null, at: "2026-10-01T12:00:00.000Z", place: null, us: false, conversationId: null, messageId: null, ...extra };
}

test("lockScreenFrom: a held story clock answers frozen true and the frozen instant as now (time, date and day words on it); the roll has no us item and no posterless clip, at most six", () => {
  const clock = storyClock({ spans: [clockSpan({ frozen_at: TUE_2100_NY })], real: FRI_1000_NY });
  const wallpaper = lock.pickWallpaper("2026-10-02", [], FALLBACK);
  const roll = [
    rollItem("r1"), rollItem("r_us", { us: true }), rollItem("r_clip", { kind: "clip", poster: null }), rollItem("r_clip2", { kind: "clip", poster: "/media/r1" }),
    rollItem("r2"), rollItem("r3"), rollItem("r4"), rollItem("r5"), rollItem("r6"),
  ];
  const screen = lock.lockScreenFrom({
    clock,
    tz: TZ,
    weather: { temp: 67.6, units: "fahrenheit", words: "clear" },
    wallpaper,
    his: null,
    hisName: "Justin",
    song: null,
    beats: [beat("b_wed", "2026-09-30T23:00:00.000Z", "sign up at the bar")], // Wed 7pm: Tomorrow from Tuesday
    roll,
    wants: [{ id: "w_test", title: "sing at an open mic" }, { id: "w_other", title: "finish the bridge" }],
  });
  assert.deepEqual(Object.keys(screen).sort(), ["dateLine", "frozen", "notes", "now", "roll", "time", "tz", "wallpaper", "wants", "weather"]);
  assert.equal(screen.frozen, true);
  assert.equal(screen.now, TUE_2100_NY);
  assert.equal(screen.time, "9:00");
  assert.equal(screen.dateLine, "Tuesday, September 29");
  assert.equal(screen.tz, TZ);
  assert.deepEqual(screen.weather, { temp: 68, units: "fahrenheit", words: "clear" });
  assert.deepEqual(screen.roll.map((i) => i.id), ["r1", "r_clip2", "r2", "r3", "r4", "r5"]);
  assert.ok(!screen.roll.some((i) => i.us));
  assert.deepEqual(screen.wants, [
    { id: "w_test", title: "sing at an open mic", next: { title: "sign up at the bar", dueOn: "2026-09-30", day: "Tomorrow" } },
    { id: "w_other", title: "finish the bridge", next: null },
  ]);
  assert.deepEqual(screen.notes.map((n) => [n.app, n.title]), [["calendar", "Tomorrow"]], "the day words follow the held clock");
  assert.equal(screen.wallpaper, wallpaper);

  const running = lock.lockScreenFrom({ clock: storyClock({ real: FRI_1000_NY }), tz: TZ, weather: null, wallpaper, his: null, hisName: null, song: null, beats: [], roll: [], wants: [] });
  assert.equal(running.frozen, false);
  assert.equal(running.now, FRI_1000_NY);
  assert.equal(running.time, "10:00");
  assert.equal(running.dateLine, "Friday, October 2");
  assert.equal(running.weather, null);
  assert.deepEqual(running.notes, []);
  const celsius = lock.lockScreenFrom({ clock: storyClock({ real: FRI_1000_NY }), tz: TZ, weather: { temp: 19.4, units: "celsius", words: "rain" }, wallpaper, his: null, hisName: null, song: null, beats: [], roll: [], wants: [] });
  assert.deepEqual(celsius.weather, { temp: 19, units: "celsius", words: "rain" });
});

test("lockScreen on the D1 stand-in: the reads it makes land (his last text under his name, the song, the roll) and it writes nothing", async () => {
  const realNow = new Date(FRI_1000_NY);
  const db = fakeDb({
    conversations: [{ id: "c1", title: null, created_at: "2026-10-01T00:00:00.000Z", last_message_at: null, status: "active" }],
    messages: [
      messageRow({ id: "m_his_old", conversation_id: "c1", role: "user", content: "older", created_at: plusMs(FRI_1000_NY, -5 * HOUR_MS), seq: 1 }),
      messageRow({ id: "m_his", conversation_id: "c1", role: "user", content: "see ya tomorrow starbrite", created_at: plusMs(FRI_1000_NY, -2 * HOUR_MS), seq: 2 }),
      messageRow({ id: "m_his_photo", conversation_id: "c1", role: "user", content: "   ", created_at: plusMs(FRI_1000_NY, -1 * HOUR_MS), seq: 3 }),
      messageRow({ id: "m_song", conversation_id: "c1", role: "assistant", content: "this one", song_json: JSON.stringify({ artist: "Some Artist", title: "Some Title" }), created_at: plusMs(FRI_1000_NY, -3 * HOUR_MS), seq: 4 }),
    ],
    state_versions: [{ id: "r1", entity: "relationship", version: 3, state_json: JSON.stringify(relationshipState({ his_name: "Justin" })), source: "owner", note: null, created_at: "2026-10-01T00:00:00.000Z" }],
    wants: [wantRow({ id: "w_test", title: "sing at an open mic" })],
    // fix0927 lane B changed this on purpose: the wallpaper and the roll take only a picture
    // she sent (img_1, on her song message); the owner-fired one (message_id null) never.
    visual_assets: [
      { ...assetRow({ id: "img_1", message_id: "m_song", created_at: "2026-10-01T12:00:00.000Z" }), with_him: 0 },
      { ...assetRow({ id: "img_owner", message_id: null, created_at: "2026-10-01T13:00:00.000Z" }), with_him: 0 },
    ],
  });
  const settings = settingsV5({ timezone: TZ, storyClockEnabled: false, weatherProvider: "off" });
  const wallpaper = await lock.wallpaperNow(db, settings, realNow, FALLBACK);
  const screen = await lock.lockScreen(secretEnv(), db, settings, realNow, wallpaper);
  assert.equal(screen.frozen, false);
  assert.equal(screen.now, FRI_1000_NY);
  assert.equal(screen.weather, null);
  assert.equal(screen.wallpaper.id, "img_1");
  assert.deepEqual(screen.notes.map((n) => [n.id, n.title, n.text]), [["msg:m_his", "Justin", "see ya tomorrow starbrite"], ["song:m_song", "Some Title", "Some Artist"]]);
  assert.deepEqual(screen.roll.map((i) => i.id), ["img_1"]);
  assert.deepEqual(screen.wants.map((w) => w.title), ["sing at an open mic"]);
  assert.equal(db.writes.length, 0, "the lock writes no story row");
  assert.ok(!db.queries.some((q) => /\bpeople\b/i.test(q.sql)), "never reads or syncs people");
});
