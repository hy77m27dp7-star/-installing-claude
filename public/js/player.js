// The Spotify player through his account (v4, Amendment A1). The page becomes a Spotify
// Connect device named "Avelie" through the Web Playback SDK, so a song she sends plays in
// full inside the chat and her phone panel. One page-level contract, nothing else:
//
//   window.dispatchEvent(new CustomEvent("avelie:play", { detail: { uri, uris?, target? } }))
//   window.dispatchEvent(new CustomEvent("avelie:pause"))
//   window.dispatchEvent(new CustomEvent("avelie:resume"))
//   window.dispatchEvent(new CustomEvent("avelie:toggle"))
//   window.dispatchEvent(new CustomEvent("avelie:next"))
//   window.dispatchEvent(new CustomEvent("avelie:queue", { detail: { uri } }))
//
// and this module answers with
//
//   "avelie:player" detail { state: "ready" | "playing" | "paused" | "off", track: { name, artist, uri } | null,
//                            position, duration, reason?, embedSrc? }
//
// A track uri rides in `uris`; a playlist or album uri (the phone panel's queue control
// sends her playlist) plays as `context_uri`, the shape Spotify's play endpoint requires.
// The song card and the phone panel dispatch the events and render from avelie:player; they
// never call Spotify. The SDK is loaded from https://sdk.scdn.co/spotify-player.js (Spotify's
// terms; the one outside script the app allows), only on the first play, and the device is
// created once per page. The page holds only the short-lived access token GET
// /api/spotify/token hands it; the refresh token never leaves the Worker.
//
// Without Premium (or where the SDK cannot run, iOS Safari for one), the embed
// https://open.spotify.com/embed/track/<id> is rendered in place of the play control (the
// event's `target` element, else #nowPlaying) and the state dispatched is "off" with the
// embed's src, so a card can render it itself. Spotify stopped reporting the account type
// to Development Mode apps (February 2026), so an unknown `premium` (null) tries the SDK
// and its own account_error turns a free account into the embed. With spotifyPlayer "off"
// nothing plays here: the state is "off" with reason player_off and no embed.
import { api } from "./api.js";

export const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
export const EMBED_BASE = "https://open.spotify.com/embed/track/";
const EMBED_ROOT = "https://open.spotify.com/embed/";
export const DEVICE_NAME = "Avelie";
const SPOTIFY_API = "https://api.spotify.com/v1";
const TOKEN_SLACK_MS = 60 * 1000;
const PROGRESS_MS = 1000;
const READY_TIMEOUT_MS = 12000;

let token = null;          // { accessToken, expiresAt (ms), premium, player }
let sdkPromise = null;
let player = null;
let deviceId = null;
let readyPromise = null;
let progressTimer = null;
let last = { state: "off", track: null, position: 0, duration: 0 };
let embedMode = false;

export function trackIdOf(uri) {
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(String(uri || "").trim());
  if (m) return m[1];
  const u = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(String(uri || ""));
  return u ? u[1] : null;
}

// A playlist, album or artist uri: the context the play endpoint takes; null for a track or junk.
export function contextOf(uri) {
  const m = /^spotify:(playlist|album|artist):([A-Za-z0-9]+)$/.exec(String(uri || "").trim());
  return m ? { kind: m[1], id: m[2], uri: m[0] } : null;
}

export function embedSrcFor(uri) {
  const id = trackIdOf(uri);
  if (id) return EMBED_BASE + encodeURIComponent(id);
  const ctx = contextOf(uri);
  return ctx ? EMBED_ROOT + ctx.kind + "/" + encodeURIComponent(ctx.id) : null;
}

function dispatch(detail) {
  last = { ...last, ...detail };
  try {
    window.dispatchEvent(new CustomEvent("avelie:player", { detail: { ...last } }));
  } catch { /* nothing listening */ }
}

export function playerState() {
  return { ...last };
}

// The short-lived token from the Worker; cached until a minute before it expires.
async function getToken() {
  if (token && token.expiresAt - Date.now() > TOKEN_SLACK_MS) return token;
  const t = await api("GET", "/api/spotify/token");
  const exp = Date.parse(t && t.expiresAt);
  token = {
    accessToken: String(t && t.accessToken || ""),
    expiresAt: Number.isFinite(exp) ? exp : Date.now() + 5 * 60 * 1000,
    // true, false, or null when Spotify did not say.
    premium: t && typeof t.premium === "boolean" ? t.premium : null,
    player: t && typeof t.player === "string" ? t.player : "sdk",
  };
  if (!token.accessToken) throw Object.assign(new Error("no token"), { code: "no_token" });
  return token;
}

function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.Spotify && window.Spotify.Player) { resolve(window.Spotify); return; }
    const prev = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (typeof prev === "function") { try { prev(); } catch { /* theirs */ } }
      resolve(window.Spotify);
    };
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => reject(Object.assign(new Error("sdk"), { code: "sdk_load" }));
    document.head.append(s);
  });
  return sdkPromise;
}

function stopProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function startProgress() {
  stopProgress();
  progressTimer = setInterval(async () => {
    if (!player) return;
    try {
      const st = await player.getCurrentState();
      if (!st) return;
      dispatch({ position: st.position || 0, duration: st.duration || 0 });
    } catch { /* between states */ }
  }, PROGRESS_MS);
}

function trackOf(st) {
  const t = st && st.track_window && st.track_window.current_track;
  if (!t) return null;
  return { name: String(t.name || ""), artist: (t.artists || []).map((a) => a && a.name).filter(Boolean).join(", "), uri: String(t.uri || "") };
}

// Creates the Connect device once per page. Resolves with the device id, or rejects with
// a code the caller turns into the embed: not_connected, no_premium, sdk_load, sdk_init,
// sdk_auth, sdk_account, ready_timeout.
async function ensureDevice() {
  if (deviceId) return deviceId;
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const t = await getToken();
    if (t.player === "off") throw Object.assign(new Error("off"), { code: "player_off" });
    if (t.player === "embed") throw Object.assign(new Error("embed"), { code: "embed_only" });
    if (t.premium === false) throw Object.assign(new Error("premium"), { code: "no_premium" });
    const Spotify = await loadSdk();
    if (!Spotify || !Spotify.Player) throw Object.assign(new Error("sdk"), { code: "sdk_load" });
    player = new Spotify.Player({
      name: DEVICE_NAME,
      getOAuthToken: (cb) => { getToken().then((x) => cb(x.accessToken)).catch(() => cb("")); },
      volume: 0.8,
    });
    const id = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ready_timeout" })), READY_TIMEOUT_MS);
      player.addListener("ready", ({ device_id }) => { clearTimeout(timer); resolve(device_id); });
      player.addListener("not_ready", () => { deviceId = null; dispatch({ state: "off", reason: "not_ready" }); });
      player.addListener("initialization_error", () => { clearTimeout(timer); reject(Object.assign(new Error("init"), { code: "sdk_init" })); });
      player.addListener("authentication_error", () => { clearTimeout(timer); token = null; reject(Object.assign(new Error("auth"), { code: "sdk_auth" })); });
      player.addListener("account_error", () => { clearTimeout(timer); reject(Object.assign(new Error("account"), { code: "sdk_account" })); });
      player.addListener("playback_error", () => { /* the state listener reports the outcome */ });
      player.addListener("player_state_changed", (st) => {
        if (!st) { stopProgress(); dispatch({ state: "ready", track: null, position: 0, duration: 0 }); return; }
        const track = trackOf(st);
        if (st.paused) { stopProgress(); dispatch({ state: "paused", track, position: st.position || 0, duration: st.duration || 0 }); }
        else { dispatch({ state: "playing", track, position: st.position || 0, duration: st.duration || 0 }); startProgress(); }
      });
      player.connect().then((ok) => { if (!ok) { clearTimeout(timer); reject(Object.assign(new Error("connect"), { code: "sdk_init" })); } })
        .catch(() => { clearTimeout(timer); reject(Object.assign(new Error("connect"), { code: "sdk_init" })); });
    });
    deviceId = id;
    dispatch({ state: "ready", track: null, position: 0, duration: 0 });
    return id;
  })();
  try {
    return await readyPromise;
  } catch (e) {
    readyPromise = null;
    if (player) { try { player.disconnect(); } catch { /* gone */ } }
    player = null;
    throw e;
  }
}

async function spotifyCall(method, path, body) {
  const t = await getToken();
  const init = { method, headers: { authorization: "Bearer " + t.accessToken } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(SPOTIFY_API + path, init);
  if (res.status === 401) token = null;
  if (!res.ok && res.status !== 204) throw Object.assign(new Error("spotify " + res.status), { code: "spotify_" + res.status });
  return res;
}

// The embed in place of the play control: the event's target element, else #nowPlaying.
function renderEmbed(uri, target) {
  const src = embedSrcFor(uri);
  if (!src) return null;
  const host = target instanceof Element ? target : document.getElementById("nowPlaying");
  if (host) {
    const frame = document.createElement("iframe");
    frame.setAttribute("src", src);
    frame.setAttribute("title", "Spotify");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("allow", "encrypted-media; autoplay; clipboard-write");
    frame.setAttribute("width", "100%");
    frame.setAttribute("height", "80");
    frame.className = "spotify-embed";
    const old = host.querySelector("iframe.spotify-embed");
    if (old) old.remove();
    if (target instanceof Element) host.replaceChildren(frame);
    else host.append(frame);
    host.classList.remove("hidden");
  }
  return src;
}

function fallback(uri, target, reason) {
  embedMode = true;
  const embedSrc = renderEmbed(uri, target);
  dispatch({ state: "off", track: null, position: 0, duration: 0, reason, embedSrc });
}

// Play: the device first, then PUT /me/player/play on it. Any refusal becomes the embed.
export async function play(detail) {
  const d = detail || {};
  const uris = Array.isArray(d.uris) && d.uris.length ? d.uris.filter((u) => typeof u === "string") : d.uri ? [String(d.uri)] : [];
  if (!uris.length) return;
  if (embedMode) { fallback(uris[0], d.target, "embed"); return; }
  let id;
  try {
    id = await ensureDevice();
  } catch (e) {
    if (e && e.code === "player_off") {
      dispatch({ state: "off", track: null, position: 0, duration: 0, reason: "player_off", embedSrc: null });
      return;
    }
    fallback(uris[0], d.target, (e && e.code) || "unavailable");
    return;
  }
  try {
    if (player && typeof player.activateElement === "function") { try { await player.activateElement(); } catch { /* not required */ } }
    const ctx = uris.length === 1 ? contextOf(uris[0]) : null;
    await spotifyCall("PUT", "/me/player/play?device_id=" + encodeURIComponent(id), ctx ? { context_uri: ctx.uri } : { uris });
  } catch (e) {
    fallback(uris[0], d.target, (e && e.code) || "play_failed");
  }
}

export async function pause() {
  if (!player) return;
  try { await player.pause(); } catch { /* nothing playing */ }
}

export async function resume() {
  if (!player) return;
  try { await player.resume(); } catch { /* nothing to resume */ }
}

export async function toggle() {
  if (!player) return;
  try { await player.togglePlay(); } catch { /* nothing to toggle */ }
}

export async function next() {
  if (!player) return;
  try { await player.nextTrack(); } catch { /* end of the list */ }
}

// Queue: POST /me/player/queue on the Avelie device (her picks from the panel).
export async function queue(detail) {
  const uri = detail && detail.uri ? String(detail.uri) : "";
  if (!uri) return;
  let id;
  try {
    id = await ensureDevice();
    await spotifyCall("POST", "/me/player/queue?uri=" + encodeURIComponent(uri) + "&device_id=" + encodeURIComponent(id));
  } catch (e) {
    dispatch({ reason: (e && e.code) || "queue_failed" });
  }
}

// Warms the device without playing (a page that shows the now-playing strip may call it
// after a tap). Never at import time: no token is fetched until something asks.
export async function ensurePlayer() {
  try {
    await ensureDevice();
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("avelie:play", (e) => { play(e.detail); });
  window.addEventListener("avelie:pause", () => { pause(); });
  window.addEventListener("avelie:resume", () => { resume(); });
  window.addEventListener("avelie:toggle", () => { toggle(); });
  window.addEventListener("avelie:next", () => { next(); });
  window.addEventListener("avelie:queue", (e) => { queue(e.detail); });
  window.addEventListener("pagehide", () => { stopProgress(); if (player) { try { player.disconnect(); } catch { /* gone */ } } });
}
