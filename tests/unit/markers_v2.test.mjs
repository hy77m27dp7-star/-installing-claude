// src/markers.ts: the song marker, both markers together, and the photo re-export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, EN_DASH, EM_DASH } from "./helpers.mjs";

const markers = await loadSrc("markers");
const images = await loadSrc("images");
const { parseSongMarker, stripMarkers, parsePhotoMarker } = markers;

const SEARCH = "https://open.spotify.com/search/";

test("parsePhotoMarker lives in markers.ts and images.ts re-exports the same function", () => {
  assert.equal(typeof parsePhotoMarker, "function");
  assert.equal(images.parsePhotoMarker, parsePhotoMarker);
});

test("parseSongMarker: a final [song: Artist - Title] line becomes artist, title and a Spotify search url", () => {
  const r = parseSongMarker("this one. do not skip the bridge\n[song: Adrianne Lenker - anything]");
  assert.deepEqual(r.song, { artist: "Adrianne Lenker", title: "anything", searchUrl: SEARCH + encodeURIComponent("Adrianne Lenker anything") });
  assert.equal(r.clean, "this one. do not skip the bridge");
  assert.ok(!r.clean.includes("[song:"));
});

test("parseSongMarker: the url is search only (no track id) and is encoded", () => {
  const r = parseSongMarker("[song: Big Thief - Not (live)]");
  assert.ok(r.song.searchUrl.startsWith(SEARCH));
  assert.ok(!r.song.searchUrl.includes(" "));
  assert.equal(decodeURIComponent(r.song.searchUrl.slice(SEARCH.length)), "Big Thief Not (live)");
});

test("parseSongMarker: separators (hyphen, double hyphen, en dash, em dash) all split artist from title", () => {
  for (const sep of [" - ", " -- ", " " + EN_DASH + " ", " " + EM_DASH + " "]) {
    const r = parseSongMarker("ok\n[song: Mitski" + sep + "Nobody]");
    assert.equal(r.song?.artist, "Mitski", "sep " + JSON.stringify(sep));
    assert.equal(r.song?.title, "Nobody");
  }
});

test("parseSongMarker: a hyphen inside a name without spaces is not a separator", () => {
  const r = parseSongMarker("[song: Jay-Z - Encore]");
  assert.equal(r.song.artist, "Jay-Z");
  assert.equal(r.song.title, "Encore");
});

test("parseSongMarker: case-insensitive, tolerates spaces, trailing period", () => {
  const r = parseSongMarker("listen\n  [SONG:   Phoebe Bridgers  -  Motion Sickness  ]  .");
  assert.equal(r.song.artist, "Phoebe Bridgers");
  assert.equal(r.song.title, "Motion Sickness");
  assert.equal(r.clean, "listen");
});

test("parseSongMarker: no separator or a missing half is not a song, but the marker still goes", () => {
  for (const text of ["hm\n[song: just a title]", "hm\n[song: - Title]", "hm\n[song: Artist - ]", "hm\n[song: ]"]) {
    const r = parseSongMarker(text);
    assert.equal(r.song, null, text);
    assert.equal(r.clean, "hm");
  }
});

test("parseSongMarker: no marker leaves the text alone", () => {
  const r = parseSongMarker("no song today.");
  assert.equal(r.song, null);
  assert.equal(r.clean, "no song today.");
});

test("parseSongMarker: inline after prose keeps the prose; two markers, the last wins, both stripped", () => {
  const inline = parseSongMarker("this. [song: Sufjan Stevens - Fourth of July]");
  assert.equal(inline.clean, "this.");
  assert.equal(inline.song.title, "Fourth of July");
  const two = parseSongMarker("a\n[song: A - One]\nb\n[song: B - Two]");
  assert.equal(two.song.artist, "B");
  assert.equal(two.clean, "a\nb");
});

test("parseSongMarker: a bracket that is not a song marker is left alone", () => {
  const r = parseSongMarker("i wrote [note: buy rice] on my hand");
  assert.equal(r.song, null);
  assert.equal(r.clean, "i wrote [note: buy rice] on my hand");
});

test("parseSongMarker: never splits or keeps a newline inside the marker value", () => {
  const r = parseSongMarker("[song: Artist\n- Title]");
  assert.equal(r.song, null);
});

test("stripMarkers: photo and song together, both stripped, both returned", () => {
  const r = stripMarkers("fine, one.\n[photo: couch, hoodie, lamp light]\nand this\n[song: Alex G - Runner]");
  assert.equal(r.photo, "couch, hoodie, lamp light");
  assert.equal(r.song.artist, "Alex G");
  assert.equal(r.song.title, "Runner");
  assert.equal(r.clean, "fine, one.\nand this");
  assert.ok(!/\[(?:photo|song):/i.test(r.clean));
});

test("stripMarkers: neither marker -> nulls and the text unchanged", () => {
  const r = stripMarkers("just words");
  assert.deepEqual(r, { clean: "just words", photo: null, song: null });
});

test("stripMarkers: a marker-only reply leaves empty clean text (the turn refuses it)", () => {
  const r = stripMarkers("[song: X - Y]");
  assert.equal(r.clean, "");
  assert.equal(r.song.artist, "X");
});
