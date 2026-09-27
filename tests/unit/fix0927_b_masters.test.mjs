// fix0927 lane B1 and B2 (Justin: "where are the fucking master photos"): on every Her
// surface (the camera roll, the lock screen's roll, the wallpaper pool, the Album) a picture
// or clip shows only when it is approved AND she sent it (a message behind it); the face
// tests Claude fired through the API (message_id null) stay in Studio. Her masters 01 to 05
// join the Her side: their own "Her" row at the top of the Album, after the pictures she sent
// on her phone, and in the wallpaper pool. master-00 (a face crop of 04) never shows there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc, relationshipState } from "./helpers.mjs";
import { fakeDb, messageRow, secretEnv } from "./helpers_v2.mjs";
import { assetRow } from "./helpers_v3.mjs";
import { TZ, FRI_1000_NY, HOUR_MS, plusMs, settingsV5 } from "./helpers_v5.mjs";

const album = await loadSrc("album");
const roll = await loadSrc("roll");
const lock = await loadSrc("lockscreen");

const read = (rel) => readFileSync(new URL("../../" + rel, import.meta.url), "utf8");
const FALLBACK = { id: "master-05", file: "images/masters/05_MASTER_GAVINS_BLACK_DRESS_APPROVED.png", focus: [50, 24] };
const SEED = "2026-09-24T00:00:00.000Z";

// The six master rows the seed files (0002_seed.sql), one per id.
const MASTER_FILES = {
  "master-00": "images/masters/00_MASTER_FACE_CROP.png",
  "master-01": "images/masters/01_MASTER_ORIGINAL_CREAM_SWEATER.png",
  "master-02": "images/masters/02_MASTER_ORIGINAL_BLACK_DRESS_NIGHT.png",
  "master-03": "images/masters/03_MASTER_ORIGINAL_BLACK_HOODIE.png",
  "master-04": "images/masters/04_MASTER_ORIGINAL_BEIGE_BLAZER.png",
  "master-05": "images/masters/05_MASTER_GAVINS_BLACK_DRESS_APPROVED.png",
};
const masterRows = () => Object.entries(MASTER_FILES)
  .reverse() // out of order on purpose: the reader sorts by id
  .map(([id, file]) => ({ ...assetRow({ id, file, role: "master", message_id: null, conversation_id: null, created_at: SEED }), with_him: 0 }));

// The live shape of 2026-09-27: four owner-fired face tests (message_id null) and one photo she
// sent (img_sent, on her message m_sent), plus the masters.
function liveTables() {
  return {
    visual_assets: [
      ...["img_63e7", "img_d8aa", "img_878e", "img_bc71"].map((id, i) => ({ ...assetRow({ id, message_id: null, conversation_id: "c1", created_at: "2026-09-25T19:0" + i + ":00.000Z" }), with_him: 0 })),
      { ...assetRow({ id: "img_sent", message_id: "m_sent", conversation_id: "c1", created_at: "2026-09-25T23:01:00.000Z" }), with_him: 0 },
      { ...assetRow({ id: "him_1", role: "him", file: "him/him_1.webp", message_id: null, created_at: "2026-09-26T00:00:00.000Z" }), with_him: 0 },
      ...masterRows(),
    ],
    messages: [messageRow({ id: "m_sent", conversation_id: "c1", role: "assistant", created_at: "2026-09-25T23:00:30.000Z" })],
    state_versions: [],
  };
}

// ------------------------------------------------------------------ album.ts: which masters

test("HER_MASTER_IDS: masters 01 to 05, never master-00; isHerMaster needs role master and approved", () => {
  assert.deepEqual([...album.HER_MASTER_IDS], ["master-01", "master-02", "master-03", "master-04", "master-05"]);
  assert.equal(album.isHerMaster({ id: "master-03", role: "master", approval_status: "approved" }), true);
  assert.equal(album.isHerMaster({ id: "master-00", role: "master", approval_status: "approved" }), false, "the face crop");
  assert.equal(album.isHerMaster({ id: "master-06", role: "master", approval_status: "approved" }), false, "not named");
  assert.equal(album.isHerMaster({ id: "master-03", role: "scene", approval_status: "approved" }), false);
  assert.equal(album.isHerMaster({ id: "master-03", role: "master", approval_status: "archive" }), false);
  assert.equal(album.isHerMaster(null), false);
});

test("masterUrl: /images/masters/ plus the file name (images.js masterSrc builds the same); null without a file", () => {
  assert.equal(album.masterUrl("images/masters/01_MASTER_ORIGINAL_CREAM_SWEATER.png"), "/images/masters/01_MASTER_ORIGINAL_CREAM_SWEATER.png");
  assert.equal(album.masterUrl("05.png"), "/images/masters/05.png");
  assert.equal(album.masterUrl(""), null);
  assert.equal(album.masterUrl(null), null);
  assert.ok(/"\/images\/masters\/" \+ encodeURIComponent\(basename\(m\.file\)\)/.test(read("public/js/images.js")), "the Images page serves masters from the same path");
});

test("the master files the seed names are in public/images/masters (served as static assets)", () => {
  for (const file of Object.values(MASTER_FILES)) {
    assert.ok(read("public/" + file).length > 0, file);
  }
  const seed = read("migrations/0002_seed.sql");
  for (const [id, file] of Object.entries(MASTER_FILES)) assert.ok(seed.includes("'" + id + "', '" + file + "', 'master'"), id + " seeded with " + file);
});

test("readHerMasters: the five in id order with their static URL; master-00, a non-approved master and any other role left out", async () => {
  const t = liveTables();
  t.visual_assets.push({ ...assetRow({ id: "master-02", role: "master", approval_status: "archive", file: "x.png", message_id: null }), with_him: 0 });
  const got = await album.readHerMasters(fakeDb(t));
  assert.deepEqual(got.map((m) => m.id), ["master-01", "master-02", "master-03", "master-04", "master-05"]);
  for (const m of got) {
    assert.equal(m.url, "/images/masters/" + MASTER_FILES[m.id].split("/").pop());
    assert.equal(m.created_at, SEED);
  }
  const broken = { prepare() { throw new Error("no such table"); } };
  assert.deepEqual(await album.readHerMasters(broken), [], "a failed read answers none");
});

// ------------------------------------------------------------------ the roll

test("listRoll on the live shape: items are the one photo she sent (never the four face tests, never him); masters are the five, in id order, as photos at their static URL", async () => {
  const page = await roll.listRoll(fakeDb(liveTables()));
  assert.deepEqual(page.items.map((i) => i.id), ["img_sent"]);
  assert.equal(page.items[0].messageId, "m_sent");
  assert.equal(page.items[0].master, undefined, "a sent picture carries no master key");
  assert.deepEqual(page.masters.map((m) => m.id), ["master-01", "master-02", "master-03", "master-04", "master-05"]);
  for (const m of page.masters) {
    assert.deepEqual(m, { id: m.id, kind: "photo", url: "/images/masters/" + MASTER_FILES[m.id].split("/").pop(), poster: null, at: SEED, place: null, us: false, conversationId: null, messageId: null, master: true });
  }
  assert.ok(!JSON.stringify(page).includes("master-00"), "never the face crop");
  assert.ok(!JSON.stringify(page).includes("him_1"), "never him");
});

// ------------------------------------------------------------------ the wallpaper

test("pickWallpaper: a master candidate answers kind master at its static URL with its focus; a sent photo answers kind photo; the fallback only when the pool is empty", () => {
  const masters = lock.masterCandidates([
    { id: "master-02", file: MASTER_FILES["master-02"], url: "/images/masters/x", created_at: SEED },
  ]);
  assert.deepEqual(masters, [{ id: "master-02", created_at: SEED, file: MASTER_FILES["master-02"], focus: [58, 24] }]);
  const w = lock.pickWallpaper("2026-09-27", masters, FALLBACK);
  assert.deepEqual(w, { kind: "master", id: "master-02", url: "/images/masters/02_MASTER_ORIGINAL_BLACK_DRESS_NIGHT.png", focus: [58, 24], day: "2026-09-27" });
  const photo = lock.pickWallpaper("2026-09-27", [{ id: "img_sent", created_at: "2026-09-25T23:01:00.000Z" }], FALLBACK);
  assert.deepEqual(photo, { kind: "photo", id: "img_sent", url: "/media/img_sent", focus: null, day: "2026-09-27" });
  const none = lock.pickWallpaper("2026-09-27", [], FALLBACK);
  assert.equal(none.kind, "master");
  assert.equal(none.id, "master-05");
  assert.equal(none.url, "/" + FALLBACK.file);
});

test("wallpaperNow on the live shape: the pool is the sent solo photo and masters 01 to 05 (never a face test, never master-00, never him); it rotates through them day by day", async () => {
  const db = fakeDb(liveTables());
  const settings = settingsV5({ timezone: TZ });
  const pool = ["img_sent", "master-05", "master-04", "master-03", "master-02", "master-01"]; // newest first
  const seen = new Set();
  for (let d = 1; d <= 30; d++) {
    const day = "2026-10-" + String(d).padStart(2, "0");
    const w = await lock.wallpaperNow(db, settings, new Date(day + "T16:00:00.000Z"), FALLBACK);
    assert.equal(w.day, day);
    assert.equal(w.id, pool[lock.fnv1a32(day) % pool.length], day);
    if (w.kind === "master") {
      assert.ok(w.url.startsWith("/images/masters/"), w.url);
      assert.deepEqual(w.focus, lock.MASTER_FOCUS[w.id]);
    } else {
      assert.equal(w.url, "/media/img_sent");
    }
    seen.add(w.id);
  }
  assert.ok(seen.size >= 4, "her lock screen rotates: " + [...seen].join(", "));
  for (const id of ["img_63e7", "img_d8aa", "img_878e", "img_bc71", "master-00", "him_1"]) assert.ok(!seen.has(id), id + " never dresses her phone");
});

test("wallpaperNow: an owner-fired picture alone never becomes the wallpaper (her masters do, else the fallback)", async () => {
  const onlyOwner = { visual_assets: [{ ...assetRow({ id: "img_owner", message_id: null, created_at: "2026-09-26T12:00:00.000Z" }), with_him: 0 }] };
  const w = await lock.wallpaperNow(fakeDb(onlyOwner), settingsV5({ timezone: TZ }), new Date(FRI_1000_NY), FALLBACK);
  assert.equal(w.kind, "master");
  assert.equal(w.id, "master-05", "no masters on file: the fallback");
  const withMasters = { visual_assets: [...onlyOwner.visual_assets, ...masterRows()] };
  const m = await lock.wallpaperNow(fakeDb(withMasters), settingsV5({ timezone: TZ }), new Date(FRI_1000_NY), FALLBACK);
  assert.equal(m.kind, "master");
  assert.ok(album.HER_MASTER_IDS.includes(m.id), m.id);
});

test("MASTER_FOCUS in lockscreen.ts equals AVATAR_FOCUS in src/api.ts (one table in two places)", () => {
  const api = read("src/api.ts");
  const m = /AVATAR_FOCUS[^=]*=\s*\{([^}]*)\}/.exec(api);
  assert.ok(m, "api.ts carries AVATAR_FOCUS");
  const table = {};
  for (const e of m[1].matchAll(/"(master-0\d)"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)) table[e[1]] = [Number(e[2]), Number(e[3])];
  assert.deepEqual({ ...lock.MASTER_FOCUS }, table);
});

// ------------------------------------------------------------------ the lock screen

test("lockScreen on the live shape: the roll is the photo she sent, then her masters (at most six, no face test, no master-00); the wallpaper passes through", async () => {
  const t = liveTables();
  t.conversations = [{ id: "c1", title: null, created_at: "2026-09-25T00:00:00.000Z", last_message_at: null, status: "active" }];
  t.state_versions = [{ id: "r1", entity: "relationship", version: 3, state_json: JSON.stringify(relationshipState({ his_name: "Justin" })), source: "owner", note: null, created_at: "2026-09-25T00:00:00.000Z" }];
  t.wants = [];
  const db = fakeDb(t);
  const settings = settingsV5({ timezone: TZ, storyClockEnabled: false, weatherProvider: "off" });
  const realNow = new Date(plusMs("2026-09-26T00:00:00.000Z", 2 * HOUR_MS));
  const wallpaper = await lock.wallpaperNow(db, settings, realNow, FALLBACK);
  const screen = await lock.lockScreen(secretEnv(), db, settings, realNow, wallpaper);
  assert.deepEqual(screen.roll.map((i) => i.id), ["img_sent", "master-01", "master-02", "master-03", "master-04", "master-05"]);
  assert.equal(screen.roll[1].url, "/images/masters/01_MASTER_ORIGINAL_CREAM_SWEATER.png");
  assert.equal(screen.wallpaper, wallpaper);
  assert.equal(db.writes.length, 0, "the lock writes nothing");
});

// ------------------------------------------------------------------ the pages (as text)

test("album.html: a Her row at the top of the Album, before the Us row, hidden until it has her masters", () => {
  const html = read("public/album.html");
  assert.ok(/<section class="gallery-section her-row hidden" id="herSection" aria-labelledby="herHead"><h2 class="display" id="herHead">Her<\/h2><div class="gallery" id="herGrid"><\/div><\/section>/.test(html));
  assert.ok(html.indexOf('id="herSection"') < html.indexOf('id="usSection"'), "Her first");
  assert.ok(html.indexOf('id="herSection"') < html.indexOf('id="albumMonths"'));
});

test("album.js: the page's masters fill the Her row in order, each once; a master's tile, lightbox, Save and Full size use its own file; no date or place on a master", () => {
  const src = read("public/js/album.js");
  assert.ok(src.includes("placeHer(page && page.masters);"), "the Her row from the page's masters");
  assert.ok(/\$\("herGrid"\)/.test(src) && /\$\("herSection"\)/.test(src));
  assert.ok(/item\.master === true && typeof item\.url === "string" && item\.url\.startsWith\("\/images\/masters\/"\)/.test(src), "a master is its own file");
  assert.ok(/isMaster\(item\) \? item\.url : mediaUrl\(item\.id, download\)/.test(src));
  assert.ok(src.includes('save.setAttribute("href", srcOf(item, true));') && src.includes('$("lbOpen").setAttribute("href", srcOf(item));'));
  assert.ok(src.includes('isMaster(item) ? "" : dayWords(item.at, nowIso())'), "no date line on a master");
  assert.ok(src.includes('"#herGrid .roll-tile, #usGrid .roll-tile, #albumMonths .roll-tile"'), "the lightbox walks the Her row first");
  assert.ok(/state\.items\.has\(item\.id\)\) continue;/.test(src), "each once");
  assert.ok(!src.includes("/api/images/"), "still no approval on the Her side");
});

test("phone.js: her Photos app is the pictures she sent, then her masters (each once); the lock is read every minute and a held clock never ticks past the read", () => {
  const src = read("public/js/phone.js");
  assert.ok(src.includes('load("roll", "/api/roll?limit=" + PHOTOS_MAX, asRoll)'));
  assert.ok(/\[\.\.\.asItems\(r\), \.\.\.\(r && Array\.isArray\(r\.masters\) \? r\.masters : \[\]\)\]/.test(src), "sent first, then masters");
  assert.ok(/const LOCK_MS = 60 \* 1000;/.test(src));
  assert.ok(/setInterval\(\(\) => \{ if \(!document\.hidden\) S\.lockPromise = loadLock\(\); \}, LOCK_MS\)/.test(src), "the lock every minute while visible");
  assert.ok(/function syncTick\(\) \{\s*stopTick\(\);\s*renderClock\(\);\s*if \(S\.frozen\) return;/.test(src), "a held clock is not ticked here");
});

test("app.css: the Her row's rules, before the global reduced-motion switch that stays last, never --muted", () => {
  const css = read("public/css/app.css");
  const at = css.indexOf("fix0927 lane B");
  assert.ok(at > 0, "the lane's block");
  assert.ok(at < css.lastIndexOf("@media (prefers-reduced-motion: reduce)"), "before the last switch");
  const block = css.slice(at, css.lastIndexOf("/* The one global switch"));
  for (const sel of [".her-row .gallery {", ".her-row .roll-tile {", ".her-row .roll-tile img {"]) assert.ok(block.includes(sel), sel);
  assert.ok(!block.includes("var(--muted)"));
});
