// src/roll.ts (DESIGN_EXPERIENCE 8.1): her camera roll. Every APPROVED picture and clip of
// hers, bound to a message or not; never a candidate, rejected, him, portrait, call-face or
// master row. Runs on the D1 stand-in (helpers_v2 fakeDb).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, sceneState } from "./helpers.mjs";
import { fakeDb, messageRow } from "./helpers_v2.mjs";
import { assetRow } from "./helpers_v3.mjs";

const roll = await loadSrc("roll");

const D = (d) => "2026-09-" + d;
const V = (version, created_at, state) => ({ id: "sv" + version, entity: "scene", version, state_json: JSON.stringify(state), created_at, source: "owner", note: null });

function tables() {
  return {
    visual_assets: [
      { ...assetRow({ id: "img_bound", message_id: "m_bound", conversation_id: "c1", created_at: D("25T10:30:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "img_us", message_id: "m_us", conversation_id: "c2", created_at: D("26T10:00:00.000Z") }), with_him: 1 },
      { ...assetRow({ id: "vid_clip", role: "video", file: "videos/vid_clip.mp4", message_id: "m_clip", conversation_id: "c2", notes: "source:img_bound|task:t1|since x", created_at: D("26T11:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "vid_bare", role: "video", file: "videos/vid_bare.mp4", message_id: null, conversation_id: null, notes: null, created_at: D("26T11:30:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "img_owner", message_id: null, conversation_id: "c9", created_at: D("26T12:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "img_cand", role: "candidate", approval_status: "candidate", message_id: "m_c", created_at: D("26T12:30:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "img_rej", role: "candidate", approval_status: "rejected", message_id: "m_r", created_at: D("26T13:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "him_1", role: "him", file: "him/him_1.png", message_id: null, created_at: D("26T14:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "por_1", role: "portrait", file: "portraits/por_1.png", message_id: null, created_at: D("26T15:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "vid_face", role: "callface", file: "videos/vid_face.mp4", message_id: null, notes: "callface:idle", created_at: D("26T16:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "master-05", role: "master", file: "images/masters/05.png", message_id: null, created_at: D("26T17:00:00.000Z") }), with_him: 0 },
    ],
    messages: [
      messageRow({ id: "m_bound", conversation_id: "c1", created_at: D("25T10:29:00.000Z") }),
      messageRow({ id: "m_us", conversation_id: "c2", created_at: D("26T09:59:00.000Z") }),
      messageRow({ id: "m_clip", conversation_id: "c2", created_at: D("26T10:59:00.000Z") }),
    ],
    state_versions: [
      V(1, D("20T00:00:00.000Z"), sceneState()),
      V(2, D("25T10:00:00.000Z"), sceneState({ status: "together", location: "the harbour bench" })),
      V(3, D("26T09:00:00.000Z"), sceneState({ status: "apart", location: null })),
    ],
  };
}

test("rollEligible: approved scene, candidate and video rows only", () => {
  assert.equal(roll.rollEligible({ role: "scene", approval_status: "approved" }), true);
  assert.equal(roll.rollEligible({ role: "candidate", approval_status: "approved" }), true);
  assert.equal(roll.rollEligible({ role: "video", approval_status: "approved" }), true);
  for (const role of ["master", "him", "portrait", "callface", "legacy_archive", "blacklisted", "missing"]) {
    assert.equal(roll.rollEligible({ role, approval_status: "approved" }), false, role);
  }
  for (const status of ["candidate", "rejected", "pending", "generating", "failed"]) {
    assert.equal(roll.rollEligible({ role: "scene", approval_status: status }), false, status);
  }
  assert.deepEqual([...roll.ROLL_ROLES], ["scene", "candidate", "video"]);
  assert.equal(roll.ROLL_LIMIT_DEFAULT, 60);
  assert.equal(roll.ROLL_LIMIT_MAX, 200);
});

test("clipSourceOf: the part before the first | when it starts with source:, trimmed; null otherwise", () => {
  assert.equal(roll.clipSourceOf("source:img_a|task:t|since x"), "img_a");
  assert.equal(roll.clipSourceOf("source: img_b "), "img_b");
  assert.equal(roll.clipSourceOf("source:|task:t"), null);
  assert.equal(roll.clipSourceOf("callface:idle"), null);
  assert.equal(roll.clipSourceOf("task:t|source:img_a"), null);
  assert.equal(roll.clipSourceOf(""), null);
  assert.equal(roll.clipSourceOf(null), null);
});

test("listRoll: approved pictures and clips newest first, the owner-fired picture in; candidate, rejected, him, portrait, call-face and master out", async () => {
  const page = await roll.listRoll(fakeDb(tables()));
  assert.deepEqual(page.items.map((i) => i.id), ["img_owner", "vid_bare", "vid_clip", "img_us", "img_bound"]);
  assert.equal(page.nextBefore, null);
  for (const i of page.items) {
    assert.deepEqual(Object.keys(i).sort(), ["at", "conversationId", "id", "kind", "messageId", "place", "poster", "url", "us"]);
    assert.equal(i.url, "/media/" + i.id);
  }
});

test("listRoll: us from with_him, kind clip for video, the poster from notes, at and place from the message for a bound row, the asset for an unbound one", async () => {
  const page = await roll.listRoll(fakeDb(tables()));
  const by = Object.fromEntries(page.items.map((i) => [i.id, i]));
  assert.equal(by.img_us.us, true);
  assert.equal(by.img_bound.us, false);
  assert.equal(by.vid_clip.kind, "clip");
  assert.equal(by.vid_clip.poster, "/media/img_bound");
  assert.equal(by.vid_bare.kind, "clip");
  assert.equal(by.vid_bare.poster, null, "a clip with no source has no poster");
  assert.equal(by.img_bound.kind, "photo");
  assert.equal(by.img_bound.poster, null);
  assert.equal(by.img_bound.at, D("25T10:29:00.000Z"), "the message's time");
  assert.equal(by.img_bound.place, "the harbour bench", "the scene in force at the message");
  assert.equal(by.img_bound.messageId, "m_bound");
  assert.equal(by.img_bound.conversationId, "c1");
  assert.equal(by.img_us.place, null, "apart at the time: no place");
  assert.equal(by.img_owner.at, D("26T12:00:00.000Z"), "unbound: the asset's time");
  assert.equal(by.img_owner.place, null, "unbound: no place even inside a together scene");
  assert.equal(by.img_owner.messageId, null);
  assert.equal(by.img_owner.conversationId, "c9", "unbound: the row's conversation");
});

test("listRoll: limit and before page the roll; nextBefore is the oldest row's created_at on a full page; a bad before is a 400", async () => {
  const two = await roll.listRoll(fakeDb(tables()), { limit: 2 });
  assert.deepEqual(two.items.map((i) => i.id), ["img_owner", "vid_bare"]);
  assert.equal(two.nextBefore, D("26T11:30:00.000Z"));
  const next = await roll.listRoll(fakeDb(tables()), { limit: 2, before: two.nextBefore });
  assert.deepEqual(next.items.map((i) => i.id), ["vid_clip", "img_us"]);
  const last = await roll.listRoll(fakeDb(tables()), { limit: 2, before: next.nextBefore });
  assert.deepEqual(last.items.map((i) => i.id), ["img_bound"]);
  assert.equal(last.nextBefore, null);
  const rfc = await roll.listRoll(fakeDb(tables()), { limit: 2, before: "Sat, 26 Sep 2026 11:30:00 GMT" });
  assert.deepEqual(rfc.items.map((i) => i.id), ["vid_clip", "img_us"], "any time Date.parse reads");
  await assert.rejects(roll.listRoll(fakeDb(tables()), { before: "yesterday" }), (e) => e.status === 400 && e.code === "validation");
  const clamped = await roll.listRoll(fakeDb(tables()), { limit: 9999 });
  assert.equal(clamped.items.length, 5);
  const empty = await roll.listRoll(fakeDb({ visual_assets: [], messages: [], state_versions: [] }));
  assert.deepEqual(empty, { items: [], nextBefore: null });
});

test("listRoll: a tie at the page edge joins the page (listAlbum's rule)", async () => {
  const at = D("26T10:00:00.000Z");
  const tied = {
    visual_assets: [
      { ...assetRow({ id: "a1", message_id: null, created_at: D("26T12:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "a2", message_id: null, created_at: at }), with_him: 0 },
      { ...assetRow({ id: "a3", message_id: null, created_at: at }), with_him: 0 },
      { ...assetRow({ id: "a4", message_id: null, created_at: D("25T10:00:00.000Z") }), with_him: 0 },
    ],
    messages: [],
    state_versions: [],
  };
  const first = await roll.listRoll(fakeDb(tied), { limit: 2 });
  assert.deepEqual(first.items.map((i) => i.id), ["a1", "a3", "a2"], "the tie at the edge joins the page");
  assert.equal(first.nextBefore, at);
  const second = await roll.listRoll(fakeDb(tied), { limit: 2, before: first.nextBefore });
  assert.deepEqual(second.items.map((i) => i.id), ["a4"], "nothing is lost or repeated");
});
