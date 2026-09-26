// Her wants with dated beats and story time (SPEC_V5 section 2: src/wants.ts, the beat
// lines grouped by want from src/arcs.ts, and the callback picker's beat kind).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wantRow, askRow } from "./helpers_v3.mjs";
import {
  loadSrcIfPresent, guard, scriptedD1, beatView, clockSpan, storyClock, TZ, TUE_2100_NY, FRI_1000_NY, DAY_MS, plusMs,
} from "./helpers_v5.mjs";

const wants = await loadSrcIfPresent("wants");
const arcs = await loadSrcIfPresent("arcs");
const callbacks = await loadSrcIfPresent("callbacks");
const t = guard(wants, "moodNow", "wantsSection", "letGoStaleStmts");
const ta = guard(arcs, "beatLinesByWant");
const tc = guard(callbacks, "pickCallbacks");

const NOW = new Date("2026-09-29T19:10:00.000Z"); // Tuesday 3:10pm New York

t("moodNow with and without a clock: a one-day mood set Tuesday noon, read Friday 10:00 across a held span from Tuesday 9pm", () => {
  const setAt = "2026-09-29T16:00:00.000Z"; // Tuesday 12:00 New York
  const rel = { mood: "annoyed at him", mood_set_at: setAt, mood_days: 1 };
  const held = storyClock({ real: FRI_1000_NY, spans: [clockSpan({ frozen_at: TUE_2100_NY })] });
  const withClock = wants.moodNow(rel, new Date(TUE_2100_NY), {}, null, held);
  assert.equal(withClock.phase, "fresh", "9 hours of story time");
  assert.ok(Math.abs(withClock.ageDays - 9 / 24) < 1e-9);
  assert.equal(wants.moodNow(rel, new Date(FRI_1000_NY), {}, null, null).phase, "gone");
});

ta("beatLinesByWant: at most two Coming up, one was and two Lately per want, in that order; wants with nothing are absent", () => {
  const mk = (id, due_at, run = {}) => beatView({ beat: { id, due_at, title: id }, run: { id: "r_" + id, due_at, ...run } });
  const views = [
    mk("c3", "2026-10-03T00:00:00.000Z"),
    mk("c1", "2026-09-30T00:00:00.000Z"),
    mk("c2", "2026-10-01T00:00:00.000Z"),
    mk("w1", "2026-09-28T00:00:00.000Z"),
    mk("w2", "2026-09-29T00:00:00.000Z"),
    mk("l1", "2026-09-26T00:00:00.000Z", { status: "resolved", outcome: "went" }),
    mk("l2", "2026-09-27T00:00:00.000Z", { status: "resolved", outcome: "went" }),
    mk("l3", "2026-09-25T00:00:00.000Z", { status: "resolved", outcome: "went" }),
    beatView({ beat: { id: "other", want_id: "w_other", due_at: "2026-10-20T00:00:00.000Z" }, run: { due_at: "2026-10-20T00:00:00.000Z" } }),
  ];
  const map = arcs.beatLinesByWant(views, NOW, TZ, null, { horizonDays: 7, memoryDays: 7 });
  const got = map.get("w_test");
  assert.equal(got.length, 5);
  assert.match(got[0], /^  Coming up: c1,/);
  assert.match(got[1], /^  Coming up: c2,/);
  assert.match(got[2], /^  w2 was /);
  assert.match(got[3], /^  Lately: l2 /);
  assert.match(got[4], /^  Lately: l1 /);
  assert.equal(map.has("w_other"), false);
});

t("wantsSection: beat lines under their want; ages in story time with a clock", () => {
  const moved = plusMs(NOW.toISOString(), -5 * DAY_MS);
  const w = wantRow({ id: "w_test", title: "sing in front of people", last_moved: moved, created_at: moved, updated_at: moved });
  const beatLines = new Map([["w_test", ["  Coming up: the open mic, Thursday at 8:00pm."]]]);
  const s = wants.wantsSection([w], [], [], NOW, TZ, 4, { beatLines });
  const lines = s.split("\n");
  const at = lines.findIndex((l) => l.startsWith("- sing in front of people"));
  assert.ok(at > 0);
  assert.equal(lines[at + 1], "  Coming up: the open mic, Thursday at 8:00pm.");
  assert.match(lines[at], /Last moved 5 days ago/);
  const clock = storyClock({ real: NOW.toISOString(), spans: [clockSpan({ frozen_at: plusMs(moved, DAY_MS), resumed_at: plusMs(moved, 4 * DAY_MS) })] });
  const held = wants.wantsSection([w], [], [], NOW, TZ, 4, { beatLines, clock });
  assert.match(held, /Last moved 2 days ago/, "three of the five days were held");
  assert.equal(wants.wantsSection([], [], [], NOW, TZ, 4, { beatLines }), "", "still omitted when there is nothing at all");
});

t("letGoStaleStmts with a clock: an ask asked 15 days ago with 3 of them held is not let go at 14 days", async () => {
  const asked = plusMs(NOW.toISOString(), -15 * DAY_MS);
  const ask = askRow({ id: "ask_1", asked_at: asked, created_at: asked });
  const db = scriptedD1([[/SELECT \* FROM asks WHERE status = \?1/, [ask]]]);
  const clock = storyClock({ real: NOW.toISOString(), spans: [clockSpan({ frozen_at: plusMs(asked, 2 * DAY_MS), resumed_at: plusMs(asked, 5 * DAY_MS) })] });
  const held = await wants.letGoStaleStmts(db, NOW, 14, "maintenance", clock);
  assert.deepEqual(held.askIds, []);
  const plain = await wants.letGoStaleStmts(db, NOW, 14, "maintenance", null);
  assert.deepEqual(plain.askIds, ["ask_1"]);
  assert.equal(plain.stmts.length, 2);
});

tc("pickCallbacks: a fresh outcome is offered as kind beat, never with a his-part sentence", () => {
  const due = plusMs(NOW.toISOString(), -1 * DAY_MS);
  const v = beatView({ beat: { due_at: due }, run: { id: "r_mic", due_at: due, status: "resolved", outcome: "went_well", his_part: "encouraged", his_note: "a text before" } });
  const picks = callbacks.pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: NOW, seed: "s", beats: [v], tz: TZ });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].sourceId, "r_mic");
  assert.equal(picks[0].text, "the open mic: you went and it went well");
  assert.ok(!/He |encouraged/.test(picks[0].text));
});

tc("pickCallbacks on an opener: went_well offered, never went_badly, chickened_out or missed", () => {
  const due = plusMs(NOW.toISOString(), -1 * DAY_MS);
  const mk = (id, outcome, kind = "event") => beatView({ beat: { id, title: id, kind, due_at: due }, run: { id: "r_" + id, due_at: due, status: "resolved", outcome } });
  const beats = [mk("good", "went_well"), mk("bad", "went_badly"), mk("scared", "chickened_out"), mk("miss", "missed", "step")];
  for (let i = 0; i < 20; i++) {
    const picks = callbacks.pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: NOW, seed: "s" + i, beats, tz: TZ, opener: true });
    assert.deepEqual(picks.map((p) => p.sourceId), ["r_good"]);
  }
  const notOpener = callbacks.pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: NOW, seed: "s", beats, tz: TZ });
  assert.equal(notOpener.length, 2, "outside an opener a setback may be offered");
});

tc("pickCallbacks: a pending beat due within two days reads its day", () => {
  const due = "2026-09-30T22:00:00.000Z"; // Wednesday 6:00pm New York
  const v = beatView({ beat: { title: "sign up", due_at: due, due_time: "18:00" }, run: { id: "r_sign", due_at: due } });
  const picks = callbacks.pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: NOW, seed: "s", beats: [v], tz: TZ });
  assert.equal(picks[0].text, "sign up: tomorrow at 6:00pm");
});
