// Reply rhythm (SPEC_V5 section 5): the shape she wrote with action lines set aside, the
// rhythm cue's tables and rolls, THIS MESSAGE, the mapping back to the v3 cue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, guard } from "./helpers_v5.mjs";

const imp = await loadSrcIfPresent("imperfection");
const checks = await loadSrcIfPresent("checks");
const t = guard(imp, "rhythmTable", "rhythmCue", "rhythmSection", "rhythmAsShapeCue", "observedRhythm", "stripActionLines", "signature", "hisTextIsSubstantive");

const BASE = { enabled: true, together: false, opener: false, intimate: false, voiceAllowed: false, typoShare: 0, substantive: false };
const SEEDS = 4000;

function share(recent, opts, pick) {
  const counts = new Map();
  for (let i = 0; i < SEEDS; i++) {
    const r = imp.rhythmCue("seed-" + i, recent, opts);
    const k = pick(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (k) => (counts.get(k) ?? 0) / SEEDS;
}

const LONG = "so i went to the shop this morning and the owner had moved every single thing in the window again without asking me which is fine it is her window but still i had a whole plan for it and now the plan is gone and i am standing there with a box of fake leaves";
const ONE_LINE = "yeah that was a whole thing";
const BOOKEND = "*leans on the counter*\n\nok fine\n\nyou win\n\n*shrugs*";

// ------------------------------------------------------------------ the shape she wrote

t("stripActionLines: an action-only line removed; an action plus speech kept", () => {
  assert.equal(imp.stripActionLines("*looks at you*\n\nno\n\n*shrugs*"), "no");
  assert.equal(imp.stripActionLines("*laughs* ok fine"), "*laughs* ok fine");
  assert.equal(imp.stripActionLines("*sits back*."), "");
});

t("observedRhythm on a fixed table", () => {
  const o = (text) => imp.observedRhythm(text);
  assert.equal(o("no").size, "one_word");
  assert.equal(o("that was a lot honestly").size, "one_line");
  assert.equal(o("word ".repeat(30).trim() + "s").size, "longer", "a 150-character line is longer");
  assert.equal(o("first\n\nsecond").size, "two_lines");
  assert.equal(o("a\n\nb\n\nc").size, "three_lines");
  const only = o("*shrugs*");
  assert.equal(only.size, "one_word");
  assert.equal(only.action, "only");
  assert.equal(only.bubbles, 0);
  const book = o(BOOKEND);
  assert.equal(book.bookended, true);
  assert.equal(book.action, "one");
  assert.equal(book.size, "two_lines");
  assert.equal(o("no").action, "none");
  assert.equal(o("*laughs*\n\nfine").bookended, false, "fewer than three non-empty lines is no bookend");
});

t("signature: action lines set aside; a text with no action line keeps its v3 value (the eight v3 fixtures)", () => {
  assert.equal(imp.signature("*looks at you*\n\nno\n\n*shrugs*"), imp.signature("no"));
  assert.equal(imp.signature("no"), "1|short|lower|s");
  assert.equal(imp.signature("No."), "1|short|mixed|s");
  assert.equal(imp.signature("what do you mean?"), "1|short|lower|q");
  assert.equal(imp.signature("ok that was werid\n\nweird*"), "2|short|lower|s");
  assert.equal(imp.signature("first bubble\n\nsecond bubble\n\nthird bubble"), "3|short|lower|s");
  assert.equal(imp.signature("a\n\nb\n\nc\n\nd\n\ne"), "3|short|lower|s");
  assert.equal(imp.signature("Fine, that is fair. I did not think of it that way."), "1|short|mixed|s");
  assert.equal(imp.signature(("word ".repeat(70)).trim() + "?"), "1|long|lower|q");
  assert.equal(imp.signature("*shrugs*"), "0|short|lower|s", "an empty remainder");
});

// ------------------------------------------------------------------ the tables

t("rhythmTable over 4,000 seeds with no history: one_line 0.30 to 0.38, longer 0.11 to 0.17, typo_fix exactly 0 at share 0", () => {
  const size = share([], BASE, (r) => r.size);
  assert.ok(size("one_line") >= 0.3 && size("one_line") <= 0.38, "one_line " + size("one_line"));
  assert.ok(size("longer") >= 0.11 && size("longer") <= 0.17, "longer " + size("longer"));
  const extra = share([], BASE, (r) => r.extra);
  assert.equal(extra("typo_fix"), 0);
});

t("rhythmTable: after three long replies longer is 0; after three one_line replies one_line is under 0.10", () => {
  const long = imp.rhythmTable([LONG, LONG, LONG], BASE);
  assert.equal(long.sizes.find((r) => r.size === "longer").p, 0);
  const one = imp.rhythmTable([ONE_LINE, ONE_LINE, ONE_LINE], BASE);
  assert.ok(one.sizes.find((r) => r.size === "one_line").p < 0.1);
});

t("rhythmTable: apart the cue's action is null; together after two bookended replies 'one' is under 'none'", () => {
  const apart = imp.rhythmCue("s", [], BASE);
  assert.equal(apart.action, null);
  assert.deepEqual(imp.rhythmTable([], BASE).actions, [{ action: "none", p: 1 }]);
  const tog = imp.rhythmTable([BOOKEND, BOOKEND], { ...BASE, together: true });
  const p = (a) => tog.actions.find((r) => r.action === a).p;
  assert.ok(p("one") < p("none"), `one ${p("one")} none ${p("none")}`);
});

t("rhythmTable: an opener is only one_line and two_lines with no action; intimate is never one_word, action one", () => {
  const op = imp.rhythmTable([], { ...BASE, opener: true, together: true });
  for (const r of op.sizes) if (r.size !== "one_line" && r.size !== "two_lines") assert.equal(r.p, 0, r.size);
  assert.equal(op.actions.find((r) => r.action === "none").p, 1);
  const extras = op.extras.filter((r) => r.p > 0 && r.extra !== null).map((r) => r.extra);
  assert.deepEqual(extras, ["lowercase"]);
  const inti = imp.rhythmTable([], { ...BASE, together: true, intimate: true });
  assert.equal(inti.sizes.find((r) => r.size === "one_word").p, 0);
  assert.equal(inti.actions.find((r) => r.action === "one").p, 1);
});

t("rhythmTable: substantive (a '?' or 201 characters) zeroes one_word and the action only over 4,000 seeds; the rest renormalised", () => {
  assert.equal(imp.hisTextIsSubstantive("what do you sing?"), true);
  assert.equal(imp.hisTextIsSubstantive("x".repeat(201)), true);
  assert.equal(imp.hisTextIsSubstantive("x".repeat(200)), false);
  assert.equal(imp.hisTextIsSubstantive(""), false);
  const opts = { ...BASE, together: true, substantive: true };
  const size = share([], opts, (r) => r.size);
  const action = share([], opts, (r) => r.action);
  assert.equal(size("one_word"), 0);
  assert.equal(action("only"), 0);
  const tbl = imp.rhythmTable([], opts);
  const total = tbl.sizes.reduce((s, r) => s + r.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(tbl.sizes.find((r) => r.size === "one_line").p - 0.34 / 0.88) < 1e-9);
});

t("rhythmCue: deterministic by seed; null when the cues are off", () => {
  const a = imp.rhythmCue("turn-42", [ONE_LINE], { ...BASE, together: true });
  const b = imp.rhythmCue("turn-42", [ONE_LINE], { ...BASE, together: true });
  assert.deepEqual(a, b);
  assert.equal(imp.rhythmCue("turn-42", [], { ...BASE, enabled: false }), null);
});

t("rhythmSection: the header and one line per part; null is empty; typography clean", () => {
  assert.equal(imp.rhythmSection(null), "");
  const s = imp.rhythmSection({ size: "one_word", action: "none", extra: "lowercase" });
  assert.equal(s.split("\n")[0], "THIS MESSAGE (its shape; the words are yours)");
  assert.ok(s.includes("One word, or two. That is the whole reply."));
  assert.ok(s.includes("No asterisk action in this one; just what you say."));
  assert.ok(s.includes(imp.CUE_LINES.lowercase));
  const sizes = {
    one_line: "One short line. One bubble, nothing after it.",
    two_lines: "Two short bubbles (a blank line between them), each one line.",
    three_lines: "Three short bubbles (blank lines between them), each one line or less.",
    longer: "You have something to say: one longer message, a few sentences, still how you text, no tidy last line.",
  };
  for (const [size, line] of Object.entries(sizes)) assert.equal(imp.rhythmSection({ size, action: null, extra: null }), "THIS MESSAGE (its shape; the words are yours)\n" + line);
  assert.ok(imp.rhythmSection({ size: "one_line", action: "one", extra: null }).includes("At most one short action between asterisks, where it belongs, never one at the start and another at the end."));
  assert.ok(imp.rhythmSection({ size: "one_line", action: "only", extra: null }).includes("Just an action between asterisks, or an action and a word or two; nothing else."));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

t("rhythmAsShapeCue: the extra first, else one_word, bubbles, long, null for one_line", () => {
  assert.equal(imp.rhythmAsShapeCue(null), null);
  assert.equal(imp.rhythmAsShapeCue({ size: "longer", action: null, extra: "typo_fix" }), "typo_fix");
  assert.equal(imp.rhythmAsShapeCue({ size: "one_word", action: null, extra: null }), "one_word");
  assert.equal(imp.rhythmAsShapeCue({ size: "two_lines", action: null, extra: null }), "bubbles");
  assert.equal(imp.rhythmAsShapeCue({ size: "three_lines", action: null, extra: null }), "bubbles");
  assert.equal(imp.rhythmAsShapeCue({ size: "longer", action: null, extra: null }), "long");
  assert.equal(imp.rhythmAsShapeCue({ size: "one_line", action: null, extra: null }), null);
});

t("v3's shapeCue, cueTable, cueSection and CUE_LINES stay exported", () => {
  for (const k of ["shapeCue", "cueTable", "cueSection", "CUE_LINES"]) assert.ok(imp[k], k);
  assert.ok(checks && Array.isArray(checks.RHYTHM_SIZES));
  assert.deepEqual([...checks.RHYTHM_SIZES], ["one_word", "one_line", "two_lines", "three_lines", "longer"]);
});
