// The experience pass, phone lane (DESIGN_EXPERIENCE 4.1 to 4.6, 10.2): her lock screen and
// her apps. lockwords.js is pure and imported here; phone.js touches the DOM at boot, so it is
// read as text; map.js is imported (no top-level DOM) and read as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const words = await import("../../public/js/lockwords.js");
const map = await import("../../public/js/map.js");
const read = (rel) => readFileSync(new URL("../../public/js/" + rel, import.meta.url), "utf8");
const phoneJs = read("phone.js");
const mapJs = read("map.js");
const lockJs = read("lockwords.js");
// phone.js without its comments, and the string literals it draws with.
const phoneCode = phoneJs.replace(/^\s*\/\/.*$/gm, "");
const phoneLiterals = phoneCode.match(/"(?:[^"\\\n]|\\.)*"|`[^`]*`|'(?:[^'\\\n]|\\.)*'/g) || [];

const NOW = Date.parse("2026-09-26T16:00:00Z"); // Saturday, noon in New York
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ lockwords.js

test("appFromHash: every view by its hash; no hash, #lock and junk are the lock screen", () => {
  for (const v of ["home", "maps", "notes", "music", "photos"]) {
    assert.equal(words.appFromHash("#" + v), v);
    assert.equal(words.appFromHash(v), v);
  }
  assert.equal(words.appFromHash("#Maps"), "maps", "case does not matter");
  for (const junk of ["", "#", "#lock", "#messages", "#calendar", "#appScreen", "#maps/1", "#../home", null, undefined, 42]) {
    assert.equal(words.appFromHash(junk), "lock", String(junk));
  }
});

test("whenWords: now, 12m, 3h, yesterday, the weekday within six days, else Sep 20", () => {
  const tz = "America/New_York";
  assert.equal(words.whenWords(ago(30 * 1000), NOW, tz), "now");
  assert.equal(words.whenWords(ago(-5 * MIN), NOW, tz), "now", "a time ahead of now reads now");
  assert.equal(words.whenWords(ago(12 * MIN), NOW, tz), "12m");
  assert.equal(words.whenWords(ago(3 * HOUR), NOW, tz), "3h");
  assert.equal(words.whenWords(ago(26 * HOUR), NOW, tz), "yesterday");
  assert.equal(words.whenWords(ago(3 * DAY), NOW, tz), "Wednesday");
  assert.equal(words.whenWords(ago(6 * DAY + HOUR), NOW, tz), "Sunday");
  assert.equal(words.whenWords(ago(10 * DAY), NOW, tz), "Sep 16");
  assert.equal(words.whenWords("not a date", NOW, tz), "");
  assert.equal(words.whenWords(ago(HOUR), NaN, tz), "");
  assert.equal(words.whenWords(ago(10 * DAY), NOW, "Not/AZone"), words.whenWords(ago(10 * DAY), NOW), "an unknown zone falls back to the device zone");
});

test("weatherWords: 68° clear; celsius says C; null and junk are empty", () => {
  assert.equal(words.weatherWords({ temp: 67.6, units: "fahrenheit", words: "clear" }), "68° clear");
  assert.equal(words.weatherWords({ temp: 20.2, units: "celsius", words: "light rain" }), "20°C light rain");
  assert.equal(words.weatherWords({ temp: 55, units: "fahrenheit", words: "" }), "55°");
  assert.equal(words.weatherWords(null), "");
  assert.equal(words.weatherWords({ temp: null, units: "fahrenheit", words: "clear" }), "");
  assert.equal(words.weatherWords({ temp: "warm", units: "fahrenheit", words: "clear" }), "");
});

test("tickOffset: the story lead over the wall clock; 0 when unreadable", () => {
  assert.equal(words.tickOffset("2026-09-26T16:05:00Z", NOW), 5 * MIN);
  assert.equal(words.tickOffset("2026-09-24T16:00:00Z", NOW), -2 * DAY, "a held clock reads behind the wall");
  assert.equal(words.tickOffset("not a date", NOW), 0);
  assert.equal(words.tickOffset(null, NOW), 0);
  assert.equal(words.tickOffset("2026-09-26T16:05:00Z", NaN), 0);
});

test("APP_NAMES: exactly messages, music and calendar", () => {
  assert.deepEqual(Object.keys(words.APP_NAMES).sort(), ["calendar", "messages", "music"]);
  assert.deepEqual(words.APP_NAMES, { messages: "Messages", music: "Music", calendar: "Calendar" });
  assert.ok(Object.isFrozen(words.APP_NAMES));
  assert.deepEqual(Object.keys(words.APP_TITLES).sort(), ["maps", "music", "notes", "photos"]);
});

test("clockWords and dateWords: h:mm with no am or pm, and the long date, in her zone", () => {
  const eveningNy = Date.parse("2026-09-26T23:42:00Z"); // 7:42pm in New York
  assert.equal(words.clockWords(eveningNy, "America/New_York"), "7:42");
  assert.equal(words.clockWords(Date.parse("2026-09-26T04:05:00Z"), "America/New_York"), "12:05");
  assert.equal(words.clockWords(Date.parse("2026-09-26T13:00:00Z"), "UTC"), "1:00");
  assert.equal(words.dateWords(NOW, "America/New_York"), "Saturday, September 26");
  assert.equal(words.dateWords(Date.parse("2026-09-27T02:00:00Z"), "America/New_York"), "Saturday, September 26", "10pm Saturday is still Saturday");
  assert.equal(words.clockWords(NaN, "UTC"), "");
  assert.equal(words.dateWords(NaN, "UTC"), "");
});

test("focusPosition, progressWidth, noteNext: the run-time values and the note line", () => {
  assert.equal(words.focusPosition([50, 30]), "50% 30%");
  assert.equal(words.focusPosition([12.5, 140]), "12.5% 100%");
  assert.equal(words.focusPosition(null), "50% 30%");
  assert.equal(words.focusPosition(["a", 3]), "50% 30%");
  assert.equal(words.progressWidth(30, 120), "25%");
  assert.equal(words.progressWidth(5, 0), "0%");
  assert.equal(words.progressWidth(500, 100), "100%");
  assert.equal(words.noteNext({ title: "sign up at the bar", dueOn: "2026-10-01", day: "Thursday" }), "Thursday -- sign up at the bar");
  assert.equal(words.noteNext({ title: "sign up", day: "" }), "sign up");
  assert.equal(words.noteNext(null), "");
  assert.equal(words.noteNext({ title: "  ", day: "Thursday" }), "");
});

test("drawableRoll: photos by url, clips by poster, a clip with no poster left out, capped", () => {
  const items = [
    { id: "a", kind: "photo", url: "/media/a", poster: null },
    { id: "b", kind: "clip", url: "/media/b", poster: "/media/src1" },
    { id: "c", kind: "clip", url: "/media/c", poster: null },
    { id: "d", kind: "photo", url: "/media/d", poster: null },
    null,
    { kind: "photo", url: "/media/x" },
  ];
  assert.deepEqual(words.drawableRoll(items), [
    { id: "a", clip: false, src: "/media/a" },
    { id: "b", clip: true, src: "/media/src1" },
    { id: "d", clip: false, src: "/media/d" },
  ]);
  assert.equal(words.drawableRoll(items, 2).length, 2);
  assert.deepEqual(words.drawableRoll(null), []);
});

test("pinnedPlaces: only places with stored coordinates (and a name) reach her Maps", () => {
  const got = words.pinnedPlaces([
    { id: "p1", title: "The bench by the water", lat: 43.66, lon: -70.25 },
    { id: "p2", title: "The record store", lat: null, lon: null },
    { id: "p3", title: "Exchange Street", lat: 43.657, lon: undefined },
    { id: "p4", title: "", lat: 43.65, lon: -70.26 },
    { id: "p5", title: "The shop", lat: 0, lon: 0 },
  ]);
  assert.deepEqual(got.map((p) => p.id), ["p1", "p5"]);
  assert.deepEqual(words.pinnedPlaces(undefined), []);
});

test("songLines, playlistIdOf, listKey", () => {
  assert.deepEqual(words.songLines("Phoebe Bridgers - Motion Sickness"), { title: "Motion Sickness", artist: "Phoebe Bridgers" });
  assert.deepEqual(words.songLines("Motion Sickness"), { title: "Motion Sickness", artist: "" });
  assert.equal(words.playlistIdOf({ connected: true, playlistId: "37i9dQZF1DX" }), "37i9dQZF1DX");
  assert.equal(words.playlistIdOf({ connected: false, playlistId: "37i9dQZF1DX" }), "");
  assert.equal(words.playlistIdOf({ connected: true, playlistId: "../x" }), "");
  assert.equal(words.playlistIdOf(null), "");
  const a = [{ id: "1", t: "x" }];
  assert.equal(words.listKey(a, ["id", "t"]), words.listKey([{ id: "1", t: "x" }], ["id", "t"]));
  assert.notEqual(words.listKey(a, ["id", "t"]), words.listKey([{ id: "1", t: "y" }], ["id", "t"]));
});

test("lockwords.js is pure: no DOM, no location, no fetch, no window", () => {
  const code = lockJs.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\b(document|window|location|fetch|localStorage)\b/.test(code));
});

// ------------------------------------------------------------------ map.js (ui_v4 pins)

test("map.js keeps its exports and the Map group; pulsePlace is added, never a style attribute", () => {
  for (const name of ["PORTLAND_BOUNDS", "MAP_VIEW", "project", "unproject", "outlinePath", "drawMap", "pulsePlace"]) {
    assert.ok(name in map, "map.js exports " + name);
  }
  assert.ok(/role: "group",\s*"aria-label": "Map"/.test(mapJs));
  assert.ok(!/setAttribute\(\s*["']style["']/.test(mapJs) && !/\.style\.cssText/.test(mapJs));
  assert.ok(/prefers-reduced-motion: reduce/.test(mapJs), "the pulse stays still under reduced motion");
  assert.equal(map.pulsePlace(null, "x"), null);
});

// ------------------------------------------------------------------ phone.js (as text)

test("phone.js reads the lock screen, the roll, the phone, what she sent and her playlist", () => {
  for (const path of ['"/api/phone/lock"', '"/api/roll?limit="', '"/api/phone"', '"/api/sent"', '"/api/spotify"']) {
    assert.ok(phoneJs.includes(path), "reads " + path);
  }
  assert.ok(/^import "\.\/player\.js";$/m.test(phoneJs), "imports player.js (ui_v4)");
  assert.ok(/from "\.\/lockwords\.js"/.test(phoneJs));
  assert.ok(/import \{[^}]*drawMap[^}]*\} from "\.\/map\.js"/.test(phoneJs));
});

test("phone.js writes nothing: no PUT, POST or DELETE, and no places route (placing is Studio's)", () => {
  assert.ok(!/api\(\s*"(PUT|POST|DELETE|PATCH)"/.test(phoneJs));
  assert.ok(!phoneJs.includes("/api/places"));
  assert.ok(!/geocode|\/picture"/.test(phoneCode));
});

test("phone.js follows her clock: reads frozen, stops the tick while held, ticks every 15 s from tickOffset", () => {
  assert.ok(/S\.frozen = lock\.frozen === true/.test(phoneJs));
  assert.ok(/function syncTick\(\) \{\s*stopTick\(\);\s*renderClock\(\);\s*if \(S\.frozen\) return;/.test(phoneJs), "a held clock stops the tick");
  assert.ok(/const TICK_MS = 15 \* 1000;/.test(phoneJs));
  assert.ok(/const LOCK_MS = 60 \* 1000;/.test(phoneJs));
  assert.ok(/tickOffset\(lock\.now, Date\.now\(\)\)/.test(phoneJs));
  assert.ok(/String\(S\.lock\.time/.test(phoneJs) && /String\(S\.lock\.dateLine/.test(phoneJs), "held: exactly the answer");
  assert.ok(/document\.hidden/.test(phoneJs), "only while the page is visible");
});

test("phone.js binds the phone.html ids of 4.3 and never the old ones", () => {
  for (const id of ["lock", "wallpaper", "lockDate", "lockTime", "lockWeather", "lockPlaying", "lockStack", "rollStrip", "openHome", "home", "homeWallpaper", "homeGrid", "homeDock", "closeHome", "appScreen", "appBack", "appTitle", "appBody"]) {
    assert.ok(phoneJs.includes('"' + id + '"') || phoneJs.includes("#" + id), "binds " + id);
  }
  for (const gone of ["lockStatus", "phoneStatus", "phoneMood", "phoneWants", "phoneOutfit", "placeAdd", "mapFoot", "moodDial"]) {
    assert.ok(!phoneJs.includes(gone), "never " + gone);
  }
});

test("phone.js: the swipe is 80px vertical, the handles and Back move by the hash", () => {
  assert.ok(/const SWIPE_PX = 80;/.test(phoneJs));
  assert.ok(/swipe\(\$\("lock"\), -1, \(\) => go\("home"\)\)/.test(phoneJs));
  assert.ok(/swipe\(\$\("home"\), 1, \(\) => go\("lock"\)\)/.test(phoneJs));
  assert.ok(/addEventListener\("hashchange"/.test(phoneJs));
  assert.ok(/location\.hash = hash/.test(phoneJs));
  assert.ok(/appFromHash\(location\.hash\)/.test(phoneJs));
});

test("phone.js builds the lock and apps from the section 9 Phone classes", () => {
  for (const cls of ["notif", "notif-head", "notif-app", "notif-when", "notif-title", "notif-text", "roll-thumb", "np-title", "np-artist", "np-progress", "place-list", "map-place", "note-line", "note-title", "note-next", "sent-song", "photo-grid"]) {
    assert.ok(new RegExp('class: "' + cls + '[" ]|"' + cls + '"').test(phoneJs), "uses " + cls);
  }
  assert.ok(/"data-app": n\.app/.test(phoneJs), "a notification carries its app");
  assert.ok(/"\/album#" \+ encode\(it\.id\)/.test(phoneJs), "a picture opens in the album");
  assert.ok(!/h\("video"/.test(phoneJs), "no <video> in the strip or the grid");
  assert.ok(/"avelie:pause"/.test(phoneJs) && /"avelie:next"/.test(phoneJs) && /"avelie:player"/.test(phoneJs) && /"avelie:play"/.test(phoneJs));
  assert.ok(/n\.app === "calendar" \? "" : whenWords/.test(phoneJs), "a calendar entry shows no time");
  assert.ok(/n\.title \? h\("div", \{ class: "notif-title"/.test(phoneJs), "no title line when the title is empty");
});

test("phone.js renders nothing for an empty list: no none, -- or percent in what it draws", () => {
  for (const lit of phoneLiterals) {
    assert.ok(!/\bnone\b/i.test(lit), "literal " + lit);
    assert.ok(!lit.includes("--"), "literal " + lit);
    assert.ok(!lit.includes("%"), "literal " + lit);
  }
  assert.ok(!/chip\(/.test(phoneJs), "no chips on her phone");
  assert.ok(/show\(stack, list\.length > 0\)/.test(phoneJs), "no stack without notifications");
  assert.ok(/show\(strip, items\.length > 0\)/.test(phoneJs), "no strip without pictures");
  assert.ok(/if \(!pinned\.length\) return;/.test(phoneJs), "no places list when nothing is pinned");
  assert.ok(/if \(!hasApp\(view\)\)/.test(phoneJs), "an empty app is never opened");
});

test("phone.js never writes a style attribute or an inline script; run-time values through the CSSOM", () => {
  assert.ok(!/setAttribute\(\s*["']style["']/.test(phoneJs));
  assert.ok(!/\.style\.cssText|style: "/.test(phoneJs));
  assert.ok(!/innerHTML|insertAdjacentHTML|eval\(|new Function/.test(phoneJs));
  assert.ok(/\.style\.objectPosition = focusPosition\(/.test(phoneJs));
});

test("phone.js and lockwords.js show no machinery words in their UI strings", () => {
  const banned = /\b(proposal|version|seq|model|prompt|flag|json|phase|weight)\b/i;
  for (const lit of phoneLiterals) {
    if (/^"\/api\//.test(lit) || /^"(https?:|M\d)/.test(lit)) continue;
    assert.ok(!banned.test(lit), "literal " + lit);
  }
  const lockLiterals = lockJs.replace(/^\s*\/\/.*$/gm, "").match(/"(?:[^"\\\n]|\\.)*"/g) || [];
  for (const lit of lockLiterals) assert.ok(!banned.test(lit), "literal " + lit);
});
