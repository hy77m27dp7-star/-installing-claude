// Her phone (DESIGN_EXPERIENCE 4.1 to 4.6): you picked up her phone. Three views inside the
// one device on phone.html, chosen by the hash (lockwords.appFromHash): the lock screen
// (#lock, the default), her apps (#home) and one app full-screen (#maps, #notes, #music,
// #photos) in #appScreen. A vertical drag of 80px up on the lock screen opens her apps, down
// on her apps locks the phone again; the handle buttons do the same for taps and keys, and
// every move is a hash, so Back works.
//
// The lock screen reads GET /api/phone/lock every minute while the page is visible. Its
// clock is HER clock: while the story clock runs (`frozen` false) the time and the date tick
// here every 15 s from the offset measured at the read; while a together scene holds it
// (`frozen` true) the tick stops and the screen shows exactly what the read answered.
// Her apps read GET /api/phone (the map and her places, the song on her mind), GET /api/sent
// (the songs she sent), GET /api/spotify (her playlist) and GET /api/roll (her pictures).
// Nothing here writes: placing a place on her map is the writer's, in Studio.
//
// Every run-time value goes through the CSSOM (objectPosition, a progress width) or a plain
// SVG attribute; no style attribute is ever written (the CSP has no unsafe-inline). Labels
// only, no prose, and nothing empty is ever drawn: an empty list hides its element.
import { api, h } from "./api.js";
import { drawMap, pulsePlace } from "./map.js";
import {
  APP_NAMES, APP_TITLES, appFromHash, whenWords, weatherWords, tickOffset, clockWords, dateWords,
  focusPosition, progressWidth, noteNext, drawableRoll, pinnedPlaces, songLines, playlistIdOf, listKey,
} from "./lockwords.js";
// player.js (A1) answers the play, pause and next events this page dispatches; importing it
// only registers its listeners (no token is fetched until something plays).
import "./player.js";

const LOCK_MS = 60 * 1000;
const TICK_MS = 15 * 1000;
const FRESH_MS = 60 * 1000;
const SWIPE_PX = 80;
const STRIP_MAX = 6;
const PHOTOS_MAX = 12;
const SPOTIFY_EMBED = "https://open.spotify.com/embed/playlist/";
const SPOTIFY_SEARCH = "https://open.spotify.com/search/";
const SVG_NS = "http://www.w3.org/2000/svg";

// Line glyphs on a 24 grid (stroke currentColor, 1.7, round), and two filled ones.
const GLYPH = {
  messages: ["M4.5 5.5h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4.5 3.5v-3.5h-1a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"],
  music: ["M9 18V5.5l11-2V16", "M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0z", "M20 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0z"],
  calendar: ["M4.5 6.5h15v13h-15z", "M4.5 10.5h15", "M8.5 4v4", "M15.5 4v4"],
  pause: ["M8.5 5.5v13", "M15.5 5.5v13"],
  next: ["M6 6l8.5 6L6 18z", "M18 6v12"],
};
const PLAY = ["M8 5.5v13l10.5-6.5z"];

const S = {
  lock: null,        // the last GET /api/phone/lock answer
  offset: 0,         // story now minus wall now, at that read
  frozen: false,
  tz: "",
  phone: null,       // GET /api/phone
  sent: null,        // GET /api/sent items
  spotify: null,     // GET /api/spotify
  roll: null,        // GET /api/roll?limit=12 items
  view: "lock",
  appToken: 0,
  lockTimer: null,
  tickTimer: null,
  stackKey: null,
  stripKey: null,
  playing: false,
  card: null,
};
const cache = {};

// ------------------------------------------------------------------ small helpers

const $ = (id) => document.getElementById(id);

function icon(paths, filled) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", filled ? "currentColor" : "transparent");
  svg.setAttribute("stroke", filled ? "transparent" : "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}

function show(el, on) {
  if (el) el.classList.toggle("hidden", !on);
}

function encode(id) {
  return encodeURIComponent(String(id));
}

function storyNowMs() {
  if (S.frozen && S.lock) {
    const held = Date.parse(S.lock.now);
    if (Number.isFinite(held)) return held;
  }
  return Date.now() + S.offset;
}

// One GET per source, shared by whoever asks first; a fresh answer is reused for a minute.
function load(key, path, pick) {
  const c = cache[key];
  if (c && c.pending) return c.pending;
  if (c && Date.now() - c.at < FRESH_MS) return Promise.resolve(S[key]);
  const pending = api("GET", path)
    .then((r) => pick(r))
    .catch(() => S[key])
    .then((v) => {
      S[key] = v === undefined ? null : v;
      cache[key] = { at: Date.now(), pending: null };
      updateIcons();
      return S[key];
    });
  cache[key] = { at: c ? c.at : 0, pending };
  return pending;
}

const asObject = (r) => (r && typeof r === "object" ? r : null);
const asItems = (r) => (r && Array.isArray(r.items) ? r.items : []);
const loadPhone = () => load("phone", "/api/phone", asObject);
const loadSent = () => load("sent", "/api/sent", asItems);
const loadSpotify = () => load("spotify", "/api/spotify", asObject);
const loadRoll = () => load("roll", "/api/roll?limit=" + PHOTOS_MAX, asItems);

// ------------------------------------------------------------------ what each app holds

function wants() {
  const list = S.lock && Array.isArray(S.lock.wants) ? S.lock.wants : [];
  return list.filter((w) => w && typeof w.title === "string" && w.title.trim());
}

function sentSongs() {
  const list = Array.isArray(S.sent) ? S.sent : [];
  return list.filter((s) => s && s.kind === "song" && typeof s.label === "string" && s.label.trim());
}

function listening() {
  const l = S.phone && S.phone.listening;
  return l && typeof l === "object" && (l.title || l.artist) ? l : null;
}

function photos() {
  return drawableRoll(S.roll, PHOTOS_MAX);
}

// An app with nothing in it is not on her home screen (Maps only once a place of hers is
// pinned: the city outline alone is an empty card; Messages always is). Unknown yet counts
// as empty, so an icon never flashes away.
function hasApp(name) {
  switch (name) {
    case "maps": return pinnedPlaces(S.phone && S.phone.places).length > 0;
    case "notes": return wants().length > 0;
    case "photos": return photos().length > 0;
    case "music": return Boolean(listening()) || sentSongs().length > 0 || Boolean(playlistIdOf(S.spotify));
    default: return true;
  }
}

function updateIcons() {
  for (const name of ["maps", "notes", "photos", "music"]) {
    for (const a of document.querySelectorAll('.app[data-app="' + name + '"]')) show(a, hasApp(name));
  }
}

// ------------------------------------------------------------------ the lock screen

async function loadLock() {
  let lock;
  try {
    lock = await api("GET", "/api/phone/lock");
  } catch {
    return;
  }
  if (!lock || typeof lock !== "object") return;
  S.lock = lock;
  S.offset = tickOffset(lock.now, Date.now());
  S.frozen = lock.frozen === true;
  S.tz = typeof lock.tz === "string" ? lock.tz : "";
  renderLock();
  updateIcons();
  syncTick();
  if (S.view === "notes") openApp("notes", false);
}

// The time and the date: exactly the answer while her clock is held, else ticked here.
function renderClock() {
  const timeEl = $("lockTime");
  const dateEl = $("lockDate");
  let time = "";
  let date = "";
  if (S.frozen && S.lock) {
    time = String(S.lock.time || "") || clockWords(storyNowMs(), S.tz);
    date = String(S.lock.dateLine || "") || dateWords(storyNowMs(), S.tz);
  } else {
    const ms = storyNowMs();
    time = clockWords(ms, S.tz) || (S.lock ? String(S.lock.time || "") : "");
    date = dateWords(ms, S.tz) || (S.lock ? String(S.lock.dateLine || "") : "");
  }
  if (timeEl && timeEl.textContent !== time) timeEl.textContent = time;
  if (dateEl && dateEl.textContent !== date) dateEl.textContent = date;
  for (const t of document.querySelectorAll("#lockStack time.notif-when")) {
    const words = whenWords(t.getAttribute("datetime"), storyNowMs(), S.tz);
    if (words && t.textContent !== words) t.textContent = words;
  }
}

function stopTick() {
  if (S.tickTimer) clearInterval(S.tickTimer);
  S.tickTimer = null;
}

// A held clock does not move on her phone either: no tick until a read says it runs again.
function syncTick() {
  stopTick();
  renderClock();
  if (S.frozen) return;
  if (typeof document !== "undefined" && document.hidden) return;
  S.tickTimer = setInterval(renderClock, TICK_MS);
}

function setWallpaper(img, wp) {
  if (!img || !wp || typeof wp.url !== "string" || !wp.url) return;
  img.style.objectPosition = focusPosition(wp.focus);
  if (img.getAttribute("src") !== wp.url) img.src = wp.url;
}

function renderLock() {
  const lock = S.lock;
  if (!lock) return;
  setWallpaper($("wallpaper"), lock.wallpaper);
  setWallpaper($("homeWallpaper"), lock.wallpaper);
  const weather = $("lockWeather");
  if (weather) {
    const words = weatherWords(lock.weather);
    weather.textContent = words;
    show(weather, Boolean(words));
  }
  renderStack(lock.notes);
  renderStrip(lock.roll);
  renderClock();
}

function notifItem(n) {
  const when = n.app === "calendar" ? "" : whenWords(n.at, storyNowMs(), S.tz);
  return h("li", { class: "notif", "data-app": n.app },
    h("div", { class: "notif-head" },
      h("span", { class: "notif-app" }, icon(GLYPH[n.app]), APP_NAMES[n.app]),
      when ? h("time", { class: "notif-when", datetime: String(n.at), text: when }) : null),
    n.title ? h("div", { class: "notif-title", text: n.title }) : null,
    h("div", { class: "notif-text", text: n.text }));
}

function renderStack(notes) {
  const stack = $("lockStack");
  if (!stack) return;
  const list = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && Object.prototype.hasOwnProperty.call(APP_NAMES, n.app) && typeof n.text === "string" && n.text.trim())
    .map((n) => ({ id: String(n.id || ""), app: n.app, title: typeof n.title === "string" ? n.title.trim() : "", text: n.text.trim(), at: String(n.at || "") }));
  const key = listKey(list, ["id", "app", "title", "text", "at"]);
  show(stack, list.length > 0);
  // Unchanged: leave the rows (their arrival plays once), the tick keeps their times.
  if (key === S.stackKey) return;
  S.stackKey = key;
  stack.replaceChildren(...list.map(notifItem));
}

function thumb(it, cls) {
  return h("a", { class: cls + (it.clip ? " clip" : ""), href: "/album#" + encode(it.id), "aria-label": it.clip ? "Clip" : "Picture" },
    h("img", { src: it.src, alt: "", loading: "lazy", decoding: "async" }),
    it.clip ? icon(PLAY, true) : null);
}

function renderStrip(roll) {
  const strip = $("rollStrip");
  if (!strip) return;
  const items = drawableRoll((Array.isArray(roll) ? roll : []).filter((it) => it && it.us !== true), STRIP_MAX);
  const key = listKey(items, ["id", "src"]);
  show(strip, items.length > 0);
  if (key === S.stripKey) return;
  S.stripKey = key;
  strip.replaceChildren(...items.map((it) => thumb(it, "roll-thumb")));
}

// ------------------------------------------------------------------ what is playing

function buildPlayingCard() {
  const card = $("lockPlaying");
  if (!card) return null;
  const title = h("span", { class: "np-title" });
  const artist = h("span", { class: "np-artist" });
  const fill = h("span");
  const progress = h("div", { class: "np-progress", role: "progressbar", "aria-label": "Played", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const toggle = h("button", { type: "button", class: "icon-btn", "aria-label": "Pause", onclick: () => emit(S.playing ? "avelie:pause" : "avelie:resume") }, icon(GLYPH.pause));
  const next = h("button", { type: "button", class: "icon-btn", "aria-label": "Next", onclick: () => emit("avelie:next") }, icon(GLYPH.next));
  card.replaceChildren(
    h("span", { class: "np-note" }, icon(GLYPH.music)),
    h("div", { class: "np-text" }, title, artist),
    toggle,
    next,
    progress);
  show(card, false);
  return { card, title, artist, fill, progress, toggle };
}

function onPlayer(ev) {
  const c = S.card;
  if (!c) return;
  const d = ev && ev.detail && typeof ev.detail === "object" ? ev.detail : {};
  const on = d.state === "playing" || d.state === "paused";
  const track = d.track && typeof d.track === "object" ? d.track : null;
  show(c.card, on && Boolean(track));
  if (!on || !track) return;
  const playing = d.state === "playing";
  c.title.textContent = String(track.name || "");
  c.artist.textContent = String(track.artist || "");
  const width = progressWidth(d.position, d.duration);
  c.fill.style.width = width;
  c.progress.setAttribute("aria-valuenow", String(parseFloat(width) || 0));
  if (playing !== S.playing || !c.toggle.firstChild) {
    c.toggle.replaceChildren(playing ? icon(GLYPH.pause) : icon(PLAY, true));
    c.toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  S.playing = playing;
}

// ------------------------------------------------------------------ her apps

function clearExtras() {
  for (const el of document.querySelectorAll("#appScreen [data-extra]")) el.remove();
}

function renderMaps(body) {
  const phone = S.phone || {};
  const pinned = pinnedPlaces(phone.places);
  const holder = h("div");
  let svg = null;
  svg = drawMap(holder, { ...phone, places: pinned }, { onPlace: (id) => pulsePlace(svg, id) });
  body.append(holder);
  if (!pinned.length) return;
  const list = h("ul", { class: "place-list", id: "placesList", "aria-label": "Places" });
  for (const p of pinned) {
    list.append(h("li", {},
      h("button", { type: "button", class: "map-place", "data-id": String(p.id || ""), text: String(p.title).trim(), onclick: () => {
        if (svg && typeof svg.scrollIntoView === "function") svg.scrollIntoView({ block: "nearest" });
        pulsePlace(svg, p.id);
      } })));
  }
  body.append(list);
}

function renderNotes(body) {
  for (const w of wants()) {
    const next = noteNext(w.next);
    body.append(h("article", { class: "note-line" },
      h("h3", { class: "note-title", text: w.title.trim() }),
      next ? h("p", { class: "note-next", text: next }) : null));
  }
}

function renderMusic(body) {
  const l = listening();
  if (l) {
    const query = (String(l.artist || "") + " " + String(l.title || "")).trim();
    body.append(h("section", { class: "listening" },
      h("span", { class: "np-note" }, icon(GLYPH.music)),
      h("div", { class: "song-text" },
        l.line ? h("span", { class: "song-line", text: l.line }) : null,
        l.title ? h("span", { class: "song-title", text: l.title }) : null,
        l.artist ? h("span", { class: "song-artist", text: l.artist }) : null),
      query ? h("a", { class: "icon-btn", href: SPOTIFY_SEARCH + encodeURIComponent(query), target: "_blank", rel: "noopener", "aria-label": "Play on Spotify" }, icon(PLAY, true)) : null));
  }
  const songs = sentSongs();
  if (songs.length) {
    const now = storyNowMs();
    body.append(h("section", {},
      h("h3", { class: "kicker", text: "Sent to you" }),
      songs.map((s) => {
        const { title, artist } = songLines(s.label);
        const when = whenWords(s.at, now, S.tz);
        return h("div", { class: "sent-song" },
          h("div", { class: "song-text" },
            h("span", { class: "song-title", text: title }),
            artist ? h("span", { class: "song-artist", text: artist }) : null),
          when ? h("time", { datetime: String(s.at), text: when }) : null);
      })));
  }
  const playlistId = playlistIdOf(S.spotify);
  if (playlistId) {
    const name = typeof S.spotify.playlistName === "string" && S.spotify.playlistName.trim() ? S.spotify.playlistName.trim() : "Playlist";
    body.append(h("section", {},
      h("h3", { class: "kicker", text: name }),
      h("button", { type: "button", class: "btn small", text: "Play", onclick: () => emit("avelie:play", { uri: "spotify:playlist:" + playlistId }) }),
      h("iframe", {
        class: "playlist-embed",
        src: SPOTIFY_EMBED + playlistId + "?theme=0",
        title: name,
        height: "352",
        loading: "lazy",
        allow: "encrypted-media; clipboard-write",
        referrerpolicy: "strict-origin-when-cross-origin",
      })));
  }
}

function renderPhotos(body) {
  const bar = document.querySelector("#appScreen .app-bar");
  if (bar) bar.append(h("a", { class: "btn small ghost", href: "/album", "data-extra": "1", text: "All" }));
  body.append(h("div", { class: "photo-grid" }, photos().map((it) =>
    h("a", { href: "/album#" + encode(it.id), "aria-label": it.clip ? "Clip" : "Picture" },
      h("img", { src: it.src, alt: "", loading: "lazy", decoding: "async" }),
      it.clip ? h("span", { class: "play-badge" }, icon(PLAY, true)) : null))));
}

function needs(view) {
  switch (view) {
    case "maps": return loadPhone();
    case "music": return Promise.all([loadPhone(), loadSent(), loadSpotify()]);
    case "photos": return loadRoll();
    case "notes": return S.lockPromise || Promise.resolve();
    default: return Promise.resolve();
  }
}

async function openApp(view, focus) {
  const token = ++S.appToken;
  const title = $("appTitle");
  const body = $("appBody");
  if (title) title.textContent = APP_TITLES[view] || "";
  await needs(view);
  if (token !== S.appToken || S.view !== view) return;
  if (!hasApp(view)) {
    // Nothing in it: her home screen, never an empty app.
    history.replaceState(null, "", "#home");
    showView("home", focus);
    return;
  }
  clearExtras();
  if (body) {
    body.replaceChildren();
    if (view === "maps") renderMaps(body);
    else if (view === "notes") renderNotes(body);
    else if (view === "music") renderMusic(body);
    else if (view === "photos") renderPhotos(body);
  }
}

// ------------------------------------------------------------------ the views

function showView(view, focus) {
  S.view = view;
  const isApp = Object.prototype.hasOwnProperty.call(APP_TITLES, view);
  show($("lock"), view === "lock");
  show($("home"), view === "home");
  show($("appScreen"), isApp);
  if (!isApp) {
    S.appToken++;
    clearExtras();
  }
  if (isApp) openApp(view, focus);
  if (!focus) return;
  let target = null;
  if (view === "lock") target = $("openHome");
  else if (view === "home") target = document.querySelector("#homeGrid .app:not(.hidden)") || document.querySelector("#homeDock .app:not(.hidden)");
  else target = $("appBack");
  if (target && typeof target.focus === "function") target.focus();
}

function go(view) {
  const hash = "#" + view;
  if (location.hash === hash || (view === "lock" && !location.hash)) showView(view, true);
  else location.hash = hash;
}

// A vertical drag of SWIPE_PX or more in `dir` (-1 up, 1 down) on `el` calls `then`; the
// click that ends such a drag is swallowed, so a drag that starts on a picture does not open it.
function swipe(el, dir, then) {
  if (!el) return;
  let start = null;
  let swallow = false;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
  });
  el.addEventListener("pointerup", (ev) => {
    if (!start || ev.pointerId !== start.id) return;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    start = null;
    if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > Math.abs(dx) && Math.sign(dy) === dir) {
      swallow = true;
      setTimeout(() => { swallow = false; }, 400);
      then();
    }
  });
  el.addEventListener("pointercancel", () => { start = null; });
  el.addEventListener("dragstart", (ev) => ev.preventDefault());
  el.addEventListener("click", (ev) => {
    if (!swallow) return;
    swallow = false;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
}

// ------------------------------------------------------------------ the page

function stopLock() {
  if (S.lockTimer) clearInterval(S.lockTimer);
  S.lockTimer = null;
}

function startLock() {
  stopLock();
  S.lockTimer = setInterval(() => { if (!document.hidden) S.lockPromise = loadLock(); }, LOCK_MS);
}

function boot() {
  S.card = buildPlayingCard();
  window.addEventListener("avelie:player", onPlayer);

  const openHome = $("openHome");
  const closeHome = $("closeHome");
  const back = $("appBack");
  if (openHome) openHome.addEventListener("click", () => go("home"));
  if (closeHome) closeHome.addEventListener("click", () => go("lock"));
  if (back) back.addEventListener("click", () => go("home"));
  swipe($("lock"), -1, () => go("home"));
  swipe($("home"), 1, () => go("lock"));

  window.addEventListener("hashchange", () => showView(appFromHash(location.hash), true));
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    if (Object.prototype.hasOwnProperty.call(APP_TITLES, S.view)) go("home");
    else if (S.view === "home") go("lock");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLock();
      stopTick();
    } else {
      S.lockPromise = loadLock();
      startLock();
      syncTick();
    }
  });

  // The device's own clock until the first read lands, so the time is never blank.
  updateIcons();
  renderClock();
  S.lockPromise = loadLock();
  showView(appFromHash(location.hash), false);
  loadPhone();
  loadSent();
  loadSpotify();
  loadRoll();
  startLock();
  syncTick();
}

if (typeof document !== "undefined" && $("lock") && $("home")) boot();
