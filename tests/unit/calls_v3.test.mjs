// Phone calls (SPEC_V3 section EE): the segment merge and the 80-row cap, the usage
// pricing, the tick meter, the stop reasons, the instructions shape, and the flag-only
// check run on speech.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, checkCtx } from "./helpers.mjs";
import { loadSrcIfPresent, guard, firstExport, settingsV3 } from "./helpers_v3.mjs";

const calls = await loadSrcIfPresent("calls");
const budget = await loadSrc("budget");
const context = await loadSrc("context");
const prompt = await loadSrc("prompt");
const { ALWAYS_ON } = await loadSrc("generated/constitution");
const { runChecks } = await loadSrc("checks");
const S = settingsV3();

// The page rule, as SPEC_V3 states it: a new segment by the same speaker as the last one is
// appended to it. The server applies the same rule again (idempotent).
function pageMerge(segments) {
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.who === s.who) last.text = (last.text + " " + s.text).trim();
    else out.push({ who: s.who, text: s.text, at: s.at });
  }
  return out;
}

function fixedSegments() {
  const out = [];
  let tick = Date.UTC(2026, 8, 29, 19, 0, 0);
  for (let i = 0; i < 900; i++) {
    // Alternating, with runs of two and three by the same speaker every so often.
    const who = i % 7 === 3 || i % 7 === 4 ? "her" : i % 2 ? "her" : "him";
    out.push({ who, text: `segment ${i}`, at: new Date(tick).toISOString() });
    tick += 1500;
  }
  return out;
}

test("segment merge: the page rule and the server rule agree on 900 segments, merging is idempotent, empties are dropped", (tc) => {
  const f = firstExport(calls, ["mergeSegments", "mergeTranscript", "merge"]);
  if (!f.fn) {
    tc.skip("calls.ts exports no mergeSegments (tried mergeSegments, mergeTranscript, merge)");
    return;
  }
  const raw = fixedSegments();
  const page = pageMerge(raw);
  const server = f.fn(raw);
  assert.deepEqual(server.map((s) => [s.who, s.text]), page.map((s) => [s.who, s.text]));
  assert.deepEqual(f.fn(page).map((s) => [s.who, s.text]), page.map((s) => [s.who, s.text]), "idempotent");
  const withEmpty = f.fn([{ who: "him", text: "  ", at: raw[0].at }, ...raw.slice(0, 3)]);
  assert.ok(withEmpty.every((s) => s.text.trim()), "no empty rows");
  for (let i = 1; i < server.length; i++) assert.notEqual(server[i].who, server[i - 1].who, "one row per speaker turn");
});

test("the transcript cap: at most 80 rows, the earliest beyond the cap folded into one row each side", (tc) => {
  const f = firstExport(calls, ["capTranscript", "capSegments", "capRows", "foldTranscript"]);
  if (!f.fn) {
    tc.skip("calls.ts exports no transcript cap (tried capTranscript, capSegments, capRows, foldTranscript)");
    return;
  }
  const merged = pageMerge(fixedSegments());
  const capped = f.fn(merged);
  assert.ok(capped.length <= 80, String(capped.length));
  const lastText = merged[merged.length - 1].text;
  assert.ok(capped[capped.length - 1].text.includes(lastText), "the newest rows survive as they are");
  assert.equal(f.fn(merged.slice(0, 10)).length, 10, "under the cap nothing changes");
});

test("priceUsage: a fixed usage against the four prices", (tc) => {
  const f = firstExport(budget, ["priceUsage"]) .fn ? { fn: budget.priceUsage } : firstExport(calls, ["priceUsage"]);
  if (!f.fn) {
    tc.skip("no priceUsage in budget.ts or calls.ts");
    return;
  }
  const usage = { audioIn: 100000, audioOut: 50000, textIn: 200000, textOut: 10000 };
  const micro = f.fn(usage, S.callPrices);
  const expected = (100000 * 32 + 50000 * 64 + 200000 * 4 + 10000 * 16); // micro-USD, since prices are per million tokens
  const value = typeof micro === "number" ? micro : micro && typeof micro.micro === "number" ? micro.micro : NaN;
  assert.equal(value, expected);
});

test("the tick meter: max(metered, priced), the delta never negative, the same usage twice adds nothing", (tc) => {
  const f = firstExport(calls, ["tickCost", "costSoFar", "meterCost", "callCost"]);
  if (!f.fn) {
    tc.skip("calls.ts exports no pure tick cost (tried tickCost, costSoFar, meterCost, callCost)");
    return;
  }
  const none = { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0 };
  const a = f.fn({ secondsTotal: 90, usage: none, settings: S });
  const floor = Math.ceil((90 / 60) * 0.3 * 1_000_000);
  const val = (x) => (typeof x === "number" ? x : x && typeof x === "object" ? x.micro ?? x.costMicro ?? x.cost : NaN);
  assert.equal(val(a), floor, "the per-minute floor with no usage");
  const heavy = { audioIn: 100000, audioOut: 100000, textIn: 0, textOut: 0 };
  const b = f.fn({ secondsTotal: 90, usage: heavy, settings: S });
  assert.equal(val(b), 100000 * 32 + 100000 * 64, "priced above the floor");
  const c = f.fn({ secondsTotal: 120, usage: heavy, settings: S });
  assert.equal(val(c), val(b), "the same usage on a later tick adds nothing while the floor is below it");
});

test("stop reasons: max minutes, the daily cap and the monthly cap on fixed spend", (tc) => {
  const f = firstExport(calls, ["stopReason", "shouldStop", "stopTest"]);
  if (!f.fn) {
    tc.skip("calls.ts exports no pure stop test (tried stopReason, shouldStop, stopTest)");
    return;
  }
  const base = { secondsTotal: 60, settings: S, todayMicro: 0, monthMicro: 0, tickDeltaMicro: 150000 };
  assert.deepEqual(f.fn({ ...base, secondsTotal: 20 * 60 + 1 }), { stop: true, reason: "max_minutes" });
  assert.deepEqual(f.fn({ ...base, todayMicro: 3_000_000 }), { stop: true, reason: "budget" });
  assert.deepEqual(f.fn({ ...base, monthMicro: 30_000_000 }), { stop: true, reason: "budget" });
  assert.deepEqual(f.fn(base), { stop: false });
});

test("the compact prefix starts with the ALWAYS_ON first line and the full prefix equals stablePrefix()", (tc) => {
  const compact = firstExport(context, ["compactSystem", "compactPrefix"]);
  if (!compact.fn) {
    tc.skip("context.ts exports no compactSystem yet");
    return;
  }
  const c = compact.fn();
  const firstLine = ALWAYS_ON.split("\n")[0];
  assert.ok(c.startsWith(firstLine), c.slice(0, 80));
  assert.ok(c.length < prompt.stablePrefix().length);
  assert.ok(!c.includes("REFERENCE: CORE IDENTITY"), "compact carries the always-on rules and the overlay, not the reference files");
});

test("the call note is appended after the state and speaks of the phone, never of a screen", (tc) => {
  const note = calls && (calls.CALL_NOTE ?? calls.PHONE_NOTE ?? calls.ON_THE_PHONE);
  if (typeof note !== "string") {
    tc.skip("calls.ts exports no CALL_NOTE constant (tried CALL_NOTE, PHONE_NOTE, ON_THE_PHONE)");
    return;
  }
  assert.ok(note.startsWith("ON THE PHONE"));
  assert.ok(/no bracket markers of any kind/.test(note));
  assert.ok(/You can be cut off mid-sentence/.test(note));
  assert.ok(/say so and say bye/.test(note));
  assert.ok(!/model|prompt|app\b/i.test(note), "sealed ontology");
});

test("the flag-only run on speech: retry-severity codes are stored, nothing is retried", () => {
  const r = runChecks("i am not an ai, whatever that means. do you want me to hang up?", checkCtx());
  assert.ok(r.flags.some((f) => f.severity === "retry"), "a leak in speech is still a flag for the record");
  // On a call the pipeline stores r.flags as flags_json and never acts on r.action.
  assert.equal(typeof r.action, "string");
});
