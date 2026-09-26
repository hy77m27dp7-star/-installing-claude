// Her playlist on his Spotify and the player through his account (SPEC_V4 section 4 and
// amendment A1): the pure helpers (the authorize URL with the seven scopes, the search
// query, the track pick, the status view without a token), the connect flow on the stub
// fetch (a pending row with a 32-hex state, the audit without it, a connected row keeping
// its tokens, the callback storing tokens and creating the playlist once, a state mismatch
// 403), the refresh with rotation, the page token (403 not connected, the five-minute
// window, premium from /me, never audited), the add outcomes, and disconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, loadSrc } from "./helpers.mjs";
import { fakeDb, secretEnv, messageRow } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard, settingsV4, spotifyAuthRow, SPOTIFY_SECRET_VALUES, carriesNone, fakeFetch } from "./helpers_v4.mjs";

const spotify = await loadSrcIfPresent("spotify");
const stub = await loadSrc("providers/stub");
const t = guard(spotify, "authorizeUrl", "searchQuery", "pickTrack", "statusView", "beginConnect", "finishConnect", "accessToken", "addSongForMessage", "disconnect", "SPOTIFY_SCOPES");
const tt = guard(spotify, "tokenView");

const SCOPES = ["playlist-modify-private", "playlist-read-private", "streaming", "user-read-email", "user-read-private", "user-read-playback-state", "user-modify-playback-state"];
const ENV = () => ({ ...secretEnv(), ACCESS_AUD: "", SPOTIFY_CLIENT_ID: "client-SECRET-id", SPOTIFY_CLIENT_SECRET: "client-SECRET-0003" });
const STUB_ENV = () => ({ ...secretEnv(), ACCESS_AUD: "", SPOTIFY_STUB: "1" });
const S = settingsV4({ spotifyEnabled: true, spotifyPlaylistId: "stubplaylist" });
const REQUEST_URL = "https://avelie.bladepharoh.com/api/spotify/connect";
const TOKENS = [...SPOTIFY_SECRET_VALUES, "stub-access", "client-SECRET"];
// The stub records a form body as an object or as its raw string; read it as fields either way.
const formOf = (q) => (typeof q.body === "string" ? Object.fromEntries(new URLSearchParams(q.body)) : (q.body && typeof q.body === "object" ? q.body : {}));

t("the constants: the seven scopes of the amendment, the callback path, the add path, the device name", () => {
  assert.deepEqual(spotify.SPOTIFY_SCOPES.split(" "), SCOPES);
  assert.equal(spotify.SPOTIFY_CALLBACK_PATH, "/api/spotify/callback");
  assert.equal(spotify.SPOTIFY_ADD_PATH("abc"), "/playlists/abc/tracks");
  assert.equal(spotify.DEFAULT_PLAYLIST_NAME, "songs from avelie");
  assert.equal(spotify.SPOTIFY_DEVICE_NAME, "Avelie");
  assert.equal(spotify.SPOTIFY_API, "https://api.spotify.com/v1");
});

t("authorizeUrl: response_type=code, the seven scopes only, the state and the redirect, encoded", () => {
  const url = new URL(spotify.authorizeUrl("abc123", "https://avelie.bladepharoh.com/api/spotify/callback", "ff".repeat(16)));
  assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "abc123");
  assert.deepEqual(url.searchParams.get("scope").split(" "), SCOPES);
  assert.equal(url.searchParams.get("redirect_uri"), "https://avelie.bladepharoh.com/api/spotify/callback");
  assert.equal(url.searchParams.get("state"), "ff".repeat(16));
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "redirect_uri", "response_type", "scope", "state"], "nothing else");
  assert.equal(spotify.redirectUriFor("http://127.0.0.1:8787/api/spotify/connect?x=1"), "http://127.0.0.1:8787/api/spotify/callback");
});

t("searchQuery: track then artist, quotes stripped, cut at 250", () => {
  assert.equal(spotify.searchQuery({ artist: "Big Thief", title: "Not (live)" }), "track:Not (live) artist:Big Thief");
  assert.equal(spotify.searchQuery({ artist: "Adrianne 'Lenker'", title: "\"anything\"" }), "track:anything artist:Adrianne Lenker");
  const curly = spotify.searchQuery({ artist: "x", title: String.fromCharCode(0x201c) + "y" + String.fromCharCode(0x201d) });
  assert.equal(curly, "track:y artist:x");
  assert.equal(spotify.searchQuery({ artist: "", title: "solo" }), "track:solo");
  const long = spotify.searchQuery({ artist: "a".repeat(200), title: "b".repeat(200) });
  assert.equal(long.length, 250);
});

t("pickTrack: the first item whose artists include the artist, else the first; null on none or junk", () => {
  const items = [
    { id: "t1", uri: "spotify:track:t1", name: "Song", artists: [{ name: "Someone Else" }], external_urls: { spotify: "https://open.spotify.com/track/t1" } },
    { id: "t2", uri: "spotify:track:t2", name: "Song", artists: [{ name: "Big Thief" }, { name: "Friend" }], external_urls: { spotify: "https://open.spotify.com/track/t2" } },
  ];
  assert.equal(spotify.pickTrack(items, { artist: "big thief", title: "Song" }).id, "t2");
  assert.equal(spotify.pickTrack(items, { artist: "Nobody", title: "Song" }).id, "t1", "falls back to the first");
  const picked = spotify.pickTrack(items, { artist: "Big Thief", title: "Song" });
  assert.deepEqual(picked, { id: "t2", uri: "spotify:track:t2", url: "https://open.spotify.com/track/t2", name: "Song", artist: "Big Thief, Friend" });
  assert.equal(spotify.pickTrack([], { artist: "x", title: "y" }), null);
  assert.equal(spotify.pickTrack(null, { artist: "x", title: "y" }), null);
  assert.equal(spotify.pickTrack([{ name: "no id" }], { artist: "x", title: "y" }), null);
  assert.equal(spotify.pickTrack([{ id: "t3" }], { artist: "x", title: "y" }).url, "https://open.spotify.com/track/t3", "a url is built when none came");
});

t("statusView never carries refresh_token or access_token; connected, the display name, the playlist name and id, configured", () => {
  const view = spotify.statusView(spotifyAuthRow(), S, true);
  assert.deepEqual(view, { connected: true, displayName: "Stub Listener", playlistId: "stubplaylist", playlistName: "songs from avelie", scope: "playlist-modify-private playlist-read-private", configured: true });
  assert.ok(carriesNone(view, TOKENS), JSON.stringify(view));
  const none = spotify.statusView(null, settingsV4(), false);
  assert.equal(none.connected, false);
  assert.equal(none.displayName, null);
  assert.equal(none.playlistId, "");
  assert.equal(none.configured, false);
  assert.equal(spotify.statusView(spotifyAuthRow({ status: "pending" }), S, ENV()).connected, false);
  assert.equal(spotify.statusView(null, settingsV4({ spotifyPlaylistName: "her songs" }), STUB_ENV()).playlistName, "her songs");
});

t("spotifyConfigured: both secrets, or the local stub while ACCESS_AUD is empty; never the stub in production", () => {
  assert.equal(spotify.spotifyConfigured(ENV()), true);
  assert.equal(spotify.spotifyConfigured({ ...secretEnv(), SPOTIFY_CLIENT_ID: "x" }), false, "one secret is not enough");
  assert.equal(spotify.spotifyConfigured(STUB_ENV()), true);
  assert.equal(spotify.spotifyConfigured({ ...STUB_ENV(), ACCESS_AUD: "aud-tag" }), false, "the stub never counts behind the door");
  assert.equal(spotify.spotifyConfigured(secretEnv()), false);
});

// ------------------------------------------------------------------ connect

// A fake D1 that answers the owner row by SQL and records every write.
function authDb(row) {
  return fakeD1((sql) => (/FROM spotify_auth WHERE id = 'owner'/.test(sql) ? (row ? [row] : []) : []));
}
const writesOf = (db) => db.log.filter((s) => s.via === "batch" || s.via === "run");

t("beginConnect: no row -> a pending row with a 32-hex state, the audit row without it; a connected row -> only the state moves; 503 without the secrets", async () => {
  const db = authDb(null);
  const r = await spotify.beginConnect(ENV(), db, REQUEST_URL, "test");
  const url = new URL(r.url);
  const state = url.searchParams.get("state");
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.equal(url.searchParams.get("client_id"), "client-SECRET-id");
  const insert = writesOf(db).find((s) => /INSERT INTO spotify_auth/.test(s.sql));
  assert.ok(insert, "the pending row");
  assert.ok(/'pending'/.test(insert.sql));
  assert.equal(insert.binds[0], state);
  const audit = writesOf(db).find((s) => /audit_events/.test(s.sql) && s.binds.includes("spotify.connect"));
  assert.ok(audit, "audited");
  assert.ok(!audit.binds.join(" ").includes(state), "the state is not in the audit row");
  assert.ok(carriesNone(audit.binds, TOKENS), "no token in the audit row");

  const connected = authDb(spotifyAuthRow());
  const again = await spotify.beginConnect(ENV(), connected, REQUEST_URL, "test");
  const update = writesOf(connected).find((s) => /UPDATE spotify_auth SET state = \?1/.test(s.sql));
  assert.ok(update, "a connected row: the state alone moves");
  assert.equal(update.binds[0], new URL(again.url).searchParams.get("state"));
  assert.ok(!writesOf(connected).some((s) => /INSERT INTO spotify_auth/.test(s.sql) || /refresh_token = NULL/.test(s.sql)), "the status and the tokens stand");

  await assert.rejects(spotify.beginConnect(secretEnv(), authDb(null), REQUEST_URL, "test"), (e) => e.status === 503 && e.code === "provider_not_configured");
});

t("finishConnect on the stub fetch: the tokens stored, /me read, the playlist created once, spotifyEnabled set, the audit carries ids only; a state mismatch is 403 and nothing is stored", async () => {
  const pending = spotifyAuthRow({ status: "pending", state: "ab".repeat(16), refresh_token: null, access_token: null, access_expires_at: null, scope: null, spotify_user_id: null, display_name: null });
  const db = authDb(pending);
  const fetch = stub.stubSpotifyFetch();
  const now = new Date("2026-09-29T19:10:00Z");
  const r = await spotify.finishConnect(ENV(), db, settingsV4(), "https://avelie.bladepharoh.com/api/spotify/callback?code=stub&state=" + "ab".repeat(16), { code: "stub", state: "ab".repeat(16) }, "test", { fetch, now: () => now });
  assert.equal(r.playlistId, "stubplaylist");
  const cleared = writesOf(db).find((s) => /SET state = NULL, updated_at/.test(s.sql));
  assert.ok(cleared, "the state is cleared before the exchange (single use)");
  const stored = writesOf(db).find((s) => /status = 'connected'/.test(s.sql));
  assert.ok(stored, "the tokens are stored");
  assert.deepEqual(stored.binds.slice(0, 3), ["stub-refresh", "stub-access", "2026-09-29T20:10:00.000Z"]);
  assert.equal(stored.binds[4], "stublistener");
  assert.equal(stored.binds[5], "Stub Listener");
  const token = fetch.requests.find((q) => /accounts\.spotify\.com\/api\/token/.test(q.url));
  assert.ok(token, "the token exchange");
  assert.deepEqual(formOf(token), { grant_type: "authorization_code", code: "stub", redirect_uri: "https://avelie.bladepharoh.com/api/spotify/callback" });
  assert.equal(fetch.requests.filter((q) => /\/v1\/users\/stublistener\/playlists$/.test(q.url)).length, 1, "the playlist is created once");
  const settingsWrites = writesOf(db).filter((s) => /INSERT INTO settings/.test(s.sql));
  assert.ok(settingsWrites.some((s) => s.binds[0] === "spotifyEnabled" && s.binds[1] === "true"));
  assert.ok(settingsWrites.some((s) => s.binds[0] === "spotifyPlaylistId" && s.binds[1] === "\"stubplaylist\""));
  const audit = writesOf(db).find((s) => /audit_events/.test(s.sql) && s.binds.includes("spotify.connected"));
  assert.ok(audit && /"playlistId":"stubplaylist"/.test(audit.binds.join(" ")));
  assert.ok(carriesNone(audit.binds, TOKENS), "no token in the audit row: " + audit.binds.join(" "));

  const wrong = authDb(spotifyAuthRow({ status: "pending", state: "ab".repeat(16) }));
  await assert.rejects(spotify.finishConnect(ENV(), wrong, settingsV4(), REQUEST_URL, { code: "stub", state: "cd".repeat(16) }, "test", { fetch: stub.stubSpotifyFetch() }), (e) => e.status === 403 && e.code === "forbidden");
  assert.equal(writesOf(wrong).length, 0, "nothing stored on a mismatch");
  await assert.rejects(spotify.finishConnect(ENV(), authDb(pending), settingsV4(), REQUEST_URL, { error: "access_denied" }, "test", { fetch }), (e) => e.status === 400 && e.detail === "access_denied");
  const existing = authDb(spotifyAuthRow({ status: "pending", state: "ab".repeat(16) }));
  const f2 = stub.stubSpotifyFetch();
  await spotify.finishConnect(ENV(), existing, settingsV4({ spotifyPlaylistId: "stubplaylist" }), REQUEST_URL, { code: "stub", state: "ab".repeat(16) }, "test", { fetch: f2, now: () => now });
  assert.equal(f2.requests.filter((q) => /\/playlists$/.test(q.url)).length, 0, "an existing playlist id is kept, none created");
});

// ------------------------------------------------------------------ tokens

t("accessToken: the stored token while more than 60 s remain; else one refresh that rotates the refresh token; null when not connected; a revoked grant marks the row pending", async () => {
  const now = new Date("2026-09-29T19:10:00Z");
  const fresh = authDb(spotifyAuthRow({ access_expires_at: "2026-09-29T19:20:00.000Z" }));
  const f = stub.stubSpotifyFetch();
  assert.equal(await spotify.accessToken(ENV(), fresh, { fetch: f, now: () => now }), "stub-access-SECRET-0002");
  assert.equal(f.requests.length, 0, "no refresh while the token is fresh");

  const expiring = authDb(spotifyAuthRow({ access_expires_at: "2026-09-29T19:10:30.000Z" }));
  const token = await spotify.accessToken(ENV(), expiring, { fetch: f, now: () => now });
  assert.equal(token, "stub-access");
  const refresh = f.requests.find((q) => /api\/token/.test(q.url));
  assert.ok(refresh && formOf(refresh).grant_type === "refresh_token", "one refresh");
  assert.equal(formOf(refresh).refresh_token, "stub-refresh-SECRET-0001");
  const rotated = writesOf(expiring).find((s) => /UPDATE spotify_auth SET access_token = \?1/.test(s.sql));
  assert.deepEqual(rotated.binds.slice(0, 3), ["stub-access", "2026-09-29T20:10:00.000Z", "stub-refresh"], "the new refresh token replaces the stored one");

  assert.equal(await spotify.accessToken(ENV(), authDb(null), { fetch: f, now: () => now }), null);
  assert.equal(await spotify.accessToken(ENV(), authDb(spotifyAuthRow({ status: "pending" })), { fetch: f, now: () => now }), null);

  const revoked = authDb(spotifyAuthRow({ refresh_token: "stub-revoked", access_expires_at: "2026-09-29T19:10:30.000Z" }));
  assert.equal(await spotify.accessToken(ENV(), revoked, { fetch: stub.stubSpotifyFetch(), now: () => now }), null);
  assert.ok(writesOf(revoked).some((s) => /status = 'pending'/.test(s.sql) && /refresh_token = NULL/.test(s.sql)), "the row goes back to pending");
  assert.ok(writesOf(revoked).some((s) => /audit_events/.test(s.sql) && s.binds.includes("spotify.revoked")), "audited spotify.revoked");
});

tt("tokenView (A1): 403 not_connected without a row or on a pending row; refreshed when under five minutes remain, not at ten; premium from /me and cached; never a refresh token; never audited", async () => {
  const now = new Date("2026-09-29T19:10:00Z");
  await assert.rejects(spotify.tokenView(ENV(), authDb(null), S, { fetch: stub.stubSpotifyFetch(), now: () => now }), (e) => e.status === 403 && e.code === "not_connected");
  await assert.rejects(spotify.tokenView(ENV(), authDb(spotifyAuthRow({ status: "pending" })), S, { fetch: stub.stubSpotifyFetch(), now: () => now }), (e) => e.status === 403 && e.code === "not_connected");

  const ten = authDb(spotifyAuthRow({ access_expires_at: "2026-09-29T19:20:00.000Z" }));
  const f1 = stub.stubSpotifyFetch();
  const v1 = await spotify.tokenView(ENV(), ten, S, { fetch: f1, now: () => now });
  assert.equal(v1.accessToken, "stub-access-SECRET-0002", "ten minutes left: the stored token");
  assert.equal(v1.expiresAt, "2026-09-29T19:20:00.000Z");
  assert.equal(v1.premium, true);
  assert.equal(v1.deviceName, "Avelie");
  assert.equal(v1.player, "sdk");
  assert.ok(!f1.requests.some((q) => /api\/token/.test(q.url)), "no refresh at ten minutes");
  assert.ok(f1.requests.some((q) => /\/v1\/me$/.test(q.url)), "premium read from /me");
  assert.ok(writesOf(ten).some((s) => /panel_cache/.test(s.sql) && /spotify:premium/.test(s.binds.join(" "))), "the premium flag is cached");
  assert.ok(!writesOf(ten).some((s) => /audit_events/.test(s.sql)), "the token route is never audited");
  assert.deepEqual(Object.keys(v1).sort(), ["accessToken", "deviceName", "expiresAt", "player", "premium"]);
  assert.ok(carriesNone(v1, ["refresh", "SECRET-0001"]), "no refresh token in the view");

  const four = authDb(spotifyAuthRow({ access_expires_at: "2026-09-29T19:14:00.000Z" }));
  const f2 = stub.stubSpotifyFetch({ premium: false });
  const v2 = await spotify.tokenView(ENV(), four, S, { fetch: f2, now: () => now });
  assert.equal(v2.accessToken, "stub-access", "four minutes left: refreshed");
  assert.ok(f2.requests.some((q) => /api\/token/.test(q.url) && formOf(q).grant_type === "refresh_token"));
  assert.equal(v2.premium, false, "a free account");
  assert.ok(!writesOf(four).some((s) => /audit_events/.test(s.sql)));

  const cached = fakeD1((sql) => (/FROM spotify_auth/.test(sql) ? [spotifyAuthRow({ access_expires_at: "2026-09-29T19:20:00.000Z" })] : /FROM panel_cache WHERE k = \?1/.test(sql) ? [{ json: JSON.stringify({ premium: true }), fetched_at: "2026-09-29T18:00:00.000Z" }] : []));
  const f3 = stub.stubSpotifyFetch({ premium: false });
  const v3 = await spotify.tokenView(ENV(), cached, S, { fetch: f3, now: () => now });
  assert.equal(v3.premium, true, "the day's cached flag wins");
  assert.ok(!f3.requests.some((q) => /\/v1\/me$/.test(q.url)), "no /me while the cache is fresh");
});

// ------------------------------------------------------------------ the add

function songDb(row, opts = {}) {
  const message = messageRow({ id: "m_song", conversation_id: "c_test", song_json: JSON.stringify({ artist: "Some Artist", title: opts.title ?? "Some Title", searchUrl: "https://open.spotify.com/search/x" }) });
  return fakeD1((sql, binds) => {
    if (/SELECT \* FROM messages WHERE id = \?1/.test(sql)) return binds[0] === "m_song" ? [message] : [];
    if (/FROM spotify_auth WHERE id = 'owner'/.test(sql)) return row ? [row] : [];
    if (/song_json LIKE \?1 AND id != \?2/.test(sql)) return opts.already ? [{ id: "m_earlier" }] : [];
    return [];
  });
}
const statusWrite = (db) => writesOf(db).find((s) => /UPDATE messages SET spotify_status/.test(s.sql));

t("addSongForMessage on the stub: added (the rewritten song_json carries trackUrl and uri), already by the LIKE probe, not_found, failed, off when disabled or not connected, 404 on no message", async () => {
  const deps = () => ({ fetch: stub.stubSpotifyFetch(), now: () => new Date("2026-09-29T19:10:00Z") });
  const added = songDb(spotifyAuthRow());
  assert.equal(await spotify.addSongForMessage(ENV(), added, S, "m_song", deps()), "added");
  const w = statusWrite(added);
  assert.equal(w.binds[0], "added");
  const song = JSON.parse(w.binds[1]);
  assert.equal(song.trackUrl, "https://open.spotify.com/track/stubtrack");
  assert.equal(song.uri, "spotify:track:stubtrack");
  assert.equal(song.artist, "Some Artist");
  assert.equal(w.binds[2], "m_song");

  const dup = songDb(spotifyAuthRow(), { already: true });
  assert.equal(await spotify.addSongForMessage(ENV(), dup, S, "m_song", deps()), "already");
  assert.equal(statusWrite(dup).binds[0], "already");

  const missing = songDb(spotifyAuthRow(), { title: "[[NOTFOUND]] nothing" });
  assert.equal(await spotify.addSongForMessage(ENV(), missing, S, "m_song", deps()), "not_found");
  assert.equal(statusWrite(missing).binds[0], "not_found");
  assert.equal(statusWrite(missing).binds[1], "m_song", "song_json untouched on not_found");

  const failing = fakeFetch(async (q) => (/\/tracks$/.test(q.url) ? { status: 500, json: { error: "down" } } : stub.stubSpotifyFetch()(q.url, { method: q.method, headers: q.headers, body: q.body })));
  const failed = songDb(spotifyAuthRow());
  assert.equal(await spotify.addSongForMessage(ENV(), failed, S, "m_song", { fetch: failing, now: () => new Date("2026-09-29T19:10:00Z") }), "failed");
  assert.equal(statusWrite(failed).binds[0], "failed");

  const off = songDb(spotifyAuthRow());
  assert.equal(await spotify.addSongForMessage(ENV(), off, settingsV4({ spotifyEnabled: false }), "m_song", deps()), "off");
  assert.equal(statusWrite(off).binds[0], "off");
  const notConnected = songDb(null);
  assert.equal(await spotify.addSongForMessage(ENV(), notConnected, S, "m_song", deps()), "off");
  await assert.rejects(spotify.addSongForMessage(ENV(), songDb(spotifyAuthRow()), S, "m_nothing", deps()), (e) => e.status === 404);
  const noSong = fakeD1((sql) => (/FROM messages WHERE id = \?1/.test(sql) ? [messageRow({ id: "m_plain", song_json: null })] : []));
  assert.equal(await spotify.addSongForMessage(ENV(), noSong, S, "m_plain", deps()), "off");
  assert.equal(writesOf(noSong).length, 0, "a message without a song writes nothing");
});

t("addSongForMessage: a 404 on the playlist creates it again once and retries; a gone playlist id is recreated when empty", async () => {
  const f = stub.stubSpotifyFetch();
  const db = songDb(spotifyAuthRow());
  const r = await spotify.addSongForMessage(ENV(), db, settingsV4({ spotifyEnabled: true, spotifyPlaylistId: "goneplaylist" }), "m_song", { fetch: f, now: () => new Date("2026-09-29T19:10:00Z") });
  assert.equal(r, "added");
  assert.equal(f.requests.filter((q) => /\/v1\/users\/stublistener\/playlists$/.test(q.url)).length, 1, "recreated once");
  assert.ok(f.requests.some((q) => /\/playlists\/stubplaylist\/tracks$/.test(q.url)), "the add retried on the new id");
  assert.ok(writesOf(db).some((s) => /INSERT INTO settings/.test(s.sql) && s.binds[0] === "spotifyPlaylistId" && s.binds[1] === "\"stubplaylist\""));
});

t("disconnect deletes the row, sets spotifyEnabled false and audits without a token; playlistStatus answers ok false without a playlist", async () => {
  const db = authDb(spotifyAuthRow());
  await spotify.disconnect(ENV(), db, "test");
  assert.ok(writesOf(db).some((s) => /DELETE FROM spotify_auth WHERE id = 'owner'/.test(s.sql)));
  assert.ok(writesOf(db).some((s) => /INSERT INTO settings/.test(s.sql) && s.binds[0] === "spotifyEnabled" && s.binds[1] === "false"));
  const audit = writesOf(db).find((s) => /audit_events/.test(s.sql) && s.binds.includes("spotify.disconnect"));
  assert.ok(audit && carriesNone(audit.binds, TOKENS), audit && audit.binds.join(" "));
  assert.deepEqual(await spotify.playlistStatus(ENV(), authDb(spotifyAuthRow()), settingsV4(), { fetch: stub.stubSpotifyFetch() }), { ok: false, name: null });
  const ok = await spotify.playlistStatus(ENV(), authDb(spotifyAuthRow({ access_expires_at: "2099-01-01T00:00:00.000Z" })), S, { fetch: stub.stubSpotifyFetch(), now: () => new Date("2026-09-29T19:10:00Z") });
  assert.deepEqual(ok, { ok: true, name: "songs from avelie" });
  const gone = await spotify.playlistStatus(ENV(), authDb(spotifyAuthRow({ access_expires_at: "2099-01-01T00:00:00.000Z" })), settingsV4({ spotifyPlaylistId: "goneplaylist" }), { fetch: stub.stubSpotifyFetch(), now: () => new Date("2026-09-29T19:10:00Z") });
  assert.deepEqual(gone, { ok: false, name: null });
});

t("statusResponse: the status view plus the playlist check when connected; never a token; the stub fetch through SPOTIFY_STUB", async () => {
  const view = await spotify.statusResponse(STUB_ENV(), authDb(spotifyAuthRow({ access_expires_at: "2099-01-01T00:00:00.000Z" })), S);
  assert.equal(view.connected, true);
  assert.equal(view.configured, true);
  assert.deepEqual(view.playlist, { ok: true, name: "songs from avelie" });
  assert.ok(carriesNone(view, TOKENS), JSON.stringify(view));
  const none = await spotify.statusResponse(secretEnv(), authDb(null), settingsV4());
  assert.deepEqual(none, { connected: false, displayName: null, playlistId: "", playlistName: "songs from avelie", scope: null, configured: false, playlist: null });
});
