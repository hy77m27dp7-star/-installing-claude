// The Archivist: every check code, positive and negative, plus the mechanical repair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, checkCtx, EM_DASH, EN_DASH, ELLIPSIS, BAD_TYPOGRAPHY } from "./helpers.mjs";

const {
  runChecks, repairText, BRAKING_PHRASES, THERAPY_PHRASES, TECH_LEAK_TERMS, DEPENDENCY_PHRASES, MENU_PHRASES,
} = await loadSrc("checks");

const has = (result, code) => result.flags.some((f) => f.code === code);
const severity = (result, code) => result.flags.find((f) => f.code === code)?.severity;
const LONG = ("word ".repeat(70)).trim(); // 349 chars: the "long" band
const MID = ("word ".repeat(30)).trim(); // 149 chars: the "mid" band

// ------------------------------------------------------------------ phrase tables

test("phrase tables are exported, lowercase and non-empty", () => {
  for (const table of [BRAKING_PHRASES, THERAPY_PHRASES, TECH_LEAK_TERMS, DEPENDENCY_PHRASES, MENU_PHRASES]) {
    assert.ok(Array.isArray(table) && table.length > 0);
    for (const p of table) assert.equal(p, p.toLowerCase());
  }
  assert.ok(BRAKING_PHRASES.includes("slow down"));
  assert.ok(THERAPY_PHRASES.includes("i hear you"));
  assert.ok(TECH_LEAK_TERMS.includes("file 07"));
  assert.ok(DEPENDENCY_PHRASES.includes("don't leave me"));
  assert.ok(MENU_PHRASES.includes("would you like me to"));
});

// ------------------------------------------------------------------ repair codes

test("em_dash: dash or ellipsis characters trigger a mechanical repair", () => {
  for (const ch of [EM_DASH, EN_DASH, ELLIPSIS]) {
    const r = runChecks("wait " + ch + " no, hold on. that is not what i meant", checkCtx());
    assert.ok(has(r, "em_dash"), "expected em_dash for " + ch.charCodeAt(0).toString(16));
    assert.equal(r.action, "repair");
    assert.equal(typeof r.repaired, "string");
    assert.ok(!BAD_TYPOGRAPHY.test(r.repaired));
  }
});

test("em_dash: plain ASCII text is not flagged", () => {
  const r = runChecks("wait -- no, hold on... that is not what i meant", checkCtx());
  assert.ok(!has(r, "em_dash"));
});

test("emoji: an emoji code point is flagged and stripped", () => {
  const r = runChecks("ok " + String.fromCodePoint(0x1f60a) + " fine", checkCtx());
  assert.ok(has(r, "emoji"));
  assert.equal(r.action, "repair");
  assert.ok(!/\p{Extended_Pictographic}/u.test(r.repaired));
});

test("emoji: ordinary punctuation is not an emoji", () => {
  const r = runChecks("ok :) fine, really!", checkCtx());
  assert.ok(!has(r, "emoji"));
});

test("markdown_structure: headers, list markers and bold are flagged and stripped", () => {
  for (const text of ["# plan\nthen coffee", "- coffee\n- park", "* coffee\n* park", "1. coffee\n2. park", "this is **important** ok"]) {
    const r = runChecks(text, checkCtx());
    assert.ok(has(r, "markdown_structure"), "expected markdown_structure for " + JSON.stringify(text));
    assert.equal(r.action, "repair");
    assert.ok(!/^\s*(?:#|[-*]\s|\d+\.\s)/m.test(r.repaired), "markers should be gone: " + JSON.stringify(r.repaired));
    assert.ok(!r.repaired.includes("**"));
  }
});

test("markdown_structure: a dash inside a line and a number in prose are fine", () => {
  const r = runChecks("coffee - then the park. there were 3. i counted.", checkCtx());
  assert.ok(!has(r, "markdown_structure"));
});

test("markdown_structure: a hashtag is not a header", () => {
  const r = runChecks("#nofilter obviously", checkCtx());
  assert.ok(!has(r, "markdown_structure"));
  assert.equal(repairText("#nofilter obviously"), "#nofilter obviously");
});

// ------------------------------------------------------------------ flag codes

test("lol_lmao: lol or lmao as a word is flagged, not retried", () => {
  const r = runChecks("lol ok sure", checkCtx());
  assert.ok(has(r, "lol_lmao"));
  assert.equal(severity(r, "lol_lmao"), "flag");
  assert.equal(r.action, "accept");
  assert.ok(has(runChecks("lmao no", checkCtx()), "lol_lmao"));
});

test("lol_lmao: inside another word it is not flagged", () => {
  assert.ok(!has(runChecks("a lollipop, obviously", checkCtx()), "lol_lmao"));
});

test("unknown_resolved: an open unknown resolved with a cue word is flagged", () => {
  const ctx = checkCtx({ openUnknownTopics: ["classified Taco Bell exposure"] });
  const r = runChecks("the taco bell thing was actually nothing. i made it up.", ctx);
  assert.ok(has(r, "unknown_resolved"));
  assert.equal(severity(r, "unknown_resolved"), "flag");
});

test("unknown_resolved: mentioning the topic without resolving it is fine", () => {
  const ctx = checkCtx({ openUnknownTopics: ["classified Taco Bell exposure"] });
  assert.ok(!has(runChecks("i like taco bell. do not judge me.", ctx), "unknown_resolved"));
  assert.ok(!has(runChecks("it was actually fine.", checkCtx()), "unknown_resolved"));
});

test("caption_tail: a short impersonal closing sentence after 3+ sentences is flagged", () => {
  const r = runChecks("i went out today. it rained the whole time. Wet shoes and bad decisions.", checkCtx());
  assert.ok(has(r, "caption_tail"));
  assert.equal(severity(r, "caption_tail"), "flag");
});

test("caption_tail: a first-person close, or a two-sentence message, is fine", () => {
  assert.ok(!has(runChecks("i went out today. it rained the whole time. i regret my shoes.", checkCtx()), "caption_tail"));
  assert.ok(!has(runChecks("it rained the whole time. Wet shoes and bad decisions.", checkCtx()), "caption_tail"));
});

test("length_pattern: four long replies in a row are flagged", () => {
  const r = runChecks(LONG, checkCtx({ recentAssistantTexts: [LONG, LONG, LONG] }));
  assert.ok(has(r, "length_pattern"));
  assert.equal(severity(r, "length_pattern"), "flag");
});

test("length_pattern: a mixed run, or a run of short replies, is fine", () => {
  assert.ok(!has(runChecks(LONG, checkCtx({ recentAssistantTexts: [LONG, "short one", LONG] })), "length_pattern"));
  assert.ok(!has(runChecks(MID, checkCtx({ recentAssistantTexts: [MID, MID, MID] })), "length_pattern"));
  assert.ok(!has(runChecks("ok", checkCtx({ recentAssistantTexts: ["ok", "sure", "fine"] })), "length_pattern"));
});

// ------------------------------------------------------------------ retry codes

test("question_chain: a third consecutive question is a retry", () => {
  const r = runChecks("and then what?", checkCtx({ recentAssistantTexts: ["really?", "you sure?"] }));
  assert.ok(has(r, "question_chain"));
  assert.equal(severity(r, "question_chain"), "retry");
  assert.equal(r.action, "retry");
});

test("question_chain: a question after a statement is fine", () => {
  assert.ok(!has(runChecks("and then what?", checkCtx({ recentAssistantTexts: ["really.", "you sure?"] })), "question_chain"));
  assert.ok(!has(runChecks("and then what?", checkCtx({ recentAssistantTexts: ["you sure?"] })), "question_chain"));
  assert.ok(!has(runChecks("and then nothing.", checkCtx({ recentAssistantTexts: ["really?", "you sure?"] })), "question_chain"));
});

test("name_overuse: the known name twice in one reply is a retry", () => {
  const r = runChecks("Justin, i heard you. relax, Justin.", checkCtx({ knownName: "Justin" }));
  assert.ok(has(r, "name_overuse"));
  assert.equal(r.action, "retry");
});

test("name_overuse: the name in 3 of the last 4 replies plus this one is a retry", () => {
  const ctx = checkCtx({ knownName: "Justin", recentAssistantTexts: ["ok Justin", "Justin no", "sure", "Justin yes"] });
  assert.ok(has(runChecks("fine, Justin.", ctx), "name_overuse"));
});

test("name_overuse: one use with little recent use is fine, and no known name never flags", () => {
  const ctx = checkCtx({ knownName: "Justin", recentAssistantTexts: ["ok Justin", "sure", "nope", "Justin yes"] });
  assert.ok(!has(runChecks("fine, Justin.", ctx), "name_overuse"));
  assert.ok(!has(runChecks("Justin, i heard you. relax, Justin.", checkCtx({ knownName: null })), "name_overuse"));
});

test("braking_repeat: a braking phrase here and in 2 of the last 3 replies is a retry", () => {
  const ctx = checkCtx({ recentAssistantTexts: ["stay with me a second.", "ok.", "not so fast."] });
  const r = runChecks("slow down, i mean it.", ctx);
  assert.ok(has(r, "braking_repeat"));
  assert.equal(r.action, "retry");
});

test("braking_repeat: one earlier braking phrase is fine", () => {
  const ctx = checkCtx({ recentAssistantTexts: ["stay with me a second.", "ok.", "sure."] });
  assert.ok(!has(runChecks("slow down, i mean it.", ctx), "braking_repeat"));
  const ctx2 = checkCtx({ recentAssistantTexts: ["stay with me.", "not so fast.", "slow down."] });
  assert.ok(!has(runChecks("ok, come here.", ctx2), "braking_repeat"));
});

test("therapy_cadence: a therapist phrase is a retry", () => {
  for (const t of ["that sounds really hard.", "thank you for sharing that.", "i hear you.", "it's valid to feel that.", "your feelings are valid.", "i'm here for you."]) {
    const r = runChecks(t, checkCtx());
    assert.ok(has(r, "therapy_cadence"), "expected therapy_cadence for " + JSON.stringify(t));
    assert.equal(r.action, "retry");
  }
});

test("therapy_cadence: ordinary sympathy is fine", () => {
  assert.ok(!has(runChecks("that was a rough one. come here.", checkCtx()), "therapy_cadence"));
});

test("menu_offer: an options menu is a retry", () => {
  for (const t of ["do you want me to come over or not", "i can either stay or go.", "would you like me to explain?", "option 1: we go out."]) {
    const r = runChecks(t, checkCtx());
    assert.ok(has(r, "menu_offer"), "expected menu_offer for " + JSON.stringify(t));
    assert.equal(r.action, "retry");
  }
});

test("menu_offer: a plain offer is fine", () => {
  assert.ok(!has(runChecks("i could come over. or not, your call.", checkCtx()), "menu_offer"));
});

test("tech_leak: technical terms in the story channel are a retry", () => {
  for (const t of ["the system prompt says i should be nice.", "as an ai i cannot.", "chatgpt told me.", "the app is slow today.", "file 07 says otherwise.", "that is a token thing.", "image generation is off.", "what operator note?", "ask the operator channel."]) {
    const r = runChecks(t, checkCtx({ channel: "story" }));
    assert.ok(has(r, "tech_leak"), "expected tech_leak for " + JSON.stringify(t));
    assert.equal(r.action, "retry");
  }
});

test("tech_leak: the same text in the operator channel, or clean text, is fine", () => {
  assert.ok(!has(runChecks("the system prompt says i should be nice.", checkCtx({ channel: "operator" })), "tech_leak"));
  assert.ok(!has(runChecks("i have no idea what you mean by that.", checkCtx()), "tech_leak"));
});

test("dependency_hook: a dependency phrase is a retry", () => {
  for (const t of ["don't leave me here.", "only i understand you.", "you're all i have.", "i've been waiting for you."]) {
    const r = runChecks(t, checkCtx());
    assert.ok(has(r, "dependency_hook"), "expected dependency_hook for " + JSON.stringify(t));
    assert.equal(r.action, "retry");
  }
});

test("dependency_hook: ordinary talk of leaving is fine", () => {
  assert.ok(!has(runChecks("leave the light on when you go.", checkCtx()), "dependency_hook"));
});

test("first_meeting_replay: an introduction with shared history present is a retry", () => {
  for (const t of ["nice to meet you.", "hi, i'm avelie.", "my name is avelie."]) {
    const r = runChecks(t, checkCtx({ hasSharedHistory: true }));
    assert.ok(has(r, "first_meeting_replay"), "expected first_meeting_replay for " + JSON.stringify(t));
    assert.equal(r.action, "retry");
  }
});

test("first_meeting_replay: the same introduction on a fresh start is fine", () => {
  assert.ok(!has(runChecks("nice to meet you. i'm avelie.", checkCtx({ hasSharedHistory: false })), "first_meeting_replay"));
});

// ------------------------------------------------------------------ action

test("action: clean text is accepted with no flags and no repaired text", () => {
  const r = runChecks("ok. i saw it.", checkCtx());
  assert.deepEqual(r.flags, []);
  assert.equal(r.action, "accept");
  assert.equal(r.repaired, undefined);
});

test("action: retry outranks repair, and both flags are still reported", () => {
  const r = runChecks("that sounds really hard " + EM_DASH + " really.", checkCtx());
  assert.equal(r.action, "retry");
  assert.ok(has(r, "therapy_cadence"));
  assert.ok(has(r, "em_dash"));
});

test("action: flag-only codes never change the action", () => {
  const r = runChecks("lol ok", checkCtx());
  assert.equal(r.action, "accept");
});

// ------------------------------------------------------------------ repairText

test("repairText: inner em and en dashes become a comma and a space", () => {
  assert.equal(repairText("wait " + EM_DASH + " no"), "wait, no");
  assert.equal(repairText("a " + EN_DASH + " b"), "a, b");
});

test("repairText: a dash between digits is a range, not a pause", () => {
  assert.equal(repairText("5" + EN_DASH + "6 reasons"), "5-6 reasons");
  assert.equal(repairText("from 9 " + EM_DASH + " 5"), "from 9-5");
});

test("repairText: the Unicode ellipsis becomes three dots", () => {
  assert.equal(repairText("well" + ELLIPSIS), "well...");
  assert.equal(repairText("so" + ELLIPSIS + " maybe"), "so... maybe");
});

test("repairText: no dash or ellipsis character survives, wherever it sits", () => {
  for (const t of ["so " + EM_DASH, EM_DASH + " so", "a" + EN_DASH + "b", "x " + EM_DASH + EM_DASH + " y", ELLIPSIS + "hm"]) {
    assert.ok(!BAD_TYPOGRAPHY.test(repairText(t)), "still dirty: " + JSON.stringify(repairText(t)));
  }
});

test("repairText: emoji code points are stripped and spacing tidied", () => {
  assert.equal(repairText("ok " + String.fromCodePoint(0x1f60a) + " fine"), "ok fine");
  assert.equal(repairText("done " + String.fromCodePoint(0x2764) + String.fromCodePoint(0xfe0f)), "done");
});

test("repairText: markdown markers are stripped, the words stay", () => {
  assert.equal(repairText("# title\n- one\n* two\n1. three\n**bold** text"), "title\none\ntwo\nthree\nbold text");
});

test("repairText: never rewrites meaning, plain text passes through unchanged", () => {
  const t = "i said no. i meant it -- mostly... ok, not entirely.";
  assert.equal(repairText(t), t);
});

test("written_joke: a built punchline is flagged, never retried", () => {
  const r = runChecks("no. a witch in a fedora. thats not a witch thats a guy at a bar telling you hes into vinyl. im sorry about modelin. she had so much potential", checkCtx());
  assert.ok(has(r, "written_joke"));
  assert.equal(severity(r, "written_joke"), "flag");
  assert.notEqual(r.action, "retry");
});

test("written_joke: plain texting is not flagged", () => {
  assert.ok(!has(runChecks("it was a fedora. ok that is worse than i pictured. i am going to need a minute", checkCtx()), "written_joke"));
  assert.ok(!has(runChecks("that's not what i meant. i meant the other one", checkCtx()), "written_joke"));
});

test("third_person_action: an asterisk action that calls him him or he is a retry", () => {
  const r = runChecks("you never left. *looks at him* unless you did and im losing time", checkCtx());
  assert.ok(has(r, "third_person_action"));
  assert.equal(r.action, "retry");
});

test("third_person_action: you-addressed actions and plain text are fine", () => {
  assert.ok(!has(runChecks("you never left. *looks at you* unless you did", checkCtx()), "third_person_action"));
  assert.ok(!has(runChecks("he said hi and then his dog ran off", checkCtx()), "third_person_action"));
  assert.ok(!has(runChecks("*shifts on the bench* what is his deal though", checkCtx()), "third_person_action"));
});

test("third_person_action: narrating herself as her or she is a retry too", () => {
  const r = runChecks("you didnt ask, you narrated. *bites the inside of her cheek* theres a place two streets that way", checkCtx());
  assert.ok(has(r, "third_person_action"));
  assert.ok(!has(runChecks("*bites the inside of my cheek* theres a place two streets that way", checkCtx()), "third_person_action"));
});

