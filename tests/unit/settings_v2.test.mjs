// The v2 settings: defaults in code and in the seed, and the PUT /api/settings validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc } from "./helpers.mjs";

const { DEFAULT_SETTINGS } = await loadSrc("db");
const { validateSettingsPatch } = await loadSrc("api");
const seed = JSON.parse(readFileSync(new URL("../../canon/seed/settings.json", import.meta.url), "utf8"));

// SPEC_V2 "Settings added" (sections B, N, F) and "Settings added" for R, S, T.
const V2_DEFAULTS = {
  replyDelayMode: "instant",
  realDelayMaxMinutes: 6,
  driftCheckEnabled: false,
  timezone: "America/New_York",
};
const V2_MORE_DEFAULTS = {
  // SPEC_V2 seeds 10; the shipped default is 0 (his word was opt-in: the v3 review fix
  // pass set it, HANDOFF "v3: review fixes"), and 10 stays the ceiling.
  herFirstTextsPerDay: 0,
  herFirstQuietHours: "23:30-08:30",
  voiceProvider: "workersai",
  voiceMode: "some",
  transcribeProvider: "workersai",
};

test("DEFAULT_SETTINGS carries the four v2 settings with their spec defaults", () => {
  for (const [k, v] of Object.entries(V2_DEFAULTS)) assert.deepEqual(DEFAULT_SETTINGS[k], v, k);
});

test("DEFAULT_SETTINGS carries the her-first, voice and transcribe settings (sections R and S)", () => {
  for (const [k, v] of Object.entries(V2_MORE_DEFAULTS)) assert.deepEqual(DEFAULT_SETTINGS[k], v, k);
  assert.ok("elevenLabsVoiceId" in DEFAULT_SETTINGS, "elevenLabsVoiceId present (empty by default)");
});

test("canon/seed/settings.json matches DEFAULT_SETTINGS key for key", () => {
  assert.deepEqual(Object.keys(seed).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  for (const k of Object.keys(DEFAULT_SETTINGS)) assert.deepEqual(seed[k], DEFAULT_SETTINGS[k], k);
});

const rejects = (patch, re) => assert.throws(() => validateSettingsPatch(patch), (e) => e && e.status === 400 && (!re || re.test(e.message)));

test("validateSettingsPatch: replyDelayMode instant or real only", () => {
  assert.deepEqual(validateSettingsPatch({ replyDelayMode: "real" }), { replyDelayMode: "real" });
  assert.deepEqual(validateSettingsPatch({ replyDelayMode: "instant" }), { replyDelayMode: "instant" });
  rejects({ replyDelayMode: "later" }, /replyDelayMode/);
  rejects({ replyDelayMode: 1 });
});

test("validateSettingsPatch: realDelayMaxMinutes 1 to 120", () => {
  assert.equal(validateSettingsPatch({ realDelayMaxMinutes: 6 }).realDelayMaxMinutes, 6);
  assert.equal(validateSettingsPatch({ realDelayMaxMinutes: 120 }).realDelayMaxMinutes, 120);
  rejects({ realDelayMaxMinutes: 0 });
  rejects({ realDelayMaxMinutes: 121 });
  rejects({ realDelayMaxMinutes: "6" });
});

test("validateSettingsPatch: driftCheckEnabled is a boolean", () => {
  assert.equal(validateSettingsPatch({ driftCheckEnabled: true }).driftCheckEnabled, true);
  rejects({ driftCheckEnabled: "yes" });
});

test("validateSettingsPatch: timezone must be one Intl knows", () => {
  assert.equal(validateSettingsPatch({ timezone: "Europe/London" }).timezone, "Europe/London");
  rejects({ timezone: "Nowhere/Place" });
  rejects({ timezone: "" });
  rejects({ timezone: 5 });
});

test("validateSettingsPatch: her-first cap 0 to 10 and quiet hours HH:MM-HH:MM", () => {
  assert.equal(validateSettingsPatch({ herFirstTextsPerDay: 0 }).herFirstTextsPerDay, 0);
  assert.equal(validateSettingsPatch({ herFirstTextsPerDay: 10 }).herFirstTextsPerDay, 10);
  rejects({ herFirstTextsPerDay: 11 });
  rejects({ herFirstTextsPerDay: 2.5 });
  assert.equal(validateSettingsPatch({ herFirstQuietHours: "23:30-08:30" }).herFirstQuietHours, "23:30-08:30");
  rejects({ herFirstQuietHours: "late" });
  rejects({ herFirstQuietHours: "25:00-08:30" });
});

test("validateSettingsPatch: voice and transcribe providers and the voice mode", () => {
  for (const v of ["elevenlabs", "workersai", "stub", "off"]) assert.equal(validateSettingsPatch({ voiceProvider: v }).voiceProvider, v);
  rejects({ voiceProvider: "siri" });
  for (const v of ["off", "some", "all"]) assert.equal(validateSettingsPatch({ voiceMode: v }).voiceMode, v);
  rejects({ voiceMode: "always" });
  for (const v of ["workersai", "openai", "stub"]) assert.equal(validateSettingsPatch({ transcribeProvider: v }).transcribeProvider, v);
  rejects({ transcribeProvider: "deepgram" });
});

test("validateSettingsPatch: unknown keys are still refused", () => {
  rejects({ somethingElse: 1 }, /unknown setting/);
});
