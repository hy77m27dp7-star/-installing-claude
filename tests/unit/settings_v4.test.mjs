// The v4 settings (SPEC_V4 "Settings added" plus the amendment's four): PUT validation for
// every row of the table, the place price rule that needs the stored settings, and the
// defaults in DEFAULT_SETTINGS and the seed. The validation rows run once the router
// knows the keys (pipeline lane); until then they skip, never pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc, testSettings } from "./helpers.mjs";
import { V4_SETTINGS_TABLE, V4_AMENDMENT_SETTINGS_TABLE, settingsV4 } from "./helpers_v4.mjs";

const { DEFAULT_SETTINGS } = await loadSrc("db");
const { validateSettingsPatch, assertSettingsConsistent } = await loadSrc("api");
const seed = JSON.parse(readFileSync(new URL("../../canon/seed/settings.json", import.meta.url), "utf8"));

const knows = (key) => {
  try {
    validateSettingsPatch({ [key]: V4_SETTINGS_TABLE[key] ? V4_SETTINGS_TABLE[key][0] : V4_AMENDMENT_SETTINGS_TABLE[key][0] });
    return true;
  } catch (e) {
    return !(e && /unknown setting/.test(e.message));
  }
};
const routerLanded = knows("avatarAssetId");
const amendmentLanded = knows("spotifyPlayer");
const defaultsLanded = Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, "avatarAssetId");
const tv = routerLanded ? test : (name, fn) => test.skip(name + " [skipped: validateSettingsPatch has no v4 keys yet (pipeline lane)]", fn);
const ta = amendmentLanded ? test : (name, fn) => test.skip(name + " [skipped: validateSettingsPatch has no amendment keys yet (pipeline lane)]", fn);
const td = defaultsLanded ? test : (name, fn) => test.skip(name + " [skipped: DEFAULT_SETTINGS has no v4 keys yet (pipeline lane)]", fn);

const rejects = (patch) => assert.throws(() => validateSettingsPatch(patch), (e) => e && e.status === 400 && e.code === "validation", JSON.stringify(patch) + " should be refused");

tv("validateSettingsPatch: every v4 row accepts its default and its good value and refuses its bad value", () => {
  for (const [key, [def, good, bad]] of Object.entries(V4_SETTINGS_TABLE)) {
    assert.deepEqual(validateSettingsPatch({ [key]: def })[key], def, key + " default");
    assert.deepEqual(validateSettingsPatch({ [key]: good })[key], good, key + " good");
    rejects({ [key]: bad });
  }
});

tv("validateSettingsPatch: the edges (the master id pattern, the playlist id pattern, the name length, the reserved lipsync value, the price range)", () => {
  for (const id of ["master-00", "master-05"]) assert.equal(validateSettingsPatch({ avatarAssetId: id }).avatarAssetId, id);
  for (const bad of ["master-6", "master-06", "master-5", "MASTER-05", "img_x", ""]) rejects({ avatarAssetId: bad });
  rejects({ callFaceSourceAssetId: "master-6" });
  assert.equal(validateSettingsPatch({ callFaceProvider: "lipsync" }).callFaceProvider, "lipsync", "reserved but a valid value");
  rejects({ callFaceProvider: "clip" });
  assert.equal(validateSettingsPatch({ spotifyPlaylistId: "" }).spotifyPlaylistId, "");
  assert.equal(validateSettingsPatch({ spotifyPlaylistId: "a".repeat(62) }).spotifyPlaylistId, "a".repeat(62));
  rejects({ spotifyPlaylistId: "a".repeat(63) });
  rejects({ spotifyPlaylistId: "spotify:playlist:abc" });
  assert.equal(validateSettingsPatch({ spotifyPlaylistName: "x".repeat(100) }).spotifyPlaylistName, "x".repeat(100));
  rejects({ spotifyPlaylistName: "" });
  rejects({ spotifyPlaylistName: "   " });
  assert.equal(validateSettingsPatch({ placeCostUsd: 0 }).placeCostUsd, 0);
  assert.equal(validateSettingsPatch({ placeCostUsd: 100 }).placeCostUsd, 100);
  rejects({ placeCostUsd: 100.01 });
  rejects({ placeCostUsd: "0.08" });
  rejects({ listeningLineEnabled: "true" });
  rejects({ hisFaceInPhotos: null });
});

ta("validateSettingsPatch: the amendment's four keys (spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled)", () => {
  for (const [key, [def, good, bad]] of Object.entries(V4_AMENDMENT_SETTINGS_TABLE)) {
    assert.deepEqual(validateSettingsPatch({ [key]: def })[key], def, key + " default");
    assert.deepEqual(validateSettingsPatch({ [key]: good })[key], good, key + " good");
    rejects({ [key]: bad });
  }
  assert.equal(validateSettingsPatch({ spotifyPlayer: "off" }).spotifyPlayer, "off");
});

tv("assertSettingsConsistent: the place price must be above 0 on a paid image provider; a keyless provider may run at 0", () => {
  const current = { ...testSettings(), imageProvider: "openai", placeCostUsd: 0.08 };
  assert.throws(() => assertSettingsConsistent(current, { placeCostUsd: 0 }), (e) => e && e.status === 400 && /placeCostUsd/.test(e.message));
  assert.throws(() => assertSettingsConsistent({ ...current, imageProvider: "stub", placeCostUsd: 0 }, { imageProvider: "runway" }), (e) => e && /placeCostUsd/.test(e.message), "switching to a paid provider with the place price at 0 is refused");
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, imageProvider: "stub" }, { placeCostUsd: 0 }));
  assert.doesNotThrow(() => assertSettingsConsistent(current, { placeCostUsd: 0.1 }));
  assert.doesNotThrow(() => assertSettingsConsistent(current, { listeningLineEnabled: false }), "an unrelated key never trips the place rule");
});

td("DEFAULT_SETTINGS carries every v4 default of the spec table, and the amendment's four", () => {
  for (const [key, [def]] of Object.entries(V4_SETTINGS_TABLE)) assert.deepEqual(DEFAULT_SETTINGS[key], def, key);
  for (const [key, [def]] of Object.entries(V4_AMENDMENT_SETTINGS_TABLE)) assert.deepEqual(DEFAULT_SETTINGS[key], def, key);
  assert.equal(DEFAULT_SETTINGS.avatarAssetId, "master-05", "his word: the sexiest master");
  assert.equal(DEFAULT_SETTINGS.callFaceSourceAssetId, "master-00", "the tight face crop keeps the whole face inside a square");
  assert.equal(DEFAULT_SETTINGS.spotifyEnabled, false, "the callback turns it on");
  assert.equal(DEFAULT_SETTINGS.herFirstTextsPerDay, 0, "unchanged: the button turns her first texts on live");
  assert.equal(DEFAULT_SETTINGS.replyDelayMode, "instant", "unchanged");
});

td("canon/seed/settings.json mirrors every v4 default", () => {
  for (const key of [...Object.keys(V4_SETTINGS_TABLE), ...Object.keys(V4_AMENDMENT_SETTINGS_TABLE)]) assert.deepEqual(seed[key], DEFAULT_SETTINGS[key], key);
});

test("the v4 test settings fixture carries every key of both tables", () => {
  const s = settingsV4();
  for (const key of [...Object.keys(V4_SETTINGS_TABLE), ...Object.keys(V4_AMENDMENT_SETTINGS_TABLE)]) assert.ok(key in s, key);
  assert.equal(s.placeCostUsd, 0.08);
});
