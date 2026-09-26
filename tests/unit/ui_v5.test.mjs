// The v5 interface (SPEC_V5 sections 1 to 9, lane L9), read as text: the new ids on the four
// pages, the song card's two buttons, the State page's calls to the v5 routes, the twenty
// settings on the Model page, the stylesheet's new classes with the one accent, no style
// attribute, no inline script, clean typography.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { repoText, V5_SETTINGS_TABLE } from "./helpers_v5.mjs";

const PAGES = ["public/index.html", "public/state.html", "public/memory.html", "public/model.html"];
const SCRIPTS = ["public/js/chat.js", "public/js/state.js", "public/js/memory.js", "public/js/model.js"];
const html = Object.fromEntries(PAGES.map((p) => [p, repoText(p)]));
const js = Object.fromEntries(SCRIPTS.map((p) => [p, repoText(p)]));
const css = repoText("public/css/app.css");
const hasId = (text, id) => new RegExp('id="' + id + '"').test(text);

test("memory.html: Her read (#memoryViews) and His ears (#memoryArtists)", () => {
  assert.ok(hasId(html["public/memory.html"], "memoryViews"));
  assert.ok(hasId(html["public/memory.html"], "memoryArtists"));
});

test("model.html: the Story card and the Nightly card with its run button and runs list", () => {
  for (const id of ["storyCard", "nightlyCard", "nightlyRun", "nightlyRuns"]) assert.ok(hasId(html["public/model.html"], id), id);
});

test("index.html: the held clock chip", () => {
  assert.ok(hasId(html["public/index.html"], "clockChip"));
});

test("chat.js: the song card's two buttons and the clock read", () => {
  const chat = js["public/js/chat.js"];
  assert.ok(chat.includes("song-feedback"));
  assert.ok(chat.includes("know it"));
  assert.ok(chat.includes("not for me"));
  assert.ok(chat.includes("/song-feedback"));
  assert.ok(chat.includes("/api/clock"));
  assert.ok(chat.includes("/api/known-artists"));
});

test("state.js calls the beats, world and rename routes", () => {
  const state = js["public/js/state.js"];
  assert.ok(state.includes("/beats"));
  assert.ok(state.includes("/api/world"));
  assert.ok(state.includes("/rename"));
});

test("memory.js: retire a read and the artists list", () => {
  const memory = js["public/js/memory.js"];
  assert.ok(memory.includes("/retire"));
  assert.ok(memory.includes("/api/known-artists"));
  assert.ok(memory.includes("view-row"));
});

test("model.js and model.html carry every one of the twenty settings; the Nightly card posts a forced run", () => {
  const model = js["public/js/model.js"];
  for (const key of Object.keys(V5_SETTINGS_TABLE)) {
    assert.ok(model.includes('"' + key + '"'), "model.js " + key);
    assert.ok(new RegExp('id="' + key + '"|name="' + key + '"|data-key="' + key + '"').test(html["public/model.html"]), "model.html " + key);
  }
  assert.ok(model.includes("/api/nightly/run"));
  assert.ok(/force:\s*true/.test(model));
});

test("app.css: the v5 classes with the tokens that exist; the one accent unchanged", () => {
  for (const sel of [".beat-row", ".view-row", ".artist-row", ".song-feedback", ".chip.guess", "#clockChip"]) assert.ok(css.includes(sel), sel);
  assert.ok(/--accent-solid: #22d3ee/.test(css));
});

test("no page carries a style attribute or an inline script; every page and script is typography clean", () => {
  for (const p of PAGES) {
    const text = html[p];
    assert.ok(text.length > 0, p + " present");
    assert.ok(!/\sstyle\s*=\s*["']/.test(text), p + " has a style attribute");
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(text), p + " has an inline script");
    assert.ok(!BAD_TYPOGRAPHY.test(text), p);
  }
  for (const s of SCRIPTS) assert.ok(!BAD_TYPOGRAPHY.test(js[s]), s);
  assert.ok(!BAD_TYPOGRAPHY.test(css));
});
