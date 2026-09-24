// The [voice] and [media: <title>] markers (SPEC_V2 sections S and V): parsed and
// stripped the way the photo and song markers are. parseVoiceMarker lives in src/voice.ts,
// parseMediaMarker in src/media.ts (the L7 contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const voice = await loadSrc("voice");
const media = await loadSrc("media");
const { parseVoiceMarker } = voice;
const { parseMediaMarker } = media;

// The flag / title field may carry one of a few names; the first present is read.
const field = (obj, names) => {
  for (const n of names) if (obj && obj[n] !== undefined) return obj[n];
  return undefined;
};
const voiceFlag = (r) => field(r, ["voice", "wantsVoice", "marker", "found", "present"]);
const mediaTitle = (r) => field(r, ["title", "media", "description", "name"]);

test("both parsers are exported functions", () => {
  assert.equal(typeof parseVoiceMarker, "function", "src/voice.ts must export parseVoiceMarker(text)");
  assert.equal(typeof parseMediaMarker, "function", "src/media.ts must export parseMediaMarker(text)");
});

// ------------------------------------------------------------------ [voice]

test("parseVoiceMarker: a final [voice] line is stripped and reported", () => {
  const r = parseVoiceMarker("i would rather say this than type it\n[voice]");
  assert.equal(r.clean, "i would rather say this than type it");
  assert.ok(voiceFlag(r) === true, "voice flag: " + JSON.stringify(r));
});

test("parseVoiceMarker: no marker -> unchanged, not a voice note", () => {
  const r = parseVoiceMarker("typed like always.");
  assert.equal(r.clean, "typed like always.");
  assert.ok(!voiceFlag(r), JSON.stringify(r));
});

test("parseVoiceMarker: case-insensitive, inline after prose, trailing period tolerated", () => {
  const a = parseVoiceMarker("ok. [VOICE]");
  assert.equal(a.clean, "ok.");
  assert.ok(voiceFlag(a) === true);
  const b = parseVoiceMarker("ok\n[voice].");
  assert.equal(b.clean, "ok");
  assert.ok(voiceFlag(b) === true);
});

test("parseVoiceMarker: a bracket that is not the marker is left alone", () => {
  const r = parseVoiceMarker("she said [voices] in her head, plural");
  assert.ok(!voiceFlag(r), JSON.stringify(r));
  assert.equal(r.clean, "she said [voices] in her head, plural");
});

// ------------------------------------------------------------------ [media: title]

test("parseMediaMarker: a final [media: title] line is stripped and the title returned as written", () => {
  const r = parseMediaMarker("this is the one from the fire escape\n[media: fire escape take 2]");
  assert.equal(r.clean, "this is the one from the fire escape");
  assert.equal(mediaTitle(r), "fire escape take 2");
});

test("parseMediaMarker: no marker -> unchanged, no title", () => {
  const r = parseMediaMarker("nothing to send.");
  assert.equal(r.clean, "nothing to send.");
  const t = mediaTitle(r);
  assert.ok(t === null || t === undefined || t === "", JSON.stringify(r));
});

test("parseMediaMarker: case-insensitive marker, spaces trimmed, two markers -> the last wins and both go", () => {
  const a = parseMediaMarker("look\n  [MEDIA:   the laundromat clip  ]  ");
  assert.equal(a.clean, "look");
  assert.equal(mediaTitle(a), "the laundromat clip");
  const b = parseMediaMarker("a\n[media: first]\nb\n[media: second]");
  assert.equal(mediaTitle(b), "second");
  assert.equal(b.clean, "a\nb");
});

test("parseMediaMarker: an empty title is no title, the marker still goes", () => {
  const r = parseMediaMarker("hm\n[media: ]");
  assert.equal(r.clean, "hm");
  const t = mediaTitle(r);
  assert.ok(!t, JSON.stringify(r));
});

test("parseMediaMarker: photo and song markers are not media markers", () => {
  const r = parseMediaMarker("x\n[photo: couch]\n[song: A - B]");
  assert.ok(!mediaTitle(r), JSON.stringify(r));
  assert.ok(r.clean.includes("[photo: couch]"));
});
