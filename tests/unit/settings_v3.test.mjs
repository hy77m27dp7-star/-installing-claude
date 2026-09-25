// The v3 settings (SPEC_V3 "Settings added"): PUT validation for every row (api.ts, this
// lane), the defaults in DEFAULT_SETTINGS and the seed when the pipeline lane has landed
// them, the owner's answers baked in (Portland, Maine; the switches that ship off), and
// the consistency rules that need the stored settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc, testSettings } from "./helpers.mjs";
import { V3_SETTINGS_TABLE } from "./helpers_v3.mjs";

const { DEFAULT_SETTINGS } = await loadSrc("db");
const { validateSettingsPatch, assertSettingsConsistent, VOICE_TAGS } = await loadSrc("api");
const seed = JSON.parse(readFileSync(new URL("../../canon/seed/settings.json", import.meta.url), "utf8"));
const landed = Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, "exemplarsPerTurn");
const tDefaults = landed ? test : (name, fn) => test.skip(name + " [skipped: DEFAULT_SETTINGS has no v3 keys yet (pipeline lane)]", fn);

const rejects = (patch) => assert.throws(() => validateSettingsPatch(patch), (e) => e && e.status === 400 && e.code === "validation");

test("validateSettingsPatch: every v3 row accepts its good value and refuses its bad value", () => {
  for (const [key, [def, good, bad]] of Object.entries(V3_SETTINGS_TABLE)) {
    assert.deepEqual(validateSettingsPatch({ [key]: def })[key], def, key + " default");
    assert.deepEqual(validateSettingsPatch({ [key]: good })[key], good, key + " good");
    rejects({ [key]: bad });
  }
});

test("validateSettingsPatch: the number, enum and shape edges", () => {
  rejects({ exemplarsPerTurn: 2.5 });
  rejects({ herLat: "43" });
  assert.equal(validateSettingsPatch({ herLat: null }).herLat, null);
  assert.equal(validateSettingsPatch({ herCity: "  " }).herCity, "");
  rejects({ callPrices: { audioInPerMTok: 1, audioOutPerMTok: 1, textInPerMTok: 1 } });
  rejects({ callPrices: { audioInPerMTok: 1, audioOutPerMTok: 1, textInPerMTok: 1, textOutPerMTok: 1, extra: 1 } });
  rejects({ callPrices: [] });
  rejects({ videoSeconds: 15 });
  rejects({ videoRatio: "720x1280" });
  rejects({ callProvider: "elevenlabs-live" });
  assert.equal(validateSettingsPatch({ callProvider: "elevenlabs" }).callProvider, "elevenlabs", "reserved but a valid value");
  rejects({ typoCueShare: -0.1 });
  rejects({ texterPrevious: { provider: "anthropic" } });
  rejects({ texterPrevious: "claude" });
  assert.deepEqual(validateSettingsPatch({ texterPrevious: { provider: "openai", model: "gpt-4.1" } }).texterPrevious, { provider: "openai", model: "gpt-4.1" });
  rejects({ notASetting: 1 });
});

test("VOICE_TAGS is the AA vocabulary, 30 tags", () => {
  assert.equal(VOICE_TAGS.length, 30);
  for (const tag of ["stranger", "familiar", "banter", "typo_fix", "song_send", "photo_ask", "own_day", "after_friction"]) assert.ok(VOICE_TAGS.includes(tag), tag);
});

test("assertSettingsConsistent: tastings cannot be enabled on an unpriced performer; a priced one passes", () => {
  const current = { ...testSettings(), tastingEnabled: false, tastingModel: "gpt-9-unpriced", prices: { ...testSettings().prices } };
  assert.throws(() => assertSettingsConsistent(current, { tastingEnabled: true }), (e) => e && e.status === 400 && /tastingModel/.test(e.message));
  assert.throws(() => assertSettingsConsistent({ ...current, tastingEnabled: true }, { tastingModel: "gpt-9-also-unpriced" }), (e) => e && e.status === 400);
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, prices: { ...current.prices, "gpt-9-unpriced": { inputPerMTok: 2, outputPerMTok: 8 } } }, { tastingEnabled: true }));
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, tastingModel: "gpt-4.1" }, { tastingEnabled: true }), "gpt-4.1 is priced in the built-in table");
  assert.doesNotThrow(() => assertSettingsConsistent(current, { tastingModel: "anything" }), "an unpriced tasting model is fine while tastings are off");
});

test("assertSettingsConsistent: a clip on Runway and a portrait on a paid image provider must carry a price", () => {
  const current = { ...testSettings(), imageProvider: "openai", portraitCostUsd: 0.04, videoProvider: "runway", videoCostUsd: 0.25 };
  assert.throws(() => assertSettingsConsistent(current, { videoCostUsd: 0 }), (e) => e && /videoCostUsd/.test(e.message));
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, videoProvider: "stub" }, { videoCostUsd: 0 }));
  assert.throws(() => assertSettingsConsistent(current, { portraitCostUsd: 0 }), (e) => e && /portraitCostUsd/.test(e.message));
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, imageProvider: "stub" }, { portraitCostUsd: 0 }));
});

tDefaults("DEFAULT_SETTINGS carries every v3 default of the spec table", () => {
  for (const [key, [def]] of Object.entries(V3_SETTINGS_TABLE)) {
    if (key === "herCity" || key === "herLat" || key === "herLon" || key === "weatherProvider") continue; // the owner's answer, below
    assert.deepEqual(DEFAULT_SETTINGS[key], def, key);
  }
});

tDefaults("the owner's answers (2026-09-24) are the defaults: Portland, Maine with the weather on; the two switches off; gpt-4.1 priced", () => {
  assert.equal(DEFAULT_SETTINGS.herCity, "Portland, Maine");
  assert.ok(typeof DEFAULT_SETTINGS.herLat === "number" && DEFAULT_SETTINGS.herLat > 43.5 && DEFAULT_SETTINGS.herLat < 43.8, String(DEFAULT_SETTINGS.herLat));
  assert.ok(typeof DEFAULT_SETTINGS.herLon === "number" && DEFAULT_SETTINGS.herLon > -70.4 && DEFAULT_SETTINGS.herLon < -70.1, String(DEFAULT_SETTINGS.herLon));
  assert.equal(DEFAULT_SETTINGS.weatherProvider, "openmeteo");
  assert.equal(DEFAULT_SETTINGS.timezone, "America/New_York");
  assert.equal(DEFAULT_SETTINGS.provisionalRecallEvery, 0);
  assert.equal(DEFAULT_SETTINGS.typoCueShare, 0);
  assert.equal(DEFAULT_SETTINGS.tastingEnabled, false);
  assert.equal(DEFAULT_SETTINGS.videoProvider, "runway");
  for (const m of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"]) assert.ok(DEFAULT_SETTINGS.prices[m], m + " priced");
});

tDefaults("canon/seed/settings.json mirrors every v3 default", () => {
  for (const key of Object.keys(V3_SETTINGS_TABLE)) assert.deepEqual(seed[key], DEFAULT_SETTINGS[key], key);
});

test("assertSettingsConsistent: a paid call provider must carry a per-minute price; the stub may run at 0", () => {
  const current = { ...testSettings(), callProvider: "openai", callPricePerMinute: 0.3 };
  assert.throws(() => assertSettingsConsistent(current, { callPricePerMinute: 0 }), (e) => e && e.status === 400 && /callPricePerMinute/.test(e.message));
  assert.throws(() => assertSettingsConsistent({ ...current, callPricePerMinute: 0, callProvider: "stub" }, { callProvider: "openai" }), (e) => e && /callPricePerMinute/.test(e.message));
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, callProvider: "stub" }, { callPricePerMinute: 0 }));
  assert.doesNotThrow(() => assertSettingsConsistent(current, { callPricePerMinute: 0.5 }));
});

tDefaults("her first texts ship off (his word was opt-in): the default cap is 0, the ceiling 10", () => {
  assert.equal(DEFAULT_SETTINGS.herFirstTextsPerDay, 0);
  assert.equal(seed.herFirstTextsPerDay, 0);
  assert.equal(validateSettingsPatch({ herFirstTextsPerDay: 10 }).herFirstTextsPerDay, 10);
});
