// The v5 settings (SPEC_V5 "Settings added"): PUT validation for every row, the two price
// rules, the defaults in DEFAULT_SETTINGS, the seed and 0009, and overlaySettings pointing the
// nightly pass at the runner's local performer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { V5_SETTINGS_TABLE, settingsV5, repoText } from "./helpers_v5.mjs";

const { DEFAULT_SETTINGS } = await loadSrc("db");
const { validateSettingsPatch, assertSettingsConsistent, overlaySettings } = await loadSrc("api");
const seed = JSON.parse(repoText("canon/seed/settings.json") || "{}");
const migration = repoText("migrations/0009_v5.sql");

const rejects = (patch) => assert.throws(() => validateSettingsPatch(patch), (e) => e && e.status === 400 && e.code === "validation", JSON.stringify(patch) + " should be refused");

test("the table has the twenty keys of the spec", () => {
  assert.equal(Object.keys(V5_SETTINGS_TABLE).length, 20);
});

test("validateSettingsPatch: every v5 row accepts its default and its good value and refuses its bad value", () => {
  for (const [key, [def, good, bad]] of Object.entries(V5_SETTINGS_TABLE)) {
    assert.deepEqual(validateSettingsPatch({ [key]: def })[key], def, key + " default");
    assert.deepEqual(validateSettingsPatch({ [key]: good })[key], good, key + " good");
    rejects({ [key]: bad });
  }
});

test("validateSettingsPatch: the edges of the ranges", () => {
  assert.equal(validateSettingsPatch({ gapLineMinMinutes: 10080 }).gapLineMinMinutes, 10080);
  rejects({ gapLineMinMinutes: 10081 });
  rejects({ gapLineMinMinutes: 120.5 });
  assert.equal(validateSettingsPatch({ nightlyBudgetUsd: 0 }).nightlyBudgetUsd, 0);
  rejects({ nightlyBudgetUsd: -0.01 });
  assert.equal(validateSettingsPatch({ herDayItemsMax: 3 }).herDayItemsMax, 3);
  assert.equal(validateSettingsPatch({ viewMinConfidence: 0 }).viewMinConfidence, 0);
  rejects({ viewMinConfidence: -0.1 });
  assert.equal(validateSettingsPatch({ nightlyModel: "x".repeat(200) }).nightlyModel, "x".repeat(200));
  rejects({ nightlyModel: "x".repeat(201) });
  rejects({ sentWindowDays: 61 });
  rejects({ frictionDaysDefault: 15 });
});

test("assertSettingsConsistent: nightlyModel must be priced while the nightly pass is on; hygieneModel while hygiene is on", () => {
  const current = settingsV5();
  assert.throws(() => assertSettingsConsistent(current, { nightlyModel: "nobody-priced-this" }), (e) => e && e.status === 400 && /nightlyModel/.test(e.message));
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, nightlyStoryEnabled: false }, { nightlyModel: "nobody-priced-this" }), "off: no price needed");
  assert.throws(() => assertSettingsConsistent({ ...current, nightlyStoryEnabled: false, nightlyModel: "nobody-priced-this" }, { nightlyStoryEnabled: true }), (e) => e && /nightlyModel/.test(e.message), "switching on with an unpriced model is refused");
  assert.throws(() => assertSettingsConsistent(current, { hygieneModel: "nobody-priced-this" }), (e) => e && e.status === 400 && /hygieneModel/.test(e.message));
  assert.doesNotThrow(() => assertSettingsConsistent({ ...current, hygieneEnabled: false }, { hygieneModel: "nobody-priced-this" }));
  assert.doesNotThrow(() => assertSettingsConsistent(current, { nightlyModel: "claude-sonnet-5", hygieneModel: "claude-haiku-4-5" }));
  assert.doesNotThrow(() => assertSettingsConsistent(current, { viewsShown: 3 }), "an unrelated key never trips the rules");
});

test("both default models are already priced in DEFAULT_SETTINGS.prices", () => {
  for (const m of ["claude-sonnet-5", "claude-haiku-4-5"]) {
    const p = DEFAULT_SETTINGS.prices[m];
    assert.ok(p && typeof p.inputPerMTok === "number" && typeof p.outputPerMTok === "number", m);
  }
});

test("DEFAULT_SETTINGS, the seed and 0009 carry every v5 default", () => {
  for (const [key, [def]] of Object.entries(V5_SETTINGS_TABLE)) {
    assert.deepEqual(DEFAULT_SETTINGS[key], def, "DEFAULT_SETTINGS." + key);
    assert.deepEqual(seed[key], def, "seed." + key);
    const m = new RegExp("VALUES \\('" + key + "', '([^']*)', '2026-09-26T00:00:00\\.000Z'\\)").exec(migration);
    assert.ok(m, "0009 row " + key);
    assert.deepEqual(JSON.parse(m[1]), def, "0009 value " + key);
  }
});

test("overlaySettings: a local DEFAULT_PROVIDER also sets nightlyProvider; an Access deploy never overlays", () => {
  const base = settingsV5({ nightlyProvider: "anthropic" });
  const local = overlaySettings({ DEFAULT_PROVIDER: "stub", ACCESS_AUD: "" }, base);
  assert.equal(local.nightlyProvider, "stub");
  assert.equal(local.provider, "stub");
  const live = overlaySettings({ DEFAULT_PROVIDER: "stub", ACCESS_AUD: "aud" }, base);
  assert.equal(live.nightlyProvider, "anthropic");
});
