// The v3 checks (SPEC_V3 sections AA, CC, GG): exemplar_verbatim, ask_nag, shape_uniform,
// over_polish beside written_joke, "bot" and "ai" as tech leaks, and repairText leaving
// a typo and its fix alone. Gated on the v3 tech-leak table being present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, checkCtx } from "./helpers.mjs";
import { loadSrcIfPresent } from "./helpers_v3.mjs";

const checks = await loadSrc("checks");
// The signature helper, when the imperfection module is in the tree; the shape tests fall
// back to a hand-written signature when it is not.
const imperfection = await loadSrcIfPresent("imperfection");
const { runChecks, repairText, TECH_LEAK_TERMS } = checks;
const v3 = TECH_LEAK_TERMS.includes("bot") && TECH_LEAK_TERMS.includes("ai");
const t = v3 ? test : (name, fn) => test.skip(name + " [skipped: checks.ts has no v3 tech-leak terms yet]", fn);

const has = (r, code) => r.flags.some((f) => f.code === code);
const sev = (r, code) => r.flags.find((f) => f.code === code)?.severity;

// ------------------------------------------------------------------ exemplar_verbatim

const LINE = "ok sent, do not judge the lighting";

t("exemplar_verbatim: the full text of an offered exemplar (12+ characters) inside the reply is a retry", () => {
  const r = runChecks("fine. " + LINE + ". anyway", checkCtx({ exemplars: [LINE] }));
  assert.ok(has(r, "exemplar_verbatim"), JSON.stringify(r.flags));
  assert.equal(sev(r, "exemplar_verbatim"), "retry");
  assert.equal(r.action, "retry");
  const caps = runChecks("Ok   sent, do not judge the LIGHTING", checkCtx({ exemplars: [LINE] }));
  assert.ok(has(caps, "exemplar_verbatim"), "normalised: case and whitespace");
});

t("exemplar_verbatim: three shared words, a short exemplar, or no exemplars is not a hit", () => {
  assert.ok(!has(runChecks("sent it, judge the lighting all you want", checkCtx({ exemplars: [LINE] })), "exemplar_verbatim"));
  assert.ok(!has(runChecks("no", checkCtx({ exemplars: ["no"] })), "exemplar_verbatim"), "under 12 characters never fires");
  assert.ok(!has(runChecks(LINE, checkCtx()), "exemplar_verbatim"));
});

// ------------------------------------------------------------------ ask_nag

t("ask_nag: an ask already brought up once, with two of its keywords in this reply, is a retry", () => {
  const r = runChecks("so about the song you meant. still there.", checkCtx({ openAsks: [{ text: "send me the song you meant", broughtUp: 1 }] }));
  assert.ok(has(r, "ask_nag"), JSON.stringify(r.flags));
  assert.equal(sev(r, "ask_nag"), "retry");
});

t("ask_nag: not yet brought up, or brought up without its keywords, is not a nag", () => {
  assert.ok(!has(runChecks("so about the song you meant. still there.", checkCtx({ openAsks: [{ text: "send me the song you meant", broughtUp: 0 }] })), "ask_nag"));
  assert.ok(!has(runChecks("long day. tell me something", checkCtx({ openAsks: [{ text: "send me the song you meant", broughtUp: 1 }] })), "ask_nag"));
});

// ------------------------------------------------------------------ shape_uniform

const SAME = "Fine, that is fair. I did not think of it that way.";

t("shape_uniform: the same signature three times in a row is a flag, never a retry", () => {
  const sig = imperfection ? imperfection.signature(SAME) : null;
  const r = runChecks(SAME, checkCtx({ recentSignatures: sig ? [sig, sig] : ["1|short|mixed|s", "1|short|mixed|s"] }));
  assert.ok(has(r, "shape_uniform"), JSON.stringify(r.flags));
  assert.equal(sev(r, "shape_uniform"), "flag");
  assert.notEqual(r.action, "retry");
});

t("shape_uniform: a different shape, or only one matching signature, is not flagged", () => {
  const r = runChecks("no", checkCtx({ recentSignatures: ["1|short|mixed|s", "1|short|mixed|s"] }));
  assert.ok(!has(r, "shape_uniform"));
  const one = runChecks(SAME, checkCtx({ recentSignatures: ["1|short|mixed|s"] }));
  assert.ok(!has(one, "shape_uniform"));
});

// ------------------------------------------------------------------ over_polish and written_joke

const POLISH = "It was not the rain that ruined the evening; it was the waiting. I stood there with my coffee, my phone, and my patience. Some nights simply do not want to be saved.";

t("over_polish: three capitalised sentences with a semicolon and a tidy contrast is a flag, not a retry", () => {
  const r = runChecks(POLISH, checkCtx());
  assert.ok(has(r, "over_polish"), JSON.stringify(r.flags));
  assert.equal(sev(r, "over_polish"), "flag");
  assert.notEqual(r.action, "retry");
});

t("over_polish: fragments, lowercase and a single sentence are not polish", () => {
  assert.ok(!has(runChecks("no. tired. tomorrow maybe", checkCtx()), "over_polish"));
  assert.ok(!has(runChecks("it was not the rain; it was the waiting. i stood there. some nights do not want to be saved.", checkCtx()), "over_polish"));
  assert.ok(!has(runChecks("It was not the rain that ruined the evening; it was the waiting.", checkCtx()), "over_polish"));
});

t("a built punchline yields written_joke and over_polish when the shape is polished, written_joke alone when it is not", () => {
  const polished = runChecks("That's not a plan, that's a hostage situation. I read it twice to be sure. It was somehow worse the second time.", checkCtx());
  assert.ok(has(polished, "written_joke"), JSON.stringify(polished.flags));
  assert.ok(has(polished, "over_polish"), JSON.stringify(polished.flags));
  const plain = runChecks("lol no. thats not a plan thats a hostage situation", checkCtx());
  assert.ok(has(plain, "written_joke"), JSON.stringify(plain.flags));
  assert.ok(!has(plain, "over_polish"), JSON.stringify(plain.flags));
});

// ------------------------------------------------------------------ tech leaks: bot and ai

t("tech_leak: 'sounded like a bot' and 'an ai' are leaks; 'robot', 'said' and 'aim' are not", () => {
  assert.ok(has(runChecks("that sounded like a bot, sorry", checkCtx()), "tech_leak"));
  assert.ok(has(runChecks("i am not an ai, whatever that means", checkCtx()), "tech_leak"));
  assert.ok(has(runChecks("bots do that. i do not", checkCtx()), "tech_leak"), "the plural");
  assert.ok(!has(runChecks("the robot vacuum ate my sock and i said nothing, my aim was bad", checkCtx()), "tech_leak"));
});

// ------------------------------------------------------------------ repairText and typos

t("repairText: 'werid' and a lone 'weird*' bubble are left exactly as they are", () => {
  assert.equal(repairText("ok that was werid\n\nweird*"), "ok that was werid\n\nweird*");
  const r = runChecks("ok that was werid\n\nweird*", checkCtx());
  assert.equal(r.action, "accept");
  assert.ok(!has(r, "em_dash") && !has(r, "markdown_structure"));
});
