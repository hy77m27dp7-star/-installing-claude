// parsePhotoMarker: the "[photo: ...]" line that asks for a candidate image.
// loadMasterBytes: the reference set, which only a master with its recorded hash may join.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fakeD1, loadSrc } from "./helpers.mjs";

const { parsePhotoMarker, loadMasterBytes } = await loadSrc("images");

test("marker on the final line: description returned, marker removed, whitespace trimmed", () => {
  const r = parsePhotoMarker("ok fine, one. do not judge the lighting\n[photo: mirror selfie in a black hoodie, messy bun, lamp light, half smile]\n\n");
  assert.equal(r.description, "mirror selfie in a black hoodie, messy bun, lamp light, half smile");
  assert.equal(r.clean, "ok fine, one. do not judge the lighting");
});

test("marker on its own line mid-text: stripped, the line goes, the description counts", () => {
  const r = parsePhotoMarker("first line\n[photo: something]\nsecond line");
  assert.equal(r.description, "something");
  assert.equal(r.clean, "first line\nsecond line");
});

test("marker inline after prose: the prose stays, the marker goes", () => {
  const r = parsePhotoMarker("fine. [photo: me on the couch, hoodie, no makeup]");
  assert.equal(r.description, "me on the couch, hoodie, no makeup");
  assert.equal(r.clean, "fine.");
});

test("marker first, prose after: the prose stays", () => {
  const r = parsePhotoMarker("[photo: mirror selfie, black hoodie]\nok dont judge the lighting");
  assert.equal(r.description, "mirror selfie, black hoodie");
  assert.equal(r.clean, "ok dont judge the lighting");
});

test("marker with a trailing period is still a marker", () => {
  const r = parsePhotoMarker("ok sent\n[photo: couch, hoodie].");
  assert.equal(r.description, "couch, hoodie");
  assert.equal(r.clean, "ok sent");
});

test("no marker: text unchanged, description null", () => {
  const r = parsePhotoMarker("hello there.");
  assert.equal(r.description, null);
  assert.equal(r.clean, "hello there.");
});

test("two markers: the final one is the description, the other is stripped", () => {
  const r = parsePhotoMarker("a\n[photo: first]\nb\n[photo: second]");
  assert.equal(r.description, "second");
  assert.equal(r.clean, "a\nb");
  assert.ok(!r.clean.includes("[photo:"));
});

test("marker is case-insensitive and tolerates surrounding spaces", () => {
  const r = parsePhotoMarker("look\n  [PHOTO:   the couch, lamp on  ]  ");
  assert.equal(r.description, "the couch, lamp on");
  assert.equal(r.clean, "look");
});

test("a marker-only reply leaves empty clean text", () => {
  const r = parsePhotoMarker("[photo: just this]");
  assert.equal(r.description, "just this");
  assert.equal(r.clean, "");
});

test("a bracket that is not a photo marker is left alone", () => {
  const r = parsePhotoMarker("i wrote [note: remember milk] on my hand");
  assert.equal(r.description, null);
  assert.equal(r.clean, "i wrote [note: remember milk] on my hand");
});

// ------------------------------------------------------------------ loadMasterBytes

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

function masterRow(overrides = {}) {
  return {
    id: "seed-master", file: "images/masters/01_test.png", role: "master", sha256: PNG_SHA, bytes: PNG.length,
    approval_status: "approved", conversation_id: null, message_id: null, prompt: null, provider: null, model: null,
    notes: null, created_at: "2026-09-24T00:00:00.000Z", decided_at: null, ...overrides,
  };
}

function assetsEnv(bytes = PNG) {
  const fetched = [];
  return {
    fetched,
    env: { ASSETS: { fetch: async (req) => { fetched.push(new URL(req.url).pathname); return new Response(bytes.slice(0)); } } },
  };
}

function registry(rows) {
  return fakeD1((sql) => (/FROM visual_assets WHERE role = 'master'/.test(sql) ? rows : []));
}

test("loadMasterBytes: a master whose bytes match its recorded hash is a reference", async () => {
  const { env } = assetsEnv();
  const refs = await loadMasterBytes(env, registry([masterRow()]));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "01_test.png");
  assert.deepEqual(new Uint8Array(refs[0].bytes), PNG);
});

test("loadMasterBytes: a master row with no recorded hash is never loaded as a reference (config error naming the file, no fetch)", async () => {
  const { env, fetched } = assetsEnv();
  await assert.rejects(
    loadMasterBytes(env, registry([masterRow({ id: "seed-nohash", file: "images/masters/02_nohash.png", sha256: null })])),
    (e) => e.name === "ProviderError" && e.kind === "config" && e.retryable === false && /02_nohash\.png/.test(e.message) && /hash/.test(e.message),
  );
  assert.deepEqual(fetched, [], "the file is not even fetched");
  // One unhashed row spoils the whole set: a photo is never made against a partial reference set.
  await assert.rejects(
    loadMasterBytes(env, registry([masterRow(), masterRow({ id: "seed-nohash", file: "images/masters/02_nohash.png", sha256: null })])),
    (e) => e.kind === "config" && /02_nohash\.png/.test(e.message),
  );
});

test("loadMasterBytes: a master whose bytes drifted from the recorded hash is refused", async () => {
  const { env } = assetsEnv(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
  await assert.rejects(
    loadMasterBytes(env, registry([masterRow({ id: "seed-drift", file: "images/masters/03_drift.png" })])),
    (e) => e.kind === "config" && /hash mismatch/.test(e.message) && /03_drift\.png/.test(e.message),
  );
});

test("loadMasterBytes: an empty registry is a config error", async () => {
  const { env } = assetsEnv();
  await assert.rejects(loadMasterBytes(env, registry([])), (e) => e.kind === "config" && /no master images/.test(e.message));
});
