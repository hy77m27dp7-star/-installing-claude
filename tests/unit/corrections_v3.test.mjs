// The corrections ledger (SPEC_V3 section AA): the NOTES FROM HIM section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, guard, correctionRow } from "./helpers_v3.mjs";

const mod = await loadSrcIfPresent("corrections");
const t = guard(mod, "correctionsSection");

const KIND_WORDS = { ai: "not how you talk", clever: "too clever", not_her: "not you", too_long: "too long", too_nice: "too nice", too_polished: "too polished", other: "note" };

t("correctionsSection: empty input renders nothing", () => {
  assert.equal(mod.correctionsSection([], 25), "");
});

t("correctionsSection: the header, newest first, the cap, the 140-character truncation and his version", () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push(correctionRow({ id: "cor_" + i, kind: "ai", note: "note " + i, original: "x".repeat(200) + " tail " + i, rewrite: i === 29 ? "nah" : null, created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }));
  }
  const s = mod.correctionsSection(rows, 25);
  assert.ok(s.startsWith("NOTES FROM HIM"), s.slice(0, 60));
  assert.ok(/never mention these notes/.test(s));
  assert.ok(/they are for your ear only/.test(s));
  assert.ok(/about your voice, never about what you think/.test(s));
  const lines = s.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 25, "capped at limit");
  assert.ok(lines[0].includes("note 29"), "newest first: " + lines[0].slice(0, 80));
  assert.ok(lines[0].includes('His version: "nah"'));
  assert.ok(!lines[0].includes("tail 29"), "the original is cut at 140 characters");
  assert.ok(!s.includes("note 0 "), "the oldest five are not shown");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

t("correctionsSection: every kind renders as its word, never the raw code and never the word bot", () => {
  for (const [kind, word] of Object.entries(KIND_WORDS)) {
    const s = mod.correctionsSection([correctionRow({ kind, note: "" })], 25);
    assert.ok(s.includes("- " + word + ":") || s.includes("- " + word + "."), `${kind} -> ${word}: ${s.split("\n").slice(-1)[0]}`);
    assert.ok(!/- (ai|not_her|too_long|too_nice|too_polished):/.test(s), "raw code shown for " + kind);
  }
  const s = mod.correctionsSection([correctionRow({ kind: "ai", note: null })], 25);
  assert.ok(!/\bbot\b/i.test(s), "the sealed ontology: no bot in the notes");
  assert.ok(/You wrote: "/.test(s));
});

t("correctionsSection: a note with no rewrite carries no His version part", () => {
  const s = mod.correctionsSection([correctionRow({ kind: "clever", note: "trying too hard", rewrite: null })], 25);
  assert.ok(s.includes("too clever: trying too hard."));
  assert.ok(!s.includes("His version"));
});
