// public/js/bubbles.js in v4 (SPEC_V4 section 6): the dots lead in real mode. Pure,
// imported as is, the way bubbles_v2 does.
import { test } from "node:test";
import assert from "node:assert/strict";

const bubbles = await import("../../public/js/bubbles.js");
const { DOTS_LEAD_MS, dotsLeadMs, splitBubbles, bubbleDelayMs } = bubbles;

test("DOTS_LEAD_MS is twenty seconds", () => {
  assert.equal(DOTS_LEAD_MS, 20000);
});

test("dotsLeadMs: the wait before the dots start; 0 when the reply lands within the lead already, six minutes minus twenty seconds otherwise", () => {
  const now = 1_000_000;
  assert.equal(dotsLeadMs(now, now), 0, "landing now");
  assert.equal(dotsLeadMs(now + 10_000, now), 0, "ten seconds away: the dots start at once");
  assert.equal(dotsLeadMs(now + 20_000, now), 0, "exactly the lead");
  assert.equal(dotsLeadMs(now + 21_000, now), 1_000);
  assert.equal(dotsLeadMs(now + 6 * 60_000, now), 6 * 60_000 - 20_000, "six minutes away: no dots for five minutes forty");
  assert.equal(dotsLeadMs(now - 5_000, now), 0, "already landed");
  assert.equal(dotsLeadMs(NaN, now), 0);
  assert.equal(dotsLeadMs(now, undefined), 0);
  assert.equal(dotsLeadMs("junk", now), 0);
});

test("the v2 pieces are untouched beside it: the splitter and the delay formula", () => {
  assert.deepEqual(splitBubbles("one.\n\ntwo."), ["one.", "two."]);
  assert.equal(bubbleDelayMs("0123456789"), 700);
});
