// src/chapters.ts (DESIGN_EXPERIENCE 8.2 and 8.3): a conversation read as a chapter. The
// title order his > the place in force at firstAt > the first VISITED together version
// inside the span > the day; the rename's cleaning; the preview; the views on the D1 stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, sceneState, EM_DASH, EN_DASH, ELLIPSIS, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { fakeDb, messageRow } from "./helpers_v2.mjs";

const ch = await loadSrc("chapters");
const TZ = "America/New_York";

const V = (version, created_at, state) => ({ id: "sv" + version, entity: "scene", version, state_json: JSON.stringify(state), created_at, source: "owner", note: null });
// Thursday 2026-09-24 in New York (EDT, UTC-4).
const VERSIONS = [
  V(1, "2026-09-20T00:00:00.000Z", sceneState()),
  V(2, "2026-09-25T00:00:00.000Z", sceneState({ status: "together", location: "the bench by the water" })), // Thu 8:00pm
  V(3, "2026-09-25T02:00:00.000Z", sceneState({ status: "together", location: "the shoot on the roof" })), // Thu 10:00pm, replaced at once
  V(4, "2026-09-25T02:00:01.000Z", sceneState({ status: "together", location: "at the record store on Congress Street, late" })),
  V(5, "2026-09-25T05:00:00.000Z", sceneState({ status: "apart", location: null })), // Fri 1:00am
];

test("placeTitle: one leading at/in/on dropped, cut at , ; ( or --, at a word before 40, trailing punctuation off, first letter up; null when nothing is left", () => {
  assert.equal(ch.placeTitle("the bench by the water"), "The bench by the water");
  assert.equal(ch.placeTitle("at the record store on Congress Street, late"), "The record store on Congress Street");
  assert.equal(ch.placeTitle("In the kitchen (her apartment)"), "The kitchen");
  assert.equal(ch.placeTitle("on the ferry -- going out to the island"), "The ferry");
  assert.equal(ch.placeTitle("ON the pier; cold"), "The pier");
  assert.equal(ch.placeTitle("  the   pier.  "), "The pier");
  const long = ch.placeTitle("the long wooden dock behind the old fish market on Commercial Street");
  assert.ok(long.length <= 40, long);
  assert.equal(long, "The long wooden dock behind the old fish");
  assert.equal(ch.placeTitle("at "), null);
  assert.equal(ch.placeTitle("   "), null);
  assert.equal(ch.placeTitle(null), null);
  assert.equal(ch.placeTitle(undefined), null);
  assert.equal(ch.placeTitle("at"), null, "the dropped word alone: nothing left");
  assert.equal(ch.placeTitle("same scene"), null, "a filler location names no place");
  assert.equal(ch.placeTitle("k"), null);
});

test("isFillerPlace and placeWords: same scene, same place, k and anything under three characters name no place; placeWords keeps the case", () => {
  for (const f of ["same scene", "Same place", "the same place", "same", "k", "K.", "ok", "at k", "xy", "", null]) assert.equal(ch.isFillerPlace(f), true, String(f));
  for (const r of ["the pier", "Rosie's", "the record store on Congress Street, at the bins"]) assert.equal(ch.isFillerPlace(r), false, r);
  assert.equal(ch.placeWords("at the record store on Congress Street, at the used bins by the listening station"), "the record store on Congress Street");
  assert.equal(ch.placeWords("same scene"), null);
});

test("dayTitle: the weekday in her timezone and the part of the day by her local hour", () => {
  assert.equal(ch.dayTitle("2026-09-24T11:00:00.000Z", TZ), "Thursday morning"); // 7:00
  assert.equal(ch.dayTitle("2026-09-24T17:00:00.000Z", TZ), "Thursday afternoon"); // 13:00
  assert.equal(ch.dayTitle("2026-09-24T22:00:00.000Z", TZ), "Thursday evening"); // 18:00
  assert.equal(ch.dayTitle("2026-09-25T03:30:00.000Z", TZ), "Thursday night"); // 23:30
  assert.equal(ch.dayTitle("2026-09-25T06:00:00.000Z", TZ), "Friday night"); // 02:00
  assert.equal(ch.dayTitle("2026-09-24T09:00:00.000Z", TZ), "Thursday morning"); // 5:00
  assert.equal(ch.dayTitle("2026-09-24T16:00:00.000Z", TZ), "Thursday afternoon"); // 12:00
  assert.equal(ch.dayTitle("2026-09-25T01:00:00.000Z", TZ), "Thursday night"); // 21:00
});

test("visitedVersions: only versions with a visible story message in [created_at, next created_at), oldest first", () => {
  const times = ["2026-09-25T00:05:00.000Z", "2026-09-25T02:30:00.000Z"];
  assert.deepEqual(ch.visitedVersions(VERSIONS, times).map((v) => v.version), [2, 4]);
  assert.deepEqual(ch.visitedVersions(VERSIONS, ["2026-09-26T00:00:00.000Z"]).map((v) => v.version), [5], "the last version's window is open-ended");
  assert.deepEqual(ch.visitedVersions(VERSIONS, ["2026-09-25T00:00:00.000Z"]).map((v) => v.version), [2], "a message at the version's own instant counts");
  assert.deepEqual(ch.visitedVersions(VERSIONS, []), []);
  assert.deepEqual(ch.visitedVersions([], times), []);
  assert.deepEqual(ch.visitedVersions([...VERSIONS].reverse(), times).map((v) => v.version), [2, 4], "order of the input does not matter");
});

test("chapterTitle: his > the place in force at firstAt > the first VISITED together version inside the span (an unvisited one skipped) > the day", () => {
  const conv = { title: null, created_at: "2026-09-24T23:00:00.000Z" };
  const his = ch.chapterTitle({ ...conv, title: "  Ours  " }, { firstAt: "2026-09-25T00:05:00.000Z", lastAt: "2026-09-25T00:05:00.000Z" }, VERSIONS, TZ);
  assert.deepEqual(his, { displayTitle: "Ours", titleFrom: "his" });

  const aTimes = ["2026-09-25T00:05:00.000Z", "2026-09-25T00:10:00.000Z", "2026-09-25T02:30:00.000Z"];
  const inForce = ch.chapterTitle(conv, { firstAt: aTimes[0], lastAt: aTimes[2], times: aTimes }, VERSIONS, TZ);
  assert.deepEqual(inForce, { displayTitle: "The bench by the water", titleFrom: "place" });

  // Starts before any together scene (8:00pm is after 7pm's first line); the bench (V2) and the
  // roof (V3) are inside the span but nobody talked in them in THIS chapter.
  const cTimes = ["2026-09-24T23:00:00.000Z", "2026-09-25T02:30:00.000Z"];
  const visited = ch.chapterTitle(conv, { firstAt: cTimes[0], lastAt: cTimes[1], times: cTimes }, VERSIONS, TZ);
  assert.deepEqual(visited, { displayTitle: "The record store on Congress Street", titleFrom: "place" });

  // Only the roof was set inside the span and replaced before a word: it names nothing.
  const ROOF = [
    V(1, "2026-09-20T00:00:00.000Z", sceneState()),
    V(2, "2026-09-25T00:00:00.000Z", sceneState({ status: "together", location: "the shoot on the roof" })),
    V(3, "2026-09-25T00:00:01.000Z", sceneState({ status: "apart", location: null })),
  ];
  const rTimes = ["2026-09-24T23:00:00.000Z", "2026-09-25T01:00:00.000Z"];
  const roof = ch.chapterTitle(conv, { firstAt: rTimes[0], lastAt: rTimes[1], times: rTimes }, ROOF, TZ);
  assert.deepEqual(roof, { displayTitle: "Thursday evening", titleFrom: "day" });

  const apart = ["2026-09-25T06:00:00.000Z", "2026-09-25T06:10:00.000Z"];
  assert.deepEqual(ch.chapterTitle(conv, { firstAt: apart[0], lastAt: apart[1], times: apart }, VERSIONS, TZ), { displayTitle: "Friday night", titleFrom: "day" });

  const empty = ch.chapterTitle(conv, { firstAt: null, lastAt: null }, VERSIONS, TZ);
  assert.deepEqual(empty, { displayTitle: "Thursday evening", titleFrom: "day" }, "no messages: the day of created_at");

  // Without `times` the versions are taken as the visited ones.
  const given = ch.chapterTitle(conv, { firstAt: cTimes[0], lastAt: cTimes[1] }, [VERSIONS[0], VERSIONS[3]], TZ);
  assert.deepEqual(given, { displayTitle: "The record store on Congress Street", titleFrom: "place" });
});

test("cleanTitle: null and blank -> null; the em dash, en dash and ellipsis repaired; 80 characters pass, 81 are a 400; a non-string is a 400", () => {
  assert.equal(ch.cleanTitle(null), null);
  assert.equal(ch.cleanTitle(""), null);
  assert.equal(ch.cleanTitle("   "), null);
  assert.equal(ch.cleanTitle("  the   first   night "), "the first night");
  assert.equal(ch.cleanTitle("coffee" + EM_DASH + "then the pier"), "coffee -- then the pier");
  assert.equal(ch.cleanTitle("coffee " + EN_DASH + " then the pier"), "coffee -- then the pier");
  assert.equal(ch.cleanTitle("wait" + ELLIPSIS), "wait...");
  assert.ok(!BAD_TYPOGRAPHY.test(ch.cleanTitle("a" + EM_DASH + "b" + ELLIPSIS + EN_DASH + "c")));
  assert.equal(ch.cleanTitle("x".repeat(80)), "x".repeat(80));
  assert.throws(() => ch.cleanTitle("x".repeat(81)), (e) => e.status === 400 && e.code === "validation" && /too long/.test(e.message));
  assert.throws(() => ch.cleanTitle("x".repeat(79) + EM_DASH + "y"), (e) => e.status === 400, "the repair counts toward the 80");
  for (const bad of [undefined, 5, true, {}, ["a"]]) {
    assert.throws(() => ch.cleanTitle(bad), (e) => e.status === 400 && e.code === "validation", JSON.stringify(bad));
  }
});

test("previewText: one line, cut at the last space before 90 with ... appended; empty -> null", () => {
  assert.equal(ch.previewText(null), null);
  assert.equal(ch.previewText("   "), null);
  assert.equal(ch.previewText("see ya\n\ntomorrow   starbrite"), "see ya tomorrow starbrite");
  const ninety = "word ".repeat(18).trim(); // 89 chars
  assert.equal(ch.previewText(ninety), ninety);
  const exact = "a".repeat(90);
  assert.equal(ch.previewText(exact), exact);
  const long = "word ".repeat(30).trim();
  const p = ch.previewText(long);
  assert.ok(p.endsWith("..."), p);
  assert.ok(p.length <= 93, "90 characters and the three dots: " + p.length);
  assert.ok(!p.slice(0, -3).endsWith(" "));
  assert.equal(p.slice(0, -3), "word ".repeat(18).trim());
  assert.equal(ch.previewText("*laughs into your shirt, doesn't move* ...yeah. we kind of are"), "...yeah. we kind of are", "her actions are not the preview");
  assert.equal(ch.previewText("*keeps looking at it a second too long*"), "keeps looking at it a second too long", "only an action: its words, no asterisks");
});

function tables() {
  const conv = (id, extra = {}) => ({ id, title: null, created_at: "2026-09-24T23:00:00.000Z", last_message_at: null, status: "active", ...extra });
  return {
    conversations: [conv("cA"), conv("cB"), conv("cE", { created_at: "2026-09-24T15:00:00.000Z" })],
    messages: [
      messageRow({ id: "a1", conversation_id: "cA", role: "user", content: "hi", created_at: "2026-09-25T00:05:00.000Z", seq: 1 }),
      messageRow({ id: "a2", conversation_id: "cA", role: "assistant", content: "hey yourself", created_at: "2026-09-25T00:06:00.000Z", seq: 2 }),
      messageRow({ id: "a3", conversation_id: "cA", role: "assistant", channel: "operator", content: "operator note", created_at: "2026-09-25T09:00:00.000Z", seq: 3 }),
      messageRow({ id: "a4", conversation_id: "cA", role: "assistant", content: "a held reply", created_at: "2026-09-25T09:30:00.000Z", seq: 4, deliver_at: "2099-01-01T00:00:00.000Z" }),
      messageRow({ id: "b1", conversation_id: "cB", role: "user", content: "", created_at: "2026-09-25T06:00:00.000Z", seq: 1 }),
    ],
    state_versions: VERSIONS,
  };
}

test("conversationViews: every row field plus the title, the span and the preview from VISIBLE story rows only (an operator row and a held reply never count)", async () => {
  const db = fakeDb(tables());
  const views = await ch.conversationViews(db, db.tables.conversations, TZ, new Date("2026-09-26T00:00:00.000Z"));
  assert.deepEqual(views.map((v) => v.id), ["cA", "cB", "cE"], "same order");
  const [a, b, e] = views;
  for (const v of views) {
    for (const k of ["id", "title", "created_at", "last_message_at", "status", "displayTitle", "titleFrom", "firstAt", "lastAt", "preview"]) assert.ok(k in v, k);
  }
  assert.equal(a.displayTitle, "The bench by the water");
  assert.equal(a.titleFrom, "place");
  assert.equal(a.firstAt, "2026-09-25T00:05:00.000Z");
  assert.equal(a.lastAt, "2026-09-25T00:06:00.000Z", "the operator row and the held reply are not the last line");
  assert.deepEqual(a.preview, { role: "assistant", text: "hey yourself", at: "2026-09-25T00:06:00.000Z" });
  assert.equal(b.titleFrom, "day");
  assert.equal(b.displayTitle, "Friday night");
  assert.equal(b.preview, null, "empty content gives no preview");
  assert.equal(e.firstAt, null);
  assert.equal(e.lastAt, null);
  assert.equal(e.preview, null);
  assert.equal(e.displayTitle, "Thursday morning", "no messages: the day of created_at");
  assert.deepEqual(await ch.conversationViews(fakeDb({}), [], TZ), []);
  assert.equal(db.writes.length, 0, "a read writes nothing");
});

test("renameConversation: one batch (the UPDATE and the conversation.rename audit row), the view back with titleFrom his; null restores the automatic title; unknown id 404", async () => {
  const db = fakeDb(tables());
  const view = await ch.renameConversation(db, "cA", "the bench" + EM_DASH + "night one", "owner@example.com", TZ);
  assert.equal(view.displayTitle, "the bench -- night one");
  assert.equal(view.titleFrom, "his");
  assert.equal(view.title, "the bench -- night one");
  assert.equal(db.writes.length, 2);
  assert.match(db.writes[0].sql, /^UPDATE conversations SET title = \?1 WHERE id = \?2/);
  assert.deepEqual(db.writes[0].binds, ["the bench -- night one", "cA"]);
  assert.match(db.writes[1].sql, /INSERT INTO audit_events/);
  assert.equal(db.writes[1].binds[2], "conversation.rename");
  assert.equal(db.writes[1].binds[3], "conversation");
  const back = await ch.renameConversation(fakeDb(tables()), "cA", null, "owner@example.com", TZ);
  assert.equal(back.title, null);
  assert.equal(back.titleFrom, "place");
  await assert.rejects(ch.renameConversation(fakeDb(tables()), "c_nothing", "x", "owner@example.com", TZ), (e) => e.status === 404 && e.code === "not_found");
  await assert.rejects(ch.renameConversation(fakeDb(tables()), "cA", "x".repeat(81), "owner@example.com", TZ), (e) => e.status === 400);
});
