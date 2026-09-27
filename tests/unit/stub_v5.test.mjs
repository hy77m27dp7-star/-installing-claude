// The v5 stub (SPEC_V5 "Stub additions"): the five nightly prefixes are COPIES in
// src/providers/stub.ts that equal their modules' constants (read as text: stub.ts never
// imports the nightly modules), and the stub answers every v5 trigger as the spec writes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { repoText } from "./helpers_v5.mjs";

const stubText = repoText("src/providers/stub.ts");
const { stubProvider, stubSpotifyFetch } = await loadSrc("providers/stub");

const PREFIXES = [
  ["HER_DAY_PREFIX", "src/nightly.ts", "Write what happened in Avelie's day"],
  ["ARC_PREFIX", "src/arcs.ts", "Decide how one dated step"],
  ["VIEWS_PREFIX", "src/views.ts", "Read the record for how Avelie"],
  ["MERGE_PREFIX", "src/hygiene.ts", "Decide which groups of facts"],
  ["INFERRED_PREFIX", "src/hygiene.ts", "Decide whether he said"],
];
const constOf = (text, name) => {
  const m = new RegExp("(?:export )?const " + name + " = \"([^\"]+)\";").exec(text);
  return m ? m[1] : null;
};

test("the five prefix copies in stub.ts equal their modules' constants and the spec's words", () => {
  for (const [name, file, words] of PREFIXES) {
    assert.equal(constOf(stubText, name), words, "stub.ts " + name);
    assert.equal(constOf(repoText(file), name), words, file + " " + name);
  }
});

test("stub.ts never imports a nightly module", () => {
  for (const m of ["nightly", "arcs", "views", "hygiene", "storycall"]) assert.ok(!new RegExp("from \"\\.\\./" + m + "\"").test(stubText), m);
});

const ENV = { APP_ENV: "test" };
const gen = async (system, user) => (await stubProvider.generate(ENV, { system, messages: [{ role: "user", content: user }], model: "stub", maxTokens: 400, temperature: 0 })).text;
const story = async (user) => gen("You are Avelie.", user);

test("story replies: DENY, NAMEDRIFT, ACTED, ACTED2, ACTED3, SONGNF", async () => {
  assert.equal(await story("[[DENY]]"), "wait i never sent you a song. did i");
  assert.equal(await story("[[NAMEDRIFT]]"), "my mom Linda called, she says hi");
  assert.equal(await story("[[ACTED]]"), "*looks at you*\n\nno\n\n*shrugs*");
  assert.equal(await story("[[ACTED2]]"), "*leans on the counter*\n\nok so the thing about the shop is nobody ever asks what i think about the windows\n\n*shrugs*");
  assert.equal(await story("[[ACTED3]]"), "*laughs*\n\nfine. fine\n\nyou win this one\n\n*sits back*");
  assert.equal(await story("[[SONGNF]]"), "found it again\n[song: Nobody Real - Notfound Song]");
});

test("the her-day pass: the first THREADS title at 13:00; [] when THREADS is (none)", async () => {
  const sys = "Write what happened in Avelie's day on 2026-09-29 (Tuesday): ...";
  const user = "THREADS:\n- the shop (place): she does the windows\n- Dana (person, best friend): moving\nHER:\n(none)\nWEATHER: (unknown)";
  assert.deepEqual(JSON.parse(await gen(sys, user)), [{ thread: "the shop", note: "stub day note", time: "13:00" }]);
  assert.deepEqual(JSON.parse(await gen(sys, "THREADS:\n(none)\nHER:\n(none)")), []);
});

test("the arc pass: the first variant id and the first OUTCOMES value, his part none", async () => {
  const sys = "Decide how one dated step in Avelie's own life went.";
  const withV = JSON.parse(await gen(sys, "WANT: x (10%).\nSTEP: the open mic (event), Tuesday 2026-09-29 at 20:00.\nOUTCOMES: went, went_well, went_badly, chickened_out, postponed\nVARIANTS:\n- v1: went_badly: her voice cracked\n- v2: went_well: they clapped\nHER:\n(none)"));
  assert.deepEqual(withV, { variant_id: "v1", outcome: "went", note: "stub outcome", his_part: "none", his_note: "", evidence: [] });
  const noV = JSON.parse(await gen(sys, "WANT: x (10%).\nSTEP: sign up (step), Tuesday 2026-09-29.\nOUTCOMES: did_it, missed, postponed\nHER:\n(none)"));
  assert.equal(noV.outcome, "did_it");
  assert.ok(!("variant_id" in noV));
});

test("the views pass: one new read from the MESSAGES lines carrying [[VIEW]], else []", async () => {
  const sys = "Read the record for how Avelie, a 22-year-old woman, reads the man she is talking to.";
  const out = JSON.parse(await gen(sys, "CURRENT READS:\n(none)\n\nMESSAGES:\n- [m_1] him: hi [[VIEW]]\n- [m_2] her: hey\n- [m_3] him: again [[VIEW]]"));
  assert.deepEqual(out, [{ op: "new", subject: "stub read", view: "you answer fast when it matters", confidence: 0.8, evidence: ["m_1", "m_3"] }]);
  assert.deepEqual(JSON.parse(await gen(sys, "CURRENT READS:\n(none)\n\nMESSAGES:\n- [m_1] him: hi")), []);
});

test("the hygiene passes: every GROUP the same, worded as its first fact; every FACT not said", async () => {
  const merge = JSON.parse(await gen("Decide which groups of facts say the same thing.", "GROUP n1:\n- [f_1] Justin moved to LA\n- [f_2] He moved to LA\n\nGROUP n2:\n- [f_3] He has a dog\n- [f_4] his dog"));
  assert.deepEqual(merge, [{ group: "n1", same: true, text: "Justin moved to LA" }, { group: "n2", same: true, text: "He has a dog" }]);
  const inferred = JSON.parse(await gen("Decide whether he said each fact himself.", "FACT f_1: he works nights\nQUOTE: (none)\nHIS MESSAGE: (none)\n\nFACT f_2: he hates mornings\nQUOTE: x\nHIS MESSAGE: y"));
  assert.deepEqual(inferred, [{ fact: "f_1", said: false }, { fact: "f_2", said: false }]);
});

const PROPOSAL_SYS = "You read one exchange between a user and a fictional character named Avelie and extract candidate DURABLE facts.";
const propose = async (text) => JSON.parse(await gen(PROPOSAL_SYS, "EXCHANGE:\nUser: " + text + "\n\nAvelie: ok"));

test("the proposal triggers of v5, each with its payload", async () => {
  const one = async (marker) => (await propose(marker))[0];
  assert.deepEqual((await one("[[BEAT:sing in front of people|sign up|2026-10-01]]")).payload, { want: "sing in front of people", title: "sign up", due_on: "2026-10-01", kind: "event" });
  const beat = await one("[[BEAT:sing|sign up|2026-10-01]]");
  assert.equal(beat.kind, "want_beat");
  const outcome = await one("[[OUTCOME:sign up|did_it]]");
  assert.equal(outcome.kind, "beat_outcome");
  assert.deepEqual(outcome.payload, { beat: "sign up", outcome: "did_it", note: "stub" });
  const friction = await one("[[FRICTION:the photo thing|2]]");
  assert.equal(friction.kind, "relationship");
  assert.deepEqual(friction.payload, { friction: "the photo thing", friction_days: 2 });
  assert.deepEqual((await one("[[NICK:Starbrite]]")).payload, { nicknames: "Starbrite" });
  const infer = await one("[[INFER:he works nights]]");
  assert.equal(infer.kind, "justin_fact");
  assert.deepEqual(infer.payload, { said_by: "inferred" });
  const hers = await one("[[HERSAYS:he hates mornings]]");
  assert.equal(hers.evidence, "she said so");
  assert.deepEqual(hers.payload, { said_by: "him" });
  const world = await one("[[WORLD:Mason|he plays at the Big Easy]]");
  assert.equal(world.kind, "world_fact");
  assert.deepEqual(world.payload, { entity: "Mason", fact: "he plays at the Big Easy" });
  const person = await one("[[PERSON:Diane|mother]]");
  assert.equal(person.kind, "life");
  assert.deepEqual(person.payload, { kind: "person", title: "Diane", relation: "mother" });
  const known = await one("[[KNOWN:Some Artist|disliked]]");
  assert.equal(known.kind, "known_artist");
  assert.deepEqual(known.payload, { artist: "Some Artist", kind: "disliked" });
  const lateral = await one("[[REL:cooling off]]");
  assert.equal(lateral.kind, "relationship");
  assert.deepEqual(lateral.payload, { status: "cooling off" });
});

test("[[VIEW]] is not a proposal trigger; the v4 triggers still answer", async () => {
  assert.deepEqual(await propose("[[VIEW]] you were sweet"), []);
  const rel = (await propose("[[REL:seeing each other|Justin]]"))[0];
  assert.deepEqual(rel.payload, { status: "seeing each other", his_name: "Justin" });
  assert.equal((await propose("[[FACT:she hates cilantro]]"))[0].kind, "avelie_fact");
});

test("stubSpotifyFetch: a query naming notfound, any case, finds nothing, as [[NOTFOUND]] does", async () => {
  const f = stubSpotifyFetch();
  const search = async (q) => (await (await f("https://api.spotify.com/v1/search?type=track&q=" + encodeURIComponent(q), { method: "GET" })).json()).tracks.items;
  assert.deepEqual(await search("artist:Nobody Real track:Notfound Song"), []);
  assert.deepEqual(await search("NOTFOUND"), []);
  assert.deepEqual(await search("[[NOTFOUND]]"), []);
  assert.ok((await search("artist:Some Artist track:Some Title")).length >= 1);
});
