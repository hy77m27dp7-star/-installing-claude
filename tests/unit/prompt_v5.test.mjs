// The prompt in v5 (SPEC_V5 header and "The prompt, section by section"): -p8, the stable
// prefix byte-identical to v4, the v5 section order on a full fixture and absent on a v4
// one, the ten hidden Relationship keys, the guesses sub-list, THIS MESSAGE as the rhythm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadSrc, factRow, historyRow, relationshipState, sceneState, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { TUE_1510_NY, promptStateV2 } from "./helpers_v2.mjs";
import { voiceLine, correctionRow, wantRow, wantLogRow, askRow, weatherNow, groundingRow } from "./helpers_v3.mjs";
import { repoText, viewRow, personRow, beatView, HOUR_MS } from "./helpers_v5.mjs";

const prompt = await loadSrc("prompt");
const { CONSTITUTION_VERSION } = await loadSrc("generated/constitution");
const sha = (s) => createHash("sha256").update(s).digest("hex");

// The value tests/unit/prompt_v4.test.mjs pins, read from that file so the two never drift.
const PINNED = (/const STABLE_PREFIX_SHA256_V4 = "([0-9a-f]{64})"/.exec(repoText("tests/unit/prompt_v4.test.mjs")) ?? [])[1];

const ORDER = [
  "FIXED CANON", "THINGS TRUE ABOUT YOU", "WHAT YOU KNOW ABOUT HIM", "WHAT HE LOOKS LIKE", "HOW YOU READ HIM", "THINGS YOU HALF REMEMBER",
  "SHARED HISTORY", "CURRENT STATE", "MODE:", "RIGHT NOW", "TIME SINCE", "YOUR LIFE RIGHT NOW", "WHO AND WHERE", "WHAT YOU WANT",
  "THINGS YOU COULD BRING UP", "THINGS ON YOUR PHONE", "WHAT YOU HAVE SENT HIM", "SONGS AND HIM", "HOW YOU TEXT", "NOTES FROM HIM",
  "OPEN UNKNOWNS", "FIRST CONVERSATION", "THIS MESSAGE",
];
const V5_HEADERS = ["HOW YOU READ HIM", "TIME SINCE", "WHO AND WHERE", "WHAT YOU HAVE SENT HIM", "SONGS AND HIM"];

const mason = personRow({ id: "pe_mason" });
const MASON_THREAD = { id: "lt_v5_canon_mason", kind: "person", title: "Mason", detail: "A drummer she dated at seventeen.", schedule_json: null, status: "done", relation: "ex", source: null, version: 1, supersedes_id: null, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" };

function v3State(overrides = {}) {
  return promptStateV2({
    justinFacts: [factRow({ id: "fj", scope: "justin", fact: "his dog is called biscuit" })],
    history: [historyRow()],
    hasSharedHistory: false,
    unknowns: [{ id: "u1", topic: "where she grew up", note: null, status: "open", resolution: null, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z" }],
    callbacks: [{ text: "the open mic", ageDays: 5, sourceId: "lt_event" }],
    exemplars: [voiceLine(), voiceLine({ id: "vl_2", text: "no. ask me tomorrow" })],
    corrections: [correctionRow()],
    turnTags: ["apart", "day", "familiar"],
    recall: { entity: "fact", entityId: "fj", score: 0.15, text: "his cousin plays drums" },
    wants: [wantRow()],
    wantLog: [wantLogRow()],
    asks: [askRow()],
    grounding: { city: "Portland, Maine", weather: weatherNow(), outfit: null, today: [groundingRow()] },
    shapeCue: "one_word",
    ...overrides,
  });
}

function fullState(overrides = {}) {
  const due = new Date(TUE_1510_NY.getTime() + 5 * HOUR_MS).toISOString();
  return v3State({
    hisLook: { text: "short dark hair, a close beard", photos: [], attached: 0 },
    views: [viewRow({ view: "you asked before you kissed me", confidence: 0.8 })],
    wrongViews: [],
    viewsShown: 6,
    viewMinConfidence: 0.4,
    timeSince: { hisAgoMs: 3 * HOUR_MS, lastAgoMs: 3 * HOUR_MS, newDay: false },
    gapLineMinMinutes: 120,
    world: { people: [mason], places: [], threads: [MASON_THREAD], facts: [], portraits: {}, picked: { personIds: ["pe_mason"], placeIds: [] } },
    worldShown: 6,
    beats: [beatView({ beat: { want_id: "w_test", due_at: due }, run: { due_at: due } })],
    beatHorizonDays: 7,
    arcMemoryDays: 7,
    media: [{ id: "ml_1", kind: "image", title: "the window at night", description: "the shop window", key: "k", mime: "image/png", bytes: 1, sha256: "x", status: "active", created_at: "2026-09-24T00:00:00.000Z" }],
    sent: [{ messageId: "m_s", conversationId: "c_1", kind: "song", at: new Date(TUE_1510_NY.getTime() - HOUR_MS).toISOString(), label: "Some Artist - Some Title", words: ["some artist"] }],
    songs: { known: ["The National"], disliked: [], missing: null },
    knownArtistsShown: 40,
    rhythm: { size: "one_line", action: null, extra: null },
    ...overrides,
  });
}

test("PROMPT_VERSION ends -p8", () => {
  assert.equal(prompt.PROMPT_VERSION, CONSTITUTION_VERSION + "-p8");
});

test("stablePrefix() sha256 equals the value prompt_v4 pins (the prefix is byte-identical to v4)", () => {
  assert.ok(PINNED, "prompt_v4.test.mjs pins a hash");
  assert.equal(sha(prompt.stablePrefix()), PINNED);
});

test("the v5 section order: every section present on a full fixture, in the header's order", () => {
  const s = prompt.stateSections(fullState());
  const pos = ORDER.map((h) => ({ h, at: s.indexOf(h) }));
  for (const p of pos) assert.ok(p.at >= 0, p.h + " missing");
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i].at > pos[i - 1].at, `${pos[i - 1].h} before ${pos[i].h}`);
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

test("a v4 fixture carries none of the v5 sections", () => {
  const s = prompt.stateSections(v3State());
  for (const h of V5_HEADERS) assert.ok(!s.includes(h), h + " must be absent");
});

test("HOW YOU READ HIM is never on an opener; TIME SINCE never in together mode", () => {
  assert.ok(!prompt.stateSections(fullState({ opener: true })).includes("HOW YOU READ HIM"));
  const together = prompt.stateSections(fullState({ mode: "together", scene: sceneState({ status: "together", location: "the pier" }) }));
  assert.ok(!together.includes("TIME SINCE"));
});

test("IN BED stays last of all inside an intimate scene", () => {
  const scene = sceneState({
    status: "together", location: "her apartment, on the couch, lamps low", time: "late night", present: ["Justin"],
    summary: "Her apartment late at night after their fourth date. They have been kissing on the couch for a while, hot and heavy.",
    last_beat: "kissing on the couch, her on his lap",
  });
  assert.equal(prompt.intimateScene(scene), true, "the v3.3 couch fixture");
  const s = prompt.stateSections(fullState({ mode: "together", scene }));
  assert.ok(s.lastIndexOf(prompt.IN_BED_SECTION) + prompt.IN_BED_SECTION.length === s.length);
  assert.ok(s.indexOf("THIS MESSAGE") < s.indexOf(prompt.IN_BED_SECTION));
});

test("the Relationship line carries none of the ten hidden keys", () => {
  const set = "2026-09-29T12:00:00.000Z";
  const rel = relationshipState({
    mood: "warm", mood_set_at: set, mood_days: 3, cooling_off_until: null,
    friction: "the photo thing", friction_set_at: set, friction_days: 3, cooling_off_set_at: null, cooling_off_hours: null, status_before: "friends",
  });
  const line = prompt.relationshipLine(rel, TUE_1510_NY, null);
  const keys = Object.keys(JSON.parse(line));
  for (const k of ["mood", "mood_set_at", "mood_days", "cooling_off_until", "friction", "friction_set_at", "friction_days", "cooling_off_set_at", "cooling_off_hours", "status_before"]) {
    assert.ok(!keys.includes(k), k);
  }
  const s = prompt.stateSections(fullState({ relationship: rel }));
  assert.match(s, /Friction: the photo thing \((fresh|healing|mostly past)/);
});

test("WHAT YOU KNOW ABOUT HIM: the guesses sub-list after the said facts; 'nothing yet' reads the said list only", () => {
  const facts = [factRow({ id: "fj1", scope: "justin", fact: "his dog is called biscuit" }), { ...factRow({ id: "fj2", scope: "justin", fact: "he works nights" }), inferred: 1 }];
  const s = prompt.stateSections(fullState({ justinFacts: facts }));
  const said = s.indexOf("his dog is called biscuit");
  const header = s.indexOf("Your guesses about him (he never said these; hold them loosely, never tell him one as a fact):");
  const guess = s.indexOf("he works nights");
  assert.ok(said >= 0 && header > said && guess > header);
  const onlyGuess = prompt.stateSections(fullState({ justinFacts: [facts[1]] }));
  assert.match(onlyGuess, /WHAT YOU KNOW ABOUT HIM[^\n]*\n- nothing yet\nYour guesses about him/);
});

test("THIS MESSAGE is the rhythm when the state carries one, v3's cue otherwise", () => {
  const withRhythm = prompt.stateSections(fullState());
  assert.ok(withRhythm.includes("THIS MESSAGE (its shape; the words are yours)\nOne short line. One bubble, nothing after it."));
  assert.ok(!withRhythm.includes("One word, or two, is the whole reply if that is the honest answer."));
  const v3cue = prompt.stateSections(fullState({ rhythm: null }));
  assert.ok(v3cue.includes("THIS MESSAGE\nOne word, or two, is the whole reply if that is the honest answer."));
});

test("TIME SINCE reads one line, never who wrote last", () => {
  const s = prompt.stateSections(fullState());
  const block = s.slice(s.indexOf("TIME SINCE"));
  const lines = block.split("\n");
  assert.equal(lines[1], "You last talked about 3 hours ago.");
  assert.ok(!/he last wrote|you wrote last|unanswered|left you/i.test(block.split("\n\n")[0]));
});
