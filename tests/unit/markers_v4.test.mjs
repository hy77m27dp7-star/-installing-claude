// The v4 markers (SPEC_V4 section 3 and amendment A3): the pure detector that says whether
// her photo description has him in it (twelve positives, thirteen negatives), and the clip
// marker she ends a message with, stripped like the photo line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const markers = await loadSrc("markers");
const { photoIncludesHim, HIM_STRONG_RE, HIM_WEAK_RE, HIM_ABSENT_RE, parseClipMarker, stripMarkers, stripAllMarkers } = markers;

const POSITIVES = [
  "selfie of the two of us", "my head on your shoulder", "you next to me on the bench", "us at the counter", "him behind me making a face",
  "both of us in the mirror", "leaning against you", "with you in it", "you and me, the harbour behind", "his jacket on my shoulders",
  "me and you at the window", "selfie with you",
];
const NEGATIVES = [
  "mirror selfie in a black hoodie", "the sweater you like, sunlit window", "the bench where we sat, empty", "just me at the pier",
  "coffee, the shop window, nobody else", "the view from the car, alone", "my face, of me, half smile", "the mug you gave me on the table",
  "the dress, before we go out", "the rain since we talked", "the view we talked about, the harbour at dusk", "the barista behind me, him again",
  "trust us, the light was better in person",
];

test("photoIncludesHim: the twelve positives", () => {
  for (const d of POSITIVES) assert.equal(photoIncludesHim(d), true, d);
});

test("photoIncludesHim: the thirteen negatives (a bare we, us, him, you or your is not a signal)", () => {
  for (const d of NEGATIVES) assert.equal(photoIncludesHim(d), false, d);
});

test("photoIncludesHim: strong wins over absent; weak yields to absent; junk is false; case does not matter", () => {
  assert.equal(photoIncludesHim("selfie of the two of us, nobody else around"), true, "strong beats absent");
  assert.equal(photoIncludesHim("us by the water, just me really"), false, "weak yields to absent");
  assert.equal(photoIncludesHim("SELFIE WITH YOU"), true);
  assert.equal(photoIncludesHim(""), false);
  assert.equal(photoIncludesHim("   "), false);
  assert.equal(photoIncludesHim(null), false);
  assert.equal(photoIncludesHim(42), false);
  assert.ok(HIM_STRONG_RE instanceof RegExp && HIM_WEAK_RE instanceof RegExp && HIM_ABSENT_RE instanceof RegExp);
  assert.ok(HIM_STRONG_RE.test("the two of us") && !HIM_STRONG_RE.test("the view we talked about"));
  assert.ok(HIM_WEAK_RE.test("us at the counter") && !HIM_WEAK_RE.test("trust us, the light was better"));
  assert.ok(HIM_ABSENT_RE.test("just me at the pier") && !HIM_ABSENT_RE.test("the two of us"));
});

// ------------------------------------------------------------------ the clip marker (A3)

test("parseClipMarker: a final [clip: ...] line becomes the description; the line goes; two markers -> the last wins; none -> null", () => {
  const r = parseClipMarker("ok one. do not make it a thing\n[clip: she looks up from the record and half smiles, then looks away]");
  assert.equal(r.description, "she looks up from the record and half smiles, then looks away");
  assert.equal(r.clean, "ok one. do not make it a thing");
  const two = parseClipMarker("a\n[clip: first]\nb\n[clip: second]");
  assert.equal(two.description, "second");
  assert.equal(two.clean, "a\nb");
  const inline = parseClipMarker("fine. [CLIP:   the walk sign  ] ok");
  assert.equal(inline.description, "the walk sign");
  assert.equal(inline.clean, "fine. ok");
  const none = parseClipMarker("hello there.");
  assert.deepEqual(none, { clean: "hello there.", description: null });
  const empty = parseClipMarker("sent\n[clip: ]");
  assert.equal(empty.description, null, "an empty marker is stripped and counts as none");
  assert.equal(empty.clean, "sent");
});

test("stripMarkers keeps its v1 shape (clean, photo, song); stripAllMarkers gains clip beside photo, song, voice and media", () => {
  const both = "look\n[photo: mirror selfie in a black hoodie]\n[clip: she waves]";
  const v1 = stripMarkers(both);
  assert.deepEqual(Object.keys(v1).sort(), ["clean", "photo", "song"]);
  assert.equal(v1.photo, "mirror selfie in a black hoodie");
  assert.ok(v1.clean.includes("[clip: she waves]"), "stripMarkers leaves the clip line to stripAllMarkers");
  const all = stripAllMarkers(both);
  assert.deepEqual(Object.keys(all).sort(), ["clean", "clip", "media", "photo", "song", "voice"]);
  assert.equal(all.clip, "she waves");
  assert.equal(all.photo, "mirror selfie in a black hoodie");
  assert.equal(all.clean, "look");
  assert.equal(all.voice, false);
  assert.equal(all.media, null);
  assert.equal(all.song, null);
  const plain = stripAllMarkers("just words");
  assert.equal(plain.clip, null);
  assert.equal(plain.clean, "just words");
});

test("photoIncludesHim (review): his clothes on her yield to alone or just me; he, him and his name someone else in her second-person line; a curly apostrophe reads", () => {
  for (const d of [
    "me and mason at the lake, his arm around my shoulders",
    "the barista behind the counter, his hands on the machine",
    "wearing your hoodie on my couch, alone",
    "mirror selfie in your hoodie, alone in my room",
    "wearing your jacket, just me at the pier",
    "he's next to me at the bar, some guy from work",
  ]) assert.equal(photoIncludesHim(d), false, d);
  assert.equal(photoIncludesHim("you’re next to me on the bench"), true, "curly apostrophe");
  assert.equal(photoIncludesHim("selfie with him"), true, "him as the subject stays a weak signal");
  assert.equal(photoIncludesHim("his jacket on my shoulders"), true, "the spec's positive, now weak");
  assert.equal(photoIncludesHim("his jacket on my shoulders, just me"), false, "and it yields to just me");
});
