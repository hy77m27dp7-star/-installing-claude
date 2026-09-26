// Her phone, live (SPEC_V4 section 1): the listening line's system text and parser, the
// cache key by her local day, the stub's copy of LISTENING_PREFIX, the whole panel on the
// D1 stand-in (every key, the mood dial's fraction, `here` by scene and by whereabouts,
// listening null with the switch off), and map.js projecting exactly as src/places.ts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { factRow, relationshipState, sceneState, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { fakeDb, secretEnv, workRoutine, placeRow as placeThread, TUE_1510_NY, TZ } from "./helpers_v2.mjs";
import { wantRow, askRow, groundingRow } from "./helpers_v3.mjs";
import { loadSrcIfPresent, guard, settingsV4, placeRow, NOW, daysAgo } from "./helpers_v4.mjs";

const phone = await loadSrcIfPresent("phone");
const places = await loadSrcIfPresent("places");
const t = guard(phone, "listeningSystem", "parseListening", "listeningCacheKey", "phoneState", "LISTENING_PREFIX");
const tp = guard(places, "project", "unproject");
const map = await import("../../public/js/map.js").catch(() => null);
const tm = map && places ? test : (name, fn) => test.skip(name + " [skipped: public/js/map.js or src/places.ts not importable yet]", fn);

const phoneSource = readFileSync(new URL("../../src/phone.ts", import.meta.url), "utf8");
const stubSource = readFileSync(new URL("../../src/providers/stub.ts", import.meta.url), "utf8");

const prefixOf = (source) => {
  const m = /const LISTENING_PREFIX = "([^"]+)"/.exec(source);
  return m ? m[1] : null;
};

t("LISTENING_PREFIX: phone.ts and stub.ts carry the same string (a copy, never an import: the module cycle)", () => {
  assert.equal(prefixOf(phoneSource), "Name one real song");
  assert.equal(prefixOf(stubSource), prefixOf(phoneSource));
  assert.equal(phone.LISTENING_PREFIX, "Name one real song");
  assert.ok(!/from "\.\.\/phone"/.test(stubSource), "stub.ts never imports phone.ts");
});

t("listeningSystem: starts with the prefix, carries her music facts (at most 12), names no artist and never 'his'", () => {
  const facts = [];
  for (let i = 0; i < 15; i++) facts.push(factRow({ id: "f" + i, subject: i % 2 ? "music" : "singing", fact: "taste line " + i }));
  facts.push(factRow({ id: "f_home", subject: "home", fact: "lives in portland" }));
  const s = phone.listeningSystem(facts);
  assert.ok(s.startsWith(phone.LISTENING_PREFIX), s.slice(0, 40));
  assert.ok(/taste line 0/.test(s) && !/lives in portland/.test(s), "music facts in, the home fact out");
  assert.equal((s.match(/taste line/g) ?? []).length, 12, "at most 12");
  assert.ok(!/\bhis\b/i.test(s), "never his taste");
  assert.ok(/never anyone else's|never his/.test(s), "her taste, from her record");
  assert.ok(/"artist"/.test(s) && /"title"/.test(s) && /"line"/.test(s), "the JSON shape");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
  const bare = phone.listeningSystem([]);
  assert.ok(bare.startsWith(phone.LISTENING_PREFIX) && !/taste line/.test(bare));
});

t("parseListening: plain JSON, fenced JSON and junk; long fields refused, the line cut at 90", () => {
  const good = phone.parseListening('{"artist":"Stub Artist","title":"Stub Song","line":"stuck in my head since the shop"}');
  assert.deepEqual(good, { artist: "Stub Artist", title: "Stub Song", line: "stuck in my head since the shop" });
  const fenced = phone.parseListening("```json\n{\"artist\":\"A\",\"title\":\"B\",\"line\":\"c\"}\n```");
  assert.deepEqual(fenced, { artist: "A", title: "B", line: "c" });
  const wrapped = phone.parseListening("sure: {\"artist\":\"A\",\"title\":\"B\",\"line\":\"c\"} there");
  assert.deepEqual(wrapped, { artist: "A", title: "B", line: "c" });
  assert.equal(phone.parseListening("not json at all"), null);
  assert.equal(phone.parseListening("[1,2]"), null);
  assert.equal(phone.parseListening(JSON.stringify({ artist: "", title: "B" })), null);
  assert.equal(phone.parseListening(JSON.stringify({ artist: "x".repeat(121), title: "B", line: "c" })), null);
  const long = phone.parseListening(JSON.stringify({ artist: "A", title: "B", line: "y".repeat(110) }));
  assert.ok(long && long.line.length <= 90 && long.line.endsWith("..."), long && long.line.length);
  const dash = phone.parseListening(JSON.stringify({ artist: "A", title: "B", line: "one" + String.fromCharCode(0x2014) + "two" }));
  assert.equal(dash.line, "one -- two");
});

t("listeningCacheKey: by her local day (10pm New York on the 29th is still the 29th; 1am UTC on the 30th too)", () => {
  assert.equal(phone.listeningCacheKey(new Date("2026-09-30T02:00:00Z"), "America/New_York"), "listening:2026-09-29");
  assert.equal(phone.listeningCacheKey(new Date("2026-09-30T02:00:00Z"), "UTC"), "listening:2026-09-30");
  assert.equal(phone.listeningCacheKey(TUE_1510_NY, TZ), "listening:2026-09-29");
});

// ------------------------------------------------------------------ the panel on the stand-in

const KEYS = ["now", "tz", "localClock", "weekday", "timeOfDay", "where", "scene", "weather", "city", "outfit", "mood", "wants", "asks", "today", "listening", "places", "map"];

function tables(over = {}) {
  const rel = relationshipState({ mood: "warm", mood_days: 2, mood_set_at: daysAgo(1) });
  return {
    life_threads: [workRoutine(), placeThread({ id: "lt_shop", title: "the shop", status: "active" })],
    grounding_log: [groundingRow()],
    visual_assets: [],
    state_versions: [
      { id: "s_rel", entity: "relationship", version: 3, state_json: JSON.stringify(rel), source: "owner", note: null, created_at: daysAgo(1) },
      { id: "s_scene", entity: "scene", version: 2, state_json: JSON.stringify(sceneState()), source: "owner", note: null, created_at: daysAgo(1) },
    ],
    wants: [wantRow()],
    asks: [askRow()],
    places: [placeRow({ id: "pl_shop", title: "the shop", thread_id: "lt_shop", lat: 43.657, lon: -70.256 }), placeRow({ id: "pl_bench", title: "the harbour bench", picture_key: "places/the-harbour-bench-000000.png" })],
    panel_cache: [],
    usage_daily: [],
    settings: [],
    ...over,
  };
}

const S = settingsV4({ weatherProvider: "stub", listeningLineEnabled: false, timezone: TZ });

t("phoneState: every key present; the stub weather; the mood dial fraction ageDays / (2 x days); listening null with the switch off", async () => {
  const db = fakeDb(tables());
  const state = await phone.phoneState(secretEnv(), db, S, NOW);
  for (const k of KEYS) assert.ok(k in state, "missing " + k + " (have " + Object.keys(state).join(", ") + ")");
  assert.equal(state.tz, TZ);
  assert.equal(state.localClock, "3:10pm");
  assert.equal(state.weekday, "Tuesday");
  assert.equal(state.timeOfDay, "afternoon");
  assert.ok(state.weather && state.weather.words === "clear" && state.weather.temp === 68, JSON.stringify(state.weather));
  assert.equal(state.city, "Portland, Maine");
  assert.equal(state.listening, null, "the switch is off");
  assert.ok(state.mood && state.mood.mood === "warm" && state.mood.phase === "fading", JSON.stringify(state.mood));
  assert.equal(state.mood.days, 2);
  assert.ok(Math.abs(state.mood.ageDays - 1) < 0.01, String(state.mood.ageDays));
  assert.ok(Math.abs(state.mood.fraction - 0.25) < 0.01, "one day of a two-day mood: 1 / (2 x 2) = " + state.mood.fraction);
  assert.equal(state.wants.length, 1);
  assert.equal(state.wants[0].title, "finish the bridge");
  assert.equal(state.asks.length, 1);
  assert.equal(state.asks[0].broughtUp, 0);
  assert.equal(state.today.length, 1);
  assert.equal(state.map.view.w, 360);
  assert.ok(state.map.outline.length >= 10);
  assert.ok(state.places.length >= 2);
  const bench = state.places.find((p) => p.id === "pl_bench");
  assert.equal(bench.picture, true);
  assert.equal(state.places.find((p) => p.id === "pl_shop").picture, false);
  assert.ok(!("picture_key" in bench), "never the R2 key");
});

t("phoneState: the dial empties as the mood fades (two days of a two-day mood is half, four is gone at 1)", async () => {
  const half = relationshipState({ mood: "warm", mood_days: 2, mood_set_at: daysAgo(2) });
  const s1 = await phone.phoneState(secretEnv(), fakeDb(tables({ state_versions: [{ id: "s", entity: "relationship", version: 1, state_json: JSON.stringify(half), source: "owner", note: null, created_at: daysAgo(2) }] })), S, NOW);
  assert.ok(Math.abs(s1.mood.fraction - 0.5) < 0.01, String(s1.mood.fraction));
  const gone = relationshipState({ mood: "warm", mood_days: 2, mood_set_at: daysAgo(4) });
  const s2 = await phone.phoneState(secretEnv(), fakeDb(tables({ state_versions: [{ id: "s", entity: "relationship", version: 1, state_json: JSON.stringify(gone), source: "owner", note: null, created_at: daysAgo(4) }] })), S, NOW);
  assert.ok(s2.mood && s2.mood.phase === "gone" && s2.mood.fraction === 1, JSON.stringify(s2.mood));
  const none = await phone.phoneState(secretEnv(), fakeDb(tables({ state_versions: [{ id: "s", entity: "relationship", version: 1, state_json: JSON.stringify(relationshipState()), source: "owner", note: null, created_at: daysAgo(4) }] })), S, NOW);
  assert.equal(none.mood, null, "an empty mood is null, never phase none");
});

t("phoneState: `here` by the whereabouts label (the shop, at work on a Tuesday afternoon) and by a together scene", async () => {
  const byWork = await phone.phoneState(secretEnv(), fakeDb(tables({ life_threads: [workRoutine({ schedule_json: JSON.stringify({ tz: TZ, blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", label: "the shop" }] }) }), placeThread({ id: "lt_shop", title: "the shop" })] })), S, NOW);
  assert.equal(byWork.where.busy, true);
  assert.equal(byWork.where.label, "the shop");
  assert.equal(byWork.places.find((p) => p.id === "pl_shop").here, true);
  assert.equal(byWork.places.find((p) => p.id === "pl_bench").here, false);
  const together = sceneState({ status: "together", location: "The Harbour  Bench" });
  const byScene = await phone.phoneState(secretEnv(), fakeDb(tables({ state_versions: [{ id: "s", entity: "scene", version: 2, state_json: JSON.stringify(together), source: "owner", note: null, created_at: daysAgo(1) }] })), S, NOW);
  assert.equal(byScene.scene.status, "together");
  assert.equal(byScene.places.find((p) => p.id === "pl_bench").here, true, "the scene place wins, whitespace and case aside");
  assert.equal(byScene.places.find((p) => p.id === "pl_shop").here, false, "one place is here at a time");
});

t("phoneState writes on a read only through syncPlaces: a place thread with no row gets one (INSERT OR IGNORE), nothing else is written", async () => {
  const db = fakeDb(tables({ places: [], life_threads: [placeThread({ id: "lt_new", title: "the laundromat on 9th" })] }));
  const state = await phone.phoneState(secretEnv(), db, S, NOW);
  assert.ok(state.places.some((p) => p.title === "the laundromat on 9th"));
  const inserts = db.writes.filter((w) => /INSERT OR IGNORE INTO places/.test(w.sql));
  assert.equal(inserts.length, 1);
  assert.ok(db.writes.every((w) => /places/.test(w.sql)), "only the places table is written on a read: " + db.writes.map((w) => w.sql.slice(0, 40)).join(" | "));
});

// ------------------------------------------------------------------ map.js against places.ts

tm("map.js project and unproject equal src/places.ts on the same points, bounds and view", () => {
  assert.deepEqual(map.PORTLAND_BOUNDS, places.PORTLAND_BOUNDS);
  assert.deepEqual(map.MAP_VIEW, places.MAP_VIEW);
  const points = [[43.6591, -70.2568], [43.6690, -70.2390], [43.6800, -70.2700], [43.6420, -70.2780], [43.636, -70.294], [43.686, -70.232], [43.7, -70.1], [43.6, -70.4], [43.65, -70.26], [43.66, -70.25]];
  for (const [lat, lon] of points) {
    const a = places.project(lat, lon);
    const b = map.project(lat, lon);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${lat},${lon}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    assert.equal(!!a.clamped, !!b.clamped, "clamped agrees at " + lat + "," + lon);
    const ua = places.unproject(a.x, a.y);
    const ub = map.unproject(b.x, b.y);
    assert.ok(Math.abs(ua.lat - ub.lat) < 1e-9 && Math.abs(ua.lon - ub.lon) < 1e-9);
  }
});

tp("map.js has no top-level DOM, location or fetch (it is imported under Node here)", () => {
  const source = readFileSync(new URL("../../public/js/map.js", import.meta.url), "utf8");
  const topLevel = source.split("\n").filter((l) => /^(document|window|location|fetch)\b/.test(l));
  assert.deepEqual(topLevel, []);
  assert.ok(!/\bfetch\(/.test(source), "the map never fetches");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(source) && !/\.style\.cssText/.test(source), "no style attribute");
});

// ------------------------------------------------------------------ review fixes (v4)

t("listeningFacts: only what she has told him (disclosed); an untold singing or music fact never reaches the line", () => {
  const told = factRow({ id: "f_told", subject: "music", fact: "she plays records too loud", disclosed: 1 });
  const untold = factRow({ id: "f_untold", subject: "singing", fact: "she has a folder of private clips", disclosed: 0 });
  const got = phone.listeningFacts([told, untold]);
  assert.deepEqual(got.map((f) => f.id), ["f_told"]);
  const s = phone.listeningSystem([told, untold]);
  assert.ok(/records too loud/.test(s) && !/private clips/.test(s));
  assert.ok(/nothing written down yet/.test(phone.listeningSystem([untold])), "all untold: the bare line");
});

// A D1 stand-in whose day-row claim reports `changes` (0: another load holds it).
function listeningDb(changes) {
  const db = fakeDb({ facts: [factRow({ id: "f_told", subject: "music", fact: "she plays records too loud", disclosed: 1 })], panel_cache: [], model_runs: [], usage_daily: [] });
  const prepare = db.prepare;
  db.prepare = (sql) => {
    const st = prepare(sql);
    if (/INSERT INTO panel_cache/.test(sql) && /WHERE panel_cache\.fetched_at < \?4/.test(sql)) {
      st.run = async () => { db.writes.push({ sql, binds: st.binds }); return { success: true, meta: { changes } }; };
    }
    return st;
  };
  return db;
}

t("listeningNow: the day's row is claimed before the paid call (a stale claim or failure is taken over after ten minutes); a claim held elsewhere answers null and calls nothing", async () => {
  const on = settingsV4({ provider: "stub", model: "claude-opus-5", listeningLineEnabled: true, timezone: TZ, dailyCapUsd: 50, monthlyCapUsd: 500 });
  const held = listeningDb(0);
  assert.equal(await phone.listeningNow(secretEnv(), held, on, TUE_1510_NY), null);
  const claim = held.writes.find((w) => /INSERT INTO panel_cache/.test(w.sql));
  assert.ok(claim && claim.binds[0] === "listening:2026-09-29" && JSON.parse(claim.binds[1]).pending === true, JSON.stringify(claim));
  assert.ok(Date.parse(claim.binds[2]) - Date.parse(claim.binds[3]) === phone.LISTENING_RETRY_MS, "the takeover window is ten minutes");
  assert.ok(!held.writes.some((w) => /model_runs|usage_daily/.test(w.sql)), "no call, nothing paid");
  const free = listeningDb(1);
  await phone.listeningNow(secretEnv(), free, on, TUE_1510_NY);
  const order = free.writes.map((w) => (/INSERT INTO panel_cache/.test(w.sql) && /pending/.test(String(w.binds[1])) ? "claim" : /model_runs/.test(w.sql) ? "run" : "")).filter(Boolean);
  assert.deepEqual(order.slice(0, 2), ["claim", "run"], "claimed, then the call's run row");
});
