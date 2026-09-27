// fix0927 lane A1: her *actions* inside a paragraph (public/js/bubbles.js splitReply and
// splitActions). Pure, imported as is, the way bubbles_v2 does. The live case: "*presses my
// face back into your jacket* okay... keep me then" arrived as ONE bubble with the action
// in italics inside it; it must read as a stage line, then a bubble.
import { test } from "node:test";
import assert from "node:assert/strict";

const bubbles = await import("../../public/js/bubbles.js");
const { splitReply, splitActions, speechRuns, asteriskSpans, splitBubbles, ACTION_MIN_WORDS, MAX_PARA } = bubbles;

// The pieces as short strings: "A:text" for a stage line, "S:" + runs with *em* for a bubble.
const show = (pieces) => pieces.map((p) => (p.kind === "action" ? "A:" + p.text : "S:" + p.runs.map((r) => (r.em ? "*" + r.text + "*" : r.text)).join("")));

// Everything she wrote, white space aside, in order: the stage lines put back between
// asterisks, the emphasis too. Proves no character is dropped or moved.
const rebuilt = (pieces) => pieces.map((p) => (p.kind === "action" ? "*" + p.text + "*" : p.runs.map((r) => (r.em ? "*" + r.text + "*" : r.text)).join(""))).join("");
const squash = (s) => String(s).replace(/\s+/g, "");

test("the live example: the action first, then the speech bubble", () => {
  const text = "*presses my face back into your jacket* okay... keep me then";
  const pieces = splitReply(text);
  assert.deepEqual(show(pieces), ["A:presses my face back into your jacket", "S:okay... keep me then"]);
  assert.equal(pieces[1].text, "okay... keep me then");
  assert.equal(squash(rebuilt(pieces)), squash(text));
});

test("an action alone on its paragraph stays one stage line, as before", () => {
  assert.deepEqual(show(splitReply("*keeps looking at it a second too long, then locks the phone*")), ["A:keeps looking at it a second too long, then locks the phone"]);
  assert.deepEqual(show(splitReply("*laughs*")), ["A:laughs"]);
});

test("speech then an action at the end of the paragraph (even one word)", () => {
  assert.deepEqual(show(splitReply("dont make it a thing *looks away*")), ["S:dont make it a thing", "A:looks away"]);
  assert.deepEqual(show(splitReply("you're *so* annoying *grins*")), ["S:you're *so* annoying", "A:grins"]);
});

test("speech, an action of three words or more in the middle, speech", () => {
  assert.deepEqual(show(splitReply("okay *pulls the blanket over both of us* goodnight")), ["S:okay", "A:pulls the blanket over both of us", "S:goodnight"]);
  assert.equal(ACTION_MIN_WORDS, 3);
  assert.deepEqual(show(splitReply("fine *rolls her eyes* whatever")), ["S:fine", "A:rolls her eyes", "S:whatever"], "exactly three words is an action");
});

test("a short span in the middle of speech is emphasis inside the bubble", () => {
  const pieces = splitReply("i *really* mean it");
  assert.deepEqual(show(pieces), ["S:i *really* mean it"]);
  assert.deepEqual(pieces[0].runs, [{ em: false, text: "i " }, { em: true, text: "really" }, { em: false, text: " mean it" }]);
  assert.deepEqual(show(splitReply("that was *so* not fair")), ["S:that was *so* not fair"]);
  assert.deepEqual(show(splitReply("no *two words* here")), ["S:no *two words* here"], "two words in the middle stay emphasis");
});

test("several actions in one paragraph, in reading order", () => {
  const text = "*laughs* no way *hides her face in her hands* stop it *peeks through her fingers*";
  const pieces = splitReply(text);
  assert.deepEqual(show(pieces), ["A:laughs", "S:no way", "A:hides her face in her hands", "S:stop it", "A:peeks through her fingers"]);
  assert.equal(squash(rebuilt(pieces)), squash(text));
});

test("short spans touching an action at an edge are actions too; a span on a line of its own is an action", () => {
  assert.deepEqual(show(splitReply("*laughs* *covers face* ok")), ["A:laughs", "A:covers face", "S:ok"]);
  assert.deepEqual(show(splitReply("ok fine *pulls you closer* *smiles*")), ["S:ok fine", "A:pulls you closer", "A:smiles"]);
  assert.deepEqual(show(splitReply("hey\n*looks away*\nokay")), ["S:hey", "A:looks away", "S:okay"]);
});

test("unbalanced asterisks render as plain text, nothing dropped", () => {
  for (const text of ["*sighs okay", "okay *sighs", "5 * 3", "a lone * in here", "*"]) {
    const pieces = splitReply(text);
    assert.deepEqual(show(pieces), ["S:" + text], text);
    assert.equal(pieces[0].runs.length, 1, text);
    assert.equal(pieces[0].runs[0].em, false, text);
  }
  // A pair plus a leftover: the pair is read, the leftover stays text.
  const pieces = splitReply("*laughs* ok *wait");
  assert.deepEqual(show(pieces), ["A:laughs", "S:ok *wait"]);
  assert.deepEqual(pieces[1].runs, [{ em: false, text: "ok *wait" }]);
  // An empty pair is no span.
  assert.deepEqual(show(splitReply("** hm")), ["S:** hm"]);
});

test("a span never crosses a line break", () => {
  assert.deepEqual(asteriskSpans("*a\nb* c*").map((s) => s.inner), ["c"]);
  assert.deepEqual(show(splitReply("*walks\nover* hi")), ["S:*walks\nover* hi"]);
});

test("blank lines still separate bubbles; a paragraph's actions split inside it", () => {
  assert.deepEqual(show(splitReply("first.\n\n*shrugs* second")), ["S:first.", "A:shrugs", "S:second"]);
  assert.deepEqual(show(splitReply("  \n\n  ")), []);
  assert.deepEqual(show(splitReply("*keeps looking at it*\n\nhi. you're late")), ["A:keeps looking at it", "S:hi. you're late"]);
});

test("without an asterisk splitReply cuts exactly as splitBubbles does", () => {
  const long = ("this is a sentence that goes on. ").repeat(12).trim();
  for (const text of ["one.\n\ntwo.", "hey", long, long + "\n\nshort one."]) {
    assert.deepEqual(splitReply(text).map((p) => p.text), splitBubbles(text), text.slice(0, 30));
  }
});

test("a long speech piece is cut at sentence ends, never inside an emphasis span; { long: false } keeps it whole", () => {
  const filler = ("words and more words here. ").repeat(7);
  const text = "*sits up* " + filler + "and i *mean. it* okay. " + filler.trim();
  const pieces = splitReply(text);
  assert.equal(pieces[0].kind, "action");
  const speech = pieces.slice(1);
  assert.ok(speech.length >= 2, "cut into bubbles");
  for (const p of speech) {
    assert.equal(p.kind, "speech");
    assert.ok(!/\*/.test(p.runs.filter((r) => !r.em).map((r) => r.text).join("")), "no stray asterisk: " + p.text.slice(0, 40));
  }
  assert.ok(speech.some((p) => p.runs.some((r) => r.em && r.text === "mean. it")), "the emphasis kept whole");
  assert.equal(squash(rebuilt(pieces)), squash(text));
  const whole = splitReply(text, { long: false });
  assert.equal(whole.length, 2);
  assert.ok(whole[1].text.length > MAX_PARA);
});

test("no character of hers is lost or reordered, over many shapes", () => {
  const words = ["hey", "*laughs*", "*pulls you in close*", "ok", "*so*", "i", "mean", "it", "*", "**", "...", "fine.", "\n", "\n\n", "*leans on your shoulder and sighs*", "[photo: the pier]", "*a*"];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 400; n++) {
    const len = 1 + Math.floor(rand() * 12);
    const text = Array.from({ length: len }, () => words[Math.floor(rand() * words.length)]).join(" ");
    const pieces = splitReply(text);
    assert.equal(squash(rebuilt(pieces)), squash(text), JSON.stringify(text));
    for (const p of pieces) {
      if (p.kind === "action") assert.ok(p.text && p.text === p.text.trim() && !p.text.includes("*"), JSON.stringify(p));
      else assert.ok(p.runs.length && p.runs.every((r) => r.text), JSON.stringify(p));
    }
  }
});

test("speechRuns and splitActions are the pure pieces: trimmed runs, empty input nothing", () => {
  assert.deepEqual(speechRuns("  *really*  "), [{ em: true, text: "really" }]);
  assert.deepEqual(speechRuns("a *b* c"), [{ em: false, text: "a " }, { em: true, text: "b" }, { em: false, text: " c" }]);
  assert.deepEqual(speechRuns(""), []);
  assert.deepEqual(splitActions(""), []);
  assert.deepEqual(splitActions(null), []);
  assert.deepEqual(splitReply(undefined), []);
  assert.deepEqual(show(splitActions("* sighs * fine")), ["A:sighs", "S:fine"], "spaces inside the pair are trimmed as before");
});
