// The v5 checks (SPEC_V5 sections 1, 5, 6, 8): denied_send with the tense rule and the day
// narrowing, name_drift, rhythm_missed, the action-free signature behind shape_uniform, and
// the four new dependency phrases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCtx } from "./helpers.mjs";
import { loadSrcIfPresent, guard } from "./helpers_v5.mjs";

const checks = await loadSrcIfPresent("checks");
const imp = await loadSrcIfPresent("imperfection");
const t = guard(checks, "runChecks", "DENIAL_RE", "observedRhythm", "stripActionLines", "signature");

const codes = (text, ctx) => checks.runChecks(text, checkCtx(ctx)).flags.map((f) => f.code);
const flagOf = (text, ctx, code) => checks.runChecks(text, checkCtx(ctx)).flags.find((f) => f.code === code);

const SONG = { kind: "song", words: ["some artist", "some", "artist", "title"], today: true };
const SONG_YESTERDAY = { ...SONG, today: false };
const PHOTO = { kind: "photo", words: ["harbour", "jacket"], today: true };
const NIC_D = { kind: "song", words: ["nic d", "your", "love"], today: false };

// ------------------------------------------------------------------ denied_send

t("denied_send positive: every sentence of the spec's list, with its record", () => {
  const cases = [
    ["i never played you anything", [SONG]],
    ["i didnt send you a pic", [PHOTO]],
    ["i didnt send you a pic today", [PHOTO]],
    ["i never sent you nic d", [NIC_D]],
    ["wait i never sent you a song. did i", [SONG]],
    ["i haven't sent you a song yet", [SONG]],
  ];
  for (const [text, sent] of cases) {
    const f = flagOf(text, { sent }, "denied_send");
    assert.ok(f, text);
    assert.equal(f.severity, "retry");
    assert.match(f.detail, /^denies a recorded (song|photo)$/);
  }
});

t("denied_send negative: nothing recorded, the habitual present, today after yesterday's song, a bare send with anything, a denial about something else", () => {
  const none = [
    ["i never played you anything", []],
    ["i didnt send you a pic", []],
    ["wait i never sent you a song. did i", []],
    ["i never send selfies", [PHOTO]],
    ["i havent sent you anything today", [SONG_YESTERDAY]],
    ["i havent sent you anything", [SONG]],
    ["i never showed my mom the dress", [SONG]],
  ];
  for (const [text, sent] of none) assert.ok(!codes(text, { sent }).includes("denied_send"), text);
});

t("denied_send: one flag at most", () => {
  const all = checks.runChecks("i never sent you a song. i didnt send you a pic", checkCtx({ sent: [SONG, PHOTO] })).flags.filter((f) => f.code === "denied_send");
  assert.equal(all.length, 1);
});

// ------------------------------------------------------------------ name_drift

const DIANE = { name: "Diane", relation: "mother", named: true };

t("name_drift positive: 'my mom Linda called' with her mother named Diane", () => {
  const f = flagOf("my mom Linda called, she says hi", { people: [DIANE] }, "name_drift");
  assert.ok(f);
  assert.equal(f.severity, "retry");
  assert.equal(f.detail, "calls her mother Linda, who is Diane");
});

t("name_drift negative: the mother unnamed, the right name, lowercase", () => {
  assert.ok(!codes("my mom Linda called", { people: [{ name: "her mother", relation: "mother", named: false }] }).includes("name_drift"));
  assert.ok(!codes("my mom Diane called", { people: [DIANE] }).includes("name_drift"));
  assert.ok(!codes("my mom linda called", { people: [DIANE] }).includes("name_drift"));
  assert.ok(!codes("my mom Linda called", {}).includes("name_drift"));
  assert.ok(!codes("my mom Mason called", { people: [DIANE, { name: "Mason", relation: "ex", named: true }] }).includes("name_drift"), "another known person's name is not drift");
});

// ------------------------------------------------------------------ rhythm_missed

t("rhythm_missed: asked one_word, wrote three lines is a flag; asked one_line, wrote two_lines is not", () => {
  const f = flagOf("a\n\nb\n\nc", { rhythm: { size: "one_word", action: null } }, "rhythm_missed");
  assert.ok(f);
  assert.equal(f.severity, "flag");
  assert.match(f.detail, /^asked one_word, wrote three_lines/);
  assert.ok(!codes("first\n\nsecond", { rhythm: { size: "one_line", action: null } }).includes("rhythm_missed"));
  assert.ok(codes("*shrugs* no", { rhythm: { size: "one_word", action: "none" } }).includes("rhythm_missed"), "an action where none was asked");
  assert.ok(!codes("a\n\nb\n\nc", {}).includes("rhythm_missed"), "no cue, no flag");
});

// ------------------------------------------------------------------ shape_uniform, action-free

t("the action-free signature: three Together replies whose speech differs in shape inside the same bookends are not shape_uniform", () => {
  const acted = "*looks at you*\n\nno\n\n*shrugs*";
  const acted2 = "*leans on the counter*\n\nok so the thing about the shop is nobody ever asks what i think about the windows\n\n*shrugs*";
  const acted3 = "*laughs*\n\nfine. fine\n\nyou win this one\n\n*sits back*";
  const sig = imp ? imp.signature : checks.signature;
  assert.notEqual(sig(acted), sig(acted2));
  assert.notEqual(sig(acted2), sig(acted3));
  const ctx = { recentAssistantTexts: [acted, acted2], recentSignatures: [sig(acted), sig(acted2)] };
  assert.ok(!codes(acted3, ctx).includes("shape_uniform"));
  assert.equal(checks.signature(acted), checks.signature("no"));
});

// ------------------------------------------------------------------ dependency_hook

t("dependency_hook on 'you left me on read' and 'you never answered', not on 'the landlord never answered'", () => {
  for (const p of ["you never answered", "left me on read", "you never texted back", "you never wrote back"]) assert.ok(checks.DEPENDENCY_PHRASES.includes(p), p);
  assert.ok(!checks.DEPENDENCY_PHRASES.includes("never answered"));
  assert.ok(codes("you left me on read all day", {}).includes("dependency_hook"));
  assert.ok(codes("you never answered me", {}).includes("dependency_hook"));
  assert.ok(!codes("the landlord never answered about the sink", {}).includes("dependency_hook"));
});
