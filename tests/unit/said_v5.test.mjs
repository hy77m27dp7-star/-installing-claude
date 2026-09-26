// Memory hygiene at the source (SPEC_V5 section 7, src/said.ts): number words fold to digits
// in the dedupe key, and the "said in this conversation" lines drop anything already kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { factRow } from "./helpers.mjs";
import { loadSrcIfPresent, guard } from "./helpers_v5.mjs";

const said = await loadSrcIfPresent("said");
const t = guard(said, "numberWordsToDigits", "saidKey", "saidLine", "buildSaidHere");

t("numberWordsToDigits: forty-four, forty four, nineteen, 'the one i like'", () => {
  assert.equal(said.numberWordsToDigits("Justin is forty-four"), "Justin is 44");
  assert.equal(said.numberWordsToDigits("forty four years"), "44 years");
  assert.equal(said.numberWordsToDigits("Nineteen"), "19");
  assert.equal(said.numberWordsToDigits("twenty"), "20");
  assert.equal(said.numberWordsToDigits("the one i like"), "the 1 i like");
  assert.equal(said.numberWordsToDigits("someone"), "someone", "whole words only");
});

t("the fold lives in the keys only: saidLine keeps her words", () => {
  assert.equal(said.saidLine("the one i like"), "the one i like");
});

t("saidKey('Justin is 44') === saidKey('Justin is forty-four')", () => {
  assert.equal(said.saidKey("Justin is 44"), said.saidKey("Justin is forty-four"));
  assert.notEqual(said.saidKey("Justin is 44"), said.saidKey("Justin is 45"));
});

t("buildSaidHere excludes a pending line that matches an approved fact that is not firm this turn", () => {
  // context.ts now passes EVERY approved fact, not only the firm ones; the dedupe does the rest.
  const rows = [
    { kind: "justin_fact", proposal: "Justin is forty-four" },
    { kind: "justin_fact", proposal: "He works nights" },
    { kind: "avelie_fact", proposal: "She sings at open mics" },
  ];
  const allApproved = [factRow({ id: "f_age", scope: "justin", fact: "Justin is 44" })];
  const her = [factRow({ id: "f_sing", scope: "avelie", fact: "she sings at open mics" })];
  const out = said.buildSaidHere(rows, allApproved, her);
  assert.deepEqual(out.him, ["He works nights"]);
  assert.deepEqual(out.her, []);
});
