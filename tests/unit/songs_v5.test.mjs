// The song loop (SPEC_V5 section 9, src/songs.ts): the artists he knows or did not like,
// the per-turn section, the one-time missing-song notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, guard, scriptedD1, knownArtistRow, DAY_MS, plusMs } from "./helpers_v5.mjs";

const songs = await loadSrcIfPresent("songs");
const t = guard(songs, "artistNorm", "songsSection", "isListedArtist", "setKnownArtist", "missingSongNotice", "songToldStmt");

const NOW = new Date("2026-10-02T14:00:00.000Z");
const HEADER = "SONGS AND HIM (so what you send him is new to him and yours)";

t("artistNorm: 'The National' and 'national' are one; '&' reads 'and'", () => {
  assert.equal(songs.artistNorm("The National"), songs.artistNorm("national"));
  assert.equal(songs.artistNorm("Simon & Garfunkel"), "simon and garfunkel");
  assert.equal(songs.artistNorm("  AC/DC "), "ac dc");
});

t("songsSection: each line alone, the limit, empty", () => {
  assert.equal(songs.songsSection({ known: [], disliked: [], missing: null, limit: 40 }), "");
  assert.equal(songs.songsSection({ known: ["Some Artist", "The National"], disliked: [], missing: null, limit: 40 }),
    HEADER + "\nHe already knows: Some Artist, The National. Send him something he does not know.");
  assert.equal(songs.songsSection({ known: [], disliked: ["Nickelback"], missing: null, limit: 40 }),
    HEADER + "\nHe did not like: Nickelback. Not his; do not send them again.");
  assert.equal(songs.songsSection({ known: [], disliked: [], missing: { artist: "Nobody Real", title: "Notfound Song" }, limit: 40 }),
    HEADER + "\nThe last song you sent him, Nobody Real - Notfound Song, is not anywhere you can find it now. If it comes up, you could not find it again; say so once, in your own words, and move on.");
  const many = songs.songsSection({ known: ["a1", "a2", "a3", "a4"], disliked: ["d1", "d2", "d3"], missing: null, limit: 4 });
  const names = many.split("\n").slice(1).join(" ").match(/\b[ad]\d\b/g);
  assert.equal(names.length, 4, "together at most limit artists");
  assert.ok(!BAD_TYPOGRAPHY.test(many));
  assert.ok(!/search|spotify|app\b/i.test(songs.songsSection({ known: [], disliked: [], missing: { artist: "x", title: "y" }, limit: 40 })), "a thing a person says");
});

t("isListedArtist by artistNorm", () => {
  const listed = new Set([songs.artistNorm("The National")]);
  assert.equal(songs.isListedArtist({ artist: "national" }, listed), true);
  assert.equal(songs.isListedArtist({ artist: "Someone Else" }, listed), false);
  assert.equal(songs.isListedArtist(null, listed), false);
});

t("setKnownArtist: an upsert by artist_norm; a disliked press over a known one changes the kind; audited", async () => {
  const store = new Map([["some artist", knownArtistRow()]]);
  const db = scriptedD1([
    [/INSERT INTO known_artists/, (b) => {
      const [id, artist, norm, kind, source, messageId, note] = b;
      const cur = store.get(norm);
      store.set(norm, cur ? { ...cur, kind, source, message_id: messageId, note } : knownArtistRow({ id, artist, artist_norm: norm, kind, source, message_id: messageId, note }));
      return 1;
    }],
    [/FROM known_artists WHERE artist_norm = \?1/, (b) => (store.has(b[0]) ? [store.get(b[0])] : [])],
  ]);
  const row = await songs.setKnownArtist(db, { artist: "Some Artist", kind: "disliked", source: "button", messageId: "m_2" }, "owner");
  assert.equal(row.kind, "disliked");
  assert.equal(store.size, 1);
  const ins = db.log.find((e) => /INSERT INTO known_artists/.test(e.sql));
  assert.match(ins.sql, /ON CONFLICT\s*\(artist_norm\)\s*DO UPDATE SET/i);
  assert.ok(db.log.some((e) => /INSERT INTO audit_events/.test(e.sql) && e.binds.includes("artist.set")), "audit artist.set");
  await assert.rejects(songs.setKnownArtist(db, { artist: "", kind: "known", source: "owner" }, "owner"), (e) => e.status === 400);
  await assert.rejects(songs.setKnownArtist(db, { artist: "x", kind: "loved", source: "owner" }, "owner"), (e) => e.status === 400);
});

t("missingSongNotice: the newest untold not_found within three days; a told one skipped; an old one skipped", async () => {
  const rows = [
    { id: "m_told", song_json: JSON.stringify({ artist: "Told", title: "Already" }), created_at: plusMs(NOW.toISOString(), -1 * 3600000), song_told_at: plusMs(NOW.toISOString(), -1000), spotify_status: "not_found" },
    { id: "m_new", song_json: JSON.stringify({ artist: "Nobody Real", title: "Notfound Song" }), created_at: plusMs(NOW.toISOString(), -2 * 3600000), song_told_at: null, spotify_status: "not_found" },
    { id: "m_old", song_json: JSON.stringify({ artist: "Old", title: "Gone" }), created_at: plusMs(NOW.toISOString(), -4 * DAY_MS), song_told_at: null, spotify_status: "not_found" },
  ];
  const db = scriptedD1([
    [/spotify_status = 'not_found'/, (b, sql) => {
      assert.match(sql, /song_told_at IS NULL/);
      assert.match(sql, /created_at >= \?1/);
      return rows.filter((r) => r.song_told_at === null && r.created_at >= b[0]).sort((a, c) => (a.created_at < c.created_at ? 1 : -1));
    }],
  ]);
  const n = await songs.missingSongNotice(db, NOW);
  assert.deepEqual(n, { messageId: "m_new", artist: "Nobody Real", title: "Notfound Song" });
  const since = db.log[0].binds[0];
  assert.equal(since, new Date(NOW.getTime() - 3 * DAY_MS).toISOString());
  const none = await songs.missingSongNotice(scriptedD1([[/not_found/, []]]), NOW);
  assert.equal(none, null);
  assert.equal(await songs.missingSongNotice({ prepare() { throw new Error("no such column: song_told_at"); } }, NOW), null);
});

t("songToldStmt stamps the message once", () => {
  const db = scriptedD1();
  const st = songs.songToldStmt(db, "m_new", NOW.toISOString());
  assert.match(st.sql, /UPDATE messages SET song_told_at = \?2 WHERE id = \?1 AND song_told_at IS NULL/);
  assert.deepEqual(st.binds, ["m_new", NOW.toISOString()]);
});
