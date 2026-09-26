// The call face (SPEC_V4 section 2): the three motion prompts under the cap and free of the
// moderation words, the notes round-trip (bare, with his decision note, inside a claim
// note), the state from rows (ready only with all three approved on the clips provider),
// the make gates (off, reserved, in progress), and the browser's faceStateFor table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { fakeDb, secretEnv } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard, settingsV4, callfaceRow } from "./helpers_v4.mjs";

const callface = await loadSrcIfPresent("callface");
const t = guard(callface, "CALL_FACE_PROMPTS", "callFaceNote", "callFaceKindOf", "callFaceStateOf", "callFaceState", "makeCallFace", "CALL_FACE_KINDS");
const browser = await import("../../public/js/callface.js").catch(() => null);
const tb = browser && typeof browser.faceStateFor === "function" ? test : (name, fn) => test.skip(name + " [skipped: public/js/callface.js not importable yet]", fn);

// The words the runway_image test bans from an identity line (the moderation risk).
const BODY_WORDS = /\b(body|bodies|breast\w*|chest|cleavage|hips?|thighs?|legs?|torso|lips|skin|butt|bottom)\b/i;

t("CALL_FACE_KINDS, ratio, seconds and the default source are the spec's", () => {
  assert.deepEqual([...callface.CALL_FACE_KINDS], ["idle", "listening", "talking"]);
  assert.equal(callface.CALL_FACE_RATIO, "960:960");
  assert.equal(callface.CALL_FACE_SECONDS, 5);
  assert.equal(callface.CALL_FACE_DEFAULT_SOURCE, "master-00");
  assert.deepEqual([...callface.CALL_FACE_PROVIDERS], ["clips", "off", "lipsync"]);
});

t("CALL_FACE_PROMPTS: one per kind, each under 1000 characters, no moderation-risk words, the camera and the light still", () => {
  for (const kind of ["idle", "listening", "talking"]) {
    const p = callface.CALL_FACE_PROMPTS[kind];
    assert.equal(typeof p, "string");
    assert.ok(p.length > 40 && p.length < 1000, kind + " " + p.length);
    assert.ok(!BODY_WORDS.test(p), kind + " carries a body-part word: " + p);
    assert.ok(/the camera does not move, the light does not change/.test(p), kind);
    assert.ok(!BAD_TYPOGRAPHY.test(p));
  }
  assert.ok(/mouth stays closed/.test(callface.CALL_FACE_PROMPTS.listening));
  assert.ok(/mouth moving/.test(callface.CALL_FACE_PROMPTS.talking));
  assert.ok(/no talking/.test(callface.CALL_FACE_PROMPTS.idle));
});

t("callFaceNote / callFaceKindOf: the round-trip, an approved clip's note with his words, a generating clip's claim note; null otherwise", () => {
  for (const kind of callface.CALL_FACE_KINDS) {
    assert.equal(callface.callFaceNote(kind), "callface:" + kind);
    assert.equal(callface.callFaceKindOf(callface.callFaceNote(kind)), kind);
  }
  assert.equal(callface.callFaceKindOf("callface:idle | good"), "idle");
  assert.equal(callface.callFaceKindOf("callface:talking | too much | second note"), "talking");
  assert.equal(callface.callFaceKindOf("source:master-00|task:stub-task-3|since 2026-09-29T19:00:00.000Z|kind:listening"), "listening");
  assert.equal(callface.callFaceKindOf(" callface:idle "), "idle");
  assert.equal(callface.callFaceKindOf("callface:dancing"), null);
  assert.equal(callface.callFaceKindOf("source:master-00|task:x|since y"), null, "a plain clip's claim note names no kind");
  assert.equal(callface.callFaceKindOf(null), null);
  assert.equal(callface.callFaceKindOf(""), null);
  assert.equal(callface.callFaceKindOf("good"), null);
});

t("callFaceSettingsOf: the two settings with the spec defaults for a missing or malformed value", () => {
  assert.deepEqual(callface.callFaceSettingsOf(settingsV4()), { provider: "clips", sourceAssetId: "master-00" });
  assert.deepEqual(callface.callFaceSettingsOf({ callFaceProvider: "lipsync", callFaceSourceAssetId: "master-04" }), { provider: "lipsync", sourceAssetId: "master-04" });
  assert.deepEqual(callface.callFaceSettingsOf({ callFaceProvider: "hedra", callFaceSourceAssetId: "master-9" }), { provider: "clips", sourceAssetId: "master-00" });
  assert.deepEqual(callface.callFaceSettingsOf(null), { provider: "clips", sourceAssetId: "master-00" });
});

t("callFaceStateOf: the newest approved clip per kind, the candidates and the generating rows; ready only with all three approved on clips", () => {
  const rows = [
    callfaceRow({ kind: "idle", id: "vid_idle_old", decided_at: "2026-09-28T00:00:00.000Z" }),
    callfaceRow({ kind: "idle", id: "vid_idle_new", decided_at: "2026-09-29T00:00:00.000Z", notes: "callface:idle | good" }),
    callfaceRow({ kind: "listening", id: "vid_listen" }),
    callfaceRow({ kind: "talking", id: "vid_talk_c", approval_status: "candidate", decided_at: null }),
    callfaceRow({ kind: "talking", id: "vid_talk_g", approval_status: "generating", sha256: null, bytes: null, decided_at: null, notes: "source:master-00|task:stub-task-9|since 2026-09-29T19:00:00.000Z|kind:talking" }),
    { id: "vid_plain", file: "videos/vid_plain.mp4", role: "video", sha256: "ab".repeat(32), bytes: 10, approval_status: "approved", conversation_id: null, message_id: null, prompt: "x", provider: "stub", model: "gen4_turbo", notes: null, created_at: "2026-09-29T00:00:00.000Z", decided_at: "2026-09-29T00:00:00.000Z" },
  ];
  const s = callface.callFaceStateOf(rows, settingsV4());
  assert.equal(s.provider, "clips");
  assert.equal(s.source, "master-00");
  assert.equal(s.clips.idle.id, "vid_idle_new", "the newest approved idle");
  assert.equal(s.clips.listening.id, "vid_listen");
  assert.equal(s.clips.talking, null);
  assert.deepEqual(s.candidates.map((r) => r.id), ["vid_talk_c"]);
  assert.deepEqual(s.generating.map((r) => r.id), ["vid_talk_g"]);
  assert.equal(s.ready, false, "two approved and one candidate");
  const three = callface.callFaceStateOf([callfaceRow({ kind: "idle" }), callfaceRow({ kind: "listening" }), callfaceRow({ kind: "talking" })], settingsV4());
  assert.equal(three.ready, true);
  assert.equal(callface.callFaceStateOf([callfaceRow({ kind: "idle" }), callfaceRow({ kind: "listening" }), callfaceRow({ kind: "talking" })], settingsV4({ callFaceProvider: "lipsync" })).ready, false, "reserved: never ready");
  assert.equal(callface.callFaceStateOf([], settingsV4({ callFaceProvider: "off" })).provider, "off");
  assert.ok(!JSON.stringify(s).includes("vid_plain"), "a plain clip is not a face");
});

t("callFaceState reads the table through listAssets; makeCallFace: off -> 503 detail off, lipsync -> 503 detail reserved_v4_1, a generating clip of that kind -> 409 in_progress", async () => {
  const generating = callfaceRow({ kind: "idle", id: "vid_busy", approval_status: "generating", sha256: null, bytes: null, decided_at: null, notes: "source:master-00|task:stub-task-1|since 2026-09-29T19:00:00.000Z|kind:idle" });
  const db = fakeDb({ visual_assets: [callfaceRow({ kind: "listening" }), generating] });
  const state = await callface.callFaceState(db, settingsV4());
  assert.equal(state.clips.listening.id, "vid_face_listening");
  assert.equal(state.generating.length, 1);
  const env = secretEnv();
  await assert.rejects(callface.makeCallFace(env, db, settingsV4({ callFaceProvider: "off" }), { kind: "idle", actor: "test" }), (e) => e.status === 503 && e.code === "provider_not_configured" && e.detail === "off");
  await assert.rejects(callface.makeCallFace(env, db, settingsV4({ callFaceProvider: "lipsync" }), { kind: "idle", actor: "test" }), (e) => e.status === 503 && e.code === "provider_not_configured" && e.detail === "reserved_v4_1");
  await assert.rejects(callface.makeCallFace(env, db, settingsV4(), { kind: "idle", actor: "test" }), (e) => e.status === 409 && e.code === "in_progress");
  await assert.rejects(callface.makeCallFace(env, db, settingsV4(), { kind: "dancing", actor: "test" }), (e) => e.status === 400 && e.code === "validation");
  assert.equal(db.writes.length, 0, "the gates write nothing");
});

t("callFaceSetCostUsd: three clips at the clip price for five seconds (0.75 at the shipped price)", () => {
  assert.equal(callface.callFaceSetCostUsd(settingsV4()), 0.75);
  assert.ok(Math.abs(callface.callFaceSetCostUsd(settingsV4({ videoCostUsd: 0.4, videoSeconds: 10 })) - 1.2) < 1e-9, "the set is always five seconds a clip");
});

// ------------------------------------------------------------------ the browser's level meter

tb("faceStateFor: enter at 0.020, hold at 0.012, the 350 ms hold, listening while he speaks, idle otherwise, talking beats listening", () => {
  const f = browser.faceStateFor;
  assert.equal(browser.TALK_ENTER, 0.020);
  assert.equal(browser.TALK_HOLD, 0.012);
  assert.equal(browser.TALK_HOLD_MS, 350);
  const t0 = 10_000;
  assert.equal(f(0.021, false, "idle", t0, 0), "talking", "at the enter level");
  assert.equal(f(0.020, false, "idle", t0, 0), "talking", "exactly the enter level");
  assert.equal(f(0.015, false, "idle", t0, 0), "idle", "under the enter level from idle");
  assert.equal(f(0.015, false, "talking", t0, 0), "talking", "held above 0.012 while talking");
  assert.equal(f(0.012, false, "talking", t0, 0), "talking", "exactly the hold level");
  assert.equal(f(0.005, false, "talking", t0, t0 - 300), "talking", "within 350 ms of the last time above the enter level");
  assert.equal(f(0.005, false, "talking", t0, t0 - 351), "idle", "the hold has passed, nobody speaking");
  assert.equal(f(0.005, true, "talking", t0, t0 - 351), "listening", "the hold has passed, he is speaking");
  assert.equal(f(0.0, true, "idle", t0, 0), "listening");
  assert.equal(f(0.0, false, "idle", t0, 0), "idle");
  assert.equal(f(0.05, true, "idle", t0, 0), "talking", "talking beats listening");
  assert.equal(f(0.015, true, "talking", t0, 0), "talking", "held talking beats listening");
  assert.equal(f(NaN, false, "idle", t0, 0), "idle", "junk is silence");
});
