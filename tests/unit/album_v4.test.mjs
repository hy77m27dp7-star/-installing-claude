// The album (SPEC_V4 section 5, plus A3's clips): sceneAt (the newest scene version not
// after the message; together gives its location, apart null, a broken row skipped, no
// versions nulls) and listAlbum on the D1 stand-in (order, the limit and `before`, the
// message join, the groups, never a role him or portrait row, clips beside photos).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sceneState } from "./helpers.mjs";
import { fakeDb, messageRow } from "./helpers_v2.mjs";
import { assetRow } from "./helpers_v3.mjs";
import { loadSrcIfPresent, guard } from "./helpers_v4.mjs";

const album = await loadSrcIfPresent("album");
const t = guard(album, "sceneAt", "listAlbum");

const V = (version, created_at, state) => ({ version, state_json: JSON.stringify(state), created_at });
const VERSIONS = [
  V(1, "2026-09-20T00:00:00.000Z", sceneState()),
  V(2, "2026-09-25T10:00:00.000Z", sceneState({ status: "together", location: "the harbour bench" })),
  V(3, "2026-09-25T12:00:00.000Z", sceneState({ status: "apart", location: null })),
  V(4, "2026-09-26T09:00:00.000Z", sceneState({ status: "together", location: "the pier" })),
];

t("sceneAt: the newest version not after the time; together gives its location; apart gives null; a broken row is skipped; no versions gives nulls", () => {
  assert.deepEqual(album.sceneAt(VERSIONS, "2026-09-25T11:00:00.000Z"), { status: "together", location: "the harbour bench" });
  assert.deepEqual(album.sceneAt(VERSIONS, "2026-09-25T13:00:00.000Z"), { status: "apart", location: null });
  assert.deepEqual(album.sceneAt(VERSIONS, "2026-09-27T00:00:00.000Z"), { status: "together", location: "the pier" });
  assert.deepEqual(album.sceneAt(VERSIONS, "2026-09-26T09:00:00.000Z"), { status: "together", location: "the pier" }, "not after: the same instant counts");
  assert.deepEqual(album.sceneAt(VERSIONS, "2026-09-19T00:00:00.000Z"), { status: null, location: null }, "before every version");
  assert.deepEqual(album.sceneAt([], "2026-09-25T11:00:00.000Z"), { status: null, location: null });
  const broken = [V(1, "2026-09-25T10:00:00.000Z", sceneState({ status: "together", location: "the bench" })), { version: 2, state_json: "{not json", created_at: "2026-09-25T11:00:00.000Z" }];
  assert.deepEqual(album.sceneAt(broken, "2026-09-25T12:00:00.000Z"), { status: "together", location: "the bench" }, "the broken row is skipped and the next newest counts");
  assert.deepEqual(album.sceneAt(VERSIONS, "not a time"), { status: null, location: null });
  assert.deepEqual(album.sceneAt([V(1, "2026-09-25T10:00:00.000Z", sceneState({ status: "together", location: "  " }))], "2026-09-25T12:00:00.000Z"), { status: "together", location: null }, "a blank location is none");
});

function tables() {
  const D = (d) => "2026-09-" + d;
  return {
    visual_assets: [
      { ...assetRow({ id: "img_a", message_id: "m_a", conversation_id: "c1", created_at: D("25T10:30:00.000Z"), prompt: "x".repeat(200) }), with_him: 0 },
      { ...assetRow({ id: "img_b", message_id: "m_b", conversation_id: "c1", created_at: D("25T12:30:00.000Z"), approval_status: "candidate", role: "candidate", prompt: "candidate one" }), with_him: 0 },
      { ...assetRow({ id: "img_us", message_id: "m_us", conversation_id: "c2", created_at: D("26T10:00:00.000Z"), prompt: "selfie of the two of us" }), with_him: 1 },
      { ...assetRow({ id: "vid_clip", message_id: "m_clip", conversation_id: "c2", created_at: D("26T11:00:00.000Z"), role: "video", file: "videos/vid_clip.mp4", prompt: "she waves" }), with_him: 0 },
      { ...assetRow({ id: "img_owner", message_id: null, created_at: D("26T12:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "img_rejected", message_id: "m_r", created_at: D("26T13:00:00.000Z"), approval_status: "rejected" }), with_him: 0 },
      { ...assetRow({ id: "him_1", message_id: "m_h", role: "him", file: "him/him_1.png", created_at: D("26T14:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "por_1", message_id: "m_p", role: "portrait", file: "portraits/por_1.png", created_at: D("26T15:00:00.000Z") }), with_him: 0 },
      { ...assetRow({ id: "vid_face", message_id: null, role: "callface", file: "videos/vid_face.mp4", notes: "callface:idle", created_at: D("26T16:00:00.000Z") }), with_him: 0 },
    ],
    messages: [
      messageRow({ id: "m_a", conversation_id: "c1", created_at: D("25T10:29:00.000Z") }),
      messageRow({ id: "m_b", conversation_id: "c1", created_at: D("25T12:29:00.000Z") }),
      messageRow({ id: "m_us", conversation_id: "c2", created_at: D("26T09:59:00.000Z") }),
      messageRow({ id: "m_clip", conversation_id: "c2", created_at: D("26T10:59:00.000Z") }),
    ],
    state_versions: VERSIONS.map((v, i) => ({ id: "s" + i, entity: "scene", ...v, source: "owner", note: null })),
  };
}

t("listAlbum: newest first, the message's time and conversation, the place from the scene in force, the description cut at 160, clips beside photos; never an owner-fired, rejected, him, portrait or call-face row", async () => {
  const page = await album.listAlbum(fakeDb(tables()));
  assert.deepEqual(page.items.map((i) => i.id), ["vid_clip", "img_us", "img_b", "img_a"]);
  assert.equal(page.nextBefore, null, "under the limit");
  const a = page.items.find((i) => i.id === "img_a");
  assert.equal(a.at, "2026-09-25T10:29:00.000Z", "the message's time");
  assert.equal(a.conversationId, "c1");
  assert.equal(a.messageId, "m_a");
  assert.equal(a.status, "approved");
  assert.equal(a.place, "the harbour bench");
  assert.equal(a.sceneStatus, "together");
  assert.equal(a.description.length, 160);
  assert.equal(a.kind, "photo");
  assert.equal(a.withHim, false);
  const b = page.items.find((i) => i.id === "img_b");
  assert.equal(b.status, "candidate");
  assert.equal(b.place, null, "apart at that time");
  assert.equal(b.sceneStatus, "apart");
  const us = page.items.find((i) => i.id === "img_us");
  assert.equal(us.withHim, true);
  assert.equal(us.place, "the pier");
  const clip = page.items.find((i) => i.id === "vid_clip");
  assert.equal(clip.kind, "clip");
  assert.equal(clip.description, "she waves");
  for (const i of page.items) assert.deepEqual(Object.keys(i).sort(), ["at", "bytes", "conversationId", "description", "id", "kind", "messageId", "place", "provider", "sceneStatus", "status", "withHim"]);
  assert.ok(!JSON.stringify(page).includes("him/") && !JSON.stringify(page).includes("candidates/"), "never the R2 key");
});

t("listAlbum: the limit pages with nextBefore, `before` cuts, the groups filter, a bad group or time is 400", async () => {
  const two = await album.listAlbum(fakeDb(tables()), { limit: 2 });
  assert.deepEqual(two.items.map((i) => i.id), ["vid_clip", "img_us"]);
  assert.equal(two.nextBefore, "2026-09-26T10:00:00.000Z", "the oldest created_at on a full page");
  const next = await album.listAlbum(fakeDb(tables()), { limit: 2, before: two.nextBefore });
  assert.deepEqual(next.items.map((i) => i.id), ["img_b", "img_a"]);
  const approved = await album.listAlbum(fakeDb(tables()), { group: "approved" });
  assert.deepEqual(approved.items.map((i) => i.id), ["vid_clip", "img_us", "img_a"]);
  const candidates = await album.listAlbum(fakeDb(tables()), { group: "candidates" });
  assert.deepEqual(candidates.items.map((i) => i.id), ["img_b"]);
  const us = await album.listAlbum(fakeDb(tables()), { group: "us" });
  assert.deepEqual(us.items.map((i) => i.id), ["img_us"]);
  const all = await album.listAlbum(fakeDb(tables()), { group: "all", limit: 500 });
  assert.equal(all.items.length, 4, "the limit is capped at 200 and the page is what exists");
  await assert.rejects(album.listAlbum(fakeDb(tables()), { group: "mine" }), (e) => e.status === 400 && e.code === "validation");
  await assert.rejects(album.listAlbum(fakeDb(tables()), { before: "yesterday" }), (e) => e.status === 400);
  const empty = await album.listAlbum(fakeDb({ visual_assets: [], messages: [], state_versions: [] }));
  assert.deepEqual(empty, { items: [], nextBefore: null });
});

t("listAlbum (review): `before` in any form Date.parse reads cuts at the same instant; a page edge inside a created_at tie takes the whole tie, so the next page loses nothing", async () => {
  const rfc = await album.listAlbum(fakeDb(tables()), { limit: 2, before: "Sat, 26 Sep 2026 10:00:00 GMT" });
  const iso = await album.listAlbum(fakeDb(tables()), { limit: 2, before: "2026-09-26T10:00:00.000Z" });
  assert.deepEqual(rfc.items.map((i) => i.id), iso.items.map((i) => i.id));
  assert.deepEqual(rfc.items.map((i) => i.id), ["img_b", "img_a"]);
  const same = "2026-09-27T10:00:00.000Z";
  const tied = {
    visual_assets: ["img_t1", "img_t2", "img_t3"].map((id, k) => ({ ...assetRow({ id, message_id: "m_" + id, conversation_id: "c1", created_at: same }), with_him: 0 }))
      .concat([{ ...assetRow({ id: "img_old", message_id: "m_old", conversation_id: "c1", created_at: "2026-09-26T10:00:00.000Z" }), with_him: 0 }]),
    messages: [],
    state_versions: [],
  };
  const first = await album.listAlbum(fakeDb(tied), { limit: 2 });
  assert.deepEqual(first.items.map((i) => i.id).sort(), ["img_t1", "img_t2", "img_t3"], "the whole tie on this page");
  assert.equal(first.nextBefore, same);
  const second = await album.listAlbum(fakeDb(tied), { limit: 2, before: first.nextBefore });
  assert.deepEqual(second.items.map((i) => i.id), ["img_old"]);
  assert.equal(second.nextBefore, null, "nothing older");
  const exact = await album.listAlbum(fakeDb(tied), { limit: 4 });
  assert.equal(exact.items.length, 4);
  assert.equal(exact.nextBefore, null, "a page that holds everything says so");
});
