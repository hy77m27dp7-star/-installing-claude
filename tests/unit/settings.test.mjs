// Settings rules that need the stored settings next to the patch (api.ts), the merged price
// table (db.ts), and the deploy guard (scripts/check_deploy.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, testSettings } from "./helpers.mjs";

const { assertSettingsConsistent, validateSettingsPatch } = await loadSrc("api");
const { DEFAULT_SETTINGS, mergedPrices } = await loadSrc("db");
const { stripJsonc, deployProblems } = await import("../../scripts/check_deploy.mjs");

const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function bad(fn, re) {
  assert.throws(fn, (e) => {
    assert.equal(e.status, 400, e.message);
    assert.equal(e.code, "validation");
    assert.ok(re.test(e.message), "message: " + e.message);
    return true;
  });
}

// ------------------------------------------------------------------ prices

test("DEFAULT_SETTINGS prices the Workers AI fallback model DEPLOY.md names", () => {
  const p = DEFAULT_SETTINGS.prices[LLAMA];
  assert.ok(p && p.inputPerMTok > 0 && p.outputPerMTok > 0);
  assert.ok(DEFAULT_SETTINGS.prices["claude-opus-5"] && DEFAULT_SETTINGS.prices["claude-sonnet-5"], "the seed's two models stay priced");
});

test("mergedPrices: stored entries win, built-in entries fill the rest, junk is dropped", () => {
  const m = mergedPrices({ "claude-opus-5": { inputPerMTok: 6, outputPerMTok: 30 }, mine: { inputPerMTok: 1, outputPerMTok: 2 }, junk: { inputPerMTok: "x" }, more: 3 });
  assert.deepEqual(m["claude-opus-5"], { inputPerMTok: 6, outputPerMTok: 30 });
  assert.deepEqual(m.mine, { inputPerMTok: 1, outputPerMTok: 2 });
  assert.ok(m[LLAMA], "the built-in entry survives a stored table that predates it");
  assert.equal(m.junk, undefined);
  assert.equal(m.more, undefined);
  assert.deepEqual(mergedPrices(undefined), DEFAULT_SETTINGS.prices);
  assert.deepEqual(mergedPrices([1]), DEFAULT_SETTINGS.prices);
});

// ------------------------------------------------------------------ assertSettingsConsistent

test("model and proposalModel must be priced: an unpriced id is refused with a clear 400", () => {
  bad(() => assertSettingsConsistent(testSettings(), validateSettingsPatch({ model: "nobody-priced-this" })), /model "nobody-priced-this" has no entry in prices/);
  bad(() => assertSettingsConsistent(testSettings(), validateSettingsPatch({ proposalModel: "nobody-priced-this" })), /proposalModel "nobody-priced-this"/);
  // Priced in the stored table, or in the built-in one (the Model page can select the Workers AI model).
  assertSettingsConsistent(testSettings(), validateSettingsPatch({ model: "claude-sonnet-5", proposalModel: "claude-opus-5" }));
  assertSettingsConsistent(testSettings(), validateSettingsPatch({ provider: "workersai", model: LLAMA }));
  // A price arriving in the same patch counts.
  assertSettingsConsistent(testSettings(), validateSettingsPatch({ model: "new-model", prices: { "new-model": { inputPerMTok: 1, outputPerMTok: 2 } } }));
});

test("a prices patch may not drop the price of the model in use; the built-in table still backs the defaults", () => {
  const custom = testSettings({ model: "mine", prices: { mine: { inputPerMTok: 1, outputPerMTok: 2 }, "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 } } });
  bad(() => assertSettingsConsistent(custom, validateSettingsPatch({ prices: { "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 } } })), /model "mine" has no entry/);
  // claude-opus-5 stays priced through the built-in table even when the stored one omits it.
  assertSettingsConsistent(testSettings(), validateSettingsPatch({ prices: { other: { inputPerMTok: 1, outputPerMTok: 1 } } }));
});

test("existing stored settings keep working: a patch that touches neither the models nor the prices is not checked against them", () => {
  const stale = testSettings({ model: "retired-model" });
  assertSettingsConsistent(stale, validateSettingsPatch({ dailyCapUsd: 5, temperature: 0.5 }));
  bad(() => assertSettingsConsistent(stale, validateSettingsPatch({ model: "retired-model" })), /retired-model/);
});

test("imageCostUsd 0 is refused for a paid image provider and allowed for a keyless one", () => {
  bad(() => assertSettingsConsistent(testSettings({ imageProvider: "openai" }), validateSettingsPatch({ imageCostUsd: 0 })), /imageCostUsd must be above 0 for image provider openai/);
  bad(() => assertSettingsConsistent(testSettings({ imageProvider: "stub", imageCostUsd: 0 }), validateSettingsPatch({ imageProvider: "openai" })), /imageCostUsd must be above 0/);
  bad(() => assertSettingsConsistent(testSettings(), validateSettingsPatch({ imageProvider: "openai", imageCostUsd: 0 })), /imageCostUsd/);
  assertSettingsConsistent(testSettings({ imageProvider: "stub" }), validateSettingsPatch({ imageCostUsd: 0 }));
  assertSettingsConsistent(testSettings({ imageProvider: "openai" }), validateSettingsPatch({ imageCostUsd: 0.04 }));
  assertSettingsConsistent(testSettings({ imageProvider: "openai", imageCostUsd: 0.06 }), validateSettingsPatch({ imageProvider: "openai" }));
});

// ------------------------------------------------------------------ the deploy guard

test("stripJsonc: comments and trailing commas go, string contents stay", () => {
  const text = "{\n  // line\n  \"a\": \"x // not a comment\", /* block */\n  \"b\": [1, 2,],\n  \"c\": \"slash\\\\\",\n}\n";
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: "x // not a comment", b: [1, 2], c: "slash\\" });
});

test("deployProblems: empty ACCESS_AUD, workers_dev or preview_urls not false each refuse; the current wrangler.jsonc passes", async () => {
  const good = { workers_dev: false, preview_urls: false, vars: { ACCESS_AUD: "tag" } };
  assert.deepEqual(deployProblems(good), []);
  assert.ok(deployProblems({ ...good, vars: { ACCESS_AUD: "" } }).some((p) => /ACCESS_AUD/.test(p)));
  assert.ok(deployProblems({ ...good, vars: {} }).some((p) => /ACCESS_AUD/.test(p)));
  assert.ok(deployProblems({ ...good, workers_dev: true }).some((p) => /workers_dev/.test(p)));
  assert.ok(deployProblems({ ...good, preview_urls: undefined }).some((p) => /preview_urls/.test(p)));
  const { readFileSync } = await import("node:fs");
  const current = JSON.parse(stripJsonc(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")));
  assert.deepEqual(deployProblems(current), []);
});
