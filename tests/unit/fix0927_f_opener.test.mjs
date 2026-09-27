// fix0927: Let her start in a Together scene answered "*pushes your sunglasses up onto your
// head so i can actually see you* hi". His photos rode on the opener's cue turn (read as him
// arriving) and the note never forbade a greeting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc } from "./helpers.mjs";

const hisFace = await loadSrc("hisFace");
const S = { hisFaceInTogether: true, hisFaceApartEvery: 8 };
const rule = (over) => hisFace.shouldShowFace({ mode: "together", isFirstTurnOfConversation: false, turnsSinceLastShown: 1, userText: "", settings: S, canSee: true, ...over });

test("never his photos on an opener, whatever the mode or the cadence says", () => {
  assert.equal(rule({}), true, "a Together turn of his still carries them");
  assert.equal(rule({ opener: true }), false);
  assert.equal(rule({ opener: true, isFirstTurnOfConversation: true }), false);
  assert.equal(rule({ opener: true, mode: "apart", turnsSinceLastShown: 99 }), false);
  assert.equal(rule({ opener: false }), true);
});

test("context passes the opener to the photo rule", () => {
  const src = readFileSync(new URL("../../src/context.ts", import.meta.url), "utf8");
  const i = src.indexOf("shouldShowFace({");
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 400), /\n\s+opener,\n/);
});

test("the together opener note forbids a greeting", () => {
  const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");
  const i = api.indexOf("const SCENE_OPENER_NOTE =");
  const note = api.slice(i, api.indexOf(";", api.indexOf("One or two bubbles", i)));
  assert.match(note, /never a greeting \(no hi, hey or hello\)/);
  assert.match(note, /Continue from exactly where the last messages left off/);
});
