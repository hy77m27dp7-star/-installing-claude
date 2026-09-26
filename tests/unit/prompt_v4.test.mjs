// The prompt in v4 (SPEC_V4 header and amendment A3): PROMPT_VERSION ends -p7 (no new
// state section), the stable prefix hash is pinned (the NEW value after the CLIPS overlay
// lands, on purpose, once; until the overlay is in the tree the v3.3 value must still hold),
// the CLIPS section sits next to PHOTOS with its rules, and the proposal system prompt
// carries the scene and relationship payload lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadSrc, BAD_TYPOGRAPHY } from "./helpers.mjs";

const prompt = await loadSrc("prompt");
const { CONSTITUTION_VERSION } = await loadSrc("generated/constitution");

// The v3.3 tree (commit 35e9ce5, CONSTITUTION_VERSION c-a9c9fa928994ef1f): the hash before
// the CLIPS overlay. It is what the tree carries until the pipeline lane runs build:canon
// with the CLIPS section.
const STABLE_PREFIX_SHA256_V33 = "a6177d8cbeb23639596ecd31d39abead50efeb183ca79b2225aaa3ad46235cd5";
const CONSTITUTION_VERSION_V33 = "c-a9c9fa928994ef1f";
// The NEW hash, pinned once the CLIPS overlay is in src/generated/constitution.ts. Empty
// until then: with CLIPS present and this empty, the test below fails and prints the value
// to pin (the integrator pins it; nothing else about the prefix may move afterwards).
const STABLE_PREFIX_SHA256_V4 = "f51997ec0b46d6e6c3b66ef063466bbe0fdc1bbbe61fa1432d8ffe915eb66c1f";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const prefix = prompt.stablePrefix();
const hasClips = /\nCLIPS\n/.test(prefix);

test("PROMPT_VERSION ends in -p7: v4 adds no state section", () => {
  assert.match(prompt.PROMPT_VERSION, /-p7$/);
  assert.equal(prompt.PROMPT_VERSION, CONSTITUTION_VERSION + "-p7");
});

test("the stable prefix hash: the v3.3 value until the CLIPS overlay lands, the pinned v4 value after", (tc) => {
  const actual = sha(prefix);
  if (!hasClips) {
    assert.equal(CONSTITUTION_VERSION, CONSTITUTION_VERSION_V33, "without CLIPS the constitution is the v3.3 one");
    assert.equal(actual, STABLE_PREFIX_SHA256_V33, "the v3.3 prefix is byte-identical");
    tc.diagnostic("CLIPS overlay not in the tree yet: the v3.3 hash holds");
    return;
  }
  assert.notEqual(actual, STABLE_PREFIX_SHA256_V33, "the prefix moved once, for CLIPS");
  assert.notEqual(CONSTITUTION_VERSION, CONSTITUTION_VERSION_V33, "and so did CONSTITUTION_VERSION");
  assert.ok(STABLE_PREFIX_SHA256_V4, "CLIPS is in the prefix: pin STABLE_PREFIX_SHA256_V4 in tests/unit/prompt_v4.test.mjs to " + actual + " (the integrator's one edit here)");
  assert.equal(actual, STABLE_PREFIX_SHA256_V4, "the pinned v4 prefix hash");
});

test("the state-section order is the v3.3 one (no new section): IN BED last, THIS MESSAGE before it", () => {
  assert.ok(typeof prompt.IN_BED_SECTION === "string" && prompt.IN_BED_SECTION.length > 0);
  const source = prompt.stateSections.toString();
  assert.ok(source.indexOf("IN_BED_SECTION") > source.indexOf("THIS MESSAGE") || !source.includes("THIS MESSAGE"), "IN BED rides last");
});

const tClips = hasClips ? test : (name, fn) => test.skip(name + " [skipped: the CLIPS overlay is not in src/generated/constitution.ts yet (pipeline lane, npm run build:canon)]", fn);

tClips("CLIPS: next to PHOTOS, the same shape: her own words, at most one per message, only when it fits, never to fill silence, the line stripped, never a mention of recording; singing only when she chooses", () => {
  const clips = prefix.slice(prefix.indexOf("\nCLIPS\n"));
  const section = clips.slice(0, clips.indexOf("\n\n", 8) > 0 ? clips.indexOf("\n\n", 8) : clips.length);
  assert.ok(/\[clip: /.test(section), "the exact line form");
  assert.ok(/at most one per message/i.test(section), "at most one");
  assert.ok(/fill silence/i.test(section), "never to fill silence");
  assert.ok(/stripped/i.test(section), "the line is stripped");
  assert.ok(/never (mention|describe)/i.test(section), "never a mention of recording or sending");
  assert.ok(/sing/i.test(section), "a clip of her singing only when she chooses it");
  assert.ok(prefix.indexOf("\nPHOTOS\n") >= 0 && Math.abs(prefix.indexOf("\nCLIPS\n") - prefix.indexOf("\nPHOTOS\n")) < 4000, "next to PHOTOS");
  assert.ok(!BAD_TYPOGRAPHY.test(section));
  assert.ok(!/\bapp\b|prompt|model/i.test(section.replace(/model of/g, "")), "nothing about the app in her rules");
});

test("proposalSystemPrompt: the first sentence is still the stub's key; the scene and relationship payload lines when landed", (tc) => {
  const text = prompt.proposalSystemPrompt();
  assert.ok(text.startsWith("You read one exchange"), "the stub's key first");
  assert.ok(!BAD_TYPOGRAPHY.test(text));
  if (!/"scene" proposal describes where they are/.test(text)) {
    tc.diagnostic("the scene payload line is not in proposalSystemPrompt yet (pipeline lane)");
    return;
  }
  assert.ok(/"his_name": his first name when he said it or omitted/.test(text));
  assert.ok(/"nicknames": a nickname that stuck or omitted/.test(text));
  assert.ok(/"location": the place in a few words or omitted when it did not change/.test(text));
  assert.ok(/"present": the people there as a list of names or omitted/.test(text));
});
