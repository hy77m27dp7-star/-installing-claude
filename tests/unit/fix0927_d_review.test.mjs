// fix0927 review round: the fixes the two reviews of fix0927 asked for.
// Backend 1 (must-fix): inside a held scene the moving time of day (storyNow) had reached the
// checks that decide whether a plan has passed, so "the open mic" at 8:00pm read "was today"
// 35 minutes into a scene frozen at 7:50pm. Only the stated time of day may move; her plans,
// the callbacks, the extractor's day and the beat outcome read the held instant (heldNow).
// Backend 2: the chat's "Her pictures" drawer lists only pictures she sent, then her masters.
// Backend 3: her masters keep a place on her phone however many pictures she has sent.
// Backend 4: the Together mode section turns the VOICE NOTES rule off.
// Front end 1: Let her start stays hidden while a chapter loads. Front end 2: tapping the lit
// Texting pill writes nothing. Front end 3: the action chain is anchored at the paragraph edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc, sceneState } from "./helpers.mjs";
import { promptStateV2, eventRow } from "./helpers_v2.mjs";
import { wantRow, weatherNow } from "./helpers_v3.mjs";
import { clockSpan, storyClock, beatView, TZ, MIN_MS } from "./helpers_v5.mjs";

const clock = await loadSrc("clock");
const prompt = await loadSrc("prompt");
const life = await loadSrc("life");
const callbacks = await loadSrc("callbacks");
const roll = await loadSrc("roll");
const lock = await loadSrc("lockscreen");
const words = await import("../../public/js/lockwords.js");
const bubbles = await import("../../public/js/bubbles.js");
const text = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");

const FROZE = "2026-09-29T23:50:00.000Z"; // Tuesday 7:50pm New York
const DUE = "2026-09-30T00:00:00.000Z"; // Tuesday 8:00pm New York
const REAL = "2026-09-30T16:00:00.000Z"; // Wednesday noon: he left overnight, the scene still held
const heldTalk = () => ({ ...storyClock({ spans: [clockSpan({ frozen_at: FROZE })], real: REAL }), talkMs: 35 * MIN_MS });
const openMic = () => beatView({ beat: { title: "the open mic", due_on: "2026-09-29", due_at: DUE, due_time: "20:00" }, run: { due_at: DUE } });

function heldState(nowOf) {
  const c = heldTalk();
  return promptStateV2({
    mode: "together",
    scene: sceneState({ status: "together", location: "the record store" }),
    clock: c,
    life: { threads: [], log: [], tz: TZ, ...nowOf(c) },
    wants: [wantRow()],
    wantLog: [],
    asks: [],
    beats: [openMic()],
    beatHorizonDays: 7,
    arcMemoryDays: 7,
    grounding: { city: "Portland, Maine", weather: weatherNow(), outfit: null, today: [] },
  });
}

// ------------------------------------------------------------------ backend 1

test("backend 1: the scenario: frozen 7:50pm, 35 minutes of talk: the plan at 8:00pm is still coming up, RIGHT NOW reads 8:25pm", () => {
  const c = heldTalk();
  assert.equal(clock.heldNow(c).toISOString(), FROZE);
  assert.equal(clock.storyNow(c).toISOString(), "2026-09-30T00:25:00.000Z");
  const s = prompt.stateSections(heldState((k) => ({ now: clock.heldNow(k), clockNow: clock.storyNow(k) })));
  assert.match(s, /Coming up: the open mic, today at 8:00pm\./);
  assert.ok(!/the open mic was/.test(s), s);
  const right = s.slice(s.indexOf("RIGHT NOW ("));
  assert.match(right, /^RIGHT NOW \([^\n]*\)\nIt is Tuesday 8:25pm/);
});

test("backend 1, the control: with the moving time as `now` (the branch before this fix) the plan read as already happened", () => {
  const s = prompt.stateSections(heldState((k) => ({ now: clock.storyNow(k) })));
  assert.match(s, /the open mic was today\. How it went is yours to say/);
});

test("backend 1: lifeSection: the 'It is' line reads clockNow; what is next reads the held instant", () => {
  const c = heldTalk();
  const ev = eventRow(DUE, { title: "the open mic" });
  const moved = life.lifeSection([ev], [], clock.heldNow(c), TZ, { together: true, clockNow: clock.storyNow(c) });
  assert.match(moved, /It is Tuesday 8:25pm\./);
  assert.match(moved, /Next up: [^\n]*open mic at the bar on 4th \(today\)\./);
  const plain = life.lifeSection([ev], [], clock.heldNow(c), TZ, { together: true });
  assert.match(plain, /It is Tuesday 7:50pm\./, "no clockNow: the held instant, as before");
});

test("backend 1: pickCallbacks on a held clock with talk: the 8:00pm plan is offered as coming up, not dropped as past", () => {
  const out = callbacks.pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: new Date(REAL), seed: "s", beats: [openMic()], clock: heldTalk(), tz: TZ });
  assert.deepEqual(out.map((x) => x.text), ["the open mic: today at 8:00pm"]);
});

test("backend 1: every measure reads heldNow: both assemble paths, the extractor's day, the beat outcome, the callbacks, the sent check", () => {
  const ctx = text("src/context.ts");
  assert.equal((ctx.match(/now: heldAt,\n\s+clockNow: storyNow,/g) ?? []).length, 2, "assembleContext and assembleSystemOnly");
  assert.match(ctx, /const localHour = localParts\(clockNow, /, "the time-of-day tags read the stated time");
  assert.match(ctx, /life: \{ threads, log, now, clockNow, tz \}/);
  const props = text("src/proposals.ts");
  assert.match(props, /return dayOf\(heldNow\(clock\)\);/);
  assert.match(props, /clock \? heldNow\(clock\)\.getTime\(\) : Date\.now\(\)/);
  assert.ok(!/storyNow/.test(props), "proposals.ts reads no moving clock");
  const cb = text("src/callbacks.ts");
  assert.match(cb, /const now = clock \? heldNow\(clock\) : args\.now;/);
  assert.ok(!/storyNow\(/.test(cb));
  assert.match(text("src/chat.ts"), /const storyNow = state\.life && state\.life\.now instanceof Date \? state\.life\.now : /);
  assert.match(text("src/prompt.ts"), /groundingSection\(\{ now: clockNow, /);
});

// ------------------------------------------------------------------ backend 4

test("backend 4: the Together mode section turns voice notes off; Apart does not mention it", () => {
  const together = prompt.stateSections(promptStateV2({ mode: "together", scene: sceneState({ status: "together", location: "the pier" }) }));
  assert.match(together, /MODE: together\n[^\n]*No voice notes while you are together: [^\n]*never end a message with the \[voice\] line/);
  const apart = prompt.stateSections(promptStateV2({ mode: "apart", scene: sceneState({ status: "apart" }) }));
  assert.ok(!/No voice notes while you are together/.test(apart), apart);
});

// ------------------------------------------------------------------ backend 2

test("backend 2: the Her pictures drawer lists only pictures she sent, newest first, then her masters 01 to 05", () => {
  const js = text("public/js/chat.js");
  const start = js.indexOf("async function openPhotos(");
  const body = js.slice(start, js.indexOf("\n}\n", start));
  assert.match(body, /\.filter\(\(a\) => a && typeof a\.message_id === "string" && a\.message_id\.trim\(\)\)/, "a picture with no message behind it stays in Studio");
  assert.match(body, /HER_MASTER_IDS\.includes\(m\.id\) && m\.approval_status === "approved"/);
  assert.match(body, /"\/images\/masters\/" \+ encodeURIComponent\(file\)/);
  assert.match(body, /"\/album#" \+ encodeURIComponent\(m\.id\)/);
  assert.match(js, /const HER_MASTER_IDS = \["master-01", "master-02", "master-03", "master-04", "master-05"\];/, "never master-00");
});

// ------------------------------------------------------------------ backend 3

const sent = (n) => Array.from({ length: n }, (_, i) => ({
  id: "img_" + i, kind: "photo", url: "/media/img_" + i, poster: null, at: "2026-09-26T0" + (i % 10) + ":00:00.000Z", place: null, us: false, conversationId: "c", messageId: "m" + i,
}));
const masters = () => ["master-01", "master-02", "master-03", "master-04", "master-05"].map((id) => roll.masterItem({ id, file: id + ".png", url: "/images/masters/" + id + ".png", created_at: "2026-09-24T00:00:00.000Z" }));

test("backend 3: rollWithMasters: masters keep their reserved places however many she sent; with few sent they fill the rest", () => {
  const many = [...sent(14), ...masters()];
  assert.deepEqual(roll.rollWithMasters(many, 6, 2).map((i) => i.id), ["img_0", "img_1", "img_2", "img_3", "master-01", "master-02"]);
  const photos = roll.rollWithMasters(many, 12, 5).map((i) => i.id);
  assert.equal(photos.length, 12);
  assert.deepEqual(photos.slice(7), ["master-01", "master-02", "master-03", "master-04", "master-05"]);
  assert.deepEqual(roll.rollWithMasters([...sent(1), ...masters()], 6, 2).map((i) => i.id), ["img_0", "master-01", "master-02", "master-03", "master-04", "master-05"]);
  assert.deepEqual(roll.rollWithMasters(sent(8), 6, 2).map((i) => i.id), ["img_0", "img_1", "img_2", "img_3", "img_4", "img_5"], "no masters: nothing reserved");
  assert.deepEqual(roll.rollWithMasters(null, 6, 2), []);
  // The page's copy answers the same.
  for (const [limit, keep] of [[6, 2], [12, 5], [3, 5]]) {
    assert.deepEqual(words.rollWithMasters(many, limit, keep).map((i) => i.id), roll.rollWithMasters(many, limit, keep).map((i) => i.id), limit + "/" + keep);
  }
});

test("backend 3: the lock strip after many sent pictures still carries two masters; the phone reserves five in Photos and two on the strip", () => {
  const c = storyClock({ spans: [], real: REAL });
  const wallpaper = lock.pickWallpaper("2026-09-30", [], { id: "master-05", file: "images/masters/05.png", focus: [50, 24] });
  const screen = lock.lockScreenFrom({ clock: c, tz: TZ, weather: null, wallpaper, his: null, hisName: null, song: null, beats: [], roll: [...sent(12), ...masters()], wants: [] });
  assert.deepEqual(screen.roll.map((i) => i.id), ["img_0", "img_1", "img_2", "img_3", "master-01", "master-02"]);
  assert.equal(lock.LOCK_ROLL_MASTERS, 2);
  const phone = text("public/js/phone.js");
  assert.match(phone, /const PHOTOS_MASTERS = 5;\nconst STRIP_MASTERS = 2;/);
  assert.match(phone, /drawableRoll\(rollWithMasters\(S\.roll, PHOTOS_MAX, PHOTOS_MASTERS\), PHOTOS_MAX\)/);
  assert.match(phone, /rollWithMasters\([^\n]*STRIP_MAX, STRIP_MASTERS\), STRIP_MAX\)/);
});

// ------------------------------------------------------------------ front end 1 and 2

const chat = text("public/js/chat.js");
function fnSrc(name) {
  const start = chat.indexOf("function " + name + "(");
  assert.ok(start >= 0, name);
  return chat.slice(start, chat.indexOf("\n}\n", start) + 2);
}

test("front end 1: Let her start stays hidden while the chapter's rows are on their way, and after a failed load", () => {
  const src = chat.slice(chat.indexOf("const START_CHIP_MS"), chat.indexOf("function startChipState("));
  const shows = new Function(src + "\nreturn startChipShows;")();
  const now = Date.parse("2026-09-27T12:00:00Z");
  const base = { loading: false, lastRole: null, lastAt: null, operator: false, tasting: false, busy: false, onCall: false, pending: false };
  assert.equal(shows(base, now), true, "an empty chapter, loaded");
  assert.equal(shows({ ...base, loading: true }, now), false, "no role yet while loading is not an empty chapter");
  assert.match(fnSrc("startChipState"), /loading: !!state\.threadLoading,/);
  const load = fnSrc("loadThread");
  const setOn = load.indexOf("state.threadLoading = !!id;");
  assert.ok(setOn > 0 && setOn < load.indexOf("updateStartButton();"), "set before the first chip update; no chapter counts as loaded");
  const setOff = load.indexOf("state.threadLoading = false;");
  assert.ok(setOff > load.indexOf("for (const m of rows)") && setOff < load.lastIndexOf("updateStartButton();"), "cleared once the rows are in");
  const failed = load.slice(load.indexOf("} catch (e) {"), load.indexOf("// Call rows sit"));
  assert.ok(!/threadLoading/.test(failed), "a failed load leaves the chip hidden");
});

test("front end 2: tapping Texting while already apart writes no scene", () => {
  assert.match(chat, /const onTextingClick = \(\) => \{\n  closeMenus\(true\);\n  if \(state\.scene && state\.scene\.status === "apart"\) return;\n  setScene\("apart", null\);\n\};/);
});

// ------------------------------------------------------------------ front end 3

const show = (pieces) => pieces.map((p) => (p.kind === "action" ? "A:" + p.text : "S:" + p.runs.map((r) => (r.em ? "*" + r.text + "*" : r.text)).join("")));

test("front end 3: a short span beside a mid-sentence action stays emphasis; the edge chains still hold", () => {
  assert.deepEqual(show(bubbles.splitActions("i said *leans in close now* *so* dramatic")), ["S:i said", "A:leans in close now", "S:*so* dramatic"]);
  assert.deepEqual(show(bubbles.splitActions("*laughs* *covers her face* ok")), ["A:laughs", "A:covers her face", "S:ok"]);
  assert.deepEqual(show(bubbles.splitActions("ok *pulls you closer* *smiles*")), ["S:ok", "A:pulls you closer", "A:smiles"]);
  assert.deepEqual(show(bubbles.splitActions("*sighs* *so* much for that")), ["A:sighs", "A:so", "S:much for that"], "anchored at the start, the chain runs on");
  assert.deepEqual(show(bubbles.splitActions("that was *so* good")), ["S:that was *so* good"]);
});
