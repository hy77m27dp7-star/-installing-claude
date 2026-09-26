// The design pass (SPEC_V4 section 0), read as text: the shell on every page exactly once,
// no style attribute and no inline script anywhere (the CSP has no unsafe-inline), the
// design tokens in the one stylesheet, every class name of the cross-lane contract, the ids
// the section names on the three new pages, the service worker's shell list, and clean
// typography under public/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = join(ROOT, "public");
const read = (rel) => readFileSync(join(PUBLIC, rel), "utf8");
const pages = readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).sort();
const css = read("css/app.css");

const TOKENS = [
  "--avatar-size: 36px", "--avatar-size-lg: 56px", "--avatar-ring:", "--bubble-hers:", "--bubble-his:", "--bubble-max: 78%",
  "--fs-0: 12px", "--fs-1: 13px", "--fs-2: 15px", "--fs-3: 17px", "--fs-4: 21px",
  "--s-1: 4px", "--s-2: 8px", "--s-3: 12px", "--s-4: 16px", "--s-5: 24px", "--s-6: 32px",
  "--place-veil:", "--dial-track:", "--dial-fill:", "--safe-b:",
];
// The class names other lanes use and L0 defines (SPEC_V4 "Cross-lane contracts").
const CLASSES = [".map", ".map-water", ".map-land", ".map-dot", ".map-dot.here", ".map-label", ".dial", ".dial-track", ".dial-fill", ".polaroid", ".drawer", ".msg-avatar", "#callFace", ".thread::before"];
const EXPECTED_PAGES = ["album.html", "images.html", "index.html", "memory.html", "model.html", "phone.html", "state.html", "timeline.html"];

const count = (text, needle) => text.split(needle).length - 1;

test("the eight pages exist", () => {
  assert.deepEqual(pages, EXPECTED_PAGES);
});

test("every page carries the shell markup exactly once: the brand link, the avatar, the wordmark, the nav", () => {
  for (const p of pages) {
    const html = read(p);
    assert.equal(count(html, 'class="brand"'), 1, p + " brand");
    assert.equal(count(html, 'id="avatar"'), 1, p + " avatar");
    assert.equal(count(html, 'class="wordmark"'), 1, p + " wordmark");
    assert.equal(count(html, 'class="nav"'), 1, p + " nav");
    assert.ok(/<header class="top">/.test(html), p + " header.top");
    assert.ok(/<script type="module" src="\/js\/nav\.js"><\/script>/.test(html), p + " loads nav.js as a module");
    assert.ok(/<link rel="stylesheet" href="\/css\/app\.css">/.test(html), p + " the one stylesheet");
  }
});

test("no page carries a style attribute or an inline script (module files only)", () => {
  for (const p of pages) {
    const html = read(p);
    assert.ok(!/\sstyle\s*=\s*["']/.test(html), p + " has a style attribute");
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), p + " has an inline script");
    for (const s of html.matchAll(/<script[^>]*>/g)) assert.ok(/type="module"/.test(s[0]) && /src="\/js\/[a-z_]+\.js"/.test(s[0]), p + " " + s[0]);
  }
});

test("app.css defines every v4 token and keeps the one accent", () => {
  for (const t of TOKENS) assert.ok(css.includes(t), "token " + t);
  assert.ok(/--accent-solid: #22d3ee/.test(css), "the accent is unchanged");
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(root, ":root block");
  const accents = (root[1].match(/--accent[a-z-]*:/g) ?? []);
  assert.ok(!accents.some((a) => /accent-2|second/.test(a)), "no second accent: " + accents.join(", "));
});

test("app.css carries every class name of the cross-lane contract", () => {
  for (const c of CLASSES) assert.ok(css.includes(c), "selector " + c);
  // The veil rides over the place picture; the design lane paints it on .thread itself
  // (a scroll container's own background stays fixed to its box) and keeps .thread::before
  // free, so either home is accepted as long as the composite is the veil over the url.
  assert.ok(/background-image:\s*var\(--place-veil\),\s*var\(--place-url\)/.test(css), "the place background under the veil");
  assert.ok(/prefers-reduced-motion/.test(css), "reduced motion respected");
});

test("the three new pages carry the ids their sections name; index carries the phone button, the drawer and the call face frame", () => {
  const phone = read("phone.html");
  for (const id of ["phoneStatus", "phoneNow", "phoneWhere", "phoneWeather", "phoneOutfit", "phoneMood", "phoneWants", "phoneAsks", "phoneToday", "phoneListening", "phoneMap", "placesList", "placesStatus"]) assert.ok(phone.includes('id="' + id + '"'), "phone.html #" + id);
  assert.ok(/<main class="page phone"/.test(phone), "main.page.phone");
  const album = read("album.html");
  for (const id of ["albumStatus", "albumFilter", "albumGrid", "albumOlder"]) assert.ok(album.includes('id="' + id + '"'), "album.html #" + id);
  for (const g of ["all", "approved", "candidates", "us"]) assert.ok(album.includes('data-group="' + g + '"'), "album filter " + g);
  const memory = read("memory.html");
  for (const id of ["memoryStatus", "memoryLegend", "memoryFacts", "memoryFading", "memoryReturned", "memoryHistory", "memorySealed", "memoryKept"]) assert.ok(memory.includes('id="' + id + '"'), "memory.html #" + id);
  const index = read("index.html");
  for (const id of ["phoneBtn", "phoneDrawer", "phoneDrawerBody", "callFace", "typing", "placeInput"]) assert.ok(index.includes('id="' + id + '"'), "index.html #" + id);
  assert.ok(/<aside class="drawer[^"]*" id="phoneDrawer"/.test(index), "the slide-in is aside.drawer");
  const images = read("images.html");
  for (const id of ["avatarPick", "callFaceCard"]) assert.ok(images.includes('id="' + id + '"'), "images.html #" + id);
  const model = read("model.html");
  for (const id of ["spotifyCard", "spotifyStatus", "spotifyConnect", "spotifyDisconnect", "spotifyPlaylist", "herTextsBtn", "herTextsStatus"]) assert.ok(model.includes('id="' + id + '"'), "model.html #" + id);
  for (const name of ["spotifyEnabled", "spotifyPlaylistName", "spotifyPlaylistId", "callFaceProvider", "hisFaceInPhotos", "listeningLineEnabled", "placeCostUsd"]) assert.ok(model.includes('name="' + name + '"'), "model.html field " + name);
});

test("sw.js: the shell list carries the three pages and the five scripts, the cache name is avelie-shell-v3", () => {
  const sw = read("sw.js");
  assert.ok(/const CACHE = "avelie-shell-v3"/.test(sw), "cache name");
  for (const u of ["/phone", "/album", "/memory", "/js/phone.js", "/js/map.js", "/js/album.js", "/js/memory.js", "/js/callface.js"]) assert.ok(sw.includes('"' + u + '"'), "shell " + u);
  assert.ok(/\/api\/push\/latest/.test(sw), "the push handler still reads /api/push/latest");
});

test("typography under public/: no em dash, en dash or Unicode ellipsis in any page, script or the stylesheet", () => {
  const files = [...pages, "css/app.css", "sw.js", ...readdirSync(join(PUBLIC, "js")).filter((f) => f.endsWith(".js")).map((f) => "js/" + f)];
  for (const f of files) assert.ok(!BAD_TYPOGRAPHY.test(read(f)), f);
});

test("A1 player (review): chat.js and phone.js import player.js (its listeners answer the play, pause and next events), the shell caches it, and the song card carries an embed slot its play event targets", () => {
  for (const f of ["js/chat.js", "js/phone.js"]) assert.ok(/^import "\.\/player\.js";$/m.test(read(f)), f + " imports player.js");
  const sw = read("sw.js");
  assert.ok(sw.includes('"/js/player.js"'), "shell /js/player.js");
  const chat = read("js/chat.js");
  assert.ok(/h\("div", \{ class: "song-embed hidden" \}\)/.test(chat), "the card's embed slot");
  assert.ok(/new CustomEvent\("avelie:play", \{ detail: \{ uri, target: embed \} \}\)/.test(chat), "the play event targets the slot");
  assert.ok(!/class: "icon-btn song-play hidden"/.test(chat), "the play control is not hidden until a device exists");
  const player = read("js/player.js");
  assert.ok(/t\.premium === false/.test(player) && !/!t\.premium/.test(player), "only an explicit false premium refuses the SDK");
  assert.ok(/code === "player_off"/.test(player), "spotifyPlayer off renders no embed");
});

test("sw.js (review): her masters are served cache-first; /api and /media are never cached", () => {
  const sw = read("sw.js");
  assert.ok(/const MASTERS = "\/images\/masters\/";/.test(sw));
  assert.ok(/url\.pathname\.startsWith\(MASTERS\)[\s\S]{0,200}caches\.match\(request/.test(sw), "cache first for the masters");
  assert.ok(/url\.pathname\.startsWith\("\/api\/"\) \|\| url\.pathname\.startsWith\("\/media\/"\)\) return;/.test(sw));
});

test("app.css (review): the memory tiles' subject and foot read at AA on the vivid phase; embeds have no browser border; a closed drawer leaves the tab order; the veil starts at 0.86", () => {
  const css = read("css/app.css");
  assert.ok(/\.tile \.subject \{[^}]*color: var\(--text-2\)/.test(css));
  assert.ok(/\.tile \.tile-foot \{[^}]*color: var\(--text-2\)/.test(css));
  assert.ok(/\.playlist-embed, \.spotify-embed \{[^}]*border: 0/.test(css));
  assert.ok(/\.drawer:not\(\.open\) \{ visibility: hidden;/.test(css));
  assert.ok(/--place-veil: linear-gradient\(180deg, rgba\(6, 10, 19, 0\.86\)/.test(css));
  const map = read("js/map.js");
  assert.ok(/role: "group",\s*"aria-label": "Map"/.test(map), "the map is a group, so its place buttons stay buttons");
});
