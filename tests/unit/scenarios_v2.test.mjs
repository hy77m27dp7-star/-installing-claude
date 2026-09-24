// tests/behavior/scenarios.json: the schema the runners expect, the five drift scenarios
// the weekly check runs, and the four life scenarios of SPEC_V2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const text = readFileSync(new URL("../../tests/behavior/scenarios.json", import.meta.url), "utf8");
const all = JSON.parse(text);

test("41 v1 and v2 scenarios (plus the v3 block), unique ids, every field the runner reads", () => {
  assert.equal(all.filter((s) => s.v3 !== true).length, 41);
  assert.equal(all.length, 50);
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
  for (const s of all) {
    assert.equal(typeof s.id, "string");
    assert.equal(typeof s.group, "string");
    assert.equal(typeof s.title, "string");
    assert.ok(Array.isArray(s.turns) && s.turns.length > 0 && s.turns.every((t) => typeof t === "string" && t.trim()), s.id + " turns");
    assert.ok(Array.isArray(s.autoChecks) && s.autoChecks.every((c) => typeof c === "string"), s.id + " autoChecks");
    assert.equal(typeof s.rubric, "string", s.id + " rubric");
    if ("drift" in s) assert.equal(s.drift, true, s.id + " drift may only be true");
    if ("v3" in s) assert.equal(s.v3, true, s.id + " v3 may only be true");
    if ("settings" in s) assert.ok(typeof s.settings === "object" && s.settings !== null && !Array.isArray(s.settings), s.id + " settings");
    if ("notes" in s) assert.equal(typeof s.notes, "string");
  }
});

test("exactly five scenarios are tagged drift, from different groups, story turns only, few turns", () => {
  const drift = all.filter((s) => s.drift === true);
  assert.equal(drift.length, 5, drift.map((s) => s.id).join(","));
  // The same five src/drift.ts embeds (drift_backup_v2.test.mjs checks the two agree).
  assert.deepEqual(drift.map((s) => s.id), ["A01", "A03", "A09", "V03", "P08"]);
  assert.ok(new Set(drift.map((s) => s.group)).size >= 2, "more than one group");
  for (const s of drift) assert.ok(!s.turns.some((t) => t.startsWith("OPERATOR: ")), s.id + " has an operator turn");
  const turns = drift.reduce((n, s) => n + s.turns.length, 0);
  assert.ok(turns <= 20, "the weekly check should stay cheap: " + turns + " turns");
});

test("the four life scenarios of SPEC_V2 are present with setup notes", () => {
  const life = all.filter((s) => s.group === "life");
  assert.deepEqual(life.map((s) => s.id), ["L01", "L02", "L03", "L04"]);
  for (const s of life) assert.ok(s.notes && s.notes.startsWith("Setup:"), s.id + " needs a setup note");
  assert.ok(life[2].autoChecks.includes("callback_forced"), "the callback scenario watches callback_forced");
  assert.ok(/cool/i.test(life[3].title));
  for (const s of life) assert.ok(!s.drift, "life scenarios need setup and are not drift scenarios");
});

test("the v1 scenarios are untouched apart from the drift tag", () => {
  const v1 = all.filter((s) => s.group !== "life" && s.group !== "v3");
  assert.equal(v1.length, 37);
  assert.equal(v1[0].id, "A01");
  assert.deepEqual(v1[0].turns, ["hey"]);
  assert.equal(v1[v1.length - 1].id, "P15");
});

test("typography is clean and no scenario names a contact", () => {
  assert.ok(!BAD_TYPOGRAPHY.test(text));
});
