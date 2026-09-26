// Honest to the record (SPEC_V5 section 6, src/honest.ts): what she already sent him, read
// from her own messages, as a section and as the input of the denied_send check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import {
  loadSrcIfPresent, guard, scriptedD1, clockSpan, storyClock, TZ, TUE_2350_NY, WED_0030_NY, DAY_MS, HOUR_MS, plusMs,
} from "./helpers_v5.mjs";

const honest = await loadSrcIfPresent("honest");
const t = guard(honest, "sentWords", "listSent", "sentSection", "sentForCheck");

const NOW = new Date("2026-10-02T14:00:00.000Z"); // Friday 10:00am New York
const HEADER = "WHAT YOU HAVE SENT HIM (true: these went to him, from you; never say you did not send one of these, never send him the same song twice)";

function msg(id, created_at, extra = {}) {
  return { id, conversation_id: "c_1", content: "here", created_at, song_json: null, image_id: null, audio_key: null, media_id: null, ...extra };
}

function sentDb(messages, assets = [], media = []) {
  return scriptedD1([
    [/FROM messages WHERE channel = 'story' AND role = 'assistant'/, (b) => {
      const since = String(b[0]);
      const limit = Number(b[2]);
      return messages.filter((m) => m.created_at >= since).sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1)).slice(0, limit);
    }],
    [/FROM visual_assets WHERE id IN/, (b) => assets.filter((a) => b.includes(a.id))],
    [/FROM media_library WHERE id IN/, (b) => media.filter((m) => b.includes(m.id))],
  ]);
}

t("sentWords: four letters or more, the stop list out, deduplicated, at most eight", () => {
  assert.deepEqual(honest.sentWords("Just a song with Your name that Stays stays"), ["song", "name", "stays"]);
  assert.equal(honest.sentWords("alpha bravo charlie delta echoes foxtrot golfing hotel indigo juliet").length, 8);
  assert.deepEqual(honest.sentWords(""), []);
});

t("listSent: a song, a photo, a rejected photo skipped, a clip, a voice note, a library item, one message giving two items, newest first", async () => {
  const messages = [
    msg("m_song", plusMs(NOW.toISOString(), -1 * HOUR_MS), { song_json: JSON.stringify({ artist: "Nic D", title: "Your Love" }) }),
    msg("m_photo", plusMs(NOW.toISOString(), -2 * HOUR_MS), { image_id: "va_ok" }),
    msg("m_rej", plusMs(NOW.toISOString(), -3 * HOUR_MS), { image_id: "va_rej" }),
    msg("m_clip", plusMs(NOW.toISOString(), -4 * HOUR_MS), { image_id: "va_vid" }),
    msg("m_voice", plusMs(NOW.toISOString(), -5 * HOUR_MS), { audio_key: "audio/x", content: "ok so listen to this one thing about the shop" }),
    msg("m_media", plusMs(NOW.toISOString(), -6 * HOUR_MS), { media_id: "ml_1" }),
    msg("m_two", plusMs(NOW.toISOString(), -7 * HOUR_MS), { song_json: JSON.stringify({ artist: "Some Artist", title: "Some Title" }), image_id: "va_ok2" }),
  ];
  const assets = [
    { id: "va_ok", role: "scene", prompt: "her at the harbour in a denim jacket", approval_status: "approved" },
    { id: "va_rej", role: "candidate", prompt: "rejected", approval_status: "rejected" },
    { id: "va_vid", role: "video", prompt: "a clip of the window display", approval_status: "approved" },
    { id: "va_ok2", role: "candidate", prompt: "her kitchen", approval_status: "candidate" },
  ];
  const db = sentDb(messages, assets, [{ id: "ml_1", title: "the shop window at night" }]);
  const items = await honest.listSent(db, { now: NOW, windowDays: 7, limit: 20 });
  const kinds = items.map((i) => i.messageId + ":" + i.kind);
  assert.deepEqual(kinds, ["m_song:song", "m_photo:photo", "m_clip:clip", "m_voice:voice", "m_media:media", "m_two:song", "m_two:photo"]);
  const song = items[0];
  assert.equal(song.label, "Nic D - Your Love");
  assert.equal(song.words[0], "nic d", "the artist's whole name as one phrase first");
  assert.equal(items.find((i) => i.kind === "voice").label.length <= 60, true);
  assert.equal(items.find((i) => i.kind === "media").label, "the shop window at night");
  const read = db.log.find((e) => /FROM messages WHERE channel = 'story'/.test(e.sql));
  assert.equal(read.binds[2], 60, "?3 = min(200, limit * 3)");
});

t("listSent: the window and the limit; a failed read answers []", async () => {
  const messages = [
    msg("m_new", plusMs(NOW.toISOString(), -1 * DAY_MS), { song_json: JSON.stringify({ artist: "A", title: "One" }) }),
    msg("m_mid", plusMs(NOW.toISOString(), -2 * DAY_MS), { song_json: JSON.stringify({ artist: "B", title: "Two" }) }),
    msg("m_old", plusMs(NOW.toISOString(), -9 * DAY_MS), { song_json: JSON.stringify({ artist: "C", title: "Three" }) }),
  ];
  const items = await honest.listSent(sentDb(messages), { now: NOW, windowDays: 7, limit: 12 });
  assert.deepEqual(items.map((i) => i.messageId), ["m_new", "m_mid"]);
  const one = await honest.listSent(sentDb(messages), { now: NOW, windowDays: 7, limit: 1 });
  assert.deepEqual(one.map((i) => i.messageId), ["m_new"]);
  const broken = { prepare() { throw new Error("no such column: media_id"); } };
  assert.deepEqual(await honest.listSent(broken, { now: NOW, windowDays: 7, limit: 12 }), []);
});

function item(kind, at, label, words = []) {
  return { messageId: "m_" + kind, conversationId: "c_1", kind, at, label, words };
}

t("sentSection: the header, each kind's wording and the day words", () => {
  const items = [
    item("song", plusMs(NOW.toISOString(), -1 * HOUR_MS), "Some Artist - Some Title"),
    item("photo", plusMs(NOW.toISOString(), -1 * DAY_MS), "her at the harbour"),
    item("clip", plusMs(NOW.toISOString(), -3 * DAY_MS), "the window"),
    item("voice", plusMs(NOW.toISOString(), -8 * DAY_MS), "ok so listen"),
    item("media", plusMs(NOW.toISOString(), -2 * HOUR_MS), "the shop window at night"),
  ];
  const s = honest.sentSection(items, NOW, TZ);
  const lines = s.split("\n");
  assert.equal(lines[0], HEADER);
  assert.equal(lines[1], "- today 9:00am: a song, Some Artist - Some Title");
  assert.equal(lines[2], "- yesterday: a photo (her at the harbour)");
  assert.equal(lines[3], "- Tuesday: a clip (the window)");
  assert.equal(lines[4], "- 8 days ago: a voice note (\"ok so listen\")");
  assert.equal(lines[5], "- today 8:00am: the shop window at night, from your phone");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
  assert.equal(honest.sentSection([], NOW, TZ), "");
});

t("sentSection with a clock: a song sent inside a held span that crossed midnight reads 'today' at the held clock", () => {
  const span = clockSpan({ frozen_at: TUE_2350_NY });
  const clock = storyClock({ spans: [span], real: WED_0030_NY });
  const storyNow = new Date(TUE_2350_NY);
  const inside = plusMs(TUE_2350_NY, 30 * 60 * 1000); // Wednesday 00:20 real time, inside the span
  const s = honest.sentSection([item("song", inside, "Some Artist - Some Title")], storyNow, TZ, clock);
  assert.equal(s.split("\n")[1], "- today 11:50pm: a song, Some Artist - Some Title");
  assert.ok(!/days ago|-1/.test(s));
  const noClock = honest.sentSection([item("song", inside, "Some Artist - Some Title")], storyNow, TZ, null);
  assert.equal(noClock.split("\n")[1], "- today: a song, Some Artist - Some Title", "without the clock the item is after storyNow: a plain today");
});

t("sentForCheck: kind, words and today by her local day of storyNow", () => {
  const items = [item("song", plusMs(NOW.toISOString(), -HOUR_MS), "x", ["some artist"]), item("photo", plusMs(NOW.toISOString(), -DAY_MS), "y", ["harbour"])];
  assert.deepEqual(honest.sentForCheck(items, NOW, TZ), [
    { kind: "song", words: ["some artist"], today: true },
    { kind: "photo", words: ["harbour"], today: false },
  ]);
});
