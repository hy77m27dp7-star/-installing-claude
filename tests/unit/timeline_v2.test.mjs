// src/timeline.ts: one merged, dated scroll (SPEC_V2 section X) and the places picker.
// Runs against the D1 stand-in: every table read gets its fixture rows back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { fakeDb, messageRow, placeRow, personRow, logRow, secretEnv } from "./helpers_v2.mjs";
import { historyRow } from "./helpers.mjs";

const { getTimeline, placesForPicker } = await loadSrc("timeline");

const D = (n) => `2026-09-${String(n).padStart(2, "0")}T12:00:00.000Z`;

function tables() {
  return {
    history: [
      historyRow({ id: "h1", seq: 1, title: "the bench", occurred: null, body: "they sat", created_at: D(3), updated_at: D(3) }),
      historyRow({ id: "h2", seq: 2, title: "the diner", occurred: null, body: "chili fries", created_at: D(9), updated_at: D(9) }),
    ],
    visual_assets: [
      { id: "img1", file: "candidates/img1.png", role: "scene", sha256: "ab", bytes: 10, approval_status: "approved", conversation_id: "c1", message_id: "m3", prompt: "couch, hoodie", provider: "stub", model: "x", notes: null, created_at: D(5), decided_at: D(5) },
      { id: "img2", file: "candidates/img2.png", role: "candidate", sha256: "cd", bytes: 10, approval_status: "rejected", conversation_id: "c1", message_id: null, prompt: "rejected one", provider: "stub", model: "x", notes: null, created_at: D(6), decided_at: D(6) },
    ],
    life_log: [logRow({ id: "ll1", occurred: D(7), created_at: D(7), note: "burnt the rice" })],
    state_versions: [
      { id: "s1", entity: "relationship", version: 1, state_json: JSON.stringify({ status: "strangers" }), source: "seed", note: null, created_at: D(1) },
      { id: "s2", entity: "relationship", version: 2, state_json: JSON.stringify({ status: "talking" }), source: "owner", note: "they talked", created_at: D(8) },
      { id: "s3", entity: "scene", version: 1, state_json: JSON.stringify({ status: "none" }), source: "seed", note: null, created_at: D(1) },
    ],
    messages: [
      messageRow({ id: "m1", role: "user", content: "hey", created_at: D(2), seq: 1, reply_to_id: null }),
      messageRow({ id: "m2", content: "hey yourself", created_at: D(2), seq: 2, reply_to_id: "m1" }),
      messageRow({ id: "m3", content: "one photo", created_at: D(5), seq: 3, reply_to_id: "m1", image_id: "img1", image_status: "ready" }),
      messageRow({ id: "m4", content: "a first text from her", created_at: D(10), seq: 4, reply_to_id: null }),
      messageRow({ id: "m5", content: "with a clip", created_at: D(11), seq: 5, reply_to_id: "m1", media_id: "md1" }),
    ],
    media_library: [{ id: "md1", kind: "clip", title: "fire escape take 2", description: "her, singing, one take", key: "library/md1.mp3", mime: "audio/mpeg", bytes: 100, sha256: "ef", status: "active", created_at: D(4) }],
    first_texts_daily: [{ day: "2026-09-10", count: 1 }],
    conversations: [{ id: "c1", title: "one", created_at: D(1), last_message_at: D(11), status: "active" }],
  };
}

const items = (r) => (Array.isArray(r) ? r : r.items ?? r.entries ?? r.rows);
const dateOf = (i) => i.date ?? i.at ?? i.when ?? i.occurred ?? i.created_at;
const kindOf = (i) => i.kind ?? i.type ?? i.entity;

test("getTimeline: an array of dated items, oldest first (newest at the bottom)", async () => {
  const r = await getTimeline(fakeDb(tables()), secretEnv(), {});
  const list = items(r);
  assert.ok(Array.isArray(list) && list.length >= 5, "items: " + JSON.stringify(r).slice(0, 300));
  const dates = list.map(dateOf);
  for (const d of dates) assert.ok(Number.isFinite(Date.parse(d)), "every item carries a date: " + JSON.stringify(d));
  for (let i = 1; i < dates.length; i++) assert.ok(Date.parse(dates[i]) >= Date.parse(dates[i - 1]), "not sorted at " + i);
});

test("getTimeline: history, approved photos, media sent, life notes, state versions and first texts all appear", async () => {
  const list = items(await getTimeline(fakeDb(tables()), secretEnv(), {}));
  const text = JSON.stringify(list);
  for (const needle of ["the bench", "the diner", "img1", "burnt the rice", "fire escape take 2", "m4"]) assert.ok(text.includes(needle), "missing " + needle);
  assert.ok(!text.includes("img2"), "a rejected candidate is not on the timeline");
  const kinds = new Set(list.map(kindOf).filter(Boolean));
  assert.ok(kinds.size >= 4, "kinds: " + [...kinds].join(", "));
});

test("getTimeline: every item links somewhere (a message id or a state version) and carries a kind", async () => {
  const list = items(await getTimeline(fakeDb(tables()), secretEnv(), {}));
  for (const i of list) {
    assert.ok(kindOf(i), "kind on " + JSON.stringify(i).slice(0, 120));
    const link = i.messageId ?? i.message_id ?? i.href ?? i.link ?? i.version ?? i.id ?? i.ref;
    assert.ok(link !== undefined, "no link on " + JSON.stringify(i).slice(0, 120));
  }
});

test("getTimeline: limit caps the list to the newest items; before pages further back", async () => {
  const two = items(await getTimeline(fakeDb(tables()), secretEnv(), { limit: 2 }));
  assert.equal(two.length, 2);
  const all = items(await getTimeline(fakeDb(tables()), secretEnv(), {}));
  assert.equal(dateOf(two[two.length - 1]), dateOf(all[all.length - 1]), "the newest item survives a limit");
  const older = items(await getTimeline(fakeDb(tables()), secretEnv(), { before: D(6) }));
  assert.ok(older.length > 0 && older.length < all.length);
  for (const i of older) assert.ok(Date.parse(dateOf(i)) < Date.parse(D(6)), "before cut: " + dateOf(i));
});

test("getTimeline: empty tables -> empty list, no throw", async () => {
  const list = items(await getTimeline(fakeDb({}), secretEnv(), {}));
  assert.deepEqual(list, []);
});

test("placesForPicker: active place threads only, title and detail, alphabetical", () => {
  const out = placesForPicker([
    placeRow({ id: "p2", title: "the roof", detail: "tar, one chair" }),
    placeRow({ id: "p1", title: "the laundromat on 9th" }),
    placeRow({ id: "p3", title: "gone", status: "dropped" }),
    personRow(),
  ]);
  assert.ok(Array.isArray(out));
  const titles = out.map((p) => (typeof p === "string" ? p : p.title ?? p.label ?? p.name));
  assert.deepEqual(titles, ["the laundromat on 9th", "the roof"]);
  assert.deepEqual(placesForPicker([]), []);
});
