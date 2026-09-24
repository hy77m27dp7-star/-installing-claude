// tests/behavior/scenarios.json gains the v3 scenarios (SPEC_V3 "Tests added"): nine,
// tagged v3, in their own group, with setup notes, and the recall scenario carrying the
// settings the runner applies and restores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const text = readFileSync(new URL("../../tests/behavior/scenarios.json", import.meta.url), "utf8");
const all = JSON.parse(text);
const v3 = all.filter((s) => s.v3 === true);

test("nine v3 scenarios, group v3, ids H01 to H09, every field the runner reads", () => {
  assert.equal(v3.length, 9, v3.map((s) => s.id).join(","));
  assert.deepEqual(v3.map((s) => s.id), ["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08", "H09"]);
  for (const s of v3) {
    assert.equal(s.group, "v3", s.id);
    assert.ok(Array.isArray(s.turns) && s.turns.length > 0, s.id);
    assert.ok(Array.isArray(s.autoChecks), s.id);
    assert.equal(typeof s.rubric, "string", s.id);
    assert.ok(s.notes && s.notes.startsWith("Setup:"), s.id + " needs a setup note");
    assert.ok(!s.drift, s.id + " is not a drift scenario");
  }
});

test("the recall scenario sets provisionalRecallEvery 8 for its run and the runner restores it", () => {
  const recall = v3.find((s) => /half-remember/i.test(s.title));
  assert.ok(recall, "a half-remember scenario");
  assert.deepEqual(recall.settings, { provisionalRecallEvery: 8 });
  for (const s of v3) if (s !== recall) assert.equal(s.settings, undefined, s.id + " sets nothing");
});

test("the v3 scenarios cover the nine items of the spec and watch the new flag codes", () => {
  const titles = v3.map((s) => s.title.toLowerCase()).join(" | ");
  for (const word of ["want", "ask", "half-remember", "says no", "typo", "one-word", "weather", "call", "tasting"]) assert.ok(titles.includes(word), word + " in: " + titles);
  const checks = new Set(v3.flatMap((s) => s.autoChecks));
  for (const code of ["ask_nag", "shape_uniform", "over_polish", "exemplar_verbatim", "dependency_hook", "tech_leak"]) assert.ok(checks.has(code), code);
  assert.ok(!BAD_TYPOGRAPHY.test(text));
});
