// Budget math: micro-USD cost from tokens, the pre-call estimate, and the gate that refuses
// a call on a model with no price (an unpriced model would meter at $0 and never trip a cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, loadSrc, testSettings } from "./helpers.mjs";

const { assertBudget, costMicro, estimateUsd, hasPrice } = await loadSrc("budget");

// ------------------------------------------------------------------ costMicro (after the call)

test("costMicro: a priced model costs tokens times price per million (already micro-USD)", () => {
  const r = costMicro(testSettings(), "claude-opus-5", 1000, 100);
  assert.equal(r.priceKnown, true);
  assert.equal(r.micro, 1000 * 5 + 100 * 25);
});

test("costMicro: after the fact an unknown model says so (priceKnown false); the pre-call gate is what refuses it", () => {
  const r = costMicro(testSettings(), "some-model-nobody-priced", 1000, 100);
  assert.equal(r.priceKnown, false);
  assert.equal(r.micro, 0);
});

test("costMicro: zero tokens cost zero, result is an integer", () => {
  const r = costMicro(testSettings(), "claude-opus-5", 0, 0);
  assert.equal(r.micro, 0);
  assert.equal(r.priceKnown, true);
  assert.ok(Number.isInteger(costMicro(testSettings(), "claude-opus-5", 333, 77).micro));
});

test("costMicro: uses the settings price table, not a built-in one", () => {
  const s = testSettings({ prices: { "my-model": { inputPerMTok: 1, outputPerMTok: 2 } } });
  assert.deepEqual(costMicro(s, "my-model", 10, 10), { micro: 30, priceKnown: true });
  assert.equal(costMicro(s, "claude-opus-5", 10, 10).priceKnown, false);
});

// ------------------------------------------------------------------ hasPrice / estimateUsd (before the call)

test("hasPrice: true only for a model with both numbers in the settings table", () => {
  assert.equal(hasPrice(testSettings(), "claude-opus-5"), true);
  assert.equal(hasPrice(testSettings(), "unpriced"), false);
  assert.equal(hasPrice(testSettings({ prices: { half: { inputPerMTok: 1 } } }), "half"), false);
});

test("estimateUsd: four characters per input token, plus the expected output, in USD", () => {
  const usd = estimateUsd(testSettings(), "claude-opus-5", 4000, 700);
  // 1000 input tokens * $5/M + 700 output tokens * $25/M
  assert.ok(Math.abs(usd - (1000 * 5 + 700 * 25) / 1e6) < 1e-9, "got " + usd);
});

test("estimateUsd: an unpriced model is refused with 402 price_unknown, never estimated at zero", () => {
  assert.throws(() => estimateUsd(testSettings(), "unpriced", 4000, 700), (e) => e.status === 402 && e.code === "price_unknown" && /unpriced/.test(e.message));
  assert.throws(() => estimateUsd(testSettings({ prices: {} }), "claude-opus-5", 4000, 700), (e) => e.status === 402 && e.code === "price_unknown");
});

test("estimateUsd: more input never costs less; nothing costs nothing", () => {
  const a = estimateUsd(testSettings(), "claude-opus-5", 1000, 100);
  const b = estimateUsd(testSettings(), "claude-opus-5", 9000, 100);
  assert.ok(b > a);
  assert.equal(estimateUsd(testSettings(), "claude-opus-5", 0, 0), 0);
});

test("estimateUsd: rounds partial tokens up rather than down", () => {
  const one = estimateUsd(testSettings(), "claude-opus-5", 1, 0);
  const four = estimateUsd(testSettings(), "claude-opus-5", 4, 0);
  assert.equal(one, four);
  assert.ok(one > 0);
});

// ------------------------------------------------------------------ assertBudget

// Spend so far, as usage_daily would sum it.
function dbWithSpend(micro) {
  return fakeD1((sql) => (/SUM\(cost_usd_micro\)/.test(sql) ? [{ s: micro }] : []));
}

test("assertBudget: an estimate that is not a finite number is refused (402 price_unknown), not treated as $0", async () => {
  for (const bad of [NaN, Infinity, -1, undefined, "0.01"]) {
    await assert.rejects(assertBudget(dbWithSpend(0), testSettings(), bad), (e) => e.status === 402 && e.code === "price_unknown", "expected refusal for " + String(bad));
  }
});

test("assertBudget: a cap of 0 refuses every call before reading the database", async () => {
  const db = dbWithSpend(0);
  await assert.rejects(assertBudget(db, testSettings({ dailyCapUsd: 0 }), 0.01), (e) => e.status === 402 && e.code === "budget_exceeded" && /daily/.test(e.message));
  await assert.rejects(assertBudget(db, testSettings({ monthlyCapUsd: 0 }), 0.01), (e) => e.status === 402 && e.code === "budget_exceeded" && /monthly/.test(e.message));
  assert.equal(db.log.length, 0);
});

test("assertBudget: under the caps the call goes through; spend plus estimate over a cap is 402 with the arithmetic", async () => {
  await assertBudget(dbWithSpend(1_000_000), testSettings(), 0.5);
  await assert.rejects(assertBudget(dbWithSpend(2_990_000), testSettings(), 0.02), (e) => e.status === 402 && e.code === "budget_exceeded" && /daily/.test(e.message) && /exceeds cap/.test(e.detail));
  await assert.rejects(assertBudget(dbWithSpend(29_990_000), testSettings({ dailyCapUsd: 1000 }), 0.02), (e) => e.status === 402 && /monthly/.test(e.message));
});
