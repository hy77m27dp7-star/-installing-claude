// Him in the picture (SPEC_V4 section 3), the pipeline half: loadMasterBytes with the
// with-him order, loadHimReference on a fake D1 and a fake R2 (newest approved, none, too
// large), generateCandidate writing with_him and the message flag, decideImage archiving the
// earlier call face of a kind, serveMedia streaming a call face, and the character export
// leaving a with-him picture out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fakeD1, loadSrc, factRow, relationshipState, sceneState } from "./helpers.mjs";
import { fakeDb, secretEnv, messageRow } from "./helpers_v2.mjs";
import { assetRow } from "./helpers_v3.mjs";
import { loadSrcIfPresent, guard, settingsV4, callfaceRow, fakeR2 } from "./helpers_v4.mjs";

const images = await loadSrc("images");
const hisFace = await loadSrcIfPresent("hisFace");
const exportCharacter = await loadSrcIfPresent("exportCharacter");
const t = guard(images, "loadMasterBytes", "generateCandidate", "MASTER_ORDER_WITH_HIM", "decideImage", "serveMedia");
const th = guard(hisFace, "loadHimReference");
const exportSource = readFileSync(new URL("../../src/exportCharacter.ts", import.meta.url), "utf8");
const te = exportCharacter && /with_him/.test(exportSource) ? test : (name, fn) => test.skip(name + " [skipped: exportCharacter.ts does not read with_him yet (pipeline lane)]", fn);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5, 4, 3, 2]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const HIM_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 2, 3]);

function master(id, file) {
  return { id, file, role: "master", sha256: PNG_SHA, bytes: PNG.length, approval_status: "approved", conversation_id: null, message_id: null, prompt: null, provider: null, model: null, notes: null, created_at: "2026-09-24T00:00:00.000Z", decided_at: null };
}
const MASTERS = [master("master-04", "images/masters/04_blazer.png"), master("master-05", "images/masters/05_dress.png"), master("master-00", "images/masters/00_face.png"), master("master-03", "images/masters/03_x.png")];

function himRow(over = {}) {
  return { id: "him_1", file: "him/him_1.png", role: "him", sha256: "aa".repeat(32), bytes: HIM_BYTES.length, approval_status: "approved", conversation_id: null, message_id: null, prompt: null, provider: null, model: null, notes: "him", created_at: "2026-09-25T00:00:00.000Z", decided_at: "2026-09-25T00:00:00.000Z", ...over };
}

function env(media = fakeR2({ "him/him_1.png": HIM_BYTES })) {
  return { ...secretEnv(), MEDIA: media, ASSETS: { fetch: async () => new Response(PNG.slice(0)) } };
}

t("MASTER_ORDER_WITH_HIM is the body reference and the face crop; loadMasterBytes(env, db, 2, MASTER_ORDER_WITH_HIM) answers 05 then 00; the default is still the three", async () => {
  assert.deepEqual([...images.MASTER_ORDER_WITH_HIM], ["master-05", "master-00"]);
  const db = fakeD1((sql) => (/FROM visual_assets WHERE role = 'master'/.test(sql) ? MASTERS : []));
  const two = await images.loadMasterBytes(env(), db, 2, images.MASTER_ORDER_WITH_HIM);
  assert.deepEqual(two.map((r) => r.name), ["05_dress.png", "00_face.png"]);
  const three = await images.loadMasterBytes(env(), db);
  assert.equal(three.length, 3);
  assert.deepEqual(three.map((r) => r.name), ["05_dress.png", "04_blazer.png", "00_face.png"], "the ordinary order: body, blazer, face");
});

th("loadHimReference: the newest approved photo of him from R2; null with none or with the file gone; too large flagged, bytes null", async () => {
  const rows = [himRow({ id: "him_old", file: "him/him_old.png", created_at: "2026-09-20T00:00:00.000Z" }), himRow()];
  const newestFirst = (sql, binds) => (/FROM visual_assets WHERE role = \?1/.test(sql) && binds[0] === "him" ? [rows[1], rows[0]] : []);
  const media = fakeR2({ "him/him_1.png": HIM_BYTES, "him/him_old.png": HIM_BYTES });
  const ref = await hisFace.loadHimReference(env(media), fakeD1(newestFirst));
  assert.ok(ref && ref.id === "him_1" && ref.name === "him_1.png" && ref.mime === "image/png", JSON.stringify(ref && { id: ref.id, name: ref.name, mime: ref.mime }));
  assert.deepEqual(new Uint8Array(ref.bytes), HIM_BYTES);
  assert.equal(await hisFace.loadHimReference(env(media), fakeD1(() => [])), null, "none on file");
  assert.equal(await hisFace.loadHimReference(env(fakeR2()), fakeD1(newestFirst)), null, "the file is gone");
  const big = {
    async get() { let cancelled = false; return { size: 6 * 1024 * 1024, body: { async cancel() { cancelled = true; } }, async arrayBuffer() { throw new Error("never read"); }, get cancelled() { return cancelled; } }; },
  };
  const large = await hisFace.loadHimReference({ ...secretEnv(), MEDIA: big }, fakeD1(newestFirst));
  assert.ok(large && large.tooLarge === true && large.bytes === null && large.id === "him_1", JSON.stringify(large));
});

// generateCandidate on a fake D1 that answers each read by its SQL (the fake table stand-in
// cannot evaluate the literal in the blacklist query, and the stub returns a master's bytes).
function candidateDb(withHim) {
  const message = messageRow({ id: "m_photo", conversation_id: "c_test", image_id: null, image_status: null, flags_json: JSON.stringify([{ code: "caption_tail", severity: "flag", detail: "x" }]) });
  const db = fakeD1((sql, binds) => {
    if (/SELECT \* FROM messages WHERE id = \?1/.test(sql)) return binds[0] === "m_photo" ? [message] : [];
    if (/FROM visual_assets WHERE role = 'master'/.test(sql)) return MASTERS;
    if (/FROM visual_assets WHERE role = \?1 AND approval_status = 'approved'/.test(sql)) return withHim ? [himRow()] : [];
    if (/approval_status = 'rejected' AND sha256/.test(sql)) return [];
    if (/SELECT 1 AS ok FROM visual_assets/.test(sql)) return [{ ok: 1 }];
    if (/SELECT flags_json FROM messages/.test(sql)) return [{ flags_json: message.flags_json }];
    return [];
  });
  return db;
}

const S = settingsV4({ imageProvider: "stub", imageCostUsd: 0.06, hisLookText: "long black hair, a beard, aviator sunglasses" });

t("generateCandidate: with him on file and her line naming him -> with_him 1, two of her references plus him, the audit says withHim true", async () => {
  const db = candidateDb(true);
  const row = await images.generateCandidate(env(), db, S, { conversationId: "c_test", messageId: "m_photo", description: "selfie of the two of us at the counter", actor: "test" });
  assert.equal(row.approval_status, "candidate");
  assert.equal(row.with_him, 1);
  const write = db.log.find((s) => /approval_status = 'candidate'/.test(s.sql) && /with_him = \?8/.test(s.sql));
  assert.ok(write, "the candidate write carries with_him");
  assert.equal(write.binds[7], 1);
  const audit = db.log.find((s) => /audit_events/.test(s.sql) && s.binds.includes("image.generate"));
  assert.ok(/"withHim":true/.test(audit.binds.join(" ")), audit.binds.join(" "));
  assert.ok(!db.log.some((s) => /UPDATE messages SET flags_json/.test(s.sql)), "no flag when his photo rode along");
});

t("generateCandidate: her line names him but no photo of him is on file -> with_him 0 and him_not_on_file appended to the message flags; a plain line -> 0 and no flag", async () => {
  const db = candidateDb(false);
  const row = await images.generateCandidate(env(), db, S, { conversationId: "c_test", messageId: "m_photo", description: "my head on your shoulder", actor: "test" });
  assert.equal(row.with_him, 0);
  const flags = db.log.find((s) => /UPDATE messages SET flags_json = \?2 WHERE id = \?1/.test(s.sql));
  assert.ok(flags, "the flags are rewritten");
  assert.equal(flags.binds[0], "m_photo");
  const parsed = JSON.parse(flags.binds[1]);
  assert.ok(parsed.some((f) => f.code === "caption_tail"), "the earlier flags are kept");
  assert.ok(parsed.some((f) => f.code === "him_not_on_file" && f.severity === "flag"), JSON.stringify(parsed));
  const plainDb = candidateDb(true);
  const plain = await images.generateCandidate(env(), plainDb, S, { conversationId: "c_test", messageId: "m_photo", description: "mirror selfie in a black hoodie", actor: "test" });
  assert.equal(plain.with_him, 0);
  assert.ok(!plainDb.log.some((s) => /UPDATE messages SET flags_json/.test(s.sql)));
  assert.ok(!plainDb.log.some((s) => /FROM visual_assets WHERE role = \?1 AND approval_status = 'approved'/.test(s.sql)), "his photo is not even looked up");
});

t("generateCandidate: hisFaceInPhotos false -> with_him 0, his photo never read, no flag", async () => {
  const db = candidateDb(true);
  const row = await images.generateCandidate(env(), db, settingsV4({ imageProvider: "stub", hisFaceInPhotos: false }), { conversationId: "c_test", messageId: "m_photo", description: "selfie of the two of us", actor: "test" });
  assert.equal(row.with_him, 0);
  assert.ok(!db.log.some((s) => /FROM visual_assets WHERE role = \?1 AND approval_status = 'approved'/.test(s.sql)));
  assert.ok(!db.log.some((s) => /UPDATE messages SET flags_json/.test(s.sql)));
});

// ------------------------------------------------------------------ the call face through the photo routes

t("decideImage: approving a call-face candidate of a kind archives the earlier approved clip of that kind and keeps the others", async () => {
  const older = callfaceRow({ kind: "idle", id: "vid_idle_old" });
  const other = callfaceRow({ kind: "listening", id: "vid_listen" });
  const candidate = callfaceRow({ kind: "idle", id: "vid_idle_new", approval_status: "candidate", decided_at: null });
  // A fake D1 answering by SQL: the stand-in cannot evaluate `id != ?1`, and the row read
  // back after the batch is the candidate itself (an UPDATE is never applied there).
  const db = fakeD1((sql, binds) => {
    if (/SELECT \* FROM visual_assets WHERE id = \?1/.test(sql)) return binds[0] === "vid_idle_new" ? [candidate] : [];
    if (/role = 'callface' AND approval_status = 'approved' AND id != \?1/.test(sql)) return [older, other].filter((r) => r.id !== binds[0]);
    return [];
  });
  const media = fakeR2({ [candidate.file]: new Uint8Array([1, 2, 3]) });
  await images.decideImage({ ...secretEnv(), MEDIA: media }, db, "vid_idle_new", "approve", "test", "good");
  const approve = db.log.find((s) => s.via === "batch" && /approval_status = 'approved'/.test(s.sql) && s.binds[2] === "vid_idle_new");
  assert.ok(approve, "the approval write");
  assert.equal(approve.binds[3], "callface", "a clip keeps its role");
  assert.equal(approve.binds[1], "callface:idle | good", "his note rides after the kind");
  const archive = db.log.filter((s) => s.via === "batch" && /approval_status = 'archive'/.test(s.sql));
  assert.deepEqual(archive.map((s) => s.binds[0]), ["vid_idle_old"], "the earlier idle goes to the archive; the listening clip stays");
  const talking = callfaceRow({ kind: "talking", id: "vid_talk", approval_status: "candidate", decided_at: null });
  const rejectDb = fakeD1((sql, binds) => (/SELECT \* FROM visual_assets WHERE id = \?1/.test(sql) && binds[0] === "vid_talk" ? [talking] : []));
  const rejectMedia = fakeR2({ [talking.file]: new Uint8Array([1]) });
  await images.decideImage({ ...secretEnv(), MEDIA: rejectMedia }, rejectDb, "vid_talk", "reject", "test");
  assert.ok(rejectDb.log.some((s) => s.via === "batch" && /approval_status = 'rejected'/.test(s.sql) && s.binds[2] === "vid_talk"));
  assert.ok(!rejectMedia.has(talking.file), "a rejected face's bytes go; the hash stays for the blacklist");
});

t("serveMedia: an approved call face streams as video/mp4 with Range; a role him row is never served", async () => {
  const face = callfaceRow({ kind: "idle" });
  const bytes = new Uint8Array(64).map((_, i) => i);
  const e = { ...secretEnv(), MEDIA: fakeR2({ [face.file]: bytes }) };
  const db = fakeDb({ visual_assets: [face, himRow()] });
  const whole = await images.serveMedia(e, db, face.id);
  assert.equal(whole.status, 200);
  assert.ok((whole.headers.get("content-type") ?? "").startsWith("video/mp4"), whole.headers.get("content-type"));
  const part = await images.serveMedia(e, db, face.id, "bytes=0-15");
  assert.equal(part.status, 206);
  assert.ok((part.headers.get("content-range") ?? "").startsWith("bytes 0-15/"), part.headers.get("content-range"));
  assert.equal((await images.serveMedia(e, db, "him_1")).status, 404, "his photo is not hers to serve");
});

te("exportCharacterJson leaves a with-him picture out of images (a real person's face never enters the character package)", async () => {
  const D = "2026-09-20T12:00:00.000Z";
  const db = fakeDb({
    facts: [factRow({ id: "f_fixed", scope: "fixed", subject: "age", fact: "She is 22." })],
    history: [], unknowns: [], life_threads: [], life_log: [], media_library: [], settings: [],
    state_versions: [
      { id: "s1", entity: "relationship", version: 1, state_json: JSON.stringify(relationshipState()), source: "seed", note: null, created_at: D },
      { id: "s2", entity: "scene", version: 1, state_json: JSON.stringify(sceneState()), source: "seed", note: null, created_at: D },
    ],
    visual_assets: [
      { ...assetRow({ id: "img_her", message_id: "m1", created_at: D, decided_at: D }), with_him: 0 },
      { ...assetRow({ id: "img_us", message_id: "m2", created_at: D, decided_at: D, prompt: "selfie of the two of us" }), with_him: 1 },
    ],
  });
  const pkg = await exportCharacter.exportCharacterJson(db, secretEnv());
  const ids = pkg.images.map((i) => i.id);
  assert.ok(ids.includes("img_her"), "her own picture is in");
  assert.ok(!ids.includes("img_us"), "the with-him picture is out");
  assert.ok(!JSON.stringify(pkg).includes("the two of us"));
});

t("generateCandidate: a regenerate (the message already carries him_not_on_file) appends nothing a second time; hasFlagCode reads the list", async () => {
  const flagged = JSON.stringify([{ code: "caption_tail", severity: "flag", detail: "x" }, { code: "him_not_on_file", severity: "flag", detail: "y" }]);
  const message = messageRow({ id: "m_photo", conversation_id: "c_test", image_id: null, image_status: null, flags_json: flagged });
  const db = fakeD1((sql, binds) => {
    if (/SELECT \* FROM messages WHERE id = \?1/.test(sql)) return binds[0] === "m_photo" ? [message] : [];
    if (/FROM visual_assets WHERE role = 'master'/.test(sql)) return MASTERS;
    if (/FROM visual_assets WHERE role = \?1 AND approval_status = 'approved'/.test(sql)) return [];
    if (/approval_status = 'rejected' AND sha256/.test(sql)) return [];
    if (/SELECT 1 AS ok FROM visual_assets/.test(sql)) return [{ ok: 1 }];
    if (/SELECT flags_json FROM messages/.test(sql)) return [{ flags_json: flagged }];
    return [];
  });
  const row = await images.generateCandidate(env(), db, S, { conversationId: "c_test", messageId: "m_photo", description: "my head on your shoulder", actor: "test" });
  assert.equal(row.with_him, 0);
  assert.ok(!db.log.some((s) => /UPDATE messages SET flags_json/.test(s.sql)), "the code is already there");
  assert.equal(images.hasFlagCode(flagged, "him_not_on_file"), true);
  assert.equal(images.hasFlagCode(flagged, "photo_with_him"), false);
  assert.equal(images.hasFlagCode(null, "him_not_on_file"), false);
  assert.equal(images.hasFlagCode("not json", "him_not_on_file"), false);
});
