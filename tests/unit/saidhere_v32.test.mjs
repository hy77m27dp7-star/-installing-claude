// v3.2 "Said in this conversation": what he told her in the open chat counts as known whether
// or not the owner has approved it into memory yet (2026-09-25: she said "i dont even know
// your name" 60 messages after he gave it, because the prompt read "nothing yet").
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, factRow, historyRow, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { promptStateV2 } from "./helpers_v2.mjs";

const prompt = await loadSrc("prompt");
const context = await loadSrc("context");

test("saidKey and dedupeSaid: two wordings of the same fact are one line, memory facts are excluded, rejected typography is cleaned, the cap keeps the newest", () => {
  const { saidKey, dedupeSaid, saidLine } = context;
  assert.equal(saidKey("His name is Justin"), saidKey("Justin's name is Justin"));
  assert.notEqual(saidKey("He is 44 years old"), saidKey("His name is Justin"));
  const lines = dedupeSaid(["His name is Justin", "Justin's name is Justin", "He is 44 years old", "Justin says his heart is beating fast, nervous"]);
  assert.deepEqual(lines, ["His name is Justin", "He is 44 years old", "Justin says his heart is beating fast, nervous"]);
  const minus = dedupeSaid(["His name is Justin", "He is 44 years old"], ["Justin's name is Justin"]);
  assert.deepEqual(minus, ["He is 44 years old"], "a line already in memory is not repeated");
  assert.equal(saidLine("he is 44 " + String.fromCharCode(0x2014) + " nervous" + String.fromCharCode(0x2026)), "he is 44 -- nervous...");
  const many = dedupeSaid(Array.from({ length: 30 }, (_, i) => "fact number " + i + " about him"));
  assert.equal(many.length, 25);
  assert.equal(many[24], "fact number 29 about him");
  assert.deepEqual(dedupeSaid([]), []);
  assert.deepEqual(dedupeSaid(["", "   ", null]), []);
});

test("buildSaidHere splits his lines and hers and excludes what memory already holds", () => {
  const rows = [
    { kind: "justin_fact", proposal: "His name is Justin" },
    { kind: "avelie_fact", proposal: "Avelie once cut her own bangs" },
    { kind: "justin_fact", proposal: "He is 44 years old" },
    { kind: "avelie_fact", proposal: "Avelie works at a clothing shop on Exchange Street" },
  ];
  const out = context.buildSaidHere(rows, [factRow({ id: "f1", scope: "justin", fact: "he is 44 years old" })], [factRow({ id: "f2", scope: "avelie", fact: "Avelie works at a clothing shop on Exchange Street" })]);
  assert.deepEqual(out.him, ["His name is Justin"]);
  assert.deepEqual(out.her, ["Avelie once cut her own bangs"]);
});

test("prompt: with nothing said and a short conversation the sections read as before; with lines said they appear under WHAT YOU KNOW ABOUT HIM and THINGS TRUE ABOUT YOU, and a long first conversation gets the prefix", () => {
  const base = { justinFacts: [], history: [], hasSharedHistory: false };
  const before = prompt.stateSections(promptStateV2({ ...base }));
  const same = prompt.stateSections(promptStateV2({ ...base, saidHere: { him: [], her: [] }, storyRows: 2 }));
  assert.equal(same, before, "empty lists and a short conversation change nothing");
  assert.ok(before.includes("WHAT YOU KNOW ABOUT HIM (only what he told you in conversation; nothing else exists)\n- nothing yet"));
  assert.ok(!before.includes("Said in this conversation"));
  assert.ok(!before.includes("This is still your first conversation"));

  const s = prompt.stateSections(promptStateV2({ ...base, saidHere: { him: ["His name is Justin", "He is 44 years old"], her: ["Avelie once cut her own bangs"] }, storyRows: 70 }));
  assert.ok(s.includes("- nothing yet from before this conversation"));
  assert.ok(/Said in this conversation \(he told you these[^\n]*\n- His name is Justin\n- He is 44 years old/.test(s), s.slice(s.indexOf("WHAT YOU KNOW"), s.indexOf("WHAT YOU KNOW") + 500));
  assert.ok(/Told him in this conversation \(already said; not new to him\):\n- Avelie once cut her own bangs/.test(s));
  assert.ok(s.includes("FIRST CONVERSATION (active because SHARED HISTORY is empty)\nThis is still your first conversation, and it has been going for a while"));
  assert.ok(s.includes("never claim not to know something he told you in it"));
  assert.ok(!BAD_TYPOGRAPHY.test(s));

  // With a fact in memory the "nothing yet" line goes and the said lines still ride.
  const withFact = prompt.stateSections(promptStateV2({ ...base, justinFacts: [factRow({ id: "fj", scope: "justin", fact: "his dog is called biscuit" })], saidHere: { him: ["His name is Justin"], her: [] }, storyRows: 70 }));
  assert.ok(!withFact.includes("nothing yet"));
  assert.ok(withFact.includes("- his dog is called biscuit"));
  assert.ok(withFact.includes("- His name is Justin"));

  // Shared history on: no FIRST CONVERSATION block at all, said lines still ride.
  const known = prompt.stateSections(promptStateV2({ ...base, hasSharedHistory: true, history: [historyRow()], saidHere: { him: ["His name is Justin"], her: [] }, storyRows: 70 }));
  assert.ok(!known.includes("FIRST CONVERSATION"));
  assert.ok(known.includes("- His name is Justin"));

  // A short first conversation keeps the block exactly as before even with lines said.
  const short = prompt.stateSections(promptStateV2({ ...base, saidHere: { him: ["His name is Justin"], her: [] }, storyRows: 3 }));
  assert.ok(!short.includes("This is still your first conversation"));
  assert.ok(short.includes("- His name is Justin"));
});
