// Fix 2026-09-27 (lane C1): the Anthropic adapter sends output_config.effort only to a model that
// takes it. Haiku 4.5 (claude-haiku-4-5 and claude-haiku-4-5-20251001) answered every nightly
// hygiene call with a 400 because the adapter always sent the effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc } from "./helpers.mjs";

const anthropic = await loadSrc("providers/anthropic");

const NO_EFFORT = [
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-3-opus-20240229",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4",
  "claude-opus-4-20250514",
  "claude-opus-4-0",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-0",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-opus-4-1@20250805",
  "  CLAUDE-HAIKU-4-5  ",
];

const EFFORT = [
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
];

test("effortSupported: false for every Haiku, every Claude 3 id and the pre-Opus-4.5 models, dated or not", () => {
  for (const id of NO_EFFORT) assert.equal(anthropic.effortSupported(id), false, id);
});

test("effortSupported: true for Opus 4.5 and later, every 4.6+, 5.x, Fable, Sonnet 5, Opus 5, Opus 5.5", () => {
  for (const id of EFFORT) assert.equal(anthropic.effortSupported(id), true, id);
});

test("the adapter sends output_config only through effortSupported, and is the only place effort is sent", () => {
  const src = readFileSync(new URL("../../src/providers/anthropic.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(/\.\.\.\(effortSupported\(req\.model\) \? \{ output_config: \{ effort: req\.effort \} \} : \{\}\)/.test(src));
  assert.equal((src.match(/output_config/g) ?? []).length, 1, "one output_config, behind the gate");
  assert.ok(!/thinking:/.test(src), "the adapter never sends a thinking setting");
});
