// src/us.ts (DESIGN_EXPERIENCE 8.7): the story of the two of them. Visits to places (an
// unvisited scene is no visit), her kept lines as pull quotes (actions stripped), her names
// for each other, and the view on the D1 stand-in: exactly seven keys, drift left out, her
// kept lines only, never his, never a dropped one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, sceneState, relationshipState, historyRow } from "./helpers.mjs";
import { fakeDb, messageRow } from "./helpers_v2.mjs";
import { placeRow } from "./helpers_v4.mjs";
import { settingsV5, TZ } from "./helpers_v5.mjs";

const us = await loadSrc("us");

const V = (version, created_at, state) => ({ id: "sv" + version, entity: "scene", version, state_json: JSON.stringify(state), created_at, source: "owner", note: null });
const VERSIONS = [
  V(1, "2026-09-24T00:00:00.000Z", sceneState()),
  V(2, "2026-09-24T20:00:00.000Z", sceneState({ status: "together", location: "at the bench by the water" })),
  V(3, "2026-09-24T21:00:00.000Z", sceneState({ status: "together", location: "the bench  by the water" })), // an edit: the same place
  V(4, "2026-09-25T18:00:00.000Z", sceneState({ status: "together", location: "the shoot on the roof" })), // set and replaced before a word
  V(5, "2026-09-25T18:00:05.000Z", sceneState({ status: "together", location: "in the record store on Congress Street" })),
  V(6, "2026-09-25T22:00:00.000Z", sceneState({ status: "apart", location: null })),
  V(7, "2026-09-26T20:00:00.000Z", sceneState({ status: "together", location: "The Bench by the water" })),
];
const TIMES = [
  "2026-09-24T20:05:00.000Z", "2026-09-24T21:10:00.000Z", // V2, V3
  "2026-09-25T18:30:00.000Z", // V5
  "2026-09-25T23:00:00.000Z", // V6
  "2026-09-26T20:10:00.000Z", // V7
];

test("togetherPlaces: a visit starts where the together place changes among VISITED versions; an edit of the same place is the same visit; an unvisited scene is no visit; oldest first", () => {
  const places = us.togetherPlaces(VERSIONS, TIMES);
  assert.deepEqual(places, [
    { title: "the bench by the water", norm: "the bench by the water", first: "2026-09-24T20:00:00.000Z", times: 2 },
    { title: "the record store on Congress Street", norm: "the record store on congress street", first: "2026-09-25T18:00:05.000Z", times: 1 },
  ]);
  assert.ok(!places.some((p) => /roof/.test(p.title)), "the roof was never a visit");
  assert.deepEqual(us.togetherPlaces(VERSIONS, []), [], "no words, no visits");
  assert.deepEqual(us.togetherPlaces([], TIMES), []);
  // Straight from one place to another (no apart between) is a new visit each time.
  const hop = [
    V(1, "2026-09-24T20:00:00.000Z", sceneState({ status: "together", location: "the pier" })),
    V(2, "2026-09-24T21:00:00.000Z", sceneState({ status: "together", location: "the diner" })),
    V(3, "2026-09-24T22:00:00.000Z", sceneState({ status: "together", location: "the pier" })),
  ];
  assert.deepEqual(us.togetherPlaces(hop, ["2026-09-24T20:30:00.000Z", "2026-09-24T21:30:00.000Z", "2026-09-24T22:30:00.000Z"]).map((p) => [p.title, p.times]), [["the pier", 2], ["the diner", 1]]);
});

test("quoteText: every *action* removed, one line, cut at the last space before 240 with ...; empty -> null", () => {
  assert.equal(us.quoteText("*laughs*\n\nfine. fine\n\nyou win this one\n\n*sits back*"), "fine. fine you win this one");
  assert.equal(us.quoteText("that was sweet *looks away* by the way"), "that was sweet by the way");
  assert.equal(us.quoteText("*shrugs*"), null);
  assert.equal(us.quoteText("   "), null);
  assert.equal(us.quoteText(null), null);
  const long = us.quoteText("word ".repeat(80));
  assert.ok(long.endsWith("...") && long.length <= 243, long.length);
  assert.equal(long.slice(0, -3), "word ".repeat(48).trim());
  assert.equal(us.quoteText("x".repeat(240)), "x".repeat(240));
});

test("splitNicknames: commas, semicolons, ' / ' and newlines; trimmed; empty and 'none established' dropped; repeats kept once without regard to case", () => {
  assert.deepEqual(us.splitNicknames("Starbrite"), ["Starbrite"]);
  assert.deepEqual(us.splitNicknames("Starbrite; starbrite, Star / Trouble\nkid ,, "), ["Starbrite", "Star", "Trouble", "kid"]);
  assert.deepEqual(us.splitNicknames("AC/DC"), ["AC/DC"], "a slash with no spaces is part of a name");
  assert.deepEqual(us.splitNicknames("none established"), []);
  assert.deepEqual(us.splitNicknames("none"), []);
  assert.deepEqual(us.splitNicknames(""), []);
  assert.deepEqual(us.splitNicknames(null), []);
  assert.deepEqual(us.splitNicknames(undefined), []);
});

function tables() {
  const conv = (id, extra = {}) => ({ id, title: null, created_at: "2026-09-24T19:00:00.000Z", last_message_at: null, status: "active", ...extra });
  const m = (id, conversation_id, created_at, extra = {}) => messageRow({ id, conversation_id, created_at, ...extra });
  return {
    conversations: [conv("cB", { created_at: "2026-09-25T18:10:00.000Z" }), conv("cA"), conv("cD", { status: "drift" }), conv("cX", { status: "deleted" }), conv("cE", { created_at: "2026-09-27T00:00:00.000Z" })],
    messages: [
      m("a1", "cA", TIMES[0], { role: "user", content: "hi", seq: 1 }),
      m("a2", "cA", TIMES[1], { content: "*laughs*\n\nfine. you win this one\n\n*sits back*", seq: 2 }),
      m("a3", "cA", "2026-09-24T21:20:00.000Z", { content: "a line he dropped", seq: 3 }),
      m("a4", "cA", "2026-09-24T21:30:00.000Z", { role: "user", content: "his own line", seq: 4 }),
      m("a5", "cA", "2026-09-24T21:40:00.000Z", { content: "*shrugs*", seq: 5 }),
      m("b1", "cB", TIMES[2], { content: "that was sweet by the way", seq: 1 }),
      m("b2", "cB", TIMES[3], { role: "user", content: "night", seq: 2 }),
      m("b3", "cB", TIMES[4], { content: "you came back", seq: 3 }),
      m("b4", "cB", "2026-09-26T20:20:00.000Z", { content: "a held line", seq: 4, deliver_at: "2099-01-01T00:00:00.000Z" }),
      m("d1", "cD", "2026-09-25T12:00:00.000Z", { content: "a drift line", seq: 1 }),
    ],
    message_marks: [
      { message_id: "a2", mark: "keep", note: null, actor: "o", created_at: "2026-09-25T00:00:00.000Z" },
      { message_id: "a3", mark: "drop", note: null, actor: "o", created_at: "2026-09-25T00:00:00.000Z" },
      { message_id: "a4", mark: "keep", note: null, actor: "o", created_at: "2026-09-25T00:00:00.000Z" },
      { message_id: "a5", mark: "keep", note: null, actor: "o", created_at: "2026-09-25T00:00:00.000Z" },
      { message_id: "b1", mark: "keep", note: null, actor: "o", created_at: "2026-09-26T00:00:00.000Z" },
      { message_id: "b4", mark: "keep", note: null, actor: "o", created_at: "2026-09-26T00:00:00.000Z" },
      { message_id: "d1", mark: "keep", note: null, actor: "o", created_at: "2026-09-26T00:00:00.000Z" },
    ],
    history: [
      historyRow({ id: "h_late", seq: 1, title: "the record store", occurred: "2026-09-25" }),
      historyRow({ id: "h_none", seq: 2, title: "an undated thing", occurred: null }),
      historyRow({ id: "h_first", seq: 3, title: "the bench, the first night", occurred: "2026-09-24" }),
      historyRow({ id: "h_old", seq: 4, title: "superseded", occurred: "2026-09-20", status: "superseded" }),
    ],
    state_versions: [
      ...VERSIONS,
      { id: "rel1", entity: "relationship", version: 13, state_json: JSON.stringify(relationshipState({ status: "seeing each other, early", his_name: "Justin", nicknames: "Starbrite; none established" })), source: "owner", note: null, created_at: "2026-09-25T00:00:00.000Z" },
    ],
    places: [
      placeRow({ id: "pl_bench", title: "the bench by the water", picture_key: "places/the-bench-abc123.png" }),
      placeRow({ id: "pl_store", title: "the record store on Congress Street", title_norm: "the record store on congress street" }),
    ],
  };
}

test("usView: exactly the seven keys; drift and deleted chapters left out, oldest first; moments by occurred then seq; places with their id and picture; her kept lines only, newest first, never his, never a dropped one, never a held one; standing and nicknames", async () => {
  const db = fakeDb(tables());
  const view = await us.usView(db, settingsV5({ timezone: TZ, storyClockEnabled: false }), new Date("2026-09-27T12:00:00.000Z"));
  assert.deepEqual(Object.keys(view).sort(), ["chapters", "kept", "moments", "nicknames", "places", "since", "standing"]);
  assert.deepEqual(view.chapters.map((c) => c.id), ["cA", "cB"], "no drift, no deleted, none without a word; oldest first");
  assert.deepEqual(view.chapters[0], { id: "cA", title: "The bench by the water", from: TIMES[0], to: "2026-09-24T21:40:00.000Z" });
  assert.equal(view.chapters[1].title, "The record store on Congress Street");
  assert.equal(view.chapters[1].to, TIMES[4], "a held reply never closes a chapter");
  assert.equal(view.since, TIMES[0]);
  assert.deepEqual(view.moments, [
    { id: "h_first", title: "the bench, the first night", at: "2026-09-24" },
    { id: "h_late", title: "the record store", at: "2026-09-25" },
    { id: "h_none", title: "an undated thing", at: null },
  ]);
  assert.deepEqual(view.places, [
    { title: "the bench by the water", first: "2026-09-24T20:00:00.000Z", times: 2, placeId: "pl_bench", picture: true },
    { title: "the record store on Congress Street", first: "2026-09-25T18:00:05.000Z", times: 1, placeId: "pl_store", picture: false },
  ]);
  assert.deepEqual(view.kept, [
    { id: "b1", text: "that was sweet by the way", at: TIMES[2], conversationId: "cB" },
    { id: "a2", text: "fine. you win this one", at: TIMES[1], conversationId: "cA" },
  ]);
  assert.equal(view.standing, "seeing each other, early");
  assert.deepEqual(view.nicknames, ["Starbrite"]);
  assert.equal(db.writes.length, 0, "Us writes nothing");
  const text = JSON.stringify(view);
  for (const word of ["his_name", "Justin", "untold", "guess", "weight", "phase"]) assert.ok(!text.includes(word), word);
});

test("usView: an empty record answers empty values, never a failure", async () => {
  const view = await us.usView(fakeDb({}), settingsV5({ timezone: TZ, storyClockEnabled: false }), new Date("2026-09-27T12:00:00.000Z"));
  assert.deepEqual(view, { since: null, standing: null, nicknames: [], chapters: [], moments: [], places: [], kept: [] });
});
