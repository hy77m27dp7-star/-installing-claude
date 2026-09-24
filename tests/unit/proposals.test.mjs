// parseProposalJson: tolerant parsing of the proposal model's output. Nothing here promotes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const { parseProposalJson } = await loadSrc("proposals");

const ONE = { kind: "avelie_fact", proposal: "she hates cilantro", evidence: "[[FACT:she hates cilantro]]", confidence: "high", scope: "general" };

test("a plain JSON array parses", () => {
  const out = parseProposalJson(JSON.stringify([ONE]));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "avelie_fact");
  assert.equal(out[0].proposal, "she hates cilantro");
  assert.equal(out[0].evidence, "[[FACT:she hates cilantro]]");
  assert.equal(out[0].confidence, "high");
  assert.equal(out[0].scope, "general");
});

test("a fenced code block parses", () => {
  const out = parseProposalJson("```json\n" + JSON.stringify([ONE]) + "\n```");
  assert.equal(out.length, 1);
  assert.equal(parseProposalJson("```\n" + JSON.stringify([ONE]) + "\n```").length, 1);
});

test("prose around the array is ignored", () => {
  const out = parseProposalJson("Here is what I found:\n\n" + JSON.stringify([ONE]) + "\n\nLet me know if you need more.");
  assert.equal(out.length, 1);
});

test("invalid kinds are dropped, valid ones kept", () => {
  const out = parseProposalJson(JSON.stringify([{ ...ONE, kind: "nope" }, ONE, { ...ONE, kind: 42 }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "avelie_fact");
});

test("every contract kind is accepted", () => {
  const kinds = ["avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown"];
  const out = parseProposalJson(JSON.stringify(kinds.map((kind, i) => ({ ...ONE, kind, proposal: "p" + i }))));
  assert.deepEqual(out.map((p) => p.kind), kinds);
});

test("a non-array (object, empty array, empty string, garbage) yields []", () => {
  assert.deepEqual(parseProposalJson(JSON.stringify(ONE)), []);
  assert.deepEqual(parseProposalJson("[]"), []);
  assert.deepEqual(parseProposalJson(""), []);
  assert.deepEqual(parseProposalJson("nothing durable happened"), []);
  assert.deepEqual(parseProposalJson("[not json"), []);
  assert.deepEqual(parseProposalJson("null"), []);
});

test("an element without a proposal string is dropped; missing fields get safe defaults", () => {
  const out = parseProposalJson(JSON.stringify([
    { kind: "avelie_fact" },
    { kind: "avelie_fact", proposal: "   " },
    { kind: "justin_fact", proposal: "he has a dog", confidence: "certain" },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].proposal, "he has a dog");
  assert.ok(["low", "medium", "high"].includes(out[0].confidence));
  assert.equal(typeof out[0].evidence, "string");
  assert.equal(typeof out[0].scope, "string");
});

test("non-object elements are skipped", () => {
  const out = parseProposalJson(JSON.stringify(["text", 1, null, [ONE], ONE]));
  assert.equal(out.length, 1);
});
