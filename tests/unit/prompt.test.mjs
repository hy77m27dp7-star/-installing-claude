// The system prompt: a stable prefix (the constitution) and per-turn state sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, promptState, factRow, historyRow, unknownRow, BAD_TYPOGRAPHY } from "./helpers.mjs";

const {
  stablePrefix, stateSections, buildSystemPrompt, PROMPT_VERSION, operatorSystemPrompt, proposalSystemPrompt, imageIdentityPrompt,
} = await loadSrc("prompt");

// ------------------------------------------------------------------ stable prefix

test("stablePrefix: identical bytes on every call (cacheable)", () => {
  assert.equal(stablePrefix(), stablePrefix());
  assert.ok(stablePrefix().length > 1000);
});

test("stablePrefix: never names him, never points at a file number", () => {
  const p = stablePrefix();
  assert.ok(!p.includes("Justin"), "the stable prefix must not contain Justin");
  assert.ok(!/file 07/i.test(p), "the stable prefix must not mention file 07");
});

test("stablePrefix: she is 22, never 24", () => {
  const p = stablePrefix();
  assert.ok(/age 22/i.test(p), "expected 'age 22' in the prefix");
  assert.ok(!/24-year/i.test(p));
  assert.ok(!/age 24/i.test(p));
});

test("stablePrefix: typography is clean", () => {
  assert.ok(!BAD_TYPOGRAPHY.test(stablePrefix()));
});

// ------------------------------------------------------------------ state sections

test("stateSections: a fresh start activates FIRST CONVERSATION and says they have not met", () => {
  const s = stateSections(promptState());
  assert.ok(s.includes("FIRST CONVERSATION"));
  assert.ok(s.includes("You have not met him"));
  assert.ok(s.includes("SHARED HISTORY"));
  assert.ok(s.includes("nothing yet"), "no facts about him yet");
});

test("stateSections: with shared history the FIRST CONVERSATION section is omitted and entries are rendered", () => {
  const h = historyRow({ title: "the bench", occurred: "a tuesday", body: "they talked for an hour", what_changed: "they know each other's names now" });
  const s = stateSections(promptState({ hasSharedHistory: true, history: [h] }));
  assert.ok(!s.includes("FIRST CONVERSATION"));
  assert.ok(!s.includes("You have not met him"));
  assert.ok(s.includes("the bench"));
  assert.ok(s.includes("they talked for an hour"));
  assert.ok(s.includes("What changed:"));
});

test("stateSections: told and untold facts land in separate blocks, provisional facts are tagged", () => {
  const told = factRow({ id: "f1", fact: "she sings in the car", disclosed: 1 });
  const untold = factRow({ id: "f2", fact: "she is afraid of being valued for her looks", disclosed: 0, provisional: 1 });
  const s = stateSections(promptState({ avelieFacts: [told, untold] }));
  const toldAt = s.indexOf("Already told him");
  const untoldAt = s.indexOf("Not told him (yet)");
  assert.ok(toldAt >= 0 && untoldAt > toldAt);
  assert.ok(s.indexOf("she sings in the car") > toldAt && s.indexOf("she sings in the car") < untoldAt);
  assert.ok(s.indexOf("afraid of being valued") > untoldAt);
  assert.ok(s.includes("(provisional)"));
});

test("stateSections: facts about him and open unknowns are rendered when present", () => {
  const him = factRow({ id: "f3", scope: "justin", fact: "he has a dog" });
  const u = unknownRow({ topic: "where she grew up", note: "never settled" });
  const s = stateSections(promptState({ justinFacts: [him], unknowns: [u] }));
  assert.ok(s.includes("he has a dog"));
  assert.ok(!s.includes("nothing yet"));
  assert.ok(s.includes("OPEN UNKNOWNS"));
  assert.ok(s.includes("where she grew up: never settled"));
  assert.ok(!stateSections(promptState()).includes("OPEN UNKNOWNS"));
});

test("stateSections: fixed canon and the current state JSON are included", () => {
  const s = stateSections(promptState());
  assert.ok(s.includes("FIXED CANON"));
  assert.ok(s.includes("She is 22."));
  assert.ok(s.includes("CURRENT STATE"));
  assert.ok(s.includes("\"status\":\"strangers\""));
});

// ------------------------------------------------------------------ whole prompt

test("buildSystemPrompt: prefix then state, version carries the constitution version, typography clean", () => {
  const b = buildSystemPrompt(promptState());
  assert.ok(b.system.startsWith(b.prefix));
  assert.ok(b.system.endsWith(b.state));
  assert.equal(b.promptVersion, PROMPT_VERSION);
  assert.ok(typeof PROMPT_VERSION === "string" && PROMPT_VERSION.length > 3);
  assert.ok(!BAD_TYPOGRAPHY.test(b.system));
});

test("buildSystemPrompt: a fresh start never mentions his name anywhere", () => {
  const b = buildSystemPrompt(promptState());
  assert.ok(!b.system.includes("Justin"));
});

// ------------------------------------------------------------------ the other prompts

test("proposalSystemPrompt starts with the prefix the stub keys on and asks for a JSON array", () => {
  const p = proposalSystemPrompt();
  assert.ok(p.startsWith("You read one exchange"));
  assert.ok(p.includes("JSON array"));
  assert.ok(!BAD_TYPOGRAPHY.test(p));
});

test("operatorSystemPrompt starts with the prefix the stub keys on and embeds the facts", () => {
  const p = operatorSystemPrompt({ constitutionVersion: "c-test", promptVersion: "c-test-p3" });
  assert.ok(p.startsWith("You are the operator console"));
  assert.ok(p.includes("c-test-p3"));
  assert.ok(!BAD_TYPOGRAPHY.test(p));
});

test("imageIdentityPrompt: an adult 22-year-old, never 24, typography clean", () => {
  const p = imageIdentityPrompt();
  assert.ok(/22/.test(p));
  assert.ok(!/24/.test(p));
  assert.ok(!BAD_TYPOGRAPHY.test(p));
});
