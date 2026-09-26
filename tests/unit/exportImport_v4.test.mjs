// Export and import in v4 (SPEC_V4 "Migration 0008_v4.sql", the export paragraph): places
// exported, spotify_auth never (neither exported nor accepted by the import), with_him,
// spotify_status and pushed_at in the whitelists, a call-face row round-tripped through
// exportAll and the import, and the panel cache left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1, loadSrc } from "./helpers.mjs";
import { fakeDb, secretEnv, messageRow } from "./helpers_v2.mjs";
import { assetRow } from "./helpers_v3.mjs";
import { placeRow, spotifyAuthRow, callfaceRow, SPOTIFY_SECRET_VALUES, carriesNone } from "./helpers_v4.mjs";

const { exportAll, importAll } = await loadSrc("exportImport");
const source = readFileSync(new URL("../../src/exportImport.ts", import.meta.url), "utf8");
const landed = /"places"/.test(source) && /with_him/.test(source);
const t = landed ? test : (name, fn) => test.skip(name + " [skipped: exportImport.ts has no v4 tables or columns yet (pipeline lane)]", fn);
const ACTOR = "justin@newsomeprojects.com";

function tables() {
  return {
    settings: [], facts: [], history: [], unknowns: [], state_versions: [], conversations: [], proposals: [], usage_daily: [], audit_events: [], model_runs: [],
    messages: [messageRow({ id: "m_song", song_json: JSON.stringify({ artist: "A", title: "B", searchUrl: "https://open.spotify.com/search/x" }), spotify_status: "added", pushed_at: null, deliver_at: null })],
    visual_assets: [
      { ...assetRow({ id: "img_us", message_id: "m_us" }), with_him: 1 },
      { ...callfaceRow({ kind: "idle", id: "vid_face" }), with_him: 0 },
    ],
    places: [placeRow({ id: "pl_bench", picture_key: "places/the-harbour-bench-bench.png" })],
    spotify_auth: [spotifyAuthRow()],
    panel_cache: [{ k: "listening:2026-09-29", json: "{\"none\":true}", fetched_at: "2026-09-29T00:00:00.000Z" }],
    life_threads: [], life_log: [], message_context: [], drift_reports: [], first_texts_daily: [], media_library: [], voiceprints: [],
    voice_lines: [], voice_line_uses: [], corrections: [], memory_weights: [], memory_recalls: [], wants: [], want_log: [], asks: [], grounding_log: [], calls: [], tastings: [], tasting_candidates: [], message_marks: [],
  };
}

test("exportAll never reads spotify_auth and never carries a token, whatever else the tree carries", async () => {
  const db = fakeDb(tables());
  const payload = await exportAll(db, secretEnv());
  assert.ok(!("spotifyAuth" in payload) && !("spotify_auth" in payload), "no Spotify key in the export");
  assert.ok(!db.queries.some((q) => /spotify_auth/i.test(q.sql)), "the table is not even read");
  assert.ok(carriesNone(payload, SPOTIFY_SECRET_VALUES), "no token anywhere in the export");
  assert.ok(!("panelCache" in payload), "a cache is not exported");
});

t("exportAll carries places (every column, the R2 key included: the backup restores it) and the v4 columns on assets and messages", async () => {
  const payload = await exportAll(fakeDb(tables()), secretEnv());
  assert.ok(Array.isArray(payload.places) && payload.places.length === 1, "places exported");
  assert.equal(payload.places[0].id, "pl_bench");
  assert.equal(payload.places[0].picture_key, "places/the-harbour-bench-bench.png");
  const us = payload.visualAssets.find((a) => a.id === "img_us");
  assert.equal(us.with_him, 1);
  const face = payload.visualAssets.find((a) => a.id === "vid_face");
  assert.equal(face.role, "callface");
  const m = payload.messages.find((x) => x.id === "m_song");
  assert.equal(m.spotify_status, "added");
  assert.ok("pushed_at" in m);
});

// Story tables are inserted; visual_assets and places may be merged (INSERT OR IGNORE).
const inserts = (d, table) => d.log.filter((s) => s.via === "batch" && new RegExp("^INSERT (OR IGNORE )?INTO " + table + " ").test(s.sql));
const emptyDb = () => fakeD1(() => []);

t("importAll: with_him, spotify_status and pushed_at are in the whitelists and land in the insert; a callface row round-trips; an unknown role is skipped", async () => {
  const d = emptyDb();
  const r = await importAll(d, {
    version: 1,
    conversations: [{ id: "c_1" }],
    messages: [{ id: "m_1", conversation_id: "c_1", role: "assistant", content: "ok", seq: 1, spotify_status: "added", pushed_at: "2026-09-29T19:00:00.000Z" }],
    visualAssets: [
      { id: "img_us", file: "candidates/img_us.png", role: "scene", approval_status: "approved", with_him: 1 },
      { id: "vid_face", file: "videos/vid_face.mp4", role: "callface", approval_status: "approved", notes: "callface:idle" },
    ],
  }, ACTOR);
  assert.equal(r.counts.messages, 1);
  const m = inserts(d, "messages")[0];
  assert.ok(/spotify_status/.test(m.sql) && /pushed_at/.test(m.sql), m.sql);
  assert.ok(m.binds.includes("added") && m.binds.includes("2026-09-29T19:00:00.000Z"));
  const assets = inserts(d, "visual_assets");
  assert.equal(assets.length, 2, "the with-him picture and the call face both land");
  const us = assets.find((s) => s.binds[0] === "img_us");
  assert.ok(/with_him/.test(us.sql));
  assert.ok(us.binds.includes(1), "with_him 1");
  const face = assets.find((s) => s.binds[0] === "vid_face");
  assert.ok(face.binds.includes("callface"), "role callface accepted");
  // A role the runtime never writes (a master, the legacy archive, anything unknown) is
  // skipped as a seed row, never inserted and never a refusal.
  const skipped = emptyDb();
  await importAll(skipped, { version: 1, visualAssets: [{ id: "x", file: "videos/x.mp4", role: "hologram", approval_status: "approved" }] }, ACTOR);
  assert.equal(inserts(skipped, "visual_assets").length, 0, "an unknown role never lands");
  await assert.rejects(importAll(emptyDb(), { version: 1, messages: [{ id: "m", conversation_id: "c", role: "assistant", content: "x", seq: 1, spotify_status: "x".repeat(21) }], conversations: [{ id: "c" }] }, ACTOR), (e) => e.status === 400 && /spotify_status/.test(e.message));
  await assert.rejects(importAll(emptyDb(), { version: 1, visualAssets: [{ id: "x", file: "candidates/x.png", role: "scene", approval_status: "approved", with_him: "yes" }] }, ACTOR), (e) => e.status === 400 && /with_him/.test(e.message));
});

t("importAll: places land with their columns; a spotifyAuth key in a payload is ignored (never inserted, never counted); a panelCache key is ignored too", async () => {
  const d = emptyDb();
  const r = await importAll(d, {
    version: 1,
    places: [{ id: "pl_1", title: "the harbour bench", title_norm: "the harbour bench", geocoded_by: "map", lat: 43.66, lon: -70.25, picture_light: "day" }],
    spotifyAuth: [spotifyAuthRow()],
    spotify_auth: [spotifyAuthRow()],
    panelCache: [{ k: "listening:2026-09-29", json: "{}", fetched_at: "x" }],
  }, ACTOR);
  const places = inserts(d, "places");
  assert.equal(places.length, 1);
  assert.ok(places[0].binds.includes("the harbour bench") && places[0].binds.includes("map"));
  assert.equal(r.counts.places, 1);
  assert.ok(!d.log.some((s) => /spotify_auth/i.test(s.sql)), "nothing touches spotify_auth");
  assert.ok(!d.log.some((s) => /panel_cache/i.test(s.sql)), "nothing touches panel_cache");
  assert.ok(!("spotifyAuth" in r.counts) && !("spotify_auth" in r.counts));
  await assert.rejects(importAll(emptyDb(), { version: 1, places: [{ id: "pl_2", title: "x", title_norm: "x", geocoded_by: "gps" }] }, ACTOR), (e) => e.status === 400 && /geocoded_by/.test(e.message));
  await assert.rejects(importAll(emptyDb(), { version: 1, places: [{ id: "pl_2", title: "x", title_norm: "x", picture_light: "dusk" }] }, ACTOR), (e) => e.status === 400 && /picture_light/.test(e.message));
});

t("exportImport.ts: the whitelists by name (places in EXTRA_TABLES, callface in RUNTIME_ASSET_ROLES, the three columns), never a Spotify table", () => {
  assert.ok(/key: "places", sql: "SELECT \* FROM places ORDER BY created_at, id"/.test(source), "places in EXTRA_TABLES");
  assert.ok(/RUNTIME_ASSET_ROLES[^\n]*"callface"/.test(source), "callface in RUNTIME_ASSET_ROLES");
  assert.ok(/name: "with_him", type: "int"/.test(source));
  assert.ok(/name: "spotify_status", type: "text", max: 20/.test(source));
  assert.ok(/name: "pushed_at", type: "(time|text)"/.test(source), "pushed_at is a nullable time (text, as decided_at is: a never-pushed reply must stay null)");
  assert.ok(!/spotify_auth/.test(source) || /never/i.test(source.split("spotify_auth")[0].slice(-400)), "spotify_auth is named only to say it is never exported");
  assert.ok(!/panelCache/.test(source) || !/key: "panelCache"/.test(source), "no panelCache key");
});

t("importAll (review): a place detail up to 2000 restores (the cap places.ts writes); picture_key must be places/<slug>.png, never his photo or a restore point", async () => {
  const ok = emptyDb();
  const r = await importAll(ok, { version: 1, places: [{ id: "pl_long", title: "the pier", title_norm: "the pier", detail: "d".repeat(1500), picture_key: "places/the-pier-long00.png" }] }, ACTOR);
  assert.equal(r.counts.places, 1, "a 1,500-character detail from a thread restores");
  await assert.rejects(importAll(emptyDb(), { version: 1, places: [{ id: "pl_x", title: "x", title_norm: "x", detail: "d".repeat(2001) }] }, ACTOR), (e) => e.status === 400 && /detail/.test(e.message));
  for (const key of ["him/him_38edf830605b4fa9bb51.webp", "snapshots/avelie-2026-09-25-2353.json", "places/../him/x.png", "candidates/img_1.png"]) {
    await assert.rejects(importAll(emptyDb(), { version: 1, places: [{ id: "pl_x", title: "x", title_norm: "x", picture_key: key }] }, ACTOR), (e) => e.status === 400 && /picture_key/.test(e.message), key);
  }
});
