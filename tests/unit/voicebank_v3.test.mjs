// The voice bank (SPEC_V3 section AA): the seed rules, the count table, the ids, the
// per-turn tags, the exemplar picker and the section it renders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EM_DASH, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, loadFileIfPresent, guard, firstExport, voiceLine, NOW } from "./helpers_v3.mjs";

const vb = await loadSrcIfPresent("voicebank");
const t = guard(vb);
const script = await loadFileIfPresent("../../scripts/build_voicebank.mjs");
const seedPath = fileURLToPath(new URL("../../canon/seed/voicebank.json", import.meta.url));
const seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : null;
const migrationPath = fileURLToPath(new URL("../../migrations/0005b_voicebank_seed.sql", import.meta.url));

const EXPECTED_COUNTS = {
  banter: 13, dry: 10, warm: 10, annoyed: 8, after_friction: 7, repair: 5, tired: 8, late: 5, morning: 5, own_day: 10, decline: 8, no: 5,
  ask: 5, answering: 8, stranger: 8, photo_send: 5, photo_ask: 5, song_send: 2, one_word: 5, fragment: 5, typo_fix: 2, flirt: 2, sad: 2,
  excited: 2, together: 2, apart: 3,
};
const TAGS = new Set(Object.keys(EXPECTED_COUNTS).concat(["familiar", "day", "evening", "lowercase"]));

// ------------------------------------------------------------------ the seed file and the build script

const tSeed = seed ? test : (name, fn) => test.skip(name + " [skipped: canon/seed/voicebank.json not in this tree yet]", fn);

tSeed("canon/seed/voicebank.json: 150 entries, the count table by primary tag, one to four known tags each", () => {
  assert.equal(seed.length, 150);
  const counts = {};
  for (const e of seed) {
    assert.equal(typeof e.text, "string");
    assert.ok(e.text.length >= 1 && e.text.length <= 160, e.text);
    assert.ok(Array.isArray(e.tags) && e.tags.length >= 1 && e.tags.length <= 4, e.text);
    for (const tag of e.tags) assert.ok(TAGS.has(tag), `unknown tag ${tag} on "${e.text}"`);
    assert.equal(typeof e.source, "string");
    counts[e.tags[0]] = (counts[e.tags[0]] ?? 0) + 1;
  }
  assert.deepEqual(counts, EXPECTED_COUNTS);
  assert.equal(Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0), 150);
});

tSeed("the seed lines are plain ASCII, unique after normalisation, name nobody and state no fact about her days", () => {
  const seen = new Set();
  const fact = /\b(my|our) (sister|brother|mom|mother|dad|father|job|boss|roommate|ex|city|apartment)\b|\bi (work|live|grew up)\b|\bat (work|school|class)\b/i;
  for (const e of seed) {
    assert.ok(!/[^\x20-\x7e]/.test(e.text), "non-ASCII: " + e.text);
    assert.ok(!/\bjustin\b|\blol\b|\blmao\b|nice to meet you|i'm avelie/i.test(e.text), e.text);
    assert.ok(!fact.test(e.text), "fact-like: " + e.text);
    assert.ok((e.text.match(/\?/g) ?? []).length < 2, "two questions: " + e.text);
    const norm = e.text.toLowerCase().replace(/\s+/g, " ").trim();
    assert.ok(!seen.has(norm), "duplicate: " + e.text);
    seen.add(norm);
  }
});

// The build script and voicebank.ts apply the same rules: the per-entry rules through
// validateSeedEntry (a list of problems, empty when clean) and the duplicate rule through
// validateSeedFile, which also enforces the 150-line count table and so refuses any short file.
const entryValidator = firstExport(vb, ["validateSeedEntry"]);
const fileValidator = firstExport(vb, ["validateSeedFile"]);
const tScript = entryValidator.fn && fileValidator.fn ? test : (name, fn) => test.skip(name + " [skipped: voicebank.ts exports no validateSeedEntry/validateSeedFile]", fn);

const entryRefused = (entry) => {
  const r = entryValidator.fn(entry, 0);
  return Array.isArray(r) ? r.length > 0 : !!r;
};
const good = (text, tags = ["dry"]) => ({ text, tags, source: "03_style: cadence" });

tScript("seed rules: a fact-like line, a therapy phrase, an em dash and an unknown tag are refused; a hyphen is accepted; a duplicate is refused by the file check", () => {
  assert.ok(entryRefused(good("my sister says i am impossible", ["banter"])), "fact-like line");
  assert.ok(entryRefused(good("i hear you, that sounds really hard", ["warm"])), "therapy phrase");
  assert.ok(entryRefused(good("fine " + EM_DASH + " whatever you say", ["dry"])), "em dash");
  assert.ok(entryRefused(good("sure, whatever", ["sarcastic"])), "unknown tag");
  assert.ok(entryRefused(good("nice to meet you, i'm avelie", ["stranger"])), "first-meeting line");
  assert.ok(entryRefused(good("lol no", ["banter"])), "lol");
  assert.ok(entryRefused(good("x".repeat(161), ["banter"])), "over 160 characters");
  assert.ok(!entryRefused(good("very self-aware of you, mid-sentence and all", ["dry"])), "a hyphen is fine");
  assert.ok(!entryRefused(good("ok sent, do not judge the lighting", ["photo_send", "dry"])), "a clean line");
  const problems = fileValidator.fn([good("ok sent, do not judge the lighting", ["photo_send"]), good("Ok  sent, do not judge the lighting", ["photo_send"])]);
  assert.ok(problems.some((m) => /duplicate/i.test(m)), "a duplicate after lowercasing and whitespace collapse: " + problems.join("; "));
  assert.deepEqual(fileValidator.fn(seed ?? []).filter((m) => !/holds \d+ lines/.test(m)), seed ? [] : fileValidator.fn([]).filter((m) => !/holds \d+ lines/.test(m)), "the shipped seed passes its own rules");
});

test("migrations/0005b_voicebank_seed.sql: generated, INSERT OR IGNORE, unapproved, deterministic ids from the text", (tc) => {
  if (!existsSync(migrationPath)) {
    tc.skip("migrations/0005b_voicebank_seed.sql not in this tree yet");
    return;
  }
  const sql = readFileSync(migrationPath, "utf8");
  assert.ok(!BAD_TYPOGRAPHY.test(sql));
  const inserts = sql.split("\n").filter((l) => /^INSERT OR IGNORE INTO voice_lines/i.test(l));
  assert.equal(inserts.length, 150, "one INSERT OR IGNORE per seed line");
  for (const line of inserts) {
    // The first two quoted values are the id and the text ('' is an escaped quote).
    const values = [];
    let i = line.indexOf("VALUES");
    while (values.length < 2 && i < line.length) {
      const start = line.indexOf("'", i);
      if (start < 0) break;
      let j = start + 1;
      let s = "";
      for (; j < line.length; j++) {
        if (line[j] === "'") {
          if (line[j + 1] === "'") { s += "'"; j++; continue; }
          break;
        }
        s += line[j];
      }
      values.push(s);
      i = j + 1;
    }
    const [id, text] = values;
    assert.equal(id, "vl_" + createHash("sha256").update(text).digest("hex").slice(0, 16), text);
    assert.ok(/'unapproved'/.test(line), "status unapproved");
    assert.ok(/'seed'/.test(line), "origin seed");
    assert.ok(line.includes("2026-09-24T00:00:00.000Z"), "the fixed stamp");
  }
});

// ------------------------------------------------------------------ turnTags

const base = { mode: "apart", localHour: 15, hasSharedHistory: true, mood: "", coolingOff: false, hisText: "what did you do today with the whole afternoon off", cue: null, opener: false };

t("turnTags: six fixed contexts", () => {
  const { turnTags } = vb;
  const tags = (o) => turnTags({ ...base, ...o });
  assert.deepEqual(tags({}), ["apart", "day", "familiar"]);
  assert.deepEqual(tags({ mode: "together", localHour: 7, hasSharedHistory: false }), ["together", "morning", "stranger"]);
  assert.deepEqual(tags({ localHour: 23, coolingOff: true, mood: "annoyed at him" }), ["apart", "late", "familiar", "after_friction", "annoyed"]);
  assert.deepEqual(tags({ localHour: 18, mood: "low and flat", hisText: "did you eat?" }), ["apart", "evening", "familiar", "sad", "answering", "banter"]);
  assert.deepEqual(tags({ localHour: 18, hisText: "did you eat anything today or just coffee?" }), ["apart", "evening", "familiar", "answering"]);
  assert.deepEqual(tags({ hisText: "sorry, my bad" }), ["apart", "day", "familiar", "repair", "banter"]);
  assert.deepEqual(tags({ mood: "happy", hisText: "send a pic", cue: "one_word" }), ["apart", "day", "familiar", "excited", "banter", "photo_ask"]);
});

t("turnTags: the cue maps, the cap is six in order, the opener skips his text and adds own_day", () => {
  const { turnTags } = vb;
  assert.ok(turnTags({ ...base, cue: "fragment" }).includes("fragment"));
  assert.ok(turnTags({ ...base, cue: "lowercase" }).includes("lowercase"));
  assert.ok(turnTags({ ...base, cue: "typo_fix" }).includes("typo_fix"));
  const capped = turnTags({ ...base, coolingOff: true, mood: "annoyed", hisText: "sorry?", cue: "one_word" });
  assert.equal(capped.length, 6, capped.join(","));
  assert.deepEqual(capped, ["apart", "day", "familiar", "after_friction", "annoyed", "answering"]);
  const opener = turnTags({ ...base, hisText: "[opener]", opener: true });
  assert.ok(!opener.includes("banter"), "the 8-character cue must not read as banter");
  assert.ok(opener.includes("own_day"));
  assert.ok(!opener.includes("answering") && !opener.includes("photo_ask"));
});

// ------------------------------------------------------------------ selectExemplars

function bank() {
  const lines = [];
  const tagsList = ["banter", "dry", "warm", "annoyed", "tired", "morning", "late", "own_day", "decline", "answering"];
  for (const tag of tagsList) {
    for (let i = 0; i < 4; i++) lines.push(voiceLine({ id: `vl_${tag}_${i}`, text: `${tag} line number ${i} with a few more words on it`, tags: [tag, i % 2 ? "familiar" : "stranger"] }));
  }
  return lines;
}
const OPTS = { perTurn: 6, maxChars: 1200 };

t("selectExemplars: deterministic by seed, at most perTurn, only approved lines with a matching tag", () => {
  const { selectExemplars } = vb;
  const lines = bank();
  const a = selectExemplars(lines, ["banter", "dry", "familiar"], new Set(), "seed-1", OPTS);
  const b = selectExemplars(lines, ["banter", "dry", "familiar"], new Set(), "seed-1", OPTS);
  assert.deepEqual(a.map((l) => l.id), b.map((l) => l.id));
  assert.ok(a.length >= 2 && a.length <= 6, String(a.length));
  for (const l of a) assert.ok(JSON.parse(l.tags_json).some((x) => ["banter", "dry", "familiar"].includes(x)), l.id);
  const c = selectExemplars(lines, ["banter", "dry", "familiar"], new Set(), "seed-2", OPTS);
  assert.ok(a.map((l) => l.id).join() !== c.map((l) => l.id).join() || a.length === 0, "a different seed usually picks differently");
  const unapproved = lines.map((l) => ({ ...l, status: "unapproved" }));
  assert.equal(selectExemplars(unapproved, ["banter"], new Set(), "s", OPTS).length, 0, "nothing unapproved is ever offered");
});

t("selectExemplars: cooldown exclusion, the two-per-primary-tag cap and the character cap", () => {
  const { selectExemplars } = vb;
  const lines = bank();
  const recent = new Set(lines.filter((l) => l.id.startsWith("vl_banter")).map((l) => l.id));
  const picked = selectExemplars(lines, ["banter", "dry"], recent, "seed", OPTS);
  assert.ok(picked.every((l) => !recent.has(l.id)), "recently used lines are excluded");
  const byPrimary = {};
  for (const l of selectExemplars(lines, ["banter", "dry", "warm"], new Set(), "seed", OPTS)) {
    const p = JSON.parse(l.tags_json)[0];
    byPrimary[p] = (byPrimary[p] ?? 0) + 1;
  }
  for (const [p, n] of Object.entries(byPrimary)) assert.ok(n <= 2, `${p}: ${n}`);
  const small = selectExemplars(lines, ["banter", "dry", "warm"], new Set(), "seed", { perTurn: 6, maxChars: 90 });
  assert.ok(small.reduce((n, l) => n + l.text.length, 0) <= 90);
});

t("selectExemplars: fewer than two matches tops up from any approved line, so the section never carries a single line", () => {
  const { selectExemplars } = vb;
  const lines = bank();
  const picked = selectExemplars(lines, ["song_send"], new Set(), "seed", OPTS);
  assert.ok(picked.length >= 2, String(picked.length));
  const one = [...lines.slice(0, 1).map((l) => ({ ...l, tags_json: JSON.stringify(["decline"]) })), ...lines.slice(1)];
  const topped = selectExemplars(one, ["decline"], new Set(), "seed", OPTS);
  assert.ok(topped.length >= 2);
});

// ------------------------------------------------------------------ exemplarSection

t("exemplarSection: empty input renders nothing; lines render without tags under the never-send-as-is header", () => {
  const { exemplarSection } = vb;
  assert.equal(exemplarSection([]), "");
  const s = exemplarSection([voiceLine({ text: "ok sent, do not judge the lighting" }), voiceLine({ id: "vl_2", text: "no. ask me tomorrow" })]);
  assert.ok(s.startsWith("HOW YOU TEXT"));
  assert.ok(/never send one of these as is/.test(s));
  assert.ok(/never quote them, never string them together/.test(s));
  assert.ok(s.includes("ok sent, do not judge the lighting"));
  assert.ok(s.includes("no. ask me tomorrow"));
  assert.ok(!s.includes("photo_send"), "no tags shown");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

test("voicebank_v3: the fixed clock is a Tuesday afternoon in New York", () => {
  assert.equal(NOW.toISOString(), "2026-09-29T19:10:00.000Z");
});
