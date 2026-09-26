// Her places (SPEC_V4 sections 1 and 8): the projection and its inverse, the drawn outline,
// the haversine, the names and the R2 slug, syncPlaces on the D1 stand-in, and the picture
// half (season, light, the prompt with no people, makePlacePicture on the stand-ins,
// servePlacePicture 404 and 200).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { fakeDb, secretEnv, placeRow as placeThread, TZ } from "./helpers_v2.mjs";
import { weatherNow } from "./helpers_v3.mjs";
import { loadSrcIfPresent, guard, settingsV4, placeRow, fakeR2, NOW } from "./helpers_v4.mjs";

const places = await loadSrcIfPresent("places");
const t = guard(places, "project", "unproject", "distanceKm", "isPlaceNearCity", "placeTitleNorm", "placeSlug", "syncPlaces", "PORTLAND_OUTLINE", "PORTLAND_BOUNDS");
const tp = guard(places, "seasonOf", "lightOf", "placePicturePrompt", "makePlacePicture", "deletePlacePicture", "servePlacePicture");

const S = settingsV4({ imageProvider: "stub", weatherProvider: "stub", timezone: TZ });
const ENV = () => ({ ...secretEnv(), MEDIA: fakeR2() });

t("project and unproject round-trip on ten points inside the bounds; a point outside is clamped to the edge and says so", () => {
  const B = places.PORTLAND_BOUNDS;
  const inside = [[43.6591, -70.2568], [43.6690, -70.2390], [43.6800, -70.2700], [43.6420, -70.2780], [43.6500, -70.2850], [43.6560, -70.2500], [43.6600, -70.2470], [43.6720, -70.2430], [43.6680, -70.2780], [43.6480, -70.2620]];
  for (const [lat, lon] of inside) {
    const p = places.project(lat, lon);
    assert.ok(p.x >= 0 && p.x <= 360 && p.y >= 0 && p.y <= 240, JSON.stringify(p));
    assert.ok(!p.clamped, "inside is never clamped");
    const back = places.unproject(p.x, p.y);
    assert.ok(Math.abs(back.lat - lat) < 1e-6 && Math.abs(back.lon - lon) < 1e-6, `${lat},${lon} -> ${JSON.stringify(back)}`);
  }
  const nw = places.project(B.latMax, B.lonMin);
  assert.deepEqual([nw.x, nw.y], [0, 0], "north-west is the origin");
  const se = places.project(B.latMin, B.lonMax);
  assert.deepEqual([se.x, se.y], [360, 240]);
  const out = places.project(44, -71);
  assert.equal(out.clamped, true);
  assert.deepEqual([out.x, out.y], [0, 0]);
  const far = places.project(43, -70);
  assert.equal(far.clamped, true);
  assert.deepEqual([far.x, far.y], [360, 240]);
  const custom = places.project(43.6591, -70.2568, { latMin: 43, latMax: 44, lonMin: -71, lonMax: -70 }, { w: 100, h: 100 });
  assert.ok(Math.abs(custom.x - 74.32) < 1e-9 && Math.abs(custom.y - 34.09) < 1e-9, JSON.stringify(custom));
});

t("PORTLAND_OUTLINE: at least ten points, every one inside PORTLAND_BOUNDS, closed on Fort Allen", () => {
  const B = places.PORTLAND_BOUNDS;
  assert.ok(places.PORTLAND_OUTLINE.length >= 10, String(places.PORTLAND_OUTLINE.length));
  for (const [lat, lon] of places.PORTLAND_OUTLINE) assert.ok(lat >= B.latMin && lat <= B.latMax && lon >= B.lonMin && lon <= B.lonMax, `${lat},${lon} outside`);
  const first = places.PORTLAND_OUTLINE[0];
  assert.ok(Math.abs(first[0] - 43.669) < 0.001 && Math.abs(first[1] + 70.239) < 0.001, "starts at Fort Allen Park");
  assert.deepEqual(places.MAP_VIEW, { w: 360, h: 240 });
});

t("distanceKm: Portland to Boston is about 165 km; isPlaceNearCity within 30 km of her coordinates, false without them", () => {
  const d = places.distanceKm(43.6591, -70.2568, 42.3601, -71.0589);
  assert.ok(d > 150 && d < 185, String(d));
  assert.ok(places.distanceKm(43.6591, -70.2568, 43.6591, -70.2568) < 1e-9);
  const her = { herLat: 43.6591, herLon: -70.2568 };
  assert.equal(places.isPlaceNearCity(43.6690, -70.2390, her), true);
  assert.equal(places.isPlaceNearCity(42.3601, -71.0589, her), false, "Boston is not near");
  assert.equal(places.isPlaceNearCity(40.7, -74.0, her), false, "Stubtown is not near");
  assert.equal(places.isPlaceNearCity(43.6690, -70.2390, { herLat: null, herLon: null }), false, "nothing is near without her coordinates");
  assert.equal(places.isPlaceNearCity(40.7, -74.0, { herLat: 40.7, herLon: -74.0 }), true);
  assert.equal(places.isPlaceNearCity(43.9, -70.2568, her, 10), false, "a custom radius");
});

t("placeTitleNorm and placeSlug: stable, ASCII, 40 plus a dash and six id characters", () => {
  assert.equal(places.placeTitleNorm("  The   Harbour Bench "), "the harbour bench");
  assert.equal(places.placeTitleNorm("Exchange Street"), "exchange street");
  assert.equal(places.placeSlug("The Harbour Bench", "pl_abcdef123456"), "the-harbour-bench-abcdef");
  assert.equal(places.placeSlug("The Harbour Bench", "pl_abcdef123456"), places.placeSlug("The Harbour Bench", "pl_abcdef123456"), "stable");
  const long = places.placeSlug("x".repeat(60) + " y", "pl_0123456789");
  assert.match(long, /^[a-z0-9-]+$/);
  assert.equal(long.length, 40 + 7);
  assert.equal(long.slice(-7), "-012345");
  const odd = places.placeSlug("Café -- am Ufer!!", "pl_ZZZ999xyz");
  assert.match(odd, /^[a-z0-9-]+-zzz999$/);
  assert.equal(places.placeSlug("", "pl_abc123"), "place-abc123");
  assert.equal(places.placeKey("The Harbour Bench", "pl_abcdef123456"), "places/the-harbour-bench-abcdef.png");
});

// ------------------------------------------------------------------ syncPlaces on the stand-in

t("syncPlaces: a new head with the same title updates thread_id; a new title inserts; a dropped thread keeps its row, listed inactive", async () => {
  const older = placeThread({ id: "lt_bench_v1", title: "the harbour bench", created_at: "2026-09-20T00:00:00.000Z" });
  const newer = placeThread({ id: "lt_bench_v2", title: "The Harbour Bench", created_at: "2026-09-21T00:00:00.000Z" });
  const fresh = placeThread({ id: "lt_pier", title: "the pier", created_at: "2026-09-22T00:00:00.000Z" });
  const dropped = placeThread({ id: "lt_gone", title: "the laundromat", status: "dropped" });
  const db = fakeDb({ places: [placeRow({ id: "pl_bench", thread_id: "lt_bench_v1" }), placeRow({ id: "pl_laundromat", title: "the laundromat", thread_id: "lt_gone" })] });
  const rows = await places.syncPlaces(db, [older, newer, fresh, dropped]);
  const update = db.writes.find((w) => /UPDATE places SET thread_id/.test(w.sql));
  assert.ok(update, "the head moved to the newest version");
  assert.deepEqual(update.binds.slice(0, 2), ["pl_bench", "lt_bench_v2"]);
  const insert = db.writes.find((w) => /INSERT OR IGNORE INTO places/.test(w.sql));
  assert.ok(insert, "the pier gets a row");
  assert.equal(insert.binds[1], "lt_pier");
  assert.equal(insert.binds[3], "the pier");
  const bench = rows.find((r) => r.id === "pl_bench");
  assert.equal(bench.thread_id, "lt_bench_v2");
  assert.equal(bench.active, true);
  const laundromat = rows.find((r) => r.id === "pl_laundromat");
  assert.equal(laundromat.active, false, "a dropped thread keeps its row, inactive");
  assert.ok(rows.some((r) => r.title === "the pier" && r.active === true));
  assert.ok(rows.findIndex((r) => r.active === false) > rows.findIndex((r) => r.active === true), "active heads first");
  const again = fakeDb({ places: [placeRow({ id: "pl_bench", thread_id: "lt_bench_v2" })] });
  await places.syncPlaces(again, [newer]);
  assert.equal(again.writes.length, 0, "a read with nothing new writes nothing");
});

// ------------------------------------------------------------------ the picture half

tp("seasonOf and lightOf on fixed instants and a night weather", () => {
  assert.equal(places.seasonOf(new Date("2026-01-15T12:00:00Z"), TZ), "winter");
  assert.equal(places.seasonOf(new Date("2026-12-15T12:00:00Z"), TZ), "winter");
  assert.equal(places.seasonOf(new Date("2026-04-15T12:00:00Z"), TZ), "spring");
  assert.equal(places.seasonOf(new Date("2026-07-15T12:00:00Z"), TZ), "summer");
  assert.equal(places.seasonOf(NOW, TZ), "fall");
  assert.equal(places.seasonOf(new Date("2026-12-01T03:00:00Z"), TZ), "fall", "still November 30th in New York");
  assert.equal(places.lightOf(NOW, TZ, null), "day");
  assert.equal(places.lightOf(new Date("2026-09-30T03:00:00Z"), TZ, null), "night", "11pm New York");
  assert.equal(places.lightOf(NOW, TZ, weatherNow({ isDay: false })), "night", "the weather's own flag wins");
  assert.equal(places.lightOf(new Date("2026-09-30T03:00:00Z"), TZ, weatherNow({ isDay: true })), "day");
});

tp("placePicturePrompt: the title, the detail, the city, the season, the light; no people; under 900", () => {
  const p = places.placePicturePrompt({ title: "the harbour bench", detail: "green paint, facing the ferry" }, "Portland, Maine", "fall", "night");
  assert.ok(p.startsWith("the harbour bench, green paint, facing the ferry, in Portland, Maine, fall, at night, street lights and windows lit."), p);
  assert.ok(/no people, no faces, no text, no watermark, photographic, one image\.$/.test(p), p);
  const day = places.placePicturePrompt({ title: "the pier", detail: null }, "Portland, Maine", "summer", "day");
  assert.ok(day.startsWith("the pier, in Portland, Maine, summer, in daylight."), day);
  const long = places.placePicturePrompt({ title: "x".repeat(300), detail: "y".repeat(2000) }, "Portland, Maine", "fall", "day");
  assert.ok(long.length <= 900, String(long.length));
  assert.ok(/no people/.test(long), "the law of the picture always rides whole");
  assert.ok(!BAD_TYPOGRAPHY.test(p));
});

function pictureDb(row = placeRow({ id: "pl_bench" })) {
  return fakeDb({ places: [row], life_threads: [], usage_daily: [], model_runs: [], audit_events: [] });
}

tp("makePlacePicture on the stand-ins: the R2 key from the slug, the run row of kind place with the flat cost, the usage row, the audit; 409 without remake; a remake replaces", async () => {
  const env = ENV();
  const db = pictureDb();
  const row = await places.makePlacePicture(env, db, S, { id: "pl_bench", actor: "test", now: NOW, weather: null });
  assert.equal(row.picture_key, "places/the-harbour-bench-bench.png");
  assert.equal(row.picture_light, "day");
  assert.equal(row.picture_season, "fall");
  assert.equal(row.picture_provider, "stub");
  assert.match(row.picture_sha256, /^[0-9a-f]{64}$/);
  assert.ok(row.picture_bytes > 0);
  assert.ok(/no people/.test(row.picture_prompt));
  assert.ok(env.MEDIA.has(row.picture_key), "the bytes are in R2");
  assert.equal(env.MEDIA.log.find((l) => l.op === "put").options.httpMetadata.contentType, "image/png");
  const run = db.writes.find((w) => /INSERT INTO model_runs/.test(w.sql));
  assert.ok(run, "a model_runs row");
  assert.ok(run.binds.includes("place"), "kind place: " + JSON.stringify(run.binds));
  assert.ok(run.binds.includes(80000), "the flat cost in micro-dollars");
  const usage = db.writes.find((w) => /usage_daily/.test(w.sql));
  assert.ok(usage && usage.binds.includes(80000), "the usage row");
  const audit = db.writes.find((w) => /INSERT INTO audit_events/.test(w.sql) && w.binds.includes("place.picture"));
  assert.ok(audit, "audited place.picture");
  assert.ok(!JSON.stringify(audit.binds).includes("SECRET"), "no secret in the audit row");

  const made = pictureDb(placeRow({ id: "pl_bench", picture_key: row.picture_key, picture_sha256: row.picture_sha256 }));
  await assert.rejects(places.makePlacePicture(env, made, S, { id: "pl_bench", actor: "test", now: NOW, weather: null }), (e) => e.status === 409 && e.code === "already_generated");
  const remade = await places.makePlacePicture(env, pictureDb(placeRow({ id: "pl_bench", picture_key: row.picture_key })), S, { id: "pl_bench", remake: true, actor: "test", now: NOW, weather: weatherNow({ isDay: false }) });
  assert.equal(remade.picture_light, "night");
  await assert.rejects(places.makePlacePicture(env, pictureDb(), S, { id: "pl_nothing", actor: "test", now: NOW, weather: null }), (e) => e.status === 404);
});

tp("makePlacePicture refuses a paid provider at a zero price and an unconfigured provider, and spends nothing", async () => {
  const env = ENV();
  const db = pictureDb();
  await assert.rejects(places.makePlacePicture(env, db, settingsV4({ imageProvider: "openai", placeCostUsd: 0 }), { id: "pl_bench", actor: "test", now: NOW, weather: null }), (e) => e.status === 402 && e.code === "price_unknown");
  await assert.rejects(places.makePlacePicture({ ...env, OPENAI_API_KEY: "" }, db, settingsV4({ imageProvider: "openai", placeCostUsd: 0.08 }), { id: "pl_bench", actor: "test", now: NOW, weather: null }), (e) => e.status === 503 && e.code === "provider_not_configured");
  assert.equal(db.writes.length, 0);
  assert.equal(env.MEDIA.store.size, 0);
});

tp("deletePlacePicture clears the columns and the object; servePlacePicture 404 without a picture, 200 image/png with one", async () => {
  const env = ENV();
  const db = pictureDb();
  const made = await places.makePlacePicture(env, db, S, { id: "pl_bench", actor: "test", now: NOW, weather: null });
  const served = await places.servePlacePicture(env, pictureDb(placeRow({ id: "pl_bench", picture_key: made.picture_key })), "pl_bench");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("cache-control"), "private, no-store");
  const bytes = new Uint8Array(await served.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
  assert.equal((await places.servePlacePicture(env, pictureDb(), "pl_bench")).status, 404, "no picture");
  assert.equal((await places.servePlacePicture(env, pictureDb(), "pl_nothing")).status, 404, "no place");
  const del = pictureDb(placeRow({ id: "pl_bench", picture_key: made.picture_key, picture_sha256: made.picture_sha256 }));
  const cleared = await places.deletePlacePicture(env, del, "pl_bench", "test");
  assert.equal(cleared.picture_key, null);
  assert.equal(cleared.picture_sha256, null);
  assert.ok(!env.MEDIA.has(made.picture_key), "the object is gone");
  assert.ok(del.writes.some((w) => /INSERT INTO audit_events/.test(w.sql) && w.binds.includes("place.picture_delete")));
  assert.equal((await places.servePlacePicture(env, pictureDb(placeRow({ id: "pl_bench", picture_key: made.picture_key })), "pl_bench")).status, 404, "the key without the object is 404");
});

// ------------------------------------------------------------------ review fixes (v4)

t("syncPlaces: a thread that moved to a new version brings its detail with it (the picture prompt reads the current words)", async () => {
  const v2 = placeThread({ id: "lt_bench_v2", title: "the harbour bench", detail: "the bench by the ferry, repainted green", created_at: "2026-09-21T00:00:00.000Z" });
  const db = fakeDb({ places: [placeRow({ id: "pl_bench", thread_id: "lt_bench_v1", detail: "the bench by the ferry" })] });
  const rows = await places.syncPlaces(db, [v2]);
  const update = db.writes.find((w) => /UPDATE places SET thread_id/.test(w.sql));
  assert.ok(update && /detail = \?3/.test(update.sql), "the detail rides with the thread");
  assert.deepEqual(update.binds.slice(0, 3), ["pl_bench", "lt_bench_v2", "the bench by the ferry, repainted green"]);
  assert.equal(rows.find((r) => r.id === "pl_bench").detail, "the bench by the ferry, repainted green");
  const noDetail = fakeDb({ places: [placeRow({ id: "pl_bench", thread_id: "lt_bench_v1", detail: "his own words" })] });
  await places.syncPlaces(noDetail, [placeThread({ id: "lt_bench_v3", title: "the harbour bench", detail: null })]);
  assert.equal(noDetail.writes.find((w) => /UPDATE places SET thread_id/.test(w.sql)).binds[2], "his own words", "a thread with no detail keeps the row's");
});

const tg = guard(places, "placeGeocodeQueries", "isPlaceKey");

tg("placeGeocodeQueries: the title with only the region after her city's last comma (Open-Meteo answers nothing for two commas or a city filter), then the bare title", () => {
  assert.deepEqual(places.placeGeocodeQueries("Deering Oaks Park", "Portland, Maine"), ["Deering Oaks Park, Maine", "Deering Oaks Park"]);
  assert.deepEqual(places.placeGeocodeQueries("  the  Eastern Promenade ", "Portland, Maine"), ["the Eastern Promenade, Maine", "the Eastern Promenade"]);
  assert.deepEqual(places.placeGeocodeQueries("Deering Oaks Park", "Portland"), ["Deering Oaks Park"], "a city with no comma adds nothing");
  assert.deepEqual(places.placeGeocodeQueries("Deering Oaks Park", ""), ["Deering Oaks Park"]);
  assert.deepEqual(places.placeGeocodeQueries("   ", "Portland, Maine"), []);
  for (const q of places.placeGeocodeQueries("x".repeat(200), "Portland, Maine")) {
    assert.ok(q.length <= 80, "under weather.ts's 80-character cap: " + q.length);
    assert.ok((q.match(/,/g) ?? []).length <= 1, "never two commas");
  }
});

tg("isPlaceKey: only places/<slug>.png; never his photo, a restore point, a traversal or a candidate", () => {
  assert.equal(places.isPlaceKey("places/the-harbour-bench-bench.png"), true);
  assert.equal(places.isPlaceKey(places.placeKey("The Pier!", "pl_abc123")), true);
  for (const bad of ["him/him_38edf830605b4fa9bb51.webp", "snapshots/avelie-2026-09-25.json", "places/../him/x.png", "places/x.webp", "candidates/img_1.png", "", null, 42]) {
    assert.equal(places.isPlaceKey(bad), false, String(bad));
  }
});

tp("a place row naming a key outside places/ is never served or deleted (a corrupted import cannot reach his photo)", async () => {
  const env = { ...secretEnv(), MEDIA: fakeR2({ "him/him_1.webp": new Uint8Array([1, 2, 3]) }) };
  const row = placeRow({ id: "pl_bench", picture_key: "him/him_1.webp", picture_sha256: "0".repeat(64) });
  assert.equal((await places.servePlacePicture(env, pictureDb(row), "pl_bench")).status, 404);
  const cleared = await places.deletePlacePicture(env, pictureDb(row), "pl_bench", "test");
  assert.equal(cleared.picture_key, null, "the column is cleared");
  assert.ok(env.MEDIA.has("him/him_1.webp"), "his photo is untouched");
  assert.ok(!env.MEDIA.log.some((l) => l.op === "delete"), "no delete reached storage");
});

tp("makePlacePicture: the claim is taken before the paid call and released after; a claim held elsewhere is 409 in_progress with nothing paid", async () => {
  const env = ENV();
  const db = pictureDb();
  await places.makePlacePicture(env, db, S, { id: "pl_bench", actor: "test", now: NOW, weather: null });
  const claim = db.writes.findIndex((w) => /INSERT INTO panel_cache/.test(w.sql) && w.binds[0] === "place_picture:pl_bench");
  const run = db.writes.findIndex((w) => /INSERT INTO model_runs/.test(w.sql));
  const release = db.writes.findIndex((w) => /DELETE FROM panel_cache WHERE k = \?1 AND fetched_at = \?2/.test(w.sql) && w.binds[0] === "place_picture:pl_bench");
  assert.ok(claim >= 0 && run > claim && release > run, `claim ${claim}, run ${run}, release ${release}`);

  const busy = pictureDb();
  const prepare = busy.prepare;
  busy.prepare = (sql) => {
    const st = prepare(sql);
    if (/INSERT INTO panel_cache/.test(sql)) st.run = async () => { busy.writes.push({ sql, binds: st.binds }); return { success: true, meta: { changes: 0 } }; };
    return st;
  };
  const busyEnv = ENV();
  await assert.rejects(places.makePlacePicture(busyEnv, busy, S, { id: "pl_bench", actor: "test", now: NOW, weather: null }), (e) => e.status === 409 && e.code === "in_progress");
  assert.equal(busyEnv.MEDIA.store.size, 0, "no picture made");
  assert.ok(!busy.writes.some((w) => /model_runs|usage_daily|DELETE FROM panel_cache/.test(w.sql)), "nothing paid, and the other call's claim is not released");
});
