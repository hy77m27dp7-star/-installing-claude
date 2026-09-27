// The experience pass, Studio lane (DESIGN_EXPERIENCE 7 and 10.2), read as text: the five
// Studio scripts touch `document` at import, so none is imported here. Timeline words first
// with the log behind a remembered switch; the Record's human fields, words-first Inbox and
// named transcripts with every review_v5 line kept; the Places tab on Pictures; the grouped
// Settings form's invalid handler and the System group's width check; Memory's kept-today
// words; no "none" chip in any of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const FILES = ["public/js/state.js", "public/js/model.js", "public/js/images.js", "public/js/timeline.js", "public/js/memory.js"];
const js = Object.fromEntries(FILES.map((p) => [p, read(p)]));
const state = js["public/js/state.js"];
const model = js["public/js/model.js"];
const images = js["public/js/images.js"];
const timeline = js["public/js/timeline.js"];
const memory = js["public/js/memory.js"];

test("timeline.js: words first from `story`, the log behind #logToggle, remembered as avelie.timelineLog", () => {
  assert.match(timeline, /i\.story/);
  assert.ok(timeline.includes('$("logToggle")'));
  assert.ok(timeline.includes('"avelie.timelineLog"'));
  assert.match(timeline, /storeSet\(LOG_KEY/);
  assert.match(timeline, /storeGet\(LOG_KEY\) === "1"/);
  for (const cls of ["story-line", "story-when", "story-text"]) assert.ok(timeline.includes('"' + cls + '"'), cls);
  // The log view keeps today's rows; there is no .log-line class.
  assert.ok(timeline.includes('"list-row"') && timeline.includes('"photo-row"'));
  assert.ok(!timeline.includes("log-line"));
  // The kind filter stays.
  assert.ok(timeline.includes('$("kindFilter")'));
  // Only items with words show by default; the log shows every item.
  assert.match(timeline, /state\.log \? ofKind : ofKind\.filter\(\(i\) => storyOf\(i\)\)/);
});

test("state.js: the human fields fill #relFields and #sceneFields, synced both ways with the JSON box", () => {
  assert.ok(state.includes('fields: "relFields"'));
  assert.ok(state.includes('fields: "sceneFields"'));
  for (const label of ["Where you stand", "His name", "Nicknames", "Trust", "Affection", "Attraction", "Private language", "Summary", "Place", "Time", "Who is there"]) {
    assert.ok(state.includes('"' + label + '"'), label);
  }
  for (const key of ["status", "his_name", "nicknames", "trust", "affection", "attraction", "private_language", "summary", "location", "time", "present"]) {
    assert.ok(state.includes('key: "' + key + '"'), key);
  }
  assert.ok(state.includes('["together", "Together"], ["apart", "Apart"]'), "the Together / Apart pair");
  // Fields write into the JSON box; the JSON box writes back into the fields.
  assert.match(state, /\$\(ed\.json\)\.value = JSON\.stringify\(obj, null, 2\)/);
  assert.match(state, /\$\(ed\.json\)\.addEventListener\("input", \(\) => syncFields\(ed, false\)\)/);
  // Save still goes through the same PUT from the JSON box.
  assert.ok(state.includes('api("PUT", "/api/state/" + ed.entity'));
});

test("state.js: transcripts and checks name a conversation by displayTitle, never \"chat\"", () => {
  assert.ok(state.includes("c.displayTitle || c.title"));
  assert.ok(!state.includes('(c.title || "chat")'));
  assert.ok(!/"chat"\s*\)/.test(state));
  const exp = state.slice(state.indexOf("async function loadExport()"), state.indexOf("async function exportTranscript("));
  assert.match(exp, /convName\(c\)/);
  const checks = state.slice(state.indexOf("async function loadChecks()"), state.indexOf("// ------------------------------------------------------------ weights"));
  assert.match(checks, /convName\(c\)/);
});

test("state.js: the Inbox reads as words: the kind as a kicker, payload as labelled lines, raw JSON under Advanced", () => {
  const card = state.slice(state.indexOf("function proposalCard(p)"), state.indexOf("function payloadText("));
  assert.match(card, /class: "kicker grow", text: KIND_LABEL\[p\.kind\]/);
  assert.match(card, /payloadLabel\(k\) \+ ": "/);
  assert.match(card, /h\("details", \{ class: "advanced" \}/);
  assert.match(card, /h\("summary", \{ text: "Advanced" \}\)/);
  assert.ok(!/chip\(k \+ " "/.test(card), "no key value chips");
  for (const b of ['"Approve"', '"Edit"', '"Reject"']) assert.ok(card.includes(b), b);
  assert.ok(state.includes('location: "Place"'));
  assert.ok(state.includes('"Nothing waiting"'));
  assert.ok(state.includes('"No questions"'));
});

test("state.js: every line review_v5 reads is still there", () => {
  assert.match(state, /if \(until === null\) remove\.push\("cooling_off_set_at", "cooling_off_hours"\)/);
  assert.match(state, /const cooling = live \? live\.coolingOff === true : coolingLocal\(st\)/);
  assert.match(state, /const phase = live \? \(typeof live\.friction === "string"/);
  assert.match(state, /if \(guess\) body\.inferred = guess\.checked;/);
  const load = state.slice(state.indexOf("async function loadWants()"), state.indexOf("function progressBar("));
  assert.match(load, /loadSettingsOnce\(\)/);
  assert.match(load, /\/api\/beats\?status=all/);
  assert.match(load, /lifeTz = settings\.timezone/);
  assert.match(state, /if \(variants\.missingNote\(\)\) \{ flash\(slot, "note", "danger"\); return; \}/);
  // The twelve tabs, found across the four grouped div.tabs, with hash routing.
  assert.ok(state.includes('const TABS = ["now", "life", "wants", "history", "facts", "memory", "voice", "notes", "unknowns", "inbox", "rulebook", "export"];'));
  assert.ok(state.includes('document.querySelectorAll(".tabs button")'));
  assert.ok(state.includes('window.addEventListener("hashchange"'));
});

test("images.js: the Places tab reads /api/places, pins by hand, geocodes, makes pictures, lists the unpinned first", () => {
  assert.ok(images.includes('const TABS = ["photos", "clips", "portraits", "library", "places"];'));
  assert.match(images, /else if \(name === "places"\) loadPlaces\(\);/);
  assert.ok(images.includes('api("GET", "/api/places")'));
  assert.ok(images.includes('"/geocode"'));
  assert.ok(images.includes('"/picture"'));
  assert.ok(images.includes('geocodedBy: "owner"'));
  assert.ok(images.includes('"Not on the map"'));
  assert.ok(images.includes('"Save pin"'));
  for (const t of ['"Make picture"', '"Remake"', '"Remove picture"', '"Geocode"']) assert.ok(images.includes(t), t);
  assert.ok(!images.includes("Set on map"), "the map pin is dropped");
  assert.ok(images.includes('"place-row"'));
  for (const id of ["placesAdmin", "placeTitle", "placeDetail", "placeAdd", "placeAddStatus"]) assert.ok(images.includes('$("' + id + '")'), id);
  // The snake_case row the route answers.
  for (const k of ["p.geocoded_by", "p.picture_light", "p.picture_season", "p.last_used_at", "p.active", "p.picture"]) assert.ok(images.includes(k), k);
  // The unpinned come first.
  const render = images.slice(images.indexOf("function renderPlaces("), images.indexOf("async function loadPlaces("));
  assert.ok(render.indexOf('"Not on the map"') < render.indexOf('"On the map"'));
  // The existing ids stay bound.
  assert.ok(images.includes('$("avatarPick")') && images.includes('$("callFaceCard")'));
  // A missing panel never breaks the tab switch.
  assert.match(images, /if \(panel\) panel\.classList\.toggle\("hidden", t !== name\)/);
});

test("model.js: invalid in the capture phase opens the details around the field; the System group opens by width", () => {
  assert.ok(model.includes('form.addEventListener("invalid", onInvalid, true)'));
  const on = model.slice(model.indexOf("function onInvalid(e)"), model.indexOf('form.addEventListener("invalid"'));
  assert.match(on, /el\.closest\("details"\)/);
  assert.match(on, /d\.open = true/);
  assert.match(on, /scrollIntoView\(\{ block: "center" \}\)/);
  assert.match(on, /\.focus\(/);
  assert.match(on, /validationMessage/);
  assert.match(on, /\$\("settings-status"\)/);
  assert.ok(model.includes('matchMedia("(min-width: 761px)")'));
  assert.ok(model.includes('$("group-system")'));
  assert.ok(model.includes('querySelector("details.advanced")'));
  // Bindings unchanged.
  for (const s of ["const FIELDS = [", "e.submitter", 'querySelector("[data-save-status]")', "/api/nightly/run"]) assert.ok(model.includes(s), s);
  assert.ok(/force:\s*true/.test(model));
  assert.ok(/\bNUMERIC\b/.test(model) && /\bBOOL\b/.test(model));
});

test("memory.js: the routes and rows it keeps; kept today as words; empty lists as a quiet label", () => {
  for (const s of ["/retire", "/api/known-artists", "view-row"]) assert.ok(memory.includes(s), s);
  for (const id of ["memoryStatus", "memoryLegend", "memoryFacts", "memoryFading", "memoryReturned", "memoryHistory", "memorySealed", "memoryViews", "memoryArtists", "memoryKept"]) {
    assert.ok(memory.includes('$("' + id + '")'), id);
  }
  const kept = memory.slice(memory.indexOf("function keptRow(p)"), memory.indexOf("function renderKept("));
  assert.match(kept, /class: "kicker", text: KIND_WORDS\[kind\]/);
  assert.match(kept, /p\.proposal/);
  assert.match(kept, /fmtTime\(p\.decidedAt\)/);
  assert.ok(!/chip\(String\(p\.kind/.test(kept), "no kind chip");
  assert.ok(memory.includes('"empty-label"'));
});

test("no Studio script renders a \"none\" chip; each shows .empty-label instead; typography clean", () => {
  for (const [p, text] of Object.entries(js)) {
    assert.ok(!text.includes('chip("none")'), p);
    assert.ok(text.includes("empty-label"), p + " empty-label");
    assert.ok(!BAD_TYPOGRAPHY.test(text), p + " typography");
    assert.ok(!/\.setAttribute\("style"|\bstyle:\s*"/.test(text), p + " style attribute");
  }
});
