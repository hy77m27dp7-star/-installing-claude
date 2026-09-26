// Her phone (SPEC_V4 section 1 and 8's places; A1's player strip): renders PhoneState from
// GET /api/phone into the panel's ids. Two homes: the Phone page (main.page.phone, full:
// the map takes a tap, the places list with its controls) and the chat's slide-in drawer
// (chat.js imports renderPhone; read-only there: the map draws, no tap, no places list).
//
// Boot rule: the page code below runs only when main.page.phone exists, and nothing is
// fetched at import time. Every run-time value goes through the CSSOM or a plain SVG
// attribute; no style attribute is ever written (the CSP has no unsafe-inline). Labels
// only, no prose.
import { api, h, chip, clear, flash, ago } from "./api.js";
import { drawMap } from "./map.js";
// player.js (A1) answers the Play / Pause / Next events this panel dispatches; importing it
// only registers its listeners (no token is fetched until something plays).
import "./player.js";

const REFRESH_MS = 60 * 1000;
const SPOTIFY_TTL_MS = 5 * 60 * 1000;
const DIAL_SIZE = 48;
const DIAL_R = 20;
const PHASE_KIND = { fresh: "ok", fading: "amber", faint: "", gone: "" };
const SPOTIFY_EMBED = "https://open.spotify.com/embed/playlist/";
const SPOTIFY_SEARCH = "https://open.spotify.com/search/";
// Every slot the renderer fills, in drawer order: [id, kind, label]. The page carries the
// same ids in its own markup (phone.html, with the design lane's classes); the drawer gets
// them built here with the same classes. Kinds: chips, now (.phone-now), line (the .v of a
// .phone-line with its label), dial (.dial-wrap), stack, listening (.listening), map, list.
const SLOTS = [
  ["phoneStatus", "chips", ""],
  ["phoneNow", "now", ""],
  ["phoneWhere", "line", "Where"],
  ["phoneWeather", "line", "Weather"],
  ["phoneOutfit", "line", "Wearing"],
  ["phoneMood", "dial", ""],
  ["phoneWants", "stack", ""],
  ["phoneAsks", "stack", ""],
  ["phoneToday", "stack", ""],
  ["phoneListening", "listening", ""],
  ["phonePlayer", "stack", ""],
  ["phoneMap", "map", ""],
  ["placesList", "list", ""],
  ["placesStatus", "chips", ""],
];

// ------------------------------------------------------------------ small formatting

function clockIn(iso, tz) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz || undefined }).toLowerCase().replace(/\s/g, "");
  } catch {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\s/g, "");
  }
}

// "7:02pm" from an Open-Meteo wall-clock string ("2026-09-24T19:02").
function wallClock(s) {
  const m = /T(\d{1,2}):(\d{2})/.exec(String(s || ""));
  if (!m) return "";
  const h24 = Number(m[1]);
  const min = m[2];
  if (!Number.isInteger(h24) || h24 > 23) return "";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ":" + min + (h24 < 12 ? "am" : "pm");
}

function coordText(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return "";
  return Number(lat).toFixed(4) + ", " + Number(lon).toFixed(4);
}

function pct(v) {
  return Math.max(0, Math.min(100, Number(v) || 0));
}

function muted(text) {
  return h("div", { class: "now-line muted", text });
}

function progressBar(value) {
  const v = pct(value);
  const fill = h("span");
  fill.style.width = v + "%";
  return h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(v) }, fill);
}

function encode(id) {
  return encodeURIComponent(String(id));
}

// ------------------------------------------------------------------ slots

// The class each slot carries (the design lane's, app.css): a "line" slot is the .v of a
// .phone-line row with its label; the page's markup (phone.html) already has them, the
// drawer's skeleton gets them here.
const SLOT_CLASS = { chips: "chips", now: "phone-now", line: "v", dial: "dial-wrap", listening: "listening", stack: "stack", map: "map-wrap", list: "stack" };

function slot(container, id, kind, label) {
  let el = container.querySelector ? container.querySelector("#" + id) : null;
  if (!el && container.id === id) el = container;
  if (!el) {
    el = h(kind === "line" ? "span" : "div", { id, class: SLOT_CLASS[kind] || "stack", "data-phone": id });
    if (kind === "line") container.append(h("div", { class: "phone-line" }, h("span", { class: "k", text: label || "" }), el));
    else container.append(el);
    return el;
  }
  const cls = SLOT_CLASS[kind];
  if (cls && !el.classList.contains(cls)) el.classList.add(cls);
  if (kind === "line" && !el.closest(".phone-line")) {
    const row = h("div", { class: "phone-line" }, h("span", { class: "k", text: label || "" }));
    el.replaceWith(row);
    row.append(el);
  }
  return el;
}

function fill(el, ...children) {
  clear(el);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
}

function hideIfEmpty(el, show) {
  el.classList.toggle("hidden", !show);
}

// ------------------------------------------------------------------ the pieces

function renderStatus(el, state) {
  fill(el,
    chip(state.timeOfDay || "", "accent"),
    state.scene && state.scene.status === "together" ? chip("together", "ok") : null,
    state.where && state.where.busy ? chip("busy", "amber") : null,
    state.weather ? null : chip("no weather"),
  );
}

// .phone-now: the clock, the day, the time-of-day word.
function renderNow(el, state) {
  fill(el,
    h("span", { class: "clock", text: state.localClock || "" }),
    h("span", { class: "day", text: state.weekday || "" }),
    h("span", { class: "tod", text: state.timeOfDay || "" }));
}

// The .v of a .phone-line: where she is (the scene place when together, else her day's
// label and its "until"), with the state as chips.
function renderWhere(el, state) {
  const scene = state.scene || {};
  const where = state.where || {};
  if (scene.status === "together" && scene.location) {
    fill(el, h("span", { text: scene.location }), h("span", { class: "chips" }, chip("with him", "ok")));
    return;
  }
  if (where.label) {
    const until = where.until ? clockIn(where.until, state.tz) : "";
    fill(el,
      h("span", { text: where.label }),
      until ? h("span", { class: "sub", text: "until " + until }) : null,
      where.busy ? h("span", { class: "chips" }, chip("busy", "amber")) : null);
    return;
  }
  fill(el, h("span", { class: "muted", text: state.city || "" }), h("span", { class: "chips" }, chip("free")));
}

// .weather-line: the temperature, the words, the small line (feels like, wind, sunset).
function renderWeather(el, state) {
  const w = state.weather;
  if (!w || !Number.isFinite(Number(w.temp))) {
    fill(el, muted("--"));
    return;
  }
  const unit = w.units === "celsius" ? "C" : "F";
  const subs = [];
  if (Number.isFinite(Number(w.feels)) && Math.round(w.feels) !== Math.round(w.temp)) subs.push("feels like " + Math.round(w.feels));
  if (Number(w.windMph) >= 20) subs.push("windy");
  const sun = w.isDay ? wallClock(w.sunset) : wallClock(w.sunrise);
  if (sun) subs.push((w.isDay ? "sunset " : "sunrise ") + sun);
  fill(el,
    h("div", { class: "weather-line" },
      h("span", { class: "temp", text: Math.round(w.temp) + unit }),
      w.words ? h("span", { class: "words", text: w.words }) : null,
      subs.length ? h("span", { class: "sub", text: subs.join(", ") }) : null),
    h("div", { class: "chips" }, chip(w.isDay ? "day" : "night", "accent"), state.city ? chip(state.city) : null));
}

function renderOutfit(el, state) {
  const o = state.outfit;
  if (!o || !o.text) {
    fill(el, muted("--"));
    return;
  }
  fill(el, h("span", { text: o.text }),
    h("div", { class: "chips" }, chip(o.from === "photo" ? "photo" : "noted", "accent"), o.at ? chip(clockIn(o.at, state.tz)) : null));
}

// The mood dial: an inline svg.dial with circle.dial-track under circle.dial-fill. The arc
// is (1 - fraction) of the ring, set through stroke-dasharray as plain numbers on a
// pathLength of 100; the colours come from the stylesheet's .dial-track and .dial-fill.
export function moodDial(mood) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "dial");
  svg.setAttribute("viewBox", "0 0 " + DIAL_SIZE + " " + DIAL_SIZE);
  svg.setAttribute("width", String(DIAL_SIZE));
  svg.setAttribute("height", String(DIAL_SIZE));
  svg.setAttribute("role", "img");
  const fraction = mood ? Math.max(0, Math.min(1, Number(mood.fraction) || 0)) : 1;
  const arc = Math.round((1 - fraction) * 1000) / 10;
  svg.setAttribute("aria-label", mood ? "Mood " + mood.mood + ", " + mood.phase : "No mood");
  svg.dataset.fraction = String(fraction);
  const c = DIAL_SIZE / 2;
  const track = document.createElementNS(NS, "circle");
  track.setAttribute("class", "dial-track");
  track.setAttribute("cx", String(c));
  track.setAttribute("cy", String(c));
  track.setAttribute("r", String(DIAL_R));
  track.setAttribute("fill", "none");
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("class", "dial-fill");
  ring.setAttribute("cx", String(c));
  ring.setAttribute("cy", String(c));
  ring.setAttribute("r", String(DIAL_R));
  ring.setAttribute("fill", "none");
  ring.setAttribute("pathLength", "100");
  ring.setAttribute("stroke-dasharray", arc + " 100");
  ring.setAttribute("stroke-dashoffset", "0");
  // The stylesheet's .dial rule turns the whole svg so the arc starts at the top.
  svg.append(track, ring);
  return svg;
}

// .dial-wrap (the slot itself): the dial beside .dial-text (the mood, its chips, its age).
function renderMood(el, state) {
  const m = state.mood;
  if (!m) {
    fill(el);
    hideIfEmpty(el, false);
    return;
  }
  hideIfEmpty(el, true);
  fill(el,
    moodDial(m),
    h("div", { class: "dial-text" },
      h("div", { class: "dial-mood", text: m.mood }),
      h("div", { class: "chips" }, chip(m.phase, PHASE_KIND[m.phase] || ""), chip(m.days + "d")),
      m.setAt ? h("div", { class: "dial-age", text: ago(m.setAt) }) : null));
}

// One .want-meter per want: the title, the progress bar, the small line (last moved, next).
function renderWants(el, state) {
  const wants = Array.isArray(state.wants) ? state.wants : [];
  if (!wants.length) {
    fill(el, muted("--"));
    return;
  }
  fill(el, ...wants.map((w) => h("div", { class: "want-meter" },
    h("div", { class: "row between" },
      h("span", { class: "want-title", text: w.title }),
      h("span", { class: "chips" }, chip(pct(w.progress) + "%", "accent"), w.status && w.status !== "active" ? chip(w.status) : null)),
    progressBar(w.progress),
    h("div", { class: "want-sub" },
      h("span", { text: "last moved " + (w.lastMoved ? ago(w.lastMoved) : "--") }),
      h("span", { text: "next " + (w.nextStep || "--") })))));
}

function renderAsks(el, state) {
  const asks = Array.isArray(state.asks) ? state.asks : [];
  if (!asks.length) {
    fill(el, muted("--"));
    return;
  }
  fill(el, ...asks.map((a) => h("div", { class: "ask-row" },
    h("span", { class: "t", text: a.text }),
    h("span", { class: "chips" }, chip(ago(a.askedAt)), Number(a.broughtUp) >= 1 ? chip("brought up", "amber") : null))));
}

function renderToday(el, state) {
  const rows = Array.isArray(state.today) ? state.today : [];
  if (!rows.length) {
    fill(el, muted("--"));
    return;
  }
  fill(el, ...rows.map((r) => h("div", { class: "today-row" },
    chip(r.kind, "accent"),
    h("span", { class: "when", text: clockIn(r.occurred, state.tz) }),
    h("span", { text: r.note }),
    h("span"))));
}

// The note glyph inside .listening .np-note (the stylesheet sizes it).
function noteIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M9 18V6l10-2v12a3 3 0 1 1-2-2.83V7.5l-6 1.2V18a3 3 0 1 1-2-2.83z");
  p.setAttribute("fill", "currentColor");
  svg.append(p);
  return svg;
}

// .listening (the slot itself): the note, .song-text (title, artist, her line), Open.
function renderListening(el, state) {
  const l = state.listening;
  if (!l) {
    fill(el);
    hideIfEmpty(el, false);
    return;
  }
  hideIfEmpty(el, true);
  const href = SPOTIFY_SEARCH + encodeURIComponent((l.artist + " " + l.title).trim());
  fill(el,
    h("span", { class: "np-note" }, noteIcon()),
    h("div", { class: "song-text" },
      h("span", { class: "song-title", text: l.title }),
      h("span", { class: "song-artist", text: l.artist }),
      l.line ? h("span", { class: "song-line", text: l.line }) : null),
    h("a", { class: "btn small", href, target: "_blank", rel: "noopener", text: "Open" }));
}

// ------------------------------------------------------------------ A1: the player strip

let spotifyInfo = null;
let spotifyAt = 0;
let spotifyPending = null;
let playerState = { state: "off", track: null, position: 0, duration: 0 };
let playerListening = false;
const playerSlots = new Set();

async function ensureSpotify() {
  if (spotifyInfo && Date.now() - spotifyAt < SPOTIFY_TTL_MS) return spotifyInfo;
  if (spotifyPending) return spotifyPending;
  spotifyPending = api("GET", "/api/spotify")
    .then((info) => {
      spotifyInfo = info && typeof info === "object" ? info : { connected: false, playlistId: "" };
      spotifyAt = Date.now();
      return spotifyInfo;
    })
    .catch(() => {
      spotifyInfo = { connected: false, playlistId: "" };
      spotifyAt = Date.now();
      return spotifyInfo;
    })
    .finally(() => { spotifyPending = null; });
  return spotifyPending;
}

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}

function listenPlayer() {
  if (playerListening) return;
  playerListening = true;
  window.addEventListener("avelie:player", (ev) => {
    const d = ev && ev.detail && typeof ev.detail === "object" ? ev.detail : {};
    playerState = {
      state: typeof d.state === "string" ? d.state : "off",
      track: d.track && typeof d.track === "object" ? d.track : null,
      position: Number(d.position) || 0,
      duration: Number(d.duration) || 0,
    };
    for (const el of playerSlots) {
      if (el.isConnected) renderNowPlaying(el);
      else playerSlots.delete(el);
    }
  });
}

function renderNowPlaying(el) {
  const strip = el.querySelector(".now-playing");
  if (!strip) return;
  const s = playerState;
  const on = s.state === "playing" || s.state === "paused";
  strip.classList.toggle("hidden", !on);
  if (!on) return;
  const title = strip.querySelector(".np-title");
  const artist = strip.querySelector(".np-artist");
  const bar = strip.querySelector(".progress > span");
  const state = strip.querySelector(".np-state");
  if (title) title.textContent = s.track ? String(s.track.name || "") : "";
  if (artist) artist.textContent = s.track ? String(s.track.artist || "") : "";
  if (bar) bar.style.width = (s.duration > 0 ? pct((s.position / s.duration) * 100) : 0) + "%";
  if (state) state.textContent = s.state;
}

function renderPlayer(el, state) {
  playerSlots.add(el);
  listenPlayer();
  const info = spotifyInfo;
  if (!info) {
    fill(el);
    hideIfEmpty(el, false);
    ensureSpotify().then(() => { if (el.isConnected) renderPlayer(el, state); });
    return;
  }
  const playlistId = typeof info.playlistId === "string" && /^[A-Za-z0-9]{1,62}$/.test(info.playlistId) ? info.playlistId : "";
  if (!info.connected || !playlistId) {
    delete el.dataset.playlistId;
    fill(el);
    hideIfEmpty(el, false);
    return;
  }
  hideIfEmpty(el, true);
  // The panel refreshes every minute: the same playlist keeps its iframe (a new one would
  // stop the embed's playback and cost a reload each time).
  if (el.dataset.playlistId === playlistId && el.querySelector("iframe.playlist-embed")) {
    renderNowPlaying(el);
    return;
  }
  el.dataset.playlistId = playlistId;
  const uri = "spotify:playlist:" + playlistId;
  const frame = h("iframe", {
    class: "playlist-embed",
    src: SPOTIFY_EMBED + playlistId + "?theme=0",
    title: info.playlistName || "Playlist",
    width: "100%",
    height: "352",
    loading: "lazy",
    allow: "encrypted-media; clipboard-write",
    referrerpolicy: "strict-origin-when-cross-origin",
  });
  const bar = progressBar(0);
  const strip = h("div", { class: "now-playing hidden" },
    h("div", { class: "row between" },
      h("div", { class: "stack tight" }, h("strong", { class: "np-title" }), h("span", { class: "muted small np-artist" })),
      chip("", "accent")),
    bar);
  const stateChip = strip.querySelector(".chip");
  if (stateChip) stateChip.classList.add("np-state");
  fill(el,
    h("div", { class: "row between" },
      h("span", { class: "now-line" }, h("span", { class: "k", text: "playlist" }), h("span", { text: info.playlistName || "" })),
      h("div", { class: "row queue-control" },
        h("button", { type: "button", class: "btn small", "aria-label": "Play", text: "Play", onclick: () => emit("avelie:play", { uri }) }),
        h("button", { type: "button", class: "btn small", "aria-label": "Pause", text: "Pause", onclick: () => emit("avelie:pause") }),
        h("button", { type: "button", class: "btn small", "aria-label": "Next", text: "Next", onclick: () => emit("avelie:next") }))),
    strip,
    frame);
  renderNowPlaying(el);
}

// A places list he is working in: focus inside it, a pin typed and not saved, or an action
// still running. The minute refresh leaves such a list alone; his own reload redraws it.
function placesBusy(el) {
  if (!el || typeof document === "undefined") return false;
  const active = document.activeElement;
  if (active && active !== document.body && el.contains(active)) return true;
  return Boolean(el.querySelector(".place-row.busy, .place-row[data-dirty]"));
}

// ------------------------------------------------------------------ the map and the places

let armedPlaceId = null;

function renderMap(el, state, opts) {
  const armed = opts.full && armedPlaceId ? armedPlaceId : null;
  el.classList.toggle("armed", Boolean(armed));
  drawMap(el, state, {
    onTap: armed ? (lat, lon) => opts.onMapTap && opts.onMapTap(armed, lat, lon) : undefined,
    onPlace: (id) => {
      const card = document.getElementById("place-" + id);
      if (card && typeof card.scrollIntoView === "function") {
        card.scrollIntoView({ block: "nearest" });
        const focus = card.querySelector("button, input");
        if (focus) focus.focus();
      }
    },
  });
  // The page's #mapFoot (the design lane's .map-foot): counts as chips, and the armed word.
  const foot = el.parentElement ? el.parentElement.querySelector("#mapFoot") : null;
  if (foot) {
    const places = Array.isArray(state.places) ? state.places : [];
    const pinned = places.filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))).length;
    fill(foot,
      chip(pinned + " pinned"),
      places.length - pinned > 0 ? chip((places.length - pinned) + " no pin", "amber") : null,
      armed ? chip("tap the map", "accent") : null);
  }
}

function seasonChip(p) {
  return p.pictureSeason ? chip(p.pictureSeason) : null;
}

// The thumbnail column of a .place-row: the picture (a link to it full size) or the empty box.
function placeThumb(p) {
  if (!p.picture) return h("span", { class: "place-thumb empty", text: "--", "aria-hidden": "true" });
  const src = "/media/place/" + encode(p.id);
  return h("a", { href: src, target: "_blank", rel: "noopener", "aria-label": "Open the picture of " + p.title },
    h("img", { class: "place-thumb", src: src + "?v=" + encode(p.pictureMadeAt || ""), alt: p.title, loading: "lazy", width: "56", height: "56" }));
}

// One place as the stylesheet's .place-row: the thumb, .place-text (title, detail, coords,
// chips) and two .place-actions rows (the pin, the picture) with the status chips.
function placeCard(p, state, opts) {
  const statusSlot = h("span", { class: "chips" });
  const busy = (on) => { card.classList.toggle("busy", on); for (const b of card.querySelectorAll("button")) b.disabled = on; };
  const act = async (label, fn) => {
    busy(true);
    flash(statusSlot, label, "accent");
    try {
      await fn();
      await opts.reload();
    } catch (e) {
      flash(statusSlot, e && e.message ? e.message : "error", "danger wrap");
      busy(false);
    }
  };
  const markDirty = () => { card.dataset.dirty = "1"; };
  const latIn = h("input", { type: "number", step: "any", min: "-90", max: "90", inputmode: "decimal", placeholder: "lat", "aria-label": "Latitude", value: Number.isFinite(Number(p.lat)) ? String(p.lat) : "", oninput: markDirty });
  const lonIn = h("input", { type: "number", step: "any", min: "-180", max: "180", inputmode: "decimal", placeholder: "lon", "aria-label": "Longitude", value: Number.isFinite(Number(p.lon)) ? String(p.lon) : "", oninput: markDirty });
  const pinned = Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon));
  const armed = armedPlaceId === p.id;
  const card = h("div", { class: "place-row" + (p.here ? " here" : "") + (p.active === false ? " inactive" : ""), id: "place-" + p.id, "data-id": p.id },
    placeThumb(p),
    h("div", { class: "place-text" },
      h("span", { class: "place-title", text: p.title }),
      p.detail ? h("span", { class: "place-detail", text: p.detail }) : null,
      h("span", { class: "place-coords", text: pinned ? coordText(p.lat, p.lon) : "no pin" }),
      h("div", { class: "chips" },
        p.here ? chip("here", "ok") : null,
        p.active === false ? chip("gone") : null,
        pinned ? null : chip("no pin", "amber"),
        p.geocodedBy ? chip(p.geocodedBy) : null,
        p.picture && p.pictureLight ? chip(p.pictureLight, "accent") : null,
        p.picture ? seasonChip(p) : null,
        p.lastUsedAt ? chip("used " + ago(p.lastUsedAt)) : null)),
    h("div", { class: "place-actions" },
      latIn, lonIn,
      h("button", { type: "button", class: "btn small", text: "Save pin", onclick: () => act("saving", async () => {
        const lat = latIn.value.trim();
        const lon = lonIn.value.trim();
        await api("PUT", "/api/places/" + encode(p.id), { lat: lat === "" ? null : Number(lat), lon: lon === "" ? null : Number(lon), geocodedBy: "owner" });
      }) }),
      h("button", { type: "button", class: "btn small" + (armed ? " primary" : ""), "aria-pressed": armed ? "true" : "false", text: armed ? "Tap the map" : "Set on map", onclick: () => {
        armedPlaceId = armed ? null : p.id;
        opts.rerender();
      } }),
      h("button", { type: "button", class: "btn small", text: "Geocode", onclick: () => act("geocoding", () => api("POST", "/api/places/" + encode(p.id) + "/geocode")) })),
    h("div", { class: "place-actions" },
      p.picture
        ? h("button", { type: "button", class: "btn small", text: "Remake", onclick: () => act("making", () => api("POST", "/api/places/" + encode(p.id) + "/picture", { remake: true })) })
        : h("button", { type: "button", class: "btn small primary", text: "Make picture", onclick: () => act("making", () => api("POST", "/api/places/" + encode(p.id) + "/picture", {})) }),
      p.picture ? h("button", { type: "button", class: "btn small ghost", text: "Remove picture", onclick: () => act("removing", () => api("DELETE", "/api/places/" + encode(p.id) + "/picture")) }) : null,
      statusSlot));
  return card;
}

function renderPlaces(el, state, opts) {
  const places = Array.isArray(state.places) ? state.places : [];
  const rows = places.map((p) => placeCard(p, state, opts));
  if (!rows.length) rows.push(h("div", { class: "chips" }, chip("none")));
  // The Phone page carries its own add form (phone.html); a shell without one gets a row here.
  if (typeof document !== "undefined" && document.getElementById("placeAdd")) {
    fill(el, ...rows);
    return;
  }
  const titleIn = h("input", { type: "text", class: "grow", maxlength: "300", placeholder: "Place", "aria-label": "Place" });
  const addStatus = h("span", { class: "chips" });
  const addRow = h("div", { class: "place-add" },
    h("div", { class: "row" },
      titleIn,
      h("button", { type: "button", class: "btn primary", text: "Add", onclick: async () => {
        const title = titleIn.value.trim();
        if (!title) { flash(addStatus, "title", "danger"); return; }
        try {
          await api("POST", "/api/places", { title });
          titleIn.value = "";
          await opts.reload();
        } catch (e) {
          flash(addStatus, e && e.message ? e.message : "error", "danger wrap");
        }
      } }),
      addStatus));
  fill(el, ...rows, addRow);
}

// ------------------------------------------------------------------ the renderer

// Full detail (the picture's light and season, the geocode source, last use) comes from
// GET /api/places; GET /api/phone carries the panel's own shape. The page merges the two
// so the places list can show both; the drawer renders the panel alone.
function mergePlaces(state, rows) {
  if (!Array.isArray(rows) || !rows.length) return state;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ...state,
    places: (state.places || []).map((p) => {
      const r = byId.get(p.id);
      return r ? { ...p, geocodedBy: r.geocoded_by || null, pictureLight: r.picture_light || null, pictureSeason: r.picture_season || null, pictureMadeAt: r.picture_made_at || null, lastUsedAt: r.last_used_at || null } : p;
    }),
  };
}

// renderPhone(container, state[, opts]): fills the panel. `full` (the Phone page) adds the
// places list and the map's tap; the drawer gets the panel alone. Never fetches at import
// time; the player strip asks GET /api/spotify once per five minutes when it renders.
export function renderPhone(container, state, opts) {
  if (!container || !state) return;
  const options = opts && typeof opts === "object" ? opts : {};
  // The drawer (chat.js) says { places: false, tap: false, readOnly: true }; the page says
  // { full: true }; anything else is decided by where the container sits.
  const readOnly = options.readOnly === true || options.places === false || options.tap === false;
  const full = typeof options.full === "boolean" ? options.full : !readOnly && Boolean(container.closest && (container.closest("main.page.phone") || container.matches("main.page.phone")));
  const ctx = {
    full,
    reload: typeof options.reload === "function" ? options.reload : async () => renderPhone(container, state, { ...options, refresh: false }),
    rerender: () => renderPhone(container, state, { ...options, refresh: false }),
    onMapTap: async (id, lat, lon) => {
      const status = slot(container, "placesStatus", "chips");
      flash(status, "pinning", "accent");
      try {
        await api("PUT", "/api/places/" + encode(id), { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, geocodedBy: "map" });
        armedPlaceId = null;
        await ctx.reload();
        flash(status, "pinned", "ok");
      } catch (e) {
        flash(status, e && e.message ? e.message : "error", "danger wrap");
      }
    },
  };
  for (const [id, kind, label] of SLOTS) {
    if (!full && (id === "placesList" || id === "placesStatus")) continue;
    const el = slot(container, id, kind, label);
    switch (id) {
      case "phoneStatus": renderStatus(el, state); break;
      case "phoneNow": renderNow(el, state); break;
      case "phoneWhere": renderWhere(el, state); break;
      case "phoneWeather": renderWeather(el, state); break;
      case "phoneOutfit": renderOutfit(el, state); break;
      case "phoneMood": renderMood(el, state); break;
      case "phoneWants": renderWants(el, state); break;
      case "phoneAsks": renderAsks(el, state); break;
      case "phoneToday": renderToday(el, state); break;
      case "phoneListening": renderListening(el, state); break;
      case "phonePlayer": renderPlayer(el, state); break;
      case "phoneMap": renderMap(el, state, ctx); break;
      case "placesList": if (!(options.refresh === true && placesBusy(el))) renderPlaces(el, state, ctx); break;
      default: break;
    }
  }
}

// ------------------------------------------------------------------ the page

function bootPhonePage(main) {
  const statusEl = slot(main, "placesStatus", "chips");
  let timer = null;
  let loading = false;
  let last = null;

  // `periodic`: the minute refresh (or a return to the tab), which leaves a places list he is
  // working in alone; every other call (the first load, his own actions) redraws it all.
  async function load(periodic) {
    if (loading) return;
    loading = true;
    try {
      const [state, places] = await Promise.all([
        api("GET", "/api/phone"),
        api("GET", "/api/places").then((r) => (r && Array.isArray(r.places) ? r.places : [])).catch(() => []),
      ]);
      last = mergePlaces(state, places);
      renderPhone(main, last, { full: true, reload: () => load(false), refresh: periodic === true });
    } catch (e) {
      flash(statusEl, e && e.message ? e.message : "error", "danger wrap");
    } finally {
      loading = false;
    }
  }

  function start() {
    stop();
    timer = setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else { load(true); start(); }
  });

  // The page's own add form (phone.html: #placeTitle, #placeDetail, #placeAdd, #placeAddStatus).
  const addBtn = document.getElementById("placeAdd");
  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      const titleIn = document.getElementById("placeTitle");
      const detailIn = document.getElementById("placeDetail");
      const status = document.getElementById("placeAddStatus");
      const title = titleIn ? titleIn.value.trim() : "";
      const detail = detailIn ? detailIn.value.trim() : "";
      if (!title) { flash(status, "title", "danger"); return; }
      addBtn.disabled = true;
      try {
        await api("POST", "/api/places", detail ? { title, detail } : { title });
        if (titleIn) titleIn.value = "";
        if (detailIn) detailIn.value = "";
        flash(status, "added", "ok");
        await load(false);
      } catch (e) {
        flash(status, e && e.message ? e.message : "error", "danger wrap");
      } finally {
        addBtn.disabled = false;
      }
    });
  }


  load();
  start();
}

if (typeof document !== "undefined") {
  const main = document.querySelector("main.page.phone");
  if (main) bootPhonePage(main);
}
