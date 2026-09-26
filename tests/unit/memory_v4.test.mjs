// The memory map (SPEC_V4 section 7): phaseOf on the four bands, returnedRecently on a
// fixed table, and memoryMap on the D1 stand-in (a 0.2 fact 40 days old faded, a 0.9 fact
// vivid, one returned, one sealed with its text absent from the JSON, one kept today in her
// timezone and one from yesterday excluded, the counts). Nothing is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { factRow, historyRow } from "./helpers.mjs";
import { fakeDb, TZ } from "./helpers_v2.mjs";
import { weightRow, settingsV3 } from "./helpers_v3.mjs";
import { loadSrcIfPresent, guard, NOW, daysAgo } from "./helpers_v4.mjs";

const mem = await loadSrcIfPresent("memory");
const t = guard(mem, "phaseOf", "returnedRecently", "memoryMap", "keptOnDay", "localDayKey");
const S = settingsV3({ timezone: TZ });

const sc = (over) => ({ score: 0.5, recency: 1, relevance: 0, ageDays: 0, halfLifeDays: 45, weight: 0.5, firm: true, ...over });

t("phaseOf: faded when not firm; else vivid at recency 0.5 and above, firm at 0.15 and above, fading under", () => {
  assert.equal(mem.phaseOf(sc({ firm: false, recency: 1 })), "faded");
  assert.equal(mem.phaseOf(sc({ recency: 0.5 })), "vivid");
  assert.equal(mem.phaseOf(sc({ recency: 0.95 })), "vivid");
  assert.equal(mem.phaseOf(sc({ recency: 0.49 })), "firm");
  assert.equal(mem.phaseOf(sc({ recency: 0.15 })), "firm");
  assert.equal(mem.phaseOf(sc({ recency: 0.149 })), "fading");
  assert.equal(mem.phaseOf(sc({ recency: 0 })), "fading");
  assert.equal(mem.phaseOf(sc({ recency: NaN })), "fading");
  assert.equal(mem.phaseOf(null), "faded");
});

t("returnedRecently: a stored row, touched at least once, within the last 7 days, created at least 14 days before that touch", () => {
  const w = (over) => ({ weight: 0.5, lastTouched: daysAgo(2), touches: 1, stored: true, ...over });
  assert.equal(mem.returnedRecently(w(), daysAgo(30), NOW), true, "created 30 days ago, touched 2 days ago");
  assert.equal(mem.returnedRecently(w({ stored: false }), daysAgo(30), NOW), false, "the defaults are not a return");
  assert.equal(mem.returnedRecently(w({ touches: 0 }), daysAgo(30), NOW), false, "never touched");
  assert.equal(mem.returnedRecently(w({ lastTouched: daysAgo(8) }), daysAgo(30), NOW), false, "touched 8 days ago is outside the window");
  assert.equal(mem.returnedRecently(w({ lastTouched: daysAgo(7) }), daysAgo(30), NOW), true, "exactly 7 days is inside");
  assert.equal(mem.returnedRecently(w(), daysAgo(10), NOW), false, "created 10 days ago and touched 2 days ago: only 8 days between, simply new");
  assert.equal(mem.returnedRecently(w(), daysAgo(16), NOW), true, "14 days between");
  assert.equal(mem.returnedRecently(w({ lastTouched: "junk" }), daysAgo(30), NOW), false);
  assert.equal(mem.returnedRecently(w({ lastTouched: new Date(NOW.getTime() + 60_000).toISOString() }), daysAgo(30), NOW), false, "a touch in the future is nothing");
  assert.equal(mem.returnedRecently(null, daysAgo(30), NOW), false);
});

t("localDayKey and keptOnDay: the decision's local day in her timezone", () => {
  assert.equal(mem.localDayKey(new Date("2026-09-30T02:00:00Z"), TZ), "2026-09-29");
  assert.equal(mem.localDayKey(new Date("2026-09-30T02:00:00Z"), "UTC"), "2026-09-30");
  assert.equal(mem.localDayKey(NOW, "Nowhere/Place"), "2026-09-29", "a bad zone falls back to UTC");
  const rows = [
    { id: "p_today", status: "approved", decision_note: "kept automatically", decided_at: "2026-09-30T01:00:00.000Z", kind: "justin_fact", proposal: "his dog is called biscuit" },
    { id: "p_yesterday", status: "approved", decision_note: "kept automatically", decided_at: "2026-09-29T03:59:00.000Z", kind: "justin_fact", proposal: "x" },
    { id: "p_hand", status: "approved", decision_note: "looks right", decided_at: "2026-09-30T01:00:00.000Z", kind: "justin_fact", proposal: "y" },
    { id: "p_pending", status: "pending", decision_note: null, decided_at: null, kind: "justin_fact", proposal: "z" },
  ];
  const kept = mem.keptOnDay(rows, "2026-09-29", TZ);
  assert.deepEqual(kept.map((k) => k.id), ["p_today"], "9pm New York on the 29th; the 29th 03:59Z is still the 28th in New York");
  assert.deepEqual(kept[0], { id: "p_today", kind: "justin_fact", proposal: "his dog is called biscuit", decidedAt: "2026-09-30T01:00:00.000Z" });
  assert.equal(mem.keptOnDay(rows, "2026-09-28", TZ)[0].id, "p_yesterday");
});

function tables() {
  return {
    facts: [
      factRow({ id: "f_faded", scope: "justin", subject: "cousin", fact: "his cousin plays drums", created_at: daysAgo(60) }),
      factRow({ id: "f_vivid", scope: "justin", subject: "dog", fact: "his dog is called biscuit", created_at: daysAgo(3) }),
      factRow({ id: "f_back", scope: "shared", subject: "bench", fact: "the bench by the water is theirs", created_at: daysAgo(40) }),
      factRow({ id: "f_sealed", scope: "avelie", subject: "the singing", fact: "SEALED TEXT she has sung in front of exactly one person", disclosed: 0 }),
      factRow({ id: "f_told", scope: "avelie", subject: "home", fact: "lives in portland", disclosed: 1 }),
      factRow({ id: "f_old", scope: "justin", subject: "gone", fact: "superseded", status: "superseded" }),
    ],
    history: [historyRow({ id: "h1", seq: 1, title: "the bench", created_at: daysAgo(20) }), historyRow({ id: "h2", seq: 2, title: "the coffee", created_at: daysAgo(2) })],
    memory_weights: [
      weightRow({ entity_id: "f_faded", weight: 0.2, last_touched: daysAgo(40), touches: 0 }),
      weightRow({ entity_id: "f_vivid", weight: 0.9, last_touched: daysAgo(1), touches: 2 }),
      weightRow({ entity_id: "f_back", weight: 0.5, last_touched: daysAgo(2), touches: 3 }),
    ],
    proposals: [
      { id: "p_today", conversation_id: "c", message_id: "m", kind: "justin_fact", proposal: "his dog is called biscuit", evidence: "x", confidence: "high", scope: "general", payload_json: null, status: "approved", decision_note: "kept automatically", promoted_id: "f_vivid", created_at: daysAgo(0.2), decided_at: new Date(NOW.getTime() - 3600_000).toISOString() },
      { id: "p_yesterday", conversation_id: "c", message_id: "m", kind: "avelie_fact", proposal: "x", evidence: "x", confidence: "high", scope: "general", payload_json: null, status: "approved", decision_note: "kept automatically", promoted_id: "f_x", created_at: daysAgo(1.2), decided_at: daysAgo(1.1) },
      { id: "p_hand", conversation_id: "c", message_id: "m", kind: "avelie_fact", proposal: "y", evidence: "x", confidence: "high", scope: "general", payload_json: null, status: "approved", decision_note: null, promoted_id: "f_y", created_at: daysAgo(0.1), decided_at: daysAgo(0.05) },
    ],
  };
}

t("memoryMap on the stand-in: the faded, the vivid, the returned, the sealed subject with no text, one kept today, the counts, nothing written", async () => {
  const db = fakeDb(tables());
  const map = await mem.memoryMap(db, S, NOW);
  assert.equal(db.writes.length, 0, "read-only");
  assert.deepEqual(Object.keys(map).sort(), ["counts", "facts", "history", "keptToday", "sealed", "settings", "now"].sort());
  const byId = Object.fromEntries(map.facts.map((f) => [f.id, f]));
  assert.ok(!("f_sealed" in byId) && !("f_told" in byId) && !("f_old" in byId), "her facts and a superseded row are not facts about him");
  assert.equal(byId.f_faded.phase, "faded", JSON.stringify(byId.f_faded));
  assert.equal(byId.f_faded.weight, 0.2);
  assert.equal(byId.f_faded.halfLifeDays, 10);
  assert.equal(byId.f_vivid.phase, "vivid", JSON.stringify(byId.f_vivid));
  assert.equal(byId.f_vivid.touches, 2);
  assert.equal(byId.f_back.returned, true, "created 40 days ago, touched two days ago");
  assert.equal(byId.f_vivid.returned, false, "three days old: simply new");
  assert.equal(map.facts[0].id, "f_vivid", "sorted by score");
  for (const f of map.facts) assert.deepEqual(Object.keys(f).sort(), ["createdAt", "halfLifeDays", "id", "lastTouched", "phase", "recency", "returned", "score", "subject", "text", "touches", "weight"]);
  assert.deepEqual(map.history.map((h) => h.seq), [1, 2]);
  assert.ok(map.history.every((h) => typeof h.phase === "string" && h.title));
  assert.deepEqual(map.sealed.map((s) => s.subject), ["the singing"]);
  assert.ok(!JSON.stringify(map).includes("SEALED TEXT"), "the untold fact's text never leaves the server");
  assert.deepEqual(map.keptToday.map((k) => k.id), ["p_today"], "today in her timezone; yesterday's and the hand decision are out");
  assert.equal(map.keptToday[0].kind, "justin_fact");
  // The returned fact (0.5, touched two days ago, a 45-day half-life) is vivid too.
  assert.deepEqual(map.counts, { facts: 3, vivid: 2, firm: 0, fading: 0, faded: 1, returned: 1, sealed: 1, keptToday: 1 });
  assert.equal(map.counts.vivid + map.counts.firm + map.counts.fading + map.counts.faded, 3);
  assert.equal(map.now, NOW.toISOString());
  assert.equal(map.settings.memoryDecayEnabled, true);
});

t("memoryMap with decay off: every fact vivid, nothing faded", async () => {
  const map = await mem.memoryMap(fakeDb(tables()), settingsV3({ timezone: TZ, memoryDecayEnabled: false }), NOW);
  assert.equal(map.counts.faded, 0);
  assert.equal(map.counts.vivid, 3);
  assert.equal(map.settings.memoryDecayEnabled, false);
});
