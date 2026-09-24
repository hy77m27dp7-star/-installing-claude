// The v2 prompt: MODE, mood and cooling-off, her life, the callbacks, opinions, the song
// rule in the stable prefix, and the opinion supersede key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, factRow, sceneState, relationshipState, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { TZ, TUE_1510_NY, TUE_2000_NY, promptStateV2, workRoutine, personRow, logRow } from "./helpers_v2.mjs";

const { stablePrefix, stateSections, buildSystemPrompt, PROMPT_VERSION, sceneMode, isOpinionFact, coolingOff } = await loadSrc("prompt");
const { opinionSubject } = await loadSrc("proposals");
const { CONSTITUTION_VERSION } = await loadSrc("generated/constitution");

// ------------------------------------------------------------------ stable prefix

test("stablePrefix: still byte-identical across calls and carries the song rule", () => {
  const p = stablePrefix();
  assert.equal(p, stablePrefix());
  assert.ok(p.includes("[song: Artist - Title]"), "the runtime overlay carries the song marker rule");
  assert.ok(/never name the song or the artist a second time/i.test(p));
  assert.ok(/from your taste, not his/i.test(p));
  assert.ok(!p.includes("Justin"));
  assert.ok(!BAD_TYPOGRAPHY.test(p));
});

test("stablePrefix: nothing from the per-turn state leaks into the prefix", () => {
  const p = stablePrefix();
  // The always-on rules name the CURRENT STATE section as the place to read; the rendered
  // block itself (with the JSON) and the other per-turn headings never appear here.
  for (const s of ["MODE:", "YOUR LIFE RIGHT NOW", "THINGS YOU COULD BRING UP", "CURRENT STATE\nRelationship:", "Mood:", "It is Tuesday"]) {
    assert.ok(!p.includes(s), JSON.stringify(s) + " must not be in the cached prefix");
  }
  assert.ok(p.includes("Follow the CURRENT STATE and SHARED HISTORY sections"), "the rules point at the state sections by name");
});

test("PROMPT_VERSION is derived from the constitution version", () => {
  assert.ok(PROMPT_VERSION.startsWith(CONSTITUTION_VERSION + "-p"), PROMPT_VERSION);
});

// ------------------------------------------------------------------ mode

test("sceneMode: only a scene status of together is together", () => {
  assert.equal(sceneMode("together"), "together");
  assert.equal(sceneMode(" Together "), "together");
  for (const v of ["apart", "none", "", null, undefined, 3]) assert.equal(sceneMode(v), "apart");
});

test("stateSections: together -> the same-place line with the location; he is not narrating her", () => {
  const s = stateSections(promptStateV2({ mode: "together", scene: sceneState({ status: "together", location: "her kitchen" }) }));
  assert.ok(s.includes("MODE: together"));
  assert.ok(s.includes("You are in the same place as him right now: her kitchen."));
  assert.ok(s.includes("Present tense."));
  assert.ok(s.includes("He is not narrating you."));
  assert.ok(!s.includes("MODE: apart"));
});

test("stateSections: apart -> texting from the location, or from wherever her day has her", () => {
  const known = stateSections(promptStateV2({ mode: "apart", scene: sceneState({ status: "apart", location: "the laundromat" }) }));
  assert.ok(known.includes("MODE: apart"));
  assert.ok(known.includes("You are texting from the laundromat."));
  assert.ok(known.includes("He is not there."));
  assert.ok(known.includes("No shared physical scene unless one starts in the conversation and the owner records it."));
  const unknown = stateSections(promptStateV2());
  assert.ok(unknown.includes("You are texting from wherever your day has you."));
  assert.ok(!unknown.includes("MODE: together"));
});

test("stateSections: apart with no location -> her current block fills the place", () => {
  const s = stateSections(promptStateV2({ life: { threads: [workRoutine()], log: [], now: TUE_1510_NY, tz: TZ } }));
  assert.ok(s.includes("wherever your day has you (right now: at work)"), s.split("MODE: apart")[1]?.slice(0, 200));
  const free = stateSections(promptStateV2({ life: { threads: [workRoutine()], log: [], now: TUE_2000_NY, tz: TZ } }));
  assert.ok(!free.includes("(right now:"));
});

test("stateSections: a fresh-start state (no v2 fields) still renders as apart with an empty life", () => {
  const s = stateSections({ ...promptStateV2(), mode: undefined, life: undefined, callbacks: undefined });
  assert.ok(s.includes("MODE: apart"));
  assert.ok(s.includes("FIRST CONVERSATION"));
});

// ------------------------------------------------------------------ mood and cooling-off

test("coolingOff: only a parseable future time counts", () => {
  const now = TUE_1510_NY;
  assert.equal(coolingOff(new Date(now.getTime() + 3600_000).toISOString(), now), true);
  assert.equal(coolingOff(new Date(now.getTime() - 1000).toISOString(), now), false);
  for (const v of [null, undefined, "", "not a date", 5]) assert.equal(coolingOff(v, now), false);
});

test("stateSections: mood renders in CURRENT STATE; a running cooling-off adds the shorter-and-cooler line", () => {
  const until = new Date(TUE_1510_NY.getTime() + 6 * 3600_000).toISOString();
  const s = stateSections(promptStateV2({ relationship: relationshipState({ mood: "annoyed at him", friction: "he made fun of her singing", cooling_off_until: until }) }));
  const cur = s.indexOf("CURRENT STATE");
  assert.ok(cur >= 0);
  assert.ok(s.indexOf("Mood: annoyed at him") > cur);
  assert.ok(s.includes("You are still cooling off from he made fun of her singing."));
  assert.ok(s.includes("Shorter replies, less warmth, no punishment, no threats, no silence as a weapon."));
  assert.ok(s.includes("Repair needs his honest, specific acknowledgment, not a polished speech."));
});

test("stateSections: an expired cooling-off and an empty mood add nothing", () => {
  const past = new Date(TUE_1510_NY.getTime() - 3600_000).toISOString();
  const s = stateSections(promptStateV2({ relationship: relationshipState({ mood: "", cooling_off_until: past }) }));
  assert.ok(!s.includes("Mood:"));
  assert.ok(!s.includes("still cooling off"));
  const none = stateSections(promptStateV2());
  assert.ok(!none.includes("still cooling off"));
});

test("stateSections: cooling off with friction 'none' names what happened between them, not 'none'", () => {
  const until = new Date(TUE_1510_NY.getTime() + 3600_000).toISOString();
  const s = stateSections(promptStateV2({ relationship: relationshipState({ friction: "none", cooling_off_until: until }) }));
  assert.ok(s.includes("still cooling off from what happened between you"));
  assert.ok(!s.includes("cooling off from none"));
});

// ------------------------------------------------------------------ her life and the callbacks

test("stateSections: the life section follows CURRENT STATE and says when nothing is written down", () => {
  const s = stateSections(promptStateV2());
  const cur = s.indexOf("CURRENT STATE");
  const life = s.indexOf("YOUR LIFE RIGHT NOW");
  assert.ok(life > cur, "life comes after the current state");
  assert.ok(s.includes("Nothing about your days has been written down yet"));
});

test("stateSections: with threads and notes the life section carries the day, the block, the people and the notes", () => {
  const s = stateSections(promptStateV2({ life: { threads: [workRoutine(), personRow()], log: [logRow()], now: TUE_1510_NY, tz: TZ } }));
  assert.ok(s.includes("It is Tuesday 3:10pm. You are at work until 5:30pm."));
  assert.ok(s.includes("Dana (best friend)"));
  assert.ok(s.includes("burnt the rice again"));
  assert.ok(!s.includes("Nothing about your days has been written down yet"));
});

test("stateSections: callbacks render as at most two lines under their heading, and not at all when empty", () => {
  const cbs = [
    { text: "the bench by the river", ageDays: 11, sourceId: "h1" },
    { text: "Dana (best friend): moving apartments", ageDays: 4, sourceId: "p1" },
    { text: "never shown", ageDays: 2, sourceId: "x" },
  ];
  const s = stateSections(promptStateV2({ callbacks: cbs }));
  assert.ok(s.includes("THINGS YOU COULD BRING UP (only if it fits; most turns you will not)"));
  assert.ok(s.includes("- 11 days ago: the bench by the river"));
  assert.ok(!s.includes("never shown"));
  assert.ok(!stateSections(promptStateV2()).includes("THINGS YOU COULD BRING UP"));
});

// ------------------------------------------------------------------ opinions

test("isOpinionFact: the subject prefix decides, case-insensitively", () => {
  assert.equal(isOpinionFact(factRow({ subject: "opinion: his song Exits" })), true);
  assert.equal(isOpinionFact(factRow({ subject: "  Opinion: coffee" })), true);
  assert.equal(isOpinionFact(factRow({ subject: "food" })), false);
  assert.equal(isOpinionFact(factRow({ subject: null })), false);
});

test("stateSections: opinions render under their own heading with the prefix kept, outside told and untold", () => {
  const op = factRow({ id: "f_op", subject: "opinion: his song Exits", fact: "the bridge is the only honest part", disclosed: 1 });
  const plain = factRow({ id: "f_plain", fact: "she sings in the car", disclosed: 1 });
  const s = stateSections(promptStateV2({ avelieFacts: [op, plain] }));
  const head = s.indexOf("Opinions you have already voiced");
  assert.ok(head >= 0, "opinions heading");
  assert.ok(s.indexOf("opinion: his song Exits: the bridge is the only honest part") > head);
  const told = s.indexOf("Already told him");
  assert.ok(told >= 0 && told < head, "told block comes before the opinions");
  assert.ok(s.indexOf("she sings in the car") > told && s.indexOf("she sings in the car") < head);
  assert.ok(!s.includes("You have said none of them out loud"), "the plain fact was told");
});

test("opinionSubject: always 'opinion: <topic>', case kept, so a changed mind meets the old row case-insensitively", () => {
  assert.equal(opinionSubject({ subject: "opinion: His Song Exits" }, "whatever").toLowerCase(), "opinion: his song exits");
  assert.equal(opinionSubject({ subject: "Opinion:   His Song Exits" }, "whatever").toLowerCase(), "opinion: his song exits");
  assert.equal(opinionSubject({ subject: "  coffee  " }, "whatever"), "opinion: coffee");
  assert.equal(opinionSubject({ topic: "the diner" }, "whatever"), "opinion: the diner");
  assert.ok(opinionSubject({}, "the bridge is the only honest part. really.").startsWith("opinion: the bridge is the only honest part"));
  assert.ok(opinionSubject({ subject: "x".repeat(500) }, "t").length <= 200);
  assert.ok(opinionSubject({ subject: "opinion: His Song Exits" }, "a").startsWith("opinion: "));
});

// ------------------------------------------------------------------ whole prompt

test("buildSystemPrompt: prefix then state, v2 sections present, typography clean, no name on a fresh start", () => {
  const b = buildSystemPrompt(promptStateV2());
  assert.ok(b.system.startsWith(b.prefix));
  assert.ok(b.system.endsWith(b.state));
  assert.ok(b.state.includes("MODE: apart"));
  assert.ok(b.state.includes("YOUR LIFE RIGHT NOW"));
  assert.equal(b.promptVersion, PROMPT_VERSION);
  assert.ok(!b.system.includes("Justin"));
  assert.ok(!BAD_TYPOGRAPHY.test(b.system));
});
