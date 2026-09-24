// The v3 prompt (SPEC_V3 header and sections AA to GG): the state section order, every
// v3 section present with data and absent without, the half-remember section off at the
// shipped setting, the Relationship line without the mood keys, the prefix unchanged
// except TEXTURE, the cue last, and the prefix/state split. Gated on -p5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadSrc, factRow, historyRow, relationshipState, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { TZ, TUE_1510_NY, promptStateV2 } from "./helpers_v2.mjs";
import { voiceLine, correctionRow, wantRow, wantLogRow, askRow, weatherNow, groundingRow } from "./helpers_v3.mjs";

const prompt = await loadSrc("prompt");
const { CONSTITUTION_VERSION } = await loadSrc("generated/constitution");
const v3 = /-p5$/.test(prompt.PROMPT_VERSION);
const t = v3 ? test : (name, fn) => test.skip(name + " [skipped: prompt.ts is not at -p5 yet]", fn);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ORDER = [
  "FIXED CANON", "THINGS TRUE ABOUT YOU", "WHAT YOU KNOW ABOUT HIM", "THINGS YOU HALF REMEMBER", "SHARED HISTORY", "CURRENT STATE", "MODE:",
  "RIGHT NOW", "YOUR LIFE RIGHT NOW", "WHAT YOU WANT", "THINGS YOU COULD BRING UP", "HOW YOU TEXT", "NOTES FROM HIM", "OPEN UNKNOWNS",
  "FIRST CONVERSATION", "THIS MESSAGE",
];

function fullState(overrides = {}) {
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

function positions(text) {
  return ORDER.map((h) => ({ h, at: text.indexOf(h) }));
}

t("stateSections: every v3 section renders when its data exists, in the header's order, the cue last", () => {
  const s = prompt.stateSections(fullState());
  const pos = positions(s);
  for (const p of pos) assert.ok(p.at >= 0, p.h + " missing");
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i].at > pos[i - 1].at, `${pos[i - 1].h} before ${pos[i].h}`);
  assert.ok(s.trimEnd().endsWith("One word, or two, is the whole reply if that is the honest answer."), "the cue section is last");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

t("stateSections: a v3 section is absent when its data is absent; the half-remember section is absent at the shipped setting", () => {
  const s = prompt.stateSections(fullState({ exemplars: [], corrections: [], recall: null, wants: [], wantLog: [], asks: [], grounding: { city: "", weather: null, outfit: null, today: [] }, shapeCue: null }));
  for (const h of ["THINGS YOU HALF REMEMBER", "WHAT YOU WANT", "HOW YOU TEXT", "NOTES FROM HIM", "THIS MESSAGE"]) assert.ok(!s.includes(h), h + " must be absent");
  const v2 = prompt.stateSections(promptStateV2());
  for (const h of ["THINGS YOU HALF REMEMBER", "WHAT YOU WANT", "HOW YOU TEXT", "NOTES FROM HIM", "THIS MESSAGE"]) assert.ok(!v2.includes(h), h + " must be absent on a v2-shaped state");
  // The clock is always known; with no city, weather, outfit or log the section carries nothing else.
  for (const h of ["You are wearing", "Today so far", "sun sets", "feels like"]) assert.ok(!v2.includes(h), h + " must be absent without grounding data");
});

t("the Relationship line carries no mood, mood_set_at, mood_days or cooling_off_until key; the phased Mood line is the only mood shown", () => {
  const rel = relationshipState({ mood: "annoyed at him", mood_set_at: new Date(TUE_1510_NY.getTime() - 3600 * 1000).toISOString(), mood_days: 3, cooling_off_until: new Date(TUE_1510_NY.getTime() + 3600 * 1000).toISOString() });
  const s = prompt.stateSections(promptStateV2({ relationship: rel, life: { threads: [], log: [], now: TUE_1510_NY, tz: TZ } }));
  const line = /Relationship: (\{.*\})/.exec(s);
  assert.ok(line, "the Relationship line");
  const obj = JSON.parse(line[1]);
  for (const k of ["mood", "mood_set_at", "mood_days", "cooling_off_until"]) assert.ok(!(k in obj), k + " must not be in the JSON line");
  assert.ok(/Mood: annoyed at him \(fresh, since /.test(s), "the phased mood line: " + (s.match(/Mood:.*/) ?? [""])[0]);
  const gone = relationshipState({ mood: "annoyed at him", mood_set_at: new Date(TUE_1510_NY.getTime() - 10 * 86400000).toISOString(), mood_days: 3 });
  const s2 = prompt.stateSections(promptStateV2({ relationship: gone, life: { threads: [], log: [], now: TUE_1510_NY, tz: TZ } }));
  assert.ok(!/Mood:/.test(s2), "a gone mood renders nothing");
  assert.ok(!s2.includes("annoyed at him"), "and the word is nowhere in the state");
});

t("stablePrefix: TEXTURE exactly once, no Justin, no 24, no dash character; the constitution version moved once from v2", () => {
  const p = prompt.stablePrefix();
  assert.equal((p.match(/\nTEXTURE\n/g) ?? []).length, 1, "TEXTURE once");
  assert.ok(/You text like a person, not a writer\./.test(p));
  assert.ok(/Never the same shape three messages in a row\./.test(p));
  assert.ok(!p.includes("Justin"));
  assert.ok(!/\b24\b/.test(p));
  assert.ok(!BAD_TYPOGRAPHY.test(p));
  let committed = null;
  try {
    committed = execFileSync("git", ["show", "HEAD:src/generated/constitution.ts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    committed = null;
  }
  if (committed) {
    const m = /CONSTITUTION_VERSION\s*=\s*"([^"]+)"/.exec(committed);
    if (m && !committed.includes("\nTEXTURE\n")) assert.notEqual(CONSTITUTION_VERSION, m[1], "the version must differ from the recorded v2 value");
  }
});

t("buildSystemPrompt: prefix equals stablePrefix() and prefix + separator + state equals system", () => {
  const built = prompt.buildSystemPrompt(fullState());
  assert.equal(built.prefix, prompt.stablePrefix());
  assert.equal(built.prefix + "\n\n" + "=".repeat(60) + "\n\n" + built.state, built.system);
  assert.equal(built.promptVersion, prompt.PROMPT_VERSION);
  assert.ok(built.promptVersion.startsWith(CONSTITUTION_VERSION + "-p5"));
});
