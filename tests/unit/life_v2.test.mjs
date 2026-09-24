// src/life.ts, the pure half: whereSheIs, lifeSection, computeDeliverAt. Fixed dates only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, BAD_TYPOGRAPHY } from "./helpers.mjs";
import {
  TZ, TUE_1510_NY, TUE_2000_NY, TUE_0830_NY, SAT_1000_NY, TUE_1730_NY_ISO, threadRow, workRoutine, eventRow, personRow, placeRow, arcRow, logRow,
} from "./helpers_v2.mjs";

const { whereSheIs, lifeSection, computeDeliverAt, EMPTY_LIFE_LINE } = await loadSrc("life");

const MIN = 60_000;

// ------------------------------------------------------------------ whereSheIs

test("whereSheIs: inside a weekday block she is busy with the block's label until its end", () => {
  const w = whereSheIs([workRoutine()], TUE_1510_NY, TZ);
  assert.equal(w.busy, true);
  assert.equal(w.label, "at work");
  assert.ok(w.until instanceof Date);
  assert.equal(w.until.toISOString(), TUE_1730_NY_ISO);
});

test("whereSheIs: after the block on the same day, and on a weekend, she is free", () => {
  for (const now of [TUE_2000_NY, SAT_1000_NY]) {
    const w = whereSheIs([workRoutine()], now, TZ);
    assert.deepEqual(w, { busy: false, label: null, until: null });
  }
});

test("whereSheIs: the block start is inclusive and the end exclusive", () => {
  const start = new Date("2026-09-29T13:00:00Z"); // 9:00am New York
  const end = new Date(TUE_1730_NY_ISO);
  assert.equal(whereSheIs([workRoutine()], start, TZ).busy, true);
  assert.equal(whereSheIs([workRoutine()], end, TZ).busy, false);
});

test("whereSheIs: an event covers its window (default two hours) and nothing before or after", () => {
  const at = "2026-10-03T19:30:00-04:00";
  const ev = eventRow(at);
  const before = new Date("2026-10-03T23:00:00Z"); // 7:00pm New York
  const during = new Date("2026-10-04T00:15:00Z"); // 8:15pm New York
  const after = new Date("2026-10-04T01:45:00Z"); // 9:45pm New York
  assert.equal(whereSheIs([ev], before, TZ).busy, false);
  const w = whereSheIs([ev], during, TZ);
  assert.equal(w.busy, true);
  assert.equal(w.label, "open mic at the bar on 4th");
  assert.equal(w.until.toISOString(), "2026-10-04T01:30:00.000Z", "the event ends 120 minutes after it starts");
  assert.equal(whereSheIs([ev], after, TZ).busy, false);
});

test("whereSheIs: an event with explicit minutes ends when they run out", () => {
  const ev = eventRow("2026-10-03T19:30:00-04:00", { schedule_json: JSON.stringify({ at: "2026-10-03T19:30:00-04:00", minutes: 30, label: "coffee" }) });
  assert.equal(whereSheIs([ev], new Date("2026-10-03T23:45:00Z"), TZ).busy, true);
  assert.equal(whereSheIs([ev], new Date("2026-10-04T00:05:00Z"), TZ).busy, false);
});

test("whereSheIs: the timezone decides the wall clock (8:30am New York is 1:30pm London)", () => {
  const block = threadRow({ schedule_json: JSON.stringify({ blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" }] }) });
  assert.equal(whereSheIs([block], TUE_0830_NY, TZ).busy, false);
  assert.equal(whereSheIs([block], TUE_0830_NY, "Europe/London").busy, true);
});

test("whereSheIs: a tz inside the schedule wins over the tz argument", () => {
  const london = threadRow({ schedule_json: JSON.stringify({ tz: "Europe/London", blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" }] }) });
  assert.equal(whereSheIs([london], TUE_0830_NY, TZ).busy, true);
});

test("whereSheIs: an overnight block runs past midnight into the next day", () => {
  const night = threadRow({ schedule_json: JSON.stringify({ tz: TZ, blocks: [{ days: [2], start: "22:00", end: "02:00", label: "closing shift" }] }) });
  const lateTuesday = new Date("2026-09-30T03:30:00Z"); // Tuesday 11:30pm New York
  const earlyWednesday = new Date("2026-09-30T05:30:00Z"); // Wednesday 1:30am New York
  const laterWednesday = new Date("2026-09-30T07:00:00Z"); // Wednesday 3:00am New York
  assert.equal(whereSheIs([night], lateTuesday, TZ).busy, true);
  assert.equal(whereSheIs([night], earlyWednesday, TZ).busy, true);
  assert.equal(whereSheIs([night], laterWednesday, TZ).busy, false);
});

test("whereSheIs: dropped, superseded and done threads and malformed schedules never make her busy", () => {
  const rows = [
    workRoutine({ id: "a", status: "dropped" }),
    workRoutine({ id: "b", status: "superseded" }),
    workRoutine({ id: "c", schedule_json: "{not json" }),
    workRoutine({ id: "d", schedule_json: JSON.stringify({ blocks: [{ days: [2], start: "9", end: "17:30" }] }) }),
    workRoutine({ id: "e", schedule_json: null }),
  ];
  assert.equal(whereSheIs(rows, TUE_1510_NY, TZ).busy, false);
  assert.equal(whereSheIs([], TUE_1510_NY, TZ).busy, false);
});

test("whereSheIs: overlapping blocks -> busy until the later end", () => {
  const rows = [
    workRoutine({ id: "a" }),
    threadRow({ id: "b", schedule_json: JSON.stringify({ tz: TZ, blocks: [{ days: [2], start: "15:00", end: "19:00", label: "rehearsal" }] }) }),
  ];
  const w = whereSheIs(rows, TUE_1510_NY, TZ);
  assert.equal(w.busy, true);
  assert.equal(w.label, "rehearsal");
  assert.equal(w.until.toISOString(), "2026-09-29T23:00:00.000Z");
});

test("whereSheIs: an unknown timezone falls back rather than throwing", () => {
  assert.doesNotThrow(() => whereSheIs([workRoutine()], TUE_1510_NY, "Nowhere/Place"));
});

// ------------------------------------------------------------------ lifeSection

test("lifeSection: empty life -> the heading and the 'nothing written down yet' line, nothing else", () => {
  const s = lifeSection([], [], TUE_1510_NY, TZ);
  assert.ok(s.startsWith("YOUR LIFE RIGHT NOW"));
  assert.ok(s.includes("Nothing about your days has been written down yet"));
  assert.ok(s.includes("You still have days"));
  assert.equal(typeof EMPTY_LIFE_LINE, "string");
  assert.ok(s.includes(EMPTY_LIFE_LINE));
  assert.ok(!s.includes("It is "));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

test("lifeSection: full -> local day and time, the current block, the next event, people, places, arcs and the last five notes", () => {
  const threads = [
    workRoutine(),
    eventRow("2026-10-03T19:30:00-04:00"),
    eventRow("2026-11-20T19:30:00-05:00", { id: "lt_far", title: "far away", schedule_json: JSON.stringify({ at: "2026-11-20T19:30:00-05:00", label: "far away thing" }) }),
    personRow(),
    placeRow(),
    arcRow(),
  ];
  const log = [];
  for (let i = 0; i < 6; i++) {
    log.push(logRow({ id: "ll" + i, occurred: new Date(TUE_1510_NY.getTime() - (i + 1) * 24 * 60 * MIN).toISOString(), note: "note number " + i, thread_id: i === 0 ? "lt_place" : null }));
  }
  const s = lifeSection(threads, log, TUE_1510_NY, TZ);
  assert.ok(s.startsWith("YOUR LIFE RIGHT NOW"));
  assert.ok(s.includes("It is Tuesday 3:10pm"), s.split("\n")[1]);
  assert.ok(s.includes("at work until 5:30pm"));
  assert.ok(/Next up: Saturday 7:30pm, open mic at the bar on 4th \(in 4 days\)/.test(s), s);
  assert.ok(!s.includes("far away thing"), "an event beyond seven days is not the next event");
  assert.ok(s.includes("the shop"));
  assert.ok(s.includes("Mon to Fri 9:00am to 5:30pm"));
  assert.ok(s.includes("Dana (best friend): moving apartments this month"));
  assert.ok(s.includes("the laundromat on 9th: fluorescent, one working dryer"));
  assert.ok(s.includes("last time: note number 0 (yesterday)"));
  assert.ok(s.includes("the singing: she has sung in front of exactly one person"));
  for (let i = 0; i < 5; i++) assert.ok(s.includes("note number " + i), "note " + i);
  assert.ok(!s.includes("note number 5"), "only the last five notes");
  assert.ok(s.indexOf("note number 0") < s.indexOf("note number 4"), "newest first");
  assert.ok(!s.includes(EMPTY_LIFE_LINE));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

test("lifeSection: free right now says so; dropped threads are left out", () => {
  const s = lifeSection([workRoutine(), personRow({ id: "x", title: "Gone", status: "dropped" })], [], TUE_2000_NY, TZ);
  assert.ok(s.includes("Nothing on your schedule right now"));
  assert.ok(!s.includes("Gone"));
});

test("lifeSection: an event later today reads 'today', tomorrow reads 'tomorrow'", () => {
  const today = lifeSection([eventRow("2026-09-29T21:00:00-04:00")], [], TUE_1510_NY, TZ);
  assert.ok(/Next up: Tuesday 9:00pm, open mic at the bar on 4th \(today\)/.test(today), today);
  const tomorrow = lifeSection([eventRow("2026-09-30T08:00:00-04:00")], [], TUE_1510_NY, TZ);
  assert.ok(/\(tomorrow\)/.test(tomorrow), tomorrow);
});

test("lifeSection: never tells her to fill silence or that he owes her anything", () => {
  const s = lifeSection([workRoutine()], [logRow()], TUE_1510_NY, TZ);
  assert.ok(/never to fill silence/.test(s));
  assert.ok(!/miss(ed)? you|waiting for you/i.test(s));
});

// ------------------------------------------------------------------ computeDeliverAt

test("computeDeliverAt: busy -> within the cap, deterministic from the seed, never in the past", () => {
  const a = computeDeliverAt([workRoutine()], TUE_1510_NY, TZ, 6, "m_seed_1");
  const b = computeDeliverAt([workRoutine()], TUE_1510_NY, TZ, 6, "m_seed_1");
  assert.equal(a.getTime(), b.getTime(), "same seed, same instant");
  const delay = a.getTime() - TUE_1510_NY.getTime();
  assert.ok(delay >= 5000 && delay <= 6 * MIN, "delay " + delay);
});

test("computeDeliverAt: busy with the block ending soon -> waits for the block, not the cap", () => {
  const soon = new Date(new Date(TUE_1730_NY_ISO).getTime() - 2 * MIN); // 5:28pm, two minutes left
  const at = computeDeliverAt([workRoutine()], soon, TZ, 6, "m_seed_2");
  const delay = at.getTime() - soon.getTime();
  assert.ok(delay >= 5000 && delay <= 2 * MIN * 1.2 + 1, "delay " + delay);
});

test("computeDeliverAt: free -> five to ninety seconds, capped by the setting", () => {
  const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (const seed of seeds) {
    const at = computeDeliverAt([], TUE_2000_NY, TZ, 6, seed);
    const delay = at.getTime() - TUE_2000_NY.getTime();
    assert.ok(delay >= 5000 && delay <= 90_000, seed + ": " + delay);
  }
  const capped = computeDeliverAt([], TUE_2000_NY, TZ, 1, "z");
  assert.ok(capped.getTime() - TUE_2000_NY.getTime() <= 60_000);
  const spread = new Set(seeds.map((s) => computeDeliverAt([], TUE_2000_NY, TZ, 6, s).getTime()));
  assert.ok(spread.size >= 2, "different seeds should land on different instants");
});

test("computeDeliverAt: a cap of zero or a bad cap means now", () => {
  assert.equal(computeDeliverAt([workRoutine()], TUE_1510_NY, TZ, 0, "s").getTime(), TUE_1510_NY.getTime());
  assert.equal(computeDeliverAt([workRoutine()], TUE_1510_NY, TZ, Number.NaN, "s").getTime(), TUE_1510_NY.getTime());
  assert.equal(computeDeliverAt([workRoutine()], TUE_1510_NY, TZ, -3, "s").getTime(), TUE_1510_NY.getTime());
});

test("computeDeliverAt: the cap bounds the busy delay too", () => {
  const at = computeDeliverAt([workRoutine()], new Date("2026-09-29T13:05:00Z"), TZ, 2, "seed"); // 9:05am, hours of block left
  assert.ok(at.getTime() - Date.parse("2026-09-29T13:05:00Z") <= 2 * MIN);
});
