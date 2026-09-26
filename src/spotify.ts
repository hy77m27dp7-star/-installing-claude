// Her playlist on his Spotify (v4, SPEC_V4 section 4) and the player through his account
// (Amendment A1). When she sends a song ([song: Artist - Title]) the track is looked up on
// Spotify and added to ONE private playlist on Justin's account, created once by the app.
// The Worker is a confidential client (Authorization Code flow with the client secret, a
// random single-use state on the callback); the tokens live in the one spotify_auth row
// and never reach an audit row, an export, a log line or the browser. The page gets only
// a short-lived access token from tokenView (GET /api/spotify/token) so the Web Playback
// SDK can be the Connect device "Avelie".
//
// The app never reads his listening history, his library or any other playlist. The add
// runs after her reply is stored and can only change a chip: a failure never blocks her.
// Nothing here is a model call, so no model_runs row is written and the meter is untouched.
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import type { Env, MessageRow, Settings } from "./types";
import type { SongRef } from "./markers";
import { auditStmt, getMessage, nowIso, putSettings } from "./db";
import { redactSecrets, safeErrorMessage } from "./providers/types";
import { stubSpotifyFetch } from "./providers/stub";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_API = "https://api.spotify.com/v1";
// Amendment A1: the two playlist scopes of section 4 plus the five the Web Playback SDK
// and the play endpoint require. Nothing else, ever.
export const SPOTIFY_SCOPES = "playlist-modify-private playlist-read-private streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state";
export const SPOTIFY_CALLBACK_PATH = "/api/spotify/callback";
// "Add Items to Playlist" is POST /playlists/{id}/items: Spotify's February 2026 Web API
// changes retired /playlists/{id}/tracks for Development Mode apps (his app is one).
export const SPOTIFY_ADD_PATH = (id: string): string => "/playlists/" + id + "/items";
// "Create Playlist" is POST /me/playlists since the same changes (POST /users/{id}/playlists is gone).
export const SPOTIFY_CREATE_PATH = "/me/playlists";
export const DEFAULT_PLAYLIST_NAME = "songs from avelie";
export const PLAYLIST_DESCRIPTION = "songs she sent";
export const SPOTIFY_DEVICE_NAME = "Avelie";
// A stored access token is reused while more than this remains (the add path); the page
// token (tokenView) is refreshed when under five minutes remain.
export const TOKEN_SLACK_MS = 60 * 1000;
export const PAGE_TOKEN_SLACK_MS = 5 * 60 * 1000;
// The Premium check (GET /v1/me product) is cached for a day.
export const PREMIUM_CACHE_MS = 24 * 60 * 60 * 1000;
const PREMIUM_CACHE_KEY = "spotify:premium";
const SEARCH_LIMIT = 3;
const MAX_QUERY_CHARS = 250;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY = 200;

export type SpotifyStatus = "added" | "already" | "not_found" | "failed" | "off" | "pending";
export type SpotifyFetch = (url: string, init?: RequestInit) => Promise<Response>;

// The one row (id 'owner'), as D1 returns it. Never handed to the browser whole.
export interface SpotifyAuthRow {
  id: string;
  status: "pending" | "connected";
  state: string | null;
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: string | null;
  scope: string | null;
  spotify_user_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  url: string;
  name: string;
  artist: string;
}

export interface SpotifyStatusView {
  connected: boolean;
  displayName: string | null;
  playlistId: string;
  playlistName: string;
  scope: string | null;
  configured: boolean;
}

export interface SpotifyTokenView {
  accessToken: string;
  expiresAt: string;
  // false only when Spotify said the account is not Premium; null when it did not say (the
  // February 2026 changes took `product` out of GET /me for Development Mode apps). The page
  // tries the Web Playback SDK unless this is false and falls back to the embed on the SDK's
  // own account_error.
  premium: boolean | null;
  deviceName: string;
  // The spotifyPlayer setting ("sdk" | "embed" | "off"), so the page knows which player to build.
  player: string;
}

// Optional test hooks: a recording fetch and a clock. Never set by the routes.
export interface SpotifyDeps {
  fetch?: SpotifyFetch;
  now?: () => Date;
}

// The three settings keys and the env vars this module reads. They are typed loosely on
// purpose: the keys are added to Settings and Env by the settings lane, and this module
// compiles and behaves the same whether or not those declarations have landed.
interface SpotifySettings {
  spotifyEnabled?: boolean;
  spotifyPlaylistId?: string;
  spotifyPlaylistName?: string;
  spotifyPlayer?: string;
}

interface SpotifyEnv {
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_STUB?: string;
  // Local only: "0" makes the stub answer a free account (the embed path).
  SPOTIFY_STUB_PREMIUM?: string;
}

function spotifySettingsOf(settings: Settings): SpotifySettings {
  return settings as unknown as SpotifySettings;
}

function spotifyEnvOf(env: Env): SpotifyEnv {
  return env as unknown as SpotifyEnv;
}

function hasText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function stubMode(env: Env): boolean {
  const e = spotifyEnvOf(env);
  return e.SPOTIFY_STUB === "1" && !(env.ACCESS_AUD ?? "").trim();
}

// Both secrets set, or the local-only stub (SPOTIFY_STUB=1 while ACCESS_AUD is empty, the
// rule overlaySettings already applies to the default providers).
export function spotifyConfigured(env: Env): boolean {
  const e = spotifyEnvOf(env);
  if (hasText(e.SPOTIFY_CLIENT_ID) && hasText(e.SPOTIFY_CLIENT_SECRET)) return true;
  return stubMode(env);
}

// The transport: fetch, or the recorder when the local stub is on.
export function spotifyFetch(env: Env): SpotifyFetch {
  if (stubMode(env)) return stubSpotifyFetch({ premium: spotifyEnvOf(env).SPOTIFY_STUB_PREMIUM !== "0" });
  return (url, init) => fetch(url, init);
}

// ------------------------------------------------------------------ pure helpers

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  return SPOTIFY_AUTHORIZE_URL
    + "?response_type=code"
    + "&client_id=" + encodeURIComponent(clientId)
    + "&scope=" + encodeURIComponent(SPOTIFY_SCOPES)
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&state=" + encodeURIComponent(state);
}

export function redirectUriFor(requestUrl: string): string {
  return new URL(requestUrl).origin + SPOTIFY_CALLBACK_PATH;
}

// Straight and curly quotes (built from code points so this file stays ASCII).
const QUOTE_RE = new RegExp("[\"'" + String.fromCharCode(0x201c, 0x201d, 0x2018, 0x2019) + "]", "g");

function plain(s: unknown): string {
  return String(s ?? "").replace(QUOTE_RE, "").replace(/\s+/g, " ").trim();
}

// track:{title} artist:{artist}, quotes stripped, 1 to 250 characters.
export function searchQuery(song: { artist: string; title: string }): string {
  const title = plain(song.title);
  const artist = plain(song.artist);
  let q = "track:" + title;
  if (artist) q += " artist:" + artist;
  return q.slice(0, MAX_QUERY_CHARS);
}

function readTrack(item: unknown): SpotifyTrack | null {
  if (typeof item !== "object" || item === null) return null;
  const o = item as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const uri = typeof o.uri === "string" ? o.uri : id ? "spotify:track:" + id : "";
  if (!id || !uri) return null;
  const artists = Array.isArray(o.artists)
    ? o.artists.map((a) => (typeof a === "object" && a !== null && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name : "")).filter(Boolean)
    : [];
  const ext = typeof o.external_urls === "object" && o.external_urls !== null ? (o.external_urls as { spotify?: unknown }).spotify : null;
  const url = typeof ext === "string" && ext.startsWith("https://") ? ext : "https://open.spotify.com/track/" + encodeURIComponent(id);
  return { id, uri, url, name: typeof o.name === "string" ? o.name : "", artist: artists.join(", ") };
}

// The first item whose artist names include the artist, case-insensitively; else the first.
export function pickTrack(items: unknown, song: { artist: string; title: string }): SpotifyTrack | null {
  if (!Array.isArray(items)) return null;
  const tracks = items.map(readTrack).filter((t): t is SpotifyTrack => t !== null);
  if (!tracks.length) return null;
  const want = plain(song.artist).toLowerCase();
  if (want) {
    for (const t of tracks) {
      const names = t.artist.toLowerCase().split(",").map((n) => n.trim()).filter(Boolean);
      if (names.some((n) => n === want || n.includes(want) || want.includes(n))) return t;
    }
  }
  return tracks[0] ?? null;
}

// The status body, never a token. `configured` is a boolean, or the Env to read it from.
export function statusView(row: SpotifyAuthRow | null, settings: Settings, configured: boolean | Env = false): SpotifyStatusView {
  const s = spotifySettingsOf(settings);
  const name = hasText(s.spotifyPlaylistName) ? s.spotifyPlaylistName.trim() : DEFAULT_PLAYLIST_NAME;
  return {
    connected: !!row && row.status === "connected",
    displayName: row && hasText(row.display_name) ? row.display_name : null,
    playlistId: hasText(s.spotifyPlaylistId) ? s.spotifyPlaylistId.trim() : "",
    playlistName: name,
    scope: row && hasText(row.scope) ? row.scope : null,
    configured: typeof configured === "boolean" ? configured : spotifyConfigured(configured),
  };
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ the row

export async function getSpotifyAuth(db: D1Database): Promise<SpotifyAuthRow | null> {
  return db.prepare("SELECT * FROM spotify_auth WHERE id = 'owner'").first<SpotifyAuthRow>();
}

// ------------------------------------------------------------------ the transport

function providerErrorFromStatus(status: number, body: string): ProviderError {
  const message = redactSecrets(body.replace(/\s+/g, " ").trim()).slice(0, MAX_ERROR_BODY) || "spotify answered " + status;
  if (status === 401 || status === 403) return new ProviderError("spotify", "auth", "spotify " + status + ": " + message, 502, false);
  if (status === 429) return new ProviderError("spotify", "rate_limit", "spotify 429: " + message, 502, true);
  if (status === 400 || status === 404 || status === 422) return new ProviderError("spotify", "bad_request", "spotify " + status + ": " + message, 502, false);
  if (status >= 500) return new ProviderError("spotify", "server", "spotify " + status + ": " + message, 502, true);
  return new ProviderError("spotify", "other", "spotify " + status + ": " + message, 502, false);
}

// One HTTP status the add path needs to see by itself (a gone playlist).
class SpotifyHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super("spotify " + status);
    this.name = "SpotifyHttpError";
    this.status = status;
    this.body = body;
  }
}

async function call(f: SpotifyFetch, url: string, init: RequestInit): Promise<{ status: number; json: unknown; text: string }> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    const cls = e instanceof Error ? e.name : "Error";
    throw new ProviderError("spotify", "network", "spotify did not answer (" + cls + ")", 502, true);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) throw new SpotifyHttpError(res.status, text);
  return { status: res.status, json: parsed, text };
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof SpotifyHttpError) return providerErrorFromStatus(e.status, e.body);
  return new ProviderError("spotify", "other", safeErrorMessage(e), 502, false);
}

function clientCredentials(env: Env): { id: string; secret: string } {
  const e = spotifyEnvOf(env);
  if (hasText(e.SPOTIFY_CLIENT_ID) && hasText(e.SPOTIFY_CLIENT_SECRET)) return { id: e.SPOTIFY_CLIENT_ID.trim(), secret: e.SPOTIFY_CLIENT_SECRET.trim() };
  return { id: "stub-client", secret: "stub-secret" };
}

function basicHeader(env: Env): string {
  const c = clientCredentials(env);
  return "Basic " + btoa(c.id + ":" + c.secret);
}

interface TokenAnswer {
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  scope: string | null;
}

function readTokenAnswer(json: unknown): TokenAnswer {
  const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  if (!hasText(o.access_token)) throw new ProviderError("spotify", "server", "spotify token answer carried no access token", 502, true);
  const expiresIn = typeof o.expires_in === "number" && Number.isFinite(o.expires_in) && o.expires_in > 0 ? o.expires_in : 3600;
  return {
    access_token: o.access_token,
    refresh_token: hasText(o.refresh_token) ? o.refresh_token : null,
    expires_in: expiresIn,
    scope: hasText(o.scope) ? o.scope : null,
  };
}

async function tokenRequest(env: Env, f: SpotifyFetch, form: Record<string, string>): Promise<TokenAnswer> {
  const body = new URLSearchParams(form).toString();
  const r = await call(f, SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { authorization: basicHeader(env), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  return readTokenAnswer(r.json);
}

function bearer(token: string): Record<string, string> {
  return { authorization: "Bearer " + token, accept: "application/json" };
}

async function apiGet(f: SpotifyFetch, token: string, path: string): Promise<unknown> {
  return (await call(f, SPOTIFY_API + path, { method: "GET", headers: bearer(token) })).json;
}

async function apiPost(f: SpotifyFetch, token: string, path: string, body: unknown): Promise<unknown> {
  return (await call(f, SPOTIFY_API + path, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) })).json;
}

interface MeAnswer {
  id: string;
  displayName: string | null;
  // null when /me did not say (no `product` field: the February 2026 Development Mode shape).
  premium: boolean | null;
}

async function readMe(f: SpotifyFetch, token: string): Promise<MeAnswer> {
  const json = await apiGet(f, token, "/me");
  const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  return {
    id: hasText(o.id) ? o.id.trim() : "",
    displayName: hasText(o.display_name) ? o.display_name.trim().slice(0, 200) : null,
    premium: typeof o.product === "string" ? o.product === "premium" : null,
  };
}

async function createPlaylist(f: SpotifyFetch, token: string, name: string): Promise<{ id: string; name: string }> {
  const json = await apiPost(f, token, SPOTIFY_CREATE_PATH, { name, public: false, description: PLAYLIST_DESCRIPTION });
  const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  if (!hasText(o.id)) throw new ProviderError("spotify", "server", "spotify created no playlist", 502, true);
  return { id: o.id.trim(), name: hasText(o.name) ? o.name : name };
}

// ------------------------------------------------------------------ the premium cache

function premiumCacheStmt(db: D1Database, premium: boolean | null, at: string): D1PreparedStatement {
  return db.prepare("INSERT INTO panel_cache (k, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at")
    .bind(PREMIUM_CACHE_KEY, JSON.stringify({ premium }), at);
}

// The day's cached answer: true, false or null (Spotify did not say); undefined on a miss.
async function cachedPremium(db: D1Database, now: Date): Promise<boolean | null | undefined> {
  const row = await db.prepare("SELECT json, fetched_at FROM panel_cache WHERE k = ?1").bind(PREMIUM_CACHE_KEY).first<{ json: string; fetched_at: string }>();
  if (!row) return undefined;
  const at = Date.parse(row.fetched_at);
  if (!Number.isFinite(at) || now.getTime() - at > PREMIUM_CACHE_MS) return undefined;
  try {
    const j = JSON.parse(row.json) as { premium?: unknown };
    return typeof j.premium === "boolean" || j.premium === null ? j.premium : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ connect

// 503 without the secrets. A fresh single-use state is written: on no row or a pending row
// the row becomes pending; on a connected row only the state moves (a second Connect press,
// a cancelled Spotify page or a failed callback never disconnects him). The audit row carries
// neither the state nor a token.
export async function beginConnect(env: Env, db: D1Database, requestUrl: string, actor: string): Promise<{ url: string }> {
  if (!spotifyConfigured(env)) throw new ApiHttpError(503, "provider_not_configured", "Spotify is not configured: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET", false, "spotify");
  const row = await getSpotifyAuth(db);
  const state = randomState();
  const t = nowIso();
  const stmts: D1PreparedStatement[] = [];
  if (row && row.status === "connected") {
    stmts.push(db.prepare("UPDATE spotify_auth SET state = ?1, updated_at = ?2 WHERE id = 'owner'").bind(state, t));
  } else {
    stmts.push(db.prepare(
      "INSERT INTO spotify_auth (id, status, state, refresh_token, access_token, access_expires_at, scope, spotify_user_id, display_name, created_at, updated_at) "
      + "VALUES ('owner', 'pending', ?1, NULL, NULL, NULL, NULL, NULL, NULL, ?2, ?2) "
      + "ON CONFLICT(id) DO UPDATE SET status = 'pending', state = excluded.state, refresh_token = NULL, access_token = NULL, access_expires_at = NULL, updated_at = excluded.updated_at",
    ).bind(state, t));
  }
  stmts.push(auditStmt(db, actor, "spotify.connect", "spotify_auth", "owner", row ? { status: row.status } : null, { status: row && row.status === "connected" ? "connected" : "pending" }));
  await db.batch(stmts);
  return { url: authorizeUrl(clientCredentials(env).id, redirectUriFor(requestUrl), state) };
}

function errorName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "error";
}

// The callback. `error` -> 400; the state must match the row's (403, and it is cleared on
// use, so it is single-use); then the code is exchanged, /me read, the tokens stored, the
// playlist created once when spotifyPlaylistId is empty, spotifyEnabled set true.
export async function finishConnect(
  env: Env, db: D1Database, settings: Settings, requestUrl: string,
  params: { code?: string; state?: string; error?: string }, actor: string, deps: SpotifyDeps = {},
): Promise<{ playlistId: string }> {
  if (hasText(params.error)) throw new ApiHttpError(400, "validation", "Spotify answered " + errorName(params.error), false, errorName(params.error));
  if (!spotifyConfigured(env)) throw new ApiHttpError(503, "provider_not_configured", "Spotify is not configured", false, "spotify");
  const row = await getSpotifyAuth(db);
  if (!row || !hasText(row.state) || !hasText(params.state) || params.state !== row.state) {
    throw new ApiHttpError(403, "forbidden", "the Spotify state does not match", false, "state_mismatch");
  }
  // Single-use: cleared before the exchange, so a replay of the same callback fails.
  await db.prepare("UPDATE spotify_auth SET state = NULL, updated_at = ?1 WHERE id = 'owner'").bind(nowIso()).run();
  if (!hasText(params.code)) throw new ApiHttpError(400, "validation", "the callback carried no code", false, "code");

  const f = deps.fetch ?? spotifyFetch(env);
  const now = deps.now ? deps.now() : new Date();
  let token: TokenAnswer;
  let me: MeAnswer;
  try {
    token = await tokenRequest(env, f, { grant_type: "authorization_code", code: params.code.trim(), redirect_uri: redirectUriFor(requestUrl) });
    me = await readMe(f, token.access_token);
  } catch (e) {
    throw toProviderError(e);
  }
  if (!me.id) throw new ApiHttpError(502, "provider_failed", "Spotify did not return the user id", false, "me_forbidden");
  if (!token.refresh_token) throw new ApiHttpError(502, "provider_failed", "Spotify returned no refresh token", false, "no_refresh_token");

  const expiresAt = new Date(now.getTime() + token.expires_in * 1000).toISOString();
  const t = now.toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      "UPDATE spotify_auth SET status = 'connected', state = NULL, refresh_token = ?1, access_token = ?2, access_expires_at = ?3, scope = ?4, spotify_user_id = ?5, display_name = ?6, updated_at = ?7 WHERE id = 'owner'",
    ).bind(token.refresh_token, token.access_token, expiresAt, token.scope ?? SPOTIFY_SCOPES, me.id, me.displayName, t),
  ];
  stmts.push(premiumCacheStmt(db, me.premium, t));
  await db.batch(stmts);

  const s = spotifySettingsOf(settings);
  let playlistId = hasText(s.spotifyPlaylistId) ? s.spotifyPlaylistId.trim() : "";
  const patch: Record<string, unknown> = { spotifyEnabled: true };
  if (!playlistId) {
    const name = hasText(s.spotifyPlaylistName) ? s.spotifyPlaylistName.trim() : DEFAULT_PLAYLIST_NAME;
    try {
      playlistId = (await createPlaylist(f, token.access_token, name)).id;
    } catch (e) {
      throw toProviderError(e);
    }
    patch.spotifyPlaylistId = playlistId;
  }
  await putSettings(db, patch as Partial<Settings>);
  await auditStmt(db, actor, "spotify.connected", "spotify_auth", "owner", null, { spotifyUserId: me.id, displayName: me.displayName, playlistId }).run();
  return { playlistId };
}

// ------------------------------------------------------------------ tokens

function isInvalidGrant(e: unknown): boolean {
  if (!(e instanceof SpotifyHttpError) || e.status !== 400) return false;
  try {
    const j = JSON.parse(e.body) as { error?: unknown };
    return j.error === "invalid_grant";
  } catch {
    return /invalid_grant/.test(e.body);
  }
}

async function freshToken(env: Env, db: D1Database, row: SpotifyAuthRow, slackMs: number, deps: SpotifyDeps): Promise<{ token: string; expiresAt: string } | null> {
  const now = deps.now ? deps.now() : new Date();
  if (row.status !== "connected" || !hasText(row.refresh_token)) return null;
  const exp = row.access_expires_at ? Date.parse(row.access_expires_at) : NaN;
  if (hasText(row.access_token) && Number.isFinite(exp) && exp - now.getTime() > slackMs) return { token: row.access_token, expiresAt: row.access_expires_at as string };
  const f = deps.fetch ?? spotifyFetch(env);
  let answer: TokenAnswer;
  try {
    answer = await tokenRequest(env, f, { grant_type: "refresh_token", refresh_token: row.refresh_token });
  } catch (e) {
    if (isInvalidGrant(e)) {
      // He revoked the app on Spotify: the row goes back to pending so the Model page shows
      // Connect again. spotifyEnabled stays as he set it; the add path answers off meanwhile.
      const t = now.toISOString();
      await db.batch([
        db.prepare("UPDATE spotify_auth SET status = 'pending', state = NULL, refresh_token = NULL, access_token = NULL, access_expires_at = NULL, updated_at = ?1 WHERE id = 'owner'").bind(t),
        auditStmt(db, "system", "spotify.revoked", "spotify_auth", "owner", { status: "connected" }, { status: "pending", reason: "invalid_grant" }),
      ]);
      return null;
    }
    throw toProviderError(e);
  }
  const expiresAt = new Date(now.getTime() + answer.expires_in * 1000).toISOString();
  const refresh = answer.refresh_token ?? row.refresh_token;
  await db.prepare("UPDATE spotify_auth SET access_token = ?1, access_expires_at = ?2, refresh_token = ?3, updated_at = ?4 WHERE id = 'owner'")
    .bind(answer.access_token, expiresAt, refresh, now.toISOString()).run();
  return { token: answer.access_token, expiresAt };
}

// The stored access token while more than 60 s remain, else one refresh (rotating the
// refresh token when a new one comes back). Null when not connected or revoked.
export async function accessToken(env: Env, db: D1Database, deps: SpotifyDeps = {}): Promise<string | null> {
  const row = await getSpotifyAuth(db);
  if (!row) return null;
  const t = await freshToken(env, db, row, TOKEN_SLACK_MS, deps);
  return t ? t.token : null;
}

// GET /api/spotify/token (Amendment A1): the short-lived access token for the Web Playback
// SDK, refreshed when under five minutes remain, the Premium flag cached for a day. Never
// audited, never logged; the refresh token never leaves the Worker.
export async function tokenView(env: Env, db: D1Database, settings: Settings, deps: SpotifyDeps = {}): Promise<SpotifyTokenView> {
  const row = await getSpotifyAuth(db);
  if (!row || row.status !== "connected") throw new ApiHttpError(403, "not_connected", "Spotify is not connected", false);
  const now = deps.now ? deps.now() : new Date();
  const t = await freshToken(env, db, row, PAGE_TOKEN_SLACK_MS, deps);
  if (!t) throw new ApiHttpError(403, "not_connected", "Spotify is not connected", false);
  let premium = await cachedPremium(db, now);
  if (premium === undefined) {
    const f = deps.fetch ?? spotifyFetch(env);
    try {
      premium = (await readMe(f, t.token)).premium;
      await premiumCacheStmt(db, premium, now.toISOString()).run();
    } catch {
      // Unknown, and not cached: a failed read never turns the player off for a day.
      premium = null;
    }
  }
  const s = spotifySettingsOf(settings);
  return { accessToken: t.token, expiresAt: t.expiresAt, premium, deviceName: SPOTIFY_DEVICE_NAME, player: hasText(s.spotifyPlayer) ? s.spotifyPlayer : "sdk" };
}

// ------------------------------------------------------------------ the add

function readSong(row: MessageRow): (SongRef & { trackUrl?: string; uri?: string }) | null {
  if (!hasText(row.song_json)) return null;
  try {
    const j = JSON.parse(row.song_json) as Record<string, unknown>;
    if (typeof j !== "object" || j === null || !hasText(j.title)) return null;
    const out: SongRef & { trackUrl?: string; uri?: string } = {
      artist: hasText(j.artist) ? j.artist : "",
      title: j.title,
      searchUrl: hasText(j.searchUrl) ? j.searchUrl : "",
    };
    if (hasText(j.trackUrl)) out.trackUrl = j.trackUrl;
    if (hasText(j.uri)) out.uri = j.uri;
    return out;
  } catch {
    return null;
  }
}

function statusStmt(db: D1Database, messageId: string, status: SpotifyStatus, songJson: string | null): D1PreparedStatement {
  if (songJson === null) return db.prepare("UPDATE messages SET spotify_status = ?1 WHERE id = ?2").bind(status, messageId);
  return db.prepare("UPDATE messages SET spotify_status = ?1, song_json = ?2 WHERE id = ?3").bind(status, songJson, messageId);
}

function failureClass(e: unknown): string {
  if (e instanceof SpotifyHttpError) return "http_" + e.status;
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof Error) return e.name;
  return "unknown";
}

// Best effort after her reply is stored: off when disabled, not connected or no song; the
// local LIKE probe on song_json for the uri answers already (nothing sent); search, pick,
// add; a 404 on the playlist creates it again once and retries; anything else is failed.
// The outcome is the status on the message (and the rewritten song_json with trackUrl and
// uri once a track is found), written in one statement, plus one log line by class.
export async function addSongForMessage(env: Env, db: D1Database, settings: Settings, messageId: string, deps: SpotifyDeps = {}): Promise<SpotifyStatus> {
  const row = await getMessage(db, messageId);
  if (!row) throw new ApiHttpError(404, "not_found", "message not found");
  const song = readSong(row);
  if (!song) return "off";
  const s = spotifySettingsOf(settings);
  const finish = async (status: SpotifyStatus, track: SpotifyTrack | null): Promise<SpotifyStatus> => {
    const json = track ? JSON.stringify({ ...song, trackUrl: track.url, uri: track.uri }) : null;
    await statusStmt(db, messageId, status, json).run();
    return status;
  };
  if (s.spotifyEnabled !== true) return finish("off", null);
  let token: string | null;
  try {
    token = await accessToken(env, db, deps);
  } catch (e) {
    console.log("spotify add: token failed (" + failureClass(e) + ")");
    return finish("failed", null);
  }
  if (!token) return finish("off", null);
  const f = deps.fetch ?? spotifyFetch(env);

  let track: SpotifyTrack | null;
  try {
    const q = searchQuery(song);
    const json = await apiGet(f, token, "/search?q=" + encodeURIComponent(q) + "&type=track&limit=" + SEARCH_LIMIT);
    const tracks = typeof json === "object" && json !== null ? (json as { tracks?: { items?: unknown } }).tracks?.items : null;
    track = pickTrack(tracks, song);
  } catch (e) {
    console.log("spotify add: search failed (" + failureClass(e) + ")");
    return finish("failed", null);
  }
  if (!track) return finish("not_found", null);

  // Only a song that actually reached the playlist counts: a failed add also stores the
  // uri on its message, and must never make the same song read "already" for good.
  const dup = await db.prepare("SELECT id FROM messages WHERE song_json LIKE ?1 AND id != ?2 AND spotify_status IN ('added', 'already') LIMIT 1")
    .bind("%\"uri\":\"" + track.uri + "\"%", messageId).first<{ id: string }>();
  if (dup) return finish("already", track);

  let playlistId = hasText(s.spotifyPlaylistId) ? s.spotifyPlaylistId.trim() : "";
  const recreate = async (): Promise<string> => {
    const name = hasText(s.spotifyPlaylistName) ? s.spotifyPlaylistName.trim() : DEFAULT_PLAYLIST_NAME;
    const made = await createPlaylist(f, token as string, name);
    await putSettings(db, { spotifyPlaylistId: made.id } as Record<string, unknown> as Partial<Settings>);
    return made.id;
  };
  try {
    if (!playlistId) playlistId = await recreate();
    try {
      await apiPost(f, token, SPOTIFY_ADD_PATH(playlistId), { uris: [track.uri] });
    } catch (e) {
      if (!(e instanceof SpotifyHttpError) || e.status !== 404) throw e;
      playlistId = await recreate();
      await apiPost(f, token, SPOTIFY_ADD_PATH(playlistId), { uris: [track.uri] });
    }
  } catch (e) {
    console.log("spotify add: add failed (" + failureClass(e) + ")");
    return finish("failed", track);
  }
  return finish("added", track);
}

// ------------------------------------------------------------------ disconnect and the playlist check

// The row goes; the playlist stays on his account; spotifyEnabled false.
export async function disconnect(_env: Env, db: D1Database, actor: string): Promise<void> {
  const row = await getSpotifyAuth(db);
  await db.batch([
    db.prepare("DELETE FROM spotify_auth WHERE id = 'owner'"),
    auditStmt(db, actor, "spotify.disconnect", "spotify_auth", "owner", row ? { status: row.status, spotifyUserId: row.spotify_user_id } : null, null),
  ]);
  await putSettings(db, { spotifyEnabled: false } as Record<string, unknown> as Partial<Settings>);
}

// One GET on the playlist; ok false on any failure or with no playlist id.
export async function playlistStatus(env: Env, db: D1Database, settings: Settings, deps: SpotifyDeps = {}): Promise<{ ok: boolean; name: string | null }> {
  const s = spotifySettingsOf(settings);
  const id = hasText(s.spotifyPlaylistId) ? s.spotifyPlaylistId.trim() : "";
  if (!id) return { ok: false, name: null };
  try {
    const token = await accessToken(env, db, deps);
    if (!token) return { ok: false, name: null };
    const f = deps.fetch ?? spotifyFetch(env);
    const json = await apiGet(f, token, "/playlists/" + encodeURIComponent(id) + "?fields=id,name");
    const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
    if (!hasText(o.id)) return { ok: false, name: null };
    return { ok: true, name: hasText(o.name) ? o.name : null };
  } catch {
    return { ok: false, name: null };
  }
}

// The whole GET /api/spotify body in one call (the status view plus the playlist check when
// connected). Never a token.
export async function statusResponse(env: Env, db: D1Database, settings: Settings, deps: SpotifyDeps = {}): Promise<SpotifyStatusView & { playlist: { ok: boolean; name: string | null } | null }> {
  const row = await getSpotifyAuth(db);
  const view = statusView(row, settings, spotifyConfigured(env));
  const playlist = view.connected ? await playlistStatus(env, db, settings, deps) : null;
  return { ...view, playlist };
}
