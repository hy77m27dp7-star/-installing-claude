// fix0927 lane B3: her phone clock was stuck on "Saturday, September 26, 3:27" while they
// kept talking inside a held Together scene. The rule now (Justin: "time can pass on texting
// mode but not together mode... i might quit in the middle of a scene"): inside a held span
// the story time moves WITH THE CONVERSATION (every gap between messages capped at five
// minutes, the tail to now too) and stands still only while he is away. Only the displayed
// and stated time of day moves; every measure of time passing stays held.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import {
  clockSpan, storyClock, scriptedD1, clockScript, sceneVersion, settingsV5,
  TZ, TUE_2100_NY, FRI_1000_NY, MIN_MS, HOUR_MS, DAY_MS, plusMs,
} from "./helpers_v5.mjs";

const clock = await loadSrc("clock");
const lock = await loadSrc("lockscreen");

const at = (iso) => new Date(iso);
const CAP = 5 * MIN_MS;

// ------------------------------------------------------------------ talkMsOf

test("talkMsOf: no messages -> only the tail from the freeze, capped at five minutes", () => {
  assert.equal(clock.TALK_GAP_CAP_MS, CAP);
  assert.equal(clock.talkMsOf([], TUE_2100_NY, plusMs(TUE_2100_NY, 2 * MIN_MS)), 2 * MIN_MS, "two minutes in: two minutes");
  assert.equal(clock.talkMsOf([], TUE_2100_NY, FRI_1000_NY), CAP, "days away: five minutes, no more");
  assert.equal(clock.talkMsOf([], TUE_2100_NY, TUE_2100_NY), 0, "at the freeze: nothing");
  assert.equal(clock.talkMsOf([], TUE_2100_NY, plusMs(TUE_2100_NY, -MIN_MS)), 0, "a real now before the freeze: nothing");
  assert.equal(clock.talkMsOf(null, TUE_2100_NY, FRI_1000_NY), CAP, "not a list: no messages");
  assert.equal(clock.talkMsOf([], "not a time", FRI_1000_NY), 0);
  assert.equal(clock.talkMsOf([], TUE_2100_NY, "not a time"), 0);
});

test("talkMsOf: several short gaps count in full, whatever the input order; the tail counts to the real now", () => {
  const stamps = [plusMs(TUE_2100_NY, 3 * MIN_MS), plusMs(TUE_2100_NY, 1 * MIN_MS), plusMs(TUE_2100_NY, 4 * MIN_MS)];
  const real = plusMs(TUE_2100_NY, 6 * MIN_MS);
  assert.equal(clock.talkMsOf(stamps, TUE_2100_NY, real), 6 * MIN_MS, "1 + 2 + 1 + a tail of 2");
  assert.equal(clock.talkMsOf([...stamps].reverse(), TUE_2100_NY, real), 6 * MIN_MS);
});

test("talkMsOf: one long gap is capped at five minutes; a custom cap is honoured", () => {
  const stamps = [plusMs(TUE_2100_NY, 1 * MIN_MS), plusMs(TUE_2100_NY, 2 * HOUR_MS), plusMs(TUE_2100_NY, 2 * HOUR_MS + 2 * MIN_MS)];
  const real = plusMs(TUE_2100_NY, 2 * HOUR_MS + 3 * MIN_MS);
  // 1 (to the first) + 5 (the two-hour gap, capped) + 2 + a tail of 1
  assert.equal(clock.talkMsOf(stamps, TUE_2100_NY, real), 9 * MIN_MS);
  assert.equal(clock.talkMsOf(stamps, TUE_2100_NY, real, 10 * MIN_MS), 14 * MIN_MS, "a ten-minute cap: 1 + 10 + 2 + 1");
});

test("talkMsOf: the tail after the last message is capped too (he went away mid-scene)", () => {
  const stamps = [plusMs(TUE_2100_NY, 2 * MIN_MS), plusMs(TUE_2100_NY, 4 * MIN_MS)];
  assert.equal(clock.talkMsOf(stamps, TUE_2100_NY, FRI_1000_NY), 4 * MIN_MS + CAP, "2 + 2 + a tail capped at 5");
});

test("talkMsOf: stamps before the freeze, after the real now or unreadable are ignored", () => {
  const real = plusMs(TUE_2100_NY, 3 * MIN_MS);
  const stamps = [plusMs(TUE_2100_NY, -30 * MIN_MS), plusMs(TUE_2100_NY, -MIN_MS), "garbage", null, plusMs(TUE_2100_NY, 2 * MIN_MS), plusMs(real, MIN_MS)];
  assert.equal(clock.talkMsOf(stamps, TUE_2100_NY, real), 3 * MIN_MS, "2 to the one inside + a tail of 1");
  assert.equal(clock.talkMsOf([plusMs(TUE_2100_NY, -MIN_MS)], TUE_2100_NY, FRI_1000_NY), CAP, "only a stamp before the freeze: the tail alone");
});

// ------------------------------------------------------------------ storyNow and heldNow

test("storyNow with talkMs: frozen_at plus the talk inside an open span; heldNow stays frozen_at; a clock without talkMs holds as before", () => {
  const span = clockSpan({ frozen_at: TUE_2100_NY });
  const held = storyClock({ spans: [span], real: FRI_1000_NY });
  assert.equal(clock.storyNow(held).toISOString(), TUE_2100_NY, "no talkMs: exactly as before");
  const talked = { ...held, talkMs: 47 * MIN_MS };
  assert.equal(clock.storyNow(talked).toISOString(), plusMs(TUE_2100_NY, 47 * MIN_MS));
  assert.equal(clock.heldNow(talked).toISOString(), TUE_2100_NY);
  assert.equal(clock.storyNow({ ...held, talkMs: 0 }).toISOString(), TUE_2100_NY);
  assert.equal(clock.storyNow({ ...held, talkMs: -5 }).toISOString(), TUE_2100_NY, "a negative talk reads 0");
  assert.equal(clock.storyNow({ ...held, talkMs: Number.NaN }).toISOString(), TUE_2100_NY);
  const apart = { ...storyClock({ spans: [], real: FRI_1000_NY }), talkMs: HOUR_MS };
  assert.equal(clock.storyNow(apart).toISOString(), FRI_1000_NY, "no open span: the real now, talk or not");
  const off = { ...storyClock({ spans: [span], real: FRI_1000_NY, enabled: false }), talkMs: HOUR_MS };
  assert.equal(clock.storyNow(off).toISOString(), FRI_1000_NY, "a disabled clock: the real now");
  assert.equal(clock.clockView(talked).storyNow, plusMs(TUE_2100_NY, 47 * MIN_MS), "the clock view shows the moving time");
});

test("storyNow never runs past the real now", () => {
  const real = plusMs(TUE_2100_NY, 10 * MIN_MS);
  const c = { ...storyClock({ spans: [clockSpan({ frozen_at: TUE_2100_NY })], real }), talkMs: 3 * HOUR_MS };
  assert.equal(clock.storyNow(c).toISOString(), real);
  assert.ok(clock.storyNow(c).getTime() <= Date.parse(c.real));
});

test("talkMs moves ONLY the time of day: storyElapsedMs, the overlap, story age, the story instant, the deferred instant, the story window and TIME SINCE are unchanged", () => {
  const open = clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: TUE_2100_NY });
  const closed = clockSpan({ id: "sc_v3", opened_version: 3, frozen_at: "2026-09-20T01:00:00.000Z", resumed_at: "2026-09-21T01:00:00.000Z", closed_version: 4 });
  const base = storyClock({ spans: [closed, open], real: FRI_1000_NY });
  const talked = { ...base, talkMs: 40 * MIN_MS };
  const his = plusMs(TUE_2100_NY, -2 * MIN_MS);
  assert.equal(clock.storyElapsedMs(talked, his), clock.storyElapsedMs(base, his));
  assert.equal(clock.storyElapsedMs(talked, his), 2 * MIN_MS, "held time is still not time");
  assert.equal(clock.storyElapsedMs(talked, "2026-09-19T00:00:00.000Z"), clock.storyElapsedMs(base, "2026-09-19T00:00:00.000Z"));
  assert.equal(clock.frozenOverlapMs(talked.spans, Date.parse(TUE_2100_NY), Date.parse(FRI_1000_NY), Date.parse(FRI_1000_NY)), Date.parse(FRI_1000_NY) - Date.parse(TUE_2100_NY));
  assert.equal(clock.storyAgeDays(talked, "2026-09-25T00:00:00.000Z"), clock.storyAgeDays(base, "2026-09-25T00:00:00.000Z"));
  const inside = plusMs(TUE_2100_NY, 5 * HOUR_MS);
  assert.equal(clock.storyInstantOf(talked, inside).toISOString(), clock.storyInstantOf(base, inside).toISOString());
  assert.equal(clock.storyInstantOf(talked, inside).toISOString(), TUE_2100_NY);
  const deferred = "2026-09-20T12:00:00.000Z";
  assert.equal(clock.deferredInstant(talked, deferred), clock.deferredInstant(base, deferred));
  assert.equal(clock.storyWindowStart(talked, 7 * DAY_MS).toISOString(), clock.storyWindowStart(base, 7 * DAY_MS).toISOString());
  const last = { hisAt: his, herAt: his, lastAt: his };
  assert.deepEqual(clock.timeSince(talked, last, TZ), clock.timeSince(base, last, TZ), "TIME SINCE reads the held instant");
  // Near midnight: a talk that crosses the day must not make TIME SINCE say "a new day".
  const lateSpan = clockSpan({ frozen_at: "2026-09-30T03:50:00.000Z" }); // Tuesday 11:50pm New York
  const late = storyClock({ spans: [lateSpan], real: FRI_1000_NY });
  const lateTalk = { ...late, talkMs: 30 * MIN_MS };
  // His last message at 11:20pm, thirty minutes before the freeze: on the moved time (12:20am)
  // that would read as yesterday; on the held instant it is the same evening.
  const lastLate = { hisAt: "2026-09-30T03:20:00.000Z", herAt: null, lastAt: "2026-09-30T03:20:00.000Z" };
  assert.equal(clock.timeSince(lateTalk, lastLate, TZ).newDay, false);
  assert.deepEqual(clock.timeSince(lateTalk, lastLate, TZ), clock.timeSince(late, lastLate, TZ));
  assert.equal(clock.localDayKeyOf(clock.storyNow(lateTalk), TZ), "2026-09-30", "while the shown time has moved past midnight");
});

// ------------------------------------------------------------------ the lock screen

test("lockScreenFrom: a held clock with talk shows the moved time (frozen stays true, the date and time follow the talk)", () => {
  const c = { ...storyClock({ spans: [clockSpan({ frozen_at: TUE_2100_NY })], real: FRI_1000_NY }), talkMs: 47 * MIN_MS };
  const wallpaper = lock.pickWallpaper("2026-10-02", [], { id: "master-05", file: "images/masters/05.png", focus: [50, 24] });
  const screen = lock.lockScreenFrom({ clock: c, tz: TZ, weather: null, wallpaper, his: null, hisName: null, song: null, beats: [], roll: [], wants: [] });
  assert.equal(screen.frozen, true);
  assert.equal(screen.now, plusMs(TUE_2100_NY, 47 * MIN_MS));
  assert.equal(screen.time, "9:47");
  assert.equal(screen.dateLine, "Tuesday, September 29");
});

// ------------------------------------------------------------------ loadStoryClock

const TALK_SQL = /FROM messages m JOIN conversations c ON c\.id = m\.conversation_id/;
const versions = [sceneVersion(6, "apart", "2026-09-29T10:00:00.000Z"), sceneVersion(7, "together", TUE_2100_NY, "the record store")];
const openSpan = () => clockSpan({ id: "sc_v7", opened_version: 7, frozen_at: TUE_2100_NY });

test("loadStoryClock: the open span's talk from ONE bounded read of the story messages since the freeze (both roles, delivered, conversations not deleted or drift)", async () => {
  const rows = [
    { created_at: plusMs(TUE_2100_NY, 22 * MIN_MS), channel: "story", deliver_at: null },
    { created_at: plusMs(TUE_2100_NY, 20 * MIN_MS), channel: "story", deliver_at: null },
    { created_at: plusMs(TUE_2100_NY, 3 * MIN_MS), channel: "story", deliver_at: null },
    { created_at: plusMs(TUE_2100_NY, 1 * MIN_MS), channel: "story", deliver_at: null },
    { created_at: plusMs(TUE_2100_NY, 23 * MIN_MS), channel: "story", deliver_at: "2026-10-09T00:00:00.000Z" }, // not delivered yet
    { created_at: plusMs(TUE_2100_NY, 24 * MIN_MS), channel: "drift", deliver_at: null },
  ];
  const db = scriptedD1(clockScript(versions, [openSpan()], [[TALK_SQL, rows]]));
  const c = await clock.loadStoryClock(db, settingsV5(), at(FRI_1000_NY));
  assert.equal(c.frozen, true);
  assert.equal(c.open.id, "sc_v7");
  // 1 + 2 + 5 (17 capped) + 2 + a tail capped at 5
  assert.equal(c.talkMs, 15 * MIN_MS);
  assert.equal(clock.storyNow(c).toISOString(), plusMs(TUE_2100_NY, 15 * MIN_MS));
  const reads = db.matching(TALK_SQL);
  assert.equal(reads.length, 1, "one read");
  const sql = reads[0].sql;
  assert.match(sql, /m\.channel = 'story'/);
  assert.match(sql, /m\.created_at >= \?1/);
  assert.match(sql, /m\.deliver_at IS NULL OR m\.deliver_at <= \?2/);
  assert.match(sql, /c\.status NOT IN \('deleted', 'drift'\)/);
  assert.match(sql, /ORDER BY m\.created_at DESC LIMIT \?3/);
  assert.ok(!/m\.role/.test(sql), "both roles");
  assert.deepEqual(reads[0].binds, [TUE_2100_NY, FRI_1000_NY, clock.TALK_STAMPS_LIMIT]);
  assert.equal(clock.TALK_STAMPS_LIMIT, 2000);
  assert.equal(db.writes().filter((w) => /messages/.test(w.sql)).length, 0, "the talk read writes nothing");
});

test("loadStoryClock: a failed talk read fails soft to 0 (the clock holds at frozen_at); apart, no talk read at all", async () => {
  const broken = scriptedD1(clockScript(versions, [openSpan()], [[TALK_SQL, () => { throw new Error("no such table: conversations"); }]]));
  const c = await clock.loadStoryClock(broken, settingsV5(), at(FRI_1000_NY));
  assert.equal(c.enabled, true);
  assert.equal(c.frozen, true);
  assert.equal(c.talkMs, 0);
  assert.equal(clock.storyNow(c).toISOString(), TUE_2100_NY);

  const apartVersions = [sceneVersion(6, "apart", "2026-09-29T10:00:00.000Z")];
  const db = scriptedD1(clockScript(apartVersions, [], [[TALK_SQL, [{ created_at: FRI_1000_NY, channel: "story", deliver_at: null }]]]));
  const a = await clock.loadStoryClock(db, settingsV5(), at(FRI_1000_NY));
  assert.equal(a.frozen, false);
  assert.equal(a.talkMs, undefined);
  assert.equal(db.matching(TALK_SQL).length, 0, "no open span, no talk read");
  assert.equal(clock.storyNow(a).toISOString(), FRI_1000_NY);
});
