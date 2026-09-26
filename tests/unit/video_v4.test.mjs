// Clips in v4 (SPEC_V4 section 2 and amendment A3): the claim note with a kind and its
// re-stamp, pollClip on a call-face row (no 404, the kind kept on a takeover, the candidate
// write carrying callface:<kind> while a plain clip gets NULL), startClip with the role, the
// kind, the ratio and the seconds, the source chosen for a message clip, the identity words,
// and startClipForMessage binding the row to its message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { fakeDb, secretEnv, messageRow } from "./helpers_v2.mjs";
import { assetRow } from "./helpers_v3.mjs";
import { loadSrcIfPresent, guard, settingsV4, callfaceRow, fakeR2 } from "./helpers_v4.mjs";

const video = await loadSrcIfPresent("video");
const providers = await loadSrcIfPresent("providers/index");
const t = guard(video, "claimNote", "parseClaimNote", "pollClip", "startClip", "chooseClipSource", "clipPromptText", "startClipForMessage", "CLIP_IDENTITY_TEXT");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const SINCE = "2026-09-29T19:00:00.000Z";

function master(id = "master-00", file = "images/masters/00_face.png") {
  return { id, file, role: "master", sha256: PNG_SHA, bytes: PNG.length, approval_status: "approved", conversation_id: null, message_id: null, prompt: null, provider: null, model: null, notes: null, created_at: "2026-09-24T00:00:00.000Z", decided_at: null };
}

function env() {
  return {
    ...secretEnv(),
    MEDIA: fakeR2(),
    ASSETS: { fetch: async () => new Response(PNG.slice(0)) },
  };
}

const S = settingsV4({ videoProvider: "stub", videoCostUsd: 0.25, videoSeconds: 5, videoRatio: "720:1280" });

t("claimNote with four arguments carries kind:<kind>; parseClaimNote reads it; a re-stamp keeps it; a plain note reads kind null", () => {
  const note = video.claimNote("master-00", "stub-task-7", SINCE, "listening");
  assert.equal(note, "source:master-00|task:stub-task-7|since " + SINCE + "|kind:listening");
  assert.deepEqual(video.parseClaimNote(note), { sourceId: "master-00", taskId: "stub-task-7", since: SINCE, kind: "listening" });
  const later = "2026-09-29T19:20:00.000Z";
  const restamped = video.claimNote("master-00", "stub-task-7", later, video.parseClaimNote(note).kind);
  assert.equal(video.parseClaimNote(restamped).kind, "listening", "the kind survives a takeover");
  assert.equal(video.parseClaimNote(restamped).since, later);
  assert.equal(video.claimNote("master-00", "stub-task-7", SINCE), "source:master-00|task:stub-task-7|since " + SINCE);
  assert.equal(video.parseClaimNote(video.claimNote("master-00", "t", SINCE)).kind, null);
  assert.equal(video.claimNote("master-00", "t", SINCE, "dancing"), "source:master-00|task:t|since " + SINCE, "an unknown kind is not written");
  assert.equal(video.parseClaimNote("callface:idle"), null);
});

// A generating call-face row whose stub task answers RUNNING once and SUCCEEDED after.
function generatingFace(kind, taskId, since = new Date().toISOString(), id = "vid_face_" + kind) {
  return callfaceRow({ kind, id, approval_status: "generating", sha256: null, bytes: null, decided_at: null, provider: "stub", notes: video.claimNote("master-00", taskId, since, kind) });
}

t("pollClip on a call-face row: no 404; running on the first poll; the candidate write carries callface:<kind>; a plain clip's candidate carries NULL", async () => {
  const face = generatingFace("idle", "stub-task-v4-face-1");
  const db = fakeDb({ visual_assets: [face, master()], usage_daily: [] });
  const e = env();
  const first = await video.pollClip(e, db, S, face.id, "test");
  assert.equal(first.status, "running");
  const second = await video.pollClip(e, db, S, face.id, "test");
  assert.equal(second.status, "candidate");
  assert.equal(second.asset.role, "callface");
  assert.equal(second.asset.notes, "callface:idle");
  assert.match(second.asset.sha256, /^[0-9a-f]{64}$/);
  const write = db.writes.find((w) => /approval_status = 'candidate'/.test(w.sql) && w.binds[0] === face.id);
  assert.ok(write, "the candidate write");
  assert.equal(write.binds[6], "callface:idle", "notes = callface:<kind>: " + JSON.stringify(write.binds));
  assert.ok(e.MEDIA.has(face.file), "the mp4 is in R2 under videos/");
  const audit = db.writes.find((w) => /audit_events/.test(w.sql) && w.binds.includes("video.generate"));
  assert.ok(audit && /"kind":"idle"/.test(audit.binds.join(" ")) && /"role":"callface"/.test(audit.binds.join(" ")), "the audit names the role and the kind");

  const plain = { ...assetRow({ id: "vid_plain", file: "videos/vid_plain.mp4", role: "video", sha256: null, bytes: null, approval_status: "generating", conversation_id: null, message_id: null, prompt: "she turns", provider: "stub", model: "gen4_turbo", decided_at: null }), notes: video.claimNote("master-00", "stub-task-v4-plain-1", new Date().toISOString()) };
  const db2 = fakeDb({ visual_assets: [plain, master()], usage_daily: [] });
  await video.pollClip(e, db2, S, plain.id, "test");
  const done = await video.pollClip(e, db2, S, plain.id, "test");
  assert.equal(done.status, "candidate");
  assert.equal(done.asset.notes, null);
  const plainWrite = db2.writes.find((w) => /approval_status = 'candidate'/.test(w.sql) && w.binds[0] === plain.id);
  assert.equal(plainWrite.binds[6], null, "a plain clip's notes clear");
});

t("pollClip: an abandoned call-face claim (older than the lease) is re-stamped with the kind intact", async () => {
  const stale = generatingFace("talking", "stub-task-v4-face-stale", "2026-09-01T00:00:00.000Z", "vid_face_stale");
  const db = fakeDb({ visual_assets: [stale, master()], usage_daily: [] });
  const r = await video.pollClip(env(), db, S, stale.id, "test");
  assert.equal(r.status, "running");
  const restamp = db.writes.find((w) => /UPDATE visual_assets SET notes = \?2 WHERE id = \?1 AND approval_status = 'generating' AND notes IS \?3/.test(w.sql));
  assert.ok(restamp, "the takeover re-stamp");
  const fresh = video.parseClaimNote(restamp.binds[1]);
  assert.equal(fresh.kind, "talking", "the kind rides along: " + restamp.binds[1]);
  assert.equal(fresh.taskId, "stub-task-v4-face-stale");
  assert.ok(Date.parse(fresh.since) > Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(r.asset.notes, restamp.binds[1]);
});

t("pollClip: a row that is not a clip role is 404; a plain photo row too", async () => {
  const photo = assetRow({ id: "img_photo", approval_status: "generating", notes: "claimed" });
  const db = fakeDb({ visual_assets: [photo] });
  await assert.rejects(video.pollClip(env(), db, S, "img_photo", "test"), (e) => e.status === 404);
  await assert.rejects(video.pollClip(env(), db, S, "vid_nothing", "test"), (e) => e.status === 404);
});

t("startClip with role callface writes role callface and the kind in the claim note; the ratio and seconds overrides reach the provider and the audit", async () => {
  const db = fakeDb({ visual_assets: [master()], usage_daily: [] });
  const stub = providers.registry.video.stub;
  const seen = [];
  providers.registry.video.stub = { ...stub, async startImageToVideo(e, req) { seen.push(req); return stub.startImageToVideo(e, req); } };
  try {
    const row = await video.startClip(env(), db, S, { sourceAssetId: "master-00", description: "she blinks once", actor: "test", role: "callface", kind: "listening", ratio: "960:960", seconds: 5 });
    assert.equal(row.role, "callface");
    assert.equal(row.approval_status, "generating");
    assert.ok(row.file.startsWith("videos/") && row.file.endsWith(".mp4"));
    assert.equal(video.parseClaimNote(row.notes).kind, "listening");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ratio, "960:960");
    assert.equal(seen[0].duration, 5);
    assert.equal(seen[0].model, "gen4_turbo");
    assert.ok(seen[0].promptImage.startsWith("data:image/png;base64,"));
    const insert = db.writes.find((w) => /INSERT INTO visual_assets/.test(w.sql));
    assert.ok(insert && insert.binds.includes("callface"), "the row is inserted with role callface");
    const audit = db.writes.find((w) => /audit_events/.test(w.sql) && w.binds.includes("video.start"));
    const after = audit.binds.join(" ");
    assert.ok(/"ratio":"960:960"/.test(after) && /"seconds":5/.test(after) && /"kind":"listening"/.test(after) && /"role":"callface"/.test(after), after);
    const usage = db.writes.find((w) => /usage_daily/.test(w.sql));
    assert.ok(usage && usage.binds.includes(250000), "charged at start: 0.25 for five seconds");
    // The stored settings decide the plain clip's shape; an override of 10 s costs double.
    const ten = await video.startClip(env(), db, settingsV4({ videoProvider: "stub", videoCostUsd: 0.25, videoSeconds: 5 }), { sourceAssetId: "master-00", description: "she looks up", actor: "test", seconds: 10 });
    assert.equal(ten.role, "video");
    assert.equal(seen[1].duration, 10);
    assert.equal(seen[1].ratio, "720:1280", "the stored ratio when none is given");
    assert.equal(video.parseClaimNote(ten.notes).kind, null);
  } finally {
    providers.registry.video.stub = stub;
  }
  await assert.rejects(video.startClip(env(), db, S, { sourceAssetId: "master-00", description: "x", actor: "test", role: "callface" }), (e) => e.status === 400, "a call face clip needs a kind");
});

// ------------------------------------------------------------------ amendment A3: the clip she sends

t("chooseClipSource: today's approved photo from this conversation, else her newest approved photo, else the avatar master, else master-05, else null", () => {
  const today = "2026-09-29";
  const rows = [
    master("master-05", "images/masters/05_dress.png"),
    master("master-00", "images/masters/00_face.png"),
    assetRow({ id: "img_today_here", conversation_id: "c_here", message_id: "m1", created_at: today + "T10:00:00.000Z" }),
    assetRow({ id: "img_today_here_late", conversation_id: "c_here", message_id: "m2", created_at: today + "T12:00:00.000Z" }),
    assetRow({ id: "img_today_elsewhere", conversation_id: "c_other", message_id: "m3", created_at: today + "T13:00:00.000Z" }),
    assetRow({ id: "img_old_here", conversation_id: "c_here", message_id: "m0", created_at: "2026-09-20T10:00:00.000Z" }),
    assetRow({ id: "img_owner_fired", conversation_id: "c_here", message_id: null, created_at: today + "T14:00:00.000Z" }),
    assetRow({ id: "img_candidate", conversation_id: "c_here", message_id: "m4", approval_status: "candidate", created_at: today + "T15:00:00.000Z" }),
  ];
  assert.equal(video.chooseClipSource(rows, { conversationId: "c_here", today }).id, "img_today_here_late", "the newest approved photo she sent here today");
  assert.equal(video.chooseClipSource(rows, { conversationId: "c_new", today }).id, "img_today_elsewhere", "else her newest approved photo anywhere");
  const noPhotos = rows.filter((r) => r.role === "master");
  assert.equal(video.chooseClipSource(noPhotos, { conversationId: "c_new", today }).id, "master-05", "else the avatar master");
  assert.equal(video.chooseClipSource(noPhotos, { conversationId: "c_new", today, avatarAssetId: "master-00" }).id, "master-00", "the chosen avatar");
  assert.equal(video.chooseClipSource(noPhotos, { conversationId: "c_new", today, avatarAssetId: "master-02" }).id, "master-05", "an avatar not in the table falls back to 05");
  assert.equal(video.chooseClipSource([], { conversationId: "c_new", today }), null);
  assert.equal(video.chooseClipSource([rows[6]], { conversationId: "c_here", today }), null, "an owner-fired picture (no message) never dresses a clip");
});

t("clipPromptText: the identity words first, her description after, within 1000 units, nothing about the app", () => {
  const p = video.clipPromptText("she looks up from the record and half smiles");
  assert.ok(p.startsWith(video.CLIP_IDENTITY_TEXT + " "), p.slice(0, 80));
  assert.ok(p.endsWith("she looks up from the record and half smiles"));
  assert.ok(!/app|prompt|model|record(ing)? (this|it)/i.test(video.CLIP_IDENTITY_TEXT.replace("the record", "")), "no tech words");
  assert.ok(/fully clothed/.test(video.CLIP_IDENTITY_TEXT) && /no text, no captions, no watermark/.test(video.CLIP_IDENTITY_TEXT));
  const long = video.clipPromptText("x ".repeat(900));
  assert.ok(long.length <= 1000, String(long.length));
  assert.ok(!BAD_TYPOGRAPHY.test(p));
});

t("startClipForMessage: the row is role video bound to the conversation and the message, the prompt is her description, the provider gets the identity words", async () => {
  const photo = assetRow({ id: "img_src", conversation_id: "c_test", message_id: "m_prev", created_at: new Date().toISOString(), file: "candidates/img_src.png" });
  const db = fakeDb({ visual_assets: [photo, master("master-05", "images/masters/05_dress.png")], messages: [messageRow({ id: "m_clip", conversation_id: "c_test" })], usage_daily: [] });
  const e = env();
  e.MEDIA = fakeR2({ "candidates/img_src.png": PNG });
  const stub = providers.registry.video.stub;
  const seen = [];
  providers.registry.video.stub = { ...stub, async startImageToVideo(en, req) { seen.push(req); return stub.startImageToVideo(en, req); } };
  try {
    const row = await video.startClipForMessage(e, db, S, { conversationId: "c_test", messageId: "m_clip", description: "  she looks up from the record\n and half smiles ", actor: "test" });
    assert.equal(row.role, "video");
    assert.equal(row.conversation_id, "c_test");
    assert.equal(row.message_id, "m_clip");
    assert.equal(row.prompt, "she looks up from the record and half smiles");
    assert.equal(video.parseClaimNote(row.notes).sourceId, "img_src", "today's approved photo from this conversation");
    assert.equal(seen[0].promptText, video.clipPromptText("she looks up from the record and half smiles"));
    assert.equal(seen[0].duration, 5);
    const audit = db.writes.find((w) => /audit_events/.test(w.sql) && w.binds.includes("video.start"));
    assert.ok(/"message_id":"m_clip"/.test(audit.binds.join(" ")), audit.binds.join(" "));
  } finally {
    providers.registry.video.stub = stub;
  }
  await assert.rejects(video.startClipForMessage(e, db, S, { conversationId: "c_test", messageId: "m_clip", description: "", actor: "test" }), (e2) => e2.status === 400);
  await assert.rejects(video.startClipForMessage(e, fakeDb({ visual_assets: [], usage_daily: [] }), S, { conversationId: "c_test", messageId: "m_clip", description: "x", actor: "test" }), (e2) => e2.status === 404, "nothing to make it from");
});

t("chooseClipSource: a picture with him in it (with_him 1) never dresses a clip, even as today's newest here; the next one down is taken", () => {
  const today = "2026-09-29";
  const rows = [
    master("master-05", "images/masters/05_dress.png"),
    { ...assetRow({ id: "img_her", conversation_id: "c_here", message_id: "m1", created_at: today + "T10:00:00.000Z" }), with_him: 0 },
    { ...assetRow({ id: "img_us", conversation_id: "c_here", message_id: "m2", created_at: today + "T12:00:00.000Z" }), with_him: 1 },
  ];
  assert.equal(video.chooseClipSource(rows, { conversationId: "c_here", today }).id, "img_her");
  assert.equal(video.chooseClipSource([rows[0], rows[2]], { conversationId: "c_here", today }).id, "master-05", "only a picture of us on file: the master");
});
