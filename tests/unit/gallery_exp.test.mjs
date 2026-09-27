// The gallery lane of the experience pass (DESIGN_EXPERIENCE 5.4, 6.4, 10.2):
// public/js/months.js imported as is (pure); public/js/album.js and public/js/us.js read
// as text for their routes and their promises (no approval, no write, no polaroid, none of
// the writer's files on the Her side), then imported under a small stand-in document so
// the tiles and the Us lists are built for real and their classes and words checked.
// Every time here is made in local time, so the suite reads the same in any time zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const months = await import("../../public/js/months.js");
const { monthKey, monthLabel, groupByMonth, capDate, dayWords, tileLabel, countLabel, spanWords, sentenceCase } = months;

const read = (p) => readFileSync(new URL("../../public/js/" + p, import.meta.url), "utf8");
const albumSrc = read("album.js");
const usSrc = read("us.js");
const monthsSrc = read("months.js");

// Local wall time -> ISO, so "Sep 26" is Sep 26 wherever the suite runs.
const L = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();
const NOW = L(2026, 9, 26, 21);

// ------------------------------------------------------------ months.js

test("monthKey: the local year and month; an unreadable time is empty", () => {
  assert.equal(monthKey(L(2026, 9, 26)), "2026-09");
  assert.equal(monthKey(L(2026, 1, 1, 0, 5)), "2026-01");
  assert.equal(monthKey(L(2025, 12, 31, 23, 55)), "2025-12");
  assert.equal(monthKey("not a time"), "");
  assert.equal(monthKey(null), "");
  assert.equal(monthKey(""), "");
});

test("monthLabel: the month alone this year, with the year in any other; a bad key is empty", () => {
  assert.equal(monthLabel("2026-09", NOW), "September");
  assert.equal(monthLabel("2026-01", NOW), "January");
  assert.equal(monthLabel("2025-09", NOW), "September 2025");
  assert.equal(monthLabel("2027-02", NOW), "February 2027");
  assert.equal(monthLabel("", NOW), "");
  assert.equal(monthLabel("2026-13", NOW), "");
  assert.equal(monthLabel("junk", NOW), "");
  assert.equal(monthLabel(monthKey(new Date().toISOString())), monthLabel(monthKey(new Date().toISOString()), new Date().toISOString()), "now defaults to the clock");
});

test("groupByMonth: newest month first, the order inside a month kept, an unreadable time last", () => {
  const items = [
    { id: "a", at: L(2026, 9, 26) },
    { id: "b", at: L(2026, 9, 20) },
    { id: "c", at: L(2026, 8, 30) },
    { id: "d", at: L(2026, 9, 1) },
    { id: "x", at: "broken" },
    { id: "e", at: L(2025, 12, 24) },
    { id: "f", at: L(2026, 8, 2) },
  ];
  const groups = groupByMonth(items);
  assert.deepEqual(groups.map((g) => g.key), ["2026-09", "2026-08", "2025-12", ""]);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [["a", "b", "d"], ["c", "f"], ["e"], ["x"]]);
  assert.deepEqual(groupByMonth([]), []);
  assert.deepEqual(groupByMonth(null), []);
  assert.deepEqual(groupByMonth([null, 3, { id: "z", at: L(2026, 3, 3) }]).map((g) => g.key), ["2026-03"]);
});

test("capDate and dayWords: \"Sep 26\" and \"Saturday, September 26\" (the year only when it is not this one)", () => {
  assert.equal(capDate(L(2026, 9, 26)), "Sep 26");
  assert.equal(capDate(L(2026, 5, 3)), "May 3");
  assert.equal(capDate("nope"), "");
  assert.equal(capDate(null), "");
  assert.equal(dayWords(L(2026, 9, 26), NOW), "Saturday, September 26");
  assert.equal(dayWords(L(2026, 9, 24), NOW), "Thursday, September 24");
  assert.equal(dayWords(L(2025, 9, 24), NOW), "Wednesday, September 24, 2025");
  assert.equal(dayWords("nope", NOW), "");
});

test("tileLabel, countLabel, spanWords, sentenceCase", () => {
  assert.equal(tileLabel({ at: L(2026, 9, 26), place: "the record store" }, NOW), "Saturday, September 26, the record store");
  assert.equal(tileLabel({ at: L(2026, 9, 26), place: null }, NOW), "Saturday, September 26");
  assert.equal(tileLabel({ at: "bad", place: "  " }, NOW), "Picture");
  assert.equal(countLabel(24, false), "24 pictures");
  assert.equal(countLabel(24, true), "24+ pictures");
  assert.equal(countLabel(1, false), "1 picture");
  assert.equal(countLabel(0, true), "");
  assert.equal(spanWords(L(2026, 9, 24, 9), L(2026, 9, 25, 22)), "Sep 24 -- Sep 25");
  assert.equal(spanWords(L(2026, 9, 24, 9), L(2026, 9, 24, 23)), "Sep 24", "one date on the same day");
  assert.equal(spanWords(L(2026, 9, 24), "bad"), "Sep 24");
  assert.equal(spanWords(null, null), "");
  assert.equal(sentenceCase("seeing each other, early"), "Seeing each other, early");
  assert.equal(sentenceCase("  "), "");
  assert.equal(sentenceCase(null), "");
});

// ------------------------------------------------------------ album.js as text

test("album.js: GET /api/roll 24 at a time, More with &before=, the month hero and the roll tiles", () => {
  assert.ok(albumSrc.includes('"/api/roll?limit=24"'), "the first page asks for 24");
  assert.ok(/ROLL \+ "&before=" \+ encodeURIComponent\(state\.nextBefore\)/.test(albumSrc), "More asks with &before=<nextBefore>");
  assert.ok(albumSrc.includes('"month-hero"'), "builds month-hero");
  assert.ok(albumSrc.includes('"roll-tile"'), "builds roll-tile");
  assert.ok(albumSrc.includes('"month-over display"'), "the month set over the hero");
  assert.ok(albumSrc.includes('"gallery edge"'), "the edge grid");
  assert.ok(albumSrc.includes('"gallery-section"'), "one section per month");
  assert.ok(albumSrc.includes('"play-badge"'), "a clip carries the play badge");
  assert.ok(albumSrc.includes('import { monthKey, monthLabel'), "the months come from months.js");
});

test("album.js: no approval on the Her side, no polaroid, no chips; Save downloads", () => {
  assert.ok(!/polaroid/i.test(albumSrc), "never builds polaroid");
  assert.ok(!albumSrc.includes("/api/images/"), "never calls /api/images/");
  assert.ok(!/\/api\/album\b/.test(albumSrc), "the old album route is gone");
  assert.ok(!/\bchip\(/.test(albumSrc), "no chips");
  assert.ok(!/"(POST|PUT|DELETE)"/.test(albumSrc), "no write");
  assert.ok(!/Approve|Reject/.test(albumSrc), "no decide words");
  assert.ok(albumSrc.includes('?download=1'), "Save uses ?download=1");
  assert.ok(albumSrc.includes('$("lbSave")') && albumSrc.includes('$("lbOpen")'), "Save and Full size are set");
});

test("album.js: the lightbox (click with the default prevented but a middle click kept, arrows, Escape, focus trap) and #<id> from the phone", () => {
  assert.ok(albumSrc.includes("location.hash"), "reads location.hash");
  assert.ok(/const HASH_PAGES = 5;/.test(albumSrc), "at most five more pages to find it");
  assert.ok(albumSrc.includes("ev.preventDefault();\n  open(id, target);"), "a plain click opens the lightbox instead of the file");
  assert.ok(/ev\.button !== 0 \|\| ev\.metaKey \|\| ev\.ctrlKey/.test(albumSrc), "a middle click or a new-tab gesture keeps the link");
  for (const k of ['"Escape"', '"ArrowLeft"', '"ArrowRight"', '"Tab"']) assert.ok(albumSrc.includes(k), "handles " + k);
  for (const id of ["lightbox", "lbClose", "lbPrev", "lbNext", "lbMedia", "lbDate", "lbPlace", "lbSave", "lbOpen", "albumCount", "usSection", "usGrid", "albumMonths", "albumEmpty", "albumOlder"]) {
    assert.ok(albumSrc.includes('"' + id + '"'), "binds #" + id);
  }
  assert.ok(/controls: true, autoplay: true, playsinline: true/.test(albumSrc), "a clip plays with controls, autoplay, playsinline");
  assert.ok(/muted: true, playsinline: true, preload: "none"/.test(albumSrc), "a clip with no poster is a muted inline video, not preloaded");
  assert.ok(albumSrc.includes('classList.add("loaded")'), "img.loaded and video.loaded");
  assert.ok(/back\.focus\(\)/.test(albumSrc), "focus goes back to the tile");
});

// ------------------------------------------------------------ us.js as text

test("us.js: one GET of /api/us, avelie.conversation for a chapter or a kept line, no write, none of the writer's files", () => {
  assert.ok(usSrc.includes('api("GET", "/api/us")'), "reads /api/us");
  assert.ok(usSrc.includes('"avelie.conversation"'), "stores avelie.conversation");
  assert.ok(!/\b(POST|PUT|DELETE)\b/.test(usSrc), "no POST, PUT or DELETE");
  for (const w of ["knows", "guesses", "reads", "untold"]) assert.ok(!new RegExp("\\b" + w + "\\b", "i").test(usSrc), "never reads " + w);
  assert.ok(!/polaroid|\/api\/images\//.test(usSrc));
  for (const id of ["usStanding", "usSince", "usNames", "chaptersSection", "usChapters", "momentsSection", "usMoments", "placesSection", "usPlaces", "keptSection", "usKept"]) {
    assert.ok(usSrc.includes('"' + id + '"'), "binds #" + id);
  }
});

// ------------------------------------------------------------ the shared promises

// Section 9's Album and Us names, the shell names the lane may use, and the ones app.css
// had before the pass (.hidden). A class built by these scripts must be one of them.
const ALLOWED = new Set([
  "gallery-section", "us-row", "gallery", "edge", "roll-tile", "clip", "month-hero", "month-over", "cap-date", "cap-place", "play-badge", "loaded",
  "lightbox", "lightbox-media", "lightbox-cap", "lightbox-actions", "lb-close", "lb-prev", "lb-next",
  "us-page", "us-hero", "us-standing", "us-since", "us-names", "us-section", "chapter-list", "chapter-card", "chapter-title", "chapter-when",
  "moments", "moment", "moment-when", "moment-title", "places-together", "place-together", "place-thumb", "place-name", "place-first", "place-times",
  "kept-quotes", "kept-quote", "kept-text", "kept-when", "display", "kicker", "hidden",
]);

test("album.js and us.js build only the classes of section 9 (and .hidden)", () => {
  for (const [name, src] of [["album.js", albumSrc], ["us.js", usSrc]]) {
    const built = [];
    for (const m of src.matchAll(/class: "([^"]+)"/g)) built.push(...m[1].split(/\s+/));
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle|contains)\("([^"]+)"/g)) built.push(m[1]);
    for (const m of src.matchAll(/classes\.push\("([^"]+)"\)/g)) built.push(m[1]);
    for (const m of src.matchAll(/const classes = \["([^"]+)"\]/g)) built.push(m[1]);
    assert.ok(built.length > 3, name + " builds classes");
    for (const c of built) assert.ok(ALLOWED.has(c), name + ": class ." + c + " is in the vocabulary");
  }
});

test("the three files: typography clean, no style attribute, no inline markup, no machinery word in a visible string", () => {
  for (const [name, src] of [["album.js", albumSrc], ["us.js", usSrc], ["months.js", monthsSrc]]) {
    assert.ok(!BAD_TYPOGRAPHY.test(src), name + " typography");
    assert.ok(!/setAttribute\("style"|\.style\.|cssText|innerHTML|insertAdjacentHTML/.test(src), name + " writes no style and parses no markup");
    const visible = [];
    for (const m of src.matchAll(/text: "([^"]*)"/g)) visible.push(m[1]);
    for (const m of src.matchAll(/"(first on |since | times| pictures?| picture)"/g)) visible.push(m[1]);
    for (const v of visible) {
      assert.ok(!/\b(proposal|version|seq|id|model|prompt|flag|json|phase|weight|none)\b/i.test(v), name + ": " + v);
    }
  }
});

// ------------------------------------------------------------ built for real, on a stand-in document

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) { super(); this.textContent = String(t); this.children = []; }
}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = {};
    this.className = "";
    const el = this;
    this.classList = {
      list: () => el.className.split(/\s+/).filter(Boolean),
      contains: (c) => el.classList.list().includes(c),
      add: (c) => { if (!el.classList.contains(c)) el.className = [...el.classList.list(), c].join(" "); },
      remove: (c) => { el.className = el.classList.list().filter((x) => x !== c).join(" "); },
      toggle: (c, on) => { const want = on === undefined ? !el.classList.contains(c) : Boolean(on); if (want) el.classList.add(c); else el.classList.remove(c); return want; },
    };
  }
  get textContent() { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = v === "" ? [] : [new FakeText(v)]; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(n)); }
  replaceChildren() { this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
}
const registry = new Map();
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeEl(tag),
  createTextNode: (t) => new FakeText(t),
  getElementById: (id) => registry.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

function all(el, pred, out = []) {
  if (el instanceof FakeEl) {
    if (pred(el)) out.push(el);
    for (const c of el.children) all(c, pred, out);
  }
  return out;
}
const byClass = (root, c) => all(root, (e) => e.classList.contains(c));

const album = await import("../../public/js/album.js");
const us = await import("../../public/js/us.js");

test("album tileFor: a photo, a clip with its poster, a clip without one, and a month hero", () => {
  const photo = album.tileFor({ id: "img_1", kind: "photo", url: "/media/img_1", poster: null, at: L(2026, 9, 26), place: "the record store", us: false }, false);
  assert.equal(photo.tagName, "A");
  assert.equal(photo.className, "roll-tile");
  assert.equal(photo.getAttribute("href"), "/media/img_1");
  assert.equal(photo.getAttribute("data-id"), "img_1");
  assert.match(photo.getAttribute("aria-label"), /, September 26, the record store$/);
  const img = photo.children[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.src, "/media/img_1");
  assert.equal(img.getAttribute("loading"), "lazy");
  assert.equal(img.getAttribute("decoding"), "async");
  assert.equal(img.getAttribute("alt"), "");
  assert.ok(!img.classList.contains("loaded"));
  img.fire("load");
  assert.ok(img.classList.contains("loaded"), "img.loaded on load");
  assert.equal(photo.textContent, "", "nothing written on a tile");

  const clip = album.tileFor({ id: "vid_1", kind: "clip", url: "/media/vid_1", poster: "/media/img_src", at: L(2026, 9, 25), place: null, us: false }, false);
  assert.equal(clip.className, "roll-tile clip");
  assert.equal(clip.children[0].tagName, "IMG");
  assert.equal(clip.children[0].src, "/media/img_src", "the poster stands in for the clip");
  assert.equal(byClass(clip, "play-badge").length, 1);
  assert.equal(byClass(clip, "play-badge")[0].getAttribute("aria-hidden"), "true");

  const bare = album.tileFor({ id: "vid_2", kind: "clip", url: "/media/vid_2", poster: null, at: L(2026, 9, 25), place: null, us: false }, false);
  const v = bare.children[0];
  assert.equal(v.tagName, "VIDEO");
  assert.equal(v.getAttribute("preload"), "none");
  assert.equal(v.getAttribute("muted"), "");
  assert.equal(v.getAttribute("playsinline"), "");
  assert.equal(v.muted, true);

  const hero = album.tileFor({ id: "img_9", kind: "photo", url: "/media/img_9", poster: null, at: L(2026, 9, 26), place: null, us: false }, true);
  assert.equal(hero.className, "roll-tile month-hero");
  const over = byClass(hero, "month-over");
  assert.equal(over.length, 1);
  assert.ok(over[0].classList.contains("display"));
  assert.equal(album.mediaUrl("img_1", true), "/media/img_1?download=1");
});

function usDom() {
  registry.clear();
  for (const id of ["usStanding", "usSince", "usNames", "chaptersSection", "usChapters", "momentsSection", "usMoments", "placesSection", "usPlaces", "keptSection", "usKept"]) {
    const el = new FakeEl(id.endsWith("Section") ? "section" : "div");
    el.className = id.endsWith("Section") || ["usStanding", "usSince", "usNames"].includes(id) ? "hidden" : "";
    registry.set(id, el);
  }
  return (id) => registry.get(id);
}

const VIEW = {
  since: L(2026, 9, 24, 20),
  standing: "seeing each other, early",
  nicknames: ["Starbrite", "trouble"],
  chapters: [
    { id: "c_1", title: "The bench", from: L(2026, 9, 24, 20), to: L(2026, 9, 25, 9) },
    { id: "c_2", title: "Breakfast on Exchange Street", from: L(2026, 9, 25, 15), to: L(2026, 9, 25, 17) },
  ],
  moments: [
    { id: "h_1", title: "first kiss at the record store", at: L(2026, 9, 24, 22) },
    { id: "h_2", title: "she sang for him", at: null },
  ],
  places: [
    { title: "the record store", first: L(2026, 9, 26), times: 3, placeId: "pl_1", picture: true },
    { title: "the bench", first: L(2026, 9, 24), times: 1, placeId: "pl_2", picture: false },
    ...Array.from({ length: 6 }, (_, i) => ({ title: "place " + i, first: L(2026, 9, 26), times: 1, placeId: "pl_x" + i, picture: true })),
  ],
  kept: [{ id: "m_1", text: "that was sweet by the way.", at: L(2026, 9, 25, 17), conversationId: "c_2" }],
};

test("us render: the standing in sentence case, since, her names; chapters, moments, places and kept lines as the contract builds them", () => {
  const $ = usDom();
  us.render(VIEW);
  assert.equal($("usStanding").textContent, "Seeing each other, early");
  assert.ok(!$("usStanding").classList.contains("hidden"));
  assert.equal($("usSince").textContent, "since Thursday, September 24");
  assert.equal($("usNames").textContent, "Starbrite / trouble");

  assert.ok(!$("chaptersSection").classList.contains("hidden"));
  const cards = byClass($("usChapters"), "chapter-card");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute("href"), "/");
  assert.equal(cards[0].getAttribute("data-id"), "c_1");
  assert.equal(byClass(cards[0], "chapter-title")[0].textContent, "The bench");
  assert.equal(byClass(cards[0], "chapter-when")[0].textContent, "Sep 24 -- Sep 25");
  assert.equal(byClass(cards[1], "chapter-when")[0].textContent, "Sep 25", "one date on the same day");
  cards[1].fire("click");
  assert.equal(store.get("avelie.conversation"), "c_2", "a chapter tap stores its conversation");

  const moments = byClass($("usMoments"), "moment");
  assert.equal(moments.length, 2);
  assert.equal(moments[0].children[0].tagName, "TIME");
  assert.equal(moments[0].children[0].textContent, "Sep 24");
  assert.equal(byClass(moments[1], "moment-when").length, 0, "no at, no time element");
  assert.equal(byClass(moments[1], "moment-title")[0].textContent, "she sang for him");

  const places = byClass($("usPlaces"), "place-together");
  assert.equal(places.length, 8);
  assert.equal(byClass(places[0], "place-thumb")[0].getAttribute("src"), "/media/place/pl_1");
  assert.equal(byClass(places[0], "place-name")[0].textContent, "the record store");
  assert.equal(byClass(places[0], "place-first")[0].textContent, "first on Sep 26");
  assert.equal(byClass(places[0], "place-times")[0].textContent, "3 times");
  assert.equal(byClass(places[1], "place-thumb").length, 0, "no picture, no thumbnail");
  assert.equal(byClass(places[1], "place-times").length, 0, "once is not a count");
  assert.equal(byClass($("usPlaces"), "place-thumb").length, 5, "thumbnails only in the first six rows");

  const kept = byClass($("usKept"), "kept-quote");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tagName, "A");
  assert.equal(kept[0].getAttribute("data-conversation"), "c_2");
  assert.equal(kept[0].children[0].tagName, "BLOCKQUOTE");
  assert.equal(kept[0].children[0].className, "kept-text");
  assert.equal(kept[0].children[1].className, "kicker kept-when");
  assert.equal(kept[0].children[1].textContent, "Sep 25");
  store.clear();
  kept[0].fire("click");
  assert.equal(store.get("avelie.conversation"), "c_2", "a kept line opens its chapter");
});

test("us render: every section and line stays hidden while empty; nothing invented", () => {
  const $ = usDom();
  us.render({ since: null, standing: null, nicknames: [], chapters: [], moments: [], places: [], kept: [] });
  for (const id of ["usStanding", "usSince", "usNames", "chaptersSection", "momentsSection", "placesSection", "keptSection"]) {
    assert.ok($(id).classList.contains("hidden"), id + " hidden");
  }
  assert.equal($("usStanding").textContent, "");
  us.render(null);
  assert.ok($("chaptersSection").classList.contains("hidden"));
  us.render({ chapters: [{ id: "c", title: "  ", from: null, to: null }], kept: [{ text: "", at: null, conversationId: "c" }] });
  assert.ok($("chaptersSection").classList.contains("hidden"), "a blank title is no chapter");
  assert.ok($("keptSection").classList.contains("hidden"), "an empty line is no quote");
});
