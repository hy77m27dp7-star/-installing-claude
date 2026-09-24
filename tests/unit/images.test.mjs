// parsePhotoMarker: the "[photo: ...]" line that asks for a candidate image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const { parsePhotoMarker } = await loadSrc("images");

test("marker on the final line: description returned, marker removed, whitespace trimmed", () => {
  const r = parsePhotoMarker("ok fine, one. do not judge the lighting\n[photo: mirror selfie in a black hoodie, messy bun, lamp light, half smile]\n\n");
  assert.equal(r.description, "mirror selfie in a black hoodie, messy bun, lamp light, half smile");
  assert.equal(r.clean, "ok fine, one. do not judge the lighting");
});

test("marker on its own line mid-text: stripped, the line goes, the description counts", () => {
  const r = parsePhotoMarker("first line\n[photo: something]\nsecond line");
  assert.equal(r.description, "something");
  assert.equal(r.clean, "first line\nsecond line");
});

test("marker inline after prose: the prose stays, the marker goes", () => {
  const r = parsePhotoMarker("fine. [photo: me on the couch, hoodie, no makeup]");
  assert.equal(r.description, "me on the couch, hoodie, no makeup");
  assert.equal(r.clean, "fine.");
});

test("marker first, prose after: the prose stays", () => {
  const r = parsePhotoMarker("[photo: mirror selfie, black hoodie]\nok dont judge the lighting");
  assert.equal(r.description, "mirror selfie, black hoodie");
  assert.equal(r.clean, "ok dont judge the lighting");
});

test("marker with a trailing period is still a marker", () => {
  const r = parsePhotoMarker("ok sent\n[photo: couch, hoodie].");
  assert.equal(r.description, "couch, hoodie");
  assert.equal(r.clean, "ok sent");
});

test("no marker: text unchanged, description null", () => {
  const r = parsePhotoMarker("hello there.");
  assert.equal(r.description, null);
  assert.equal(r.clean, "hello there.");
});

test("two markers: the final one is the description, the other is stripped", () => {
  const r = parsePhotoMarker("a\n[photo: first]\nb\n[photo: second]");
  assert.equal(r.description, "second");
  assert.equal(r.clean, "a\nb");
  assert.ok(!r.clean.includes("[photo:"));
});

test("marker is case-insensitive and tolerates surrounding spaces", () => {
  const r = parsePhotoMarker("look\n  [PHOTO:   the couch, lamp on  ]  ");
  assert.equal(r.description, "the couch, lamp on");
  assert.equal(r.clean, "look");
});

test("a marker-only reply leaves empty clean text", () => {
  const r = parsePhotoMarker("[photo: just this]");
  assert.equal(r.description, "just this");
  assert.equal(r.clean, "");
});

test("a bracket that is not a photo marker is left alone", () => {
  const r = parsePhotoMarker("i wrote [note: remember milk] on my hand");
  assert.equal(r.description, null);
  assert.equal(r.clean, "i wrote [note: remember milk] on my hand");
});
