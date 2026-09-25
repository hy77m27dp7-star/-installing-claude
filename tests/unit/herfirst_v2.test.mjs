// src/herfirst.ts: the decision table for "she texts first" (SPEC_V2 section R), pure.
// Every gate is a reason not to send; the probability window is the only place a send
// can come from, and it is deterministic by seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { TZ } from "./helpers_v2.mjs";

const { decideFirstText, HARD_REJECT_CODES, FIRST_TEXT_NOTE } = await loadSrc("herfirst");

const MIN = 60_000;
// Tuesday 10:30am New York: waking hours, far from the quiet window, hours of ticks left.
const MORNING = new Date("2026-09-29T14:30:00Z");
// Tuesday 11:20pm New York: ten minutes before quiet hours start.
const LATE = new Date("2026-09-30T03:20:00Z");
// Wednesday 2:00am New York: inside the quiet window.
const NIGHT = new Date("2026-09-30T06:00:00Z");

function args(overrides = {}) {
  return {
    enabled: true,
    cap: 10,
    countToday: 0,
    now: MORNING,
    tz: TZ,
    quietHours: "23:30-08:30",
    busy: false,
    lastMessageAt: null,
    lastTwoAreHers: false,
    seed: "2026-09-29T14:30:c_test",
    ...overrides,
  };
}

const decide = (over) => decideFirstText(args(over));

test("decideFirstText returns { send, reason } with a plain reason string", () => {
  const d = decide();
  assert.equal(typeof d.send, "boolean");
  assert.equal(typeof d.reason, "string");
  assert.ok(d.reason.trim().length > 0);
});

test("off: disabled or a cap of zero never sends", () => {
  assert.equal(decide({ enabled: false }).send, false);
  assert.equal(decide({ cap: 0 }).send, false);
  assert.ok(/off|disabled|cap/i.test(decide({ enabled: false }).reason));
});

test("quiet hours: nothing inside the window, in her timezone; the window wraps midnight", () => {
  const d = decide({ now: NIGHT, seed: "any" });
  assert.equal(d.send, false);
  assert.ok(/quiet/i.test(d.reason), d.reason);
  // 2:00am New York is 7:00am London: still quiet in London terms too, but 6:00am UTC in
  // a UTC setting is inside 23:30-08:30 as well. Move the window instead: a daytime
  // window that does not cover 10:30am must not block the morning.
  const d2 = decide({ quietHours: "12:00-14:00" });
  assert.ok(!/quiet/i.test(d2.reason), "a window elsewhere in the day must not block: " + d2.reason);
  const d3 = decide({ quietHours: "10:00-11:00" });
  assert.equal(d3.send, false);
  assert.ok(/quiet/i.test(d3.reason));
});

test("busy: when her life says she is busy she does not text first", () => {
  const d = decide({ busy: true });
  assert.equal(d.send, false);
  assert.ok(/busy/i.test(d.reason), d.reason);
});

test("cap reached: today's count at or above the cap never sends", () => {
  assert.equal(decide({ countToday: 10 }).send, false);
  assert.equal(decide({ countToday: 12 }).send, false);
  assert.ok(/cap|count|today/i.test(decide({ countToday: 10 }).reason));
});

test("recent message: less than 45 minutes since the last message in the conversation -> no", () => {
  const d = decide({ lastMessageAt: new Date(MORNING.getTime() - 20 * MIN) });
  assert.equal(d.send, false);
  assert.ok(/recent|minutes|last message/i.test(d.reason), d.reason);
  const older = decide({ lastMessageAt: new Date(MORNING.getTime() - 50 * MIN), seed: "late-window", now: LATE });
  assert.ok(!/recent|minutes|last message/i.test(older.reason), "50 minutes is old enough: " + older.reason);
});

test("two unanswered: when the last two messages are hers she never stacks a third", () => {
  const d = decide({ lastTwoAreHers: true });
  assert.equal(d.send, false);
  assert.ok(/unanswered|two|hers|stack|reply/i.test(d.reason), d.reason);
});

test("probability window: the same seed decides the same way", () => {
  for (let i = 0; i < 5; i++) {
    const seed = "seed-" + i;
    assert.equal(decide({ seed }).send, decide({ seed }).send);
  }
});

test("probability window: mid-morning with the whole day ahead she sometimes sends and mostly does not", () => {
  let sends = 0;
  const n = 300;
  for (let i = 0; i < n; i++) if (decide({ seed: "s" + i }).send) sends++;
  assert.ok(sends > 0, "never sends");
  assert.ok(sends < n, "always sends");
  // cap 10 over roughly 45 ticks (20-minute ticks from 8:30am to 11:30pm): well under half.
  assert.ok(sends / n < 0.6, "send share " + (sends / n).toFixed(2));
});

test("probability window: with the day nearly over and the cap far off, the remaining ticks must carry the count -> sends", () => {
  let sends = 0;
  for (let i = 0; i < 20; i++) if (decide({ now: LATE, countToday: 0, seed: "late-" + i }).send) sends++;
  assert.equal(sends, 20, "probability should be 1 when remaining count >= remaining ticks");
});

test("probability window: one text left today and a whole day of ticks -> rarely", () => {
  let sends = 0;
  const n = 300;
  for (let i = 0; i < n; i++) if (decide({ countToday: 9, seed: "one-left-" + i }).send) sends++;
  assert.ok(sends / n < 0.25, "send share " + (sends / n).toFixed(2));
});

test("gates win over the window: a late-day send is still refused when busy, capped or recent", () => {
  assert.equal(decide({ now: LATE, busy: true }).send, false);
  assert.equal(decide({ now: LATE, countToday: 10 }).send, false);
  assert.equal(decide({ now: LATE, lastMessageAt: new Date(LATE.getTime() - 5 * MIN) }).send, false);
  assert.equal(decide({ now: LATE, lastTwoAreHers: true }).send, false);
});

test("a first text is dropped for a dependency line or for an open ask leading it; the note forbids both in words", () => {
  assert.ok(HARD_REJECT_CODES.has("dependency_hook"));
  assert.ok(HARD_REJECT_CODES.has("ask_nag"));
  assert.ok(/never say you missed him or waited/.test(FIRST_TEXT_NOTE));
  assert.ok(/never make it about him being gone/.test(FIRST_TEXT_NOTE));
});
