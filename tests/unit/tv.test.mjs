// The game on TV (2026-09-27): the live Lions game in her prompt while they watch together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const tv = await loadSrc("tv");
const payload = (state, extra = {}) => ({ events: [{ name: "New York Jets at Detroit Lions", competitions: [{
  status: { type: { state, detail: state === "in" ? "2nd Quarter - 4:12" : state === "pre" ? "Sun, September 27th at 1:00 PM EDT" : "Final", description: "x" } },
  competitors: [{ score: "14", team: { id: "8", displayName: "Detroit Lions" } }, { score: "3", team: { id: "20", displayName: "New York Jets" } }],
  situation: { possession: "8", downDistanceText: "2nd & 7 at NYJ 34", lastPlay: { text: "J.Goff pass short right to A.St. Brown for 12 yards" } },
  ...extra,
}] }] });

test("gameSection: live, before and after; another team's day is nothing", () => {
  const live = tv.gameSection(payload("in"));
  assert.equal(live.state, "in");
  assert.match(live.text, /Detroit Lions 14, New York Jets 3\. 2nd Quarter - 4:12\./);
  assert.match(live.text, /Detroit Lions have the ball, 2nd & 7 at NYJ 34\./);
  assert.match(live.text, /Last play: J\.Goff pass short right to A\.St\. Brown for 12 yards/);
  assert.match(tv.gameSection(payload("pre")).text, /not started yet/);
  assert.match(tv.gameSection(payload("post")).text, /^Final: Detroit Lions 14, New York Jets 3\.$/);
  assert.equal(tv.gameSection({ events: [] }), null);
  assert.equal(tv.gameSection(null), null);
});

test("tvWanted: together and the game in the air, never apart", () => {
  assert.equal(tv.tvWanted("together", "on the couch at his place", ""), true);
  assert.equal(tv.tvWanted("together", "the record store", "put the lions on"), true);
  assert.equal(tv.tvWanted("together", "the record store", "you look cute"), false);
  assert.equal(tv.tvWanted("apart", "on the couch", "the lions game"), false);
});

test("tvSection never lets her invent the game", () => {
  const s = tv.tvSection({ state: "in", text: "x" });
  assert.match(s, /^ON THE TV/);
  assert.match(s, /never invent a play, a player or a score/);
});
