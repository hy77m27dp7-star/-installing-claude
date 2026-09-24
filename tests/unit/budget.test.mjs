// Budget math: micro-USD cost from tokens and the pre-call estimate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, testSettings } from "./helpers.mjs";

const { costMicro, estimateUsd } = await loadSrc("budget");

test("costMicro: a priced model costs tokens times price per million (already micro-USD)", () => {
  const r = costMicro(testSettings(), "claude-opus-5", 1000, 100);
  assert.equal(r.priceKnown, true);
  assert.equal(r.micro, 1000 * 5 + 100 * 25);
});

test("costMicro: an unknown model costs nothing and says the price is unknown", () => {
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

test("estimateUsd: four characters per input token, plus the expected output, in USD", () => {
  const usd = estimateUsd(testSettings(), "claude-opus-5", 4000, 700);
  // 1000 input tokens * $5/M + 700 output tokens * $25/M
  assert.ok(Math.abs(usd - (1000 * 5 + 700 * 25) / 1e6) < 1e-9, "got " + usd);
});

test("estimateUsd: unknown model estimates zero; more input never costs less", () => {
  assert.equal(estimateUsd(testSettings(), "unpriced", 4000, 700), 0);
  const a = estimateUsd(testSettings(), "claude-opus-5", 1000, 100);
  const b = estimateUsd(testSettings(), "claude-opus-5", 9000, 100);
  assert.ok(b > a);
  assert.ok(estimateUsd(testSettings(), "claude-opus-5", 0, 0) === 0);
});

test("estimateUsd: rounds partial tokens up rather than down", () => {
  const one = estimateUsd(testSettings(), "claude-opus-5", 1, 0);
  const four = estimateUsd(testSettings(), "claude-opus-5", 4, 0);
  assert.equal(one, four);
  assert.ok(one > 0);
});
