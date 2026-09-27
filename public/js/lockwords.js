// The words on her phone (DESIGN_EXPERIENCE 4.4 and 4.5): pure functions, no DOM, no fetch,
// no location, so the unit suite imports this file under Node. phone.js draws; this file only
// decides what the words and the few run-time values are.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const APPS = Object.freeze(["lock", "home", "maps", "notes", "music", "photos"]);

// The notification apps and the name each one shows over its line.
export const APP_NAMES = Object.freeze({ messages: "Messages", music: "Music", calendar: "Calendar" });

// The app screens and their titles in the app bar.
export const APP_TITLES = Object.freeze({ maps: "Maps", notes: "Notes", music: "Music", photos: "Photos" });

// "#home" -> "home"; no hash, "#lock" or anything unknown -> "lock".
export function appFromHash(hash) {
  const name = String(hash ?? "").replace(/^#/, "").trim().toLowerCase();
  return APPS.includes(name) ? name : "lock";
}

function fmt(ms, tz, options) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", tz ? { ...options, timeZone: tz } : options).format(d);
  } catch {
    // An unknown time zone name: the device's own zone rather than nothing.
    try {
      return new Intl.DateTimeFormat("en-US", options).format(d);
    } catch {
      return "";
    }
  }
}

// When a notification happened, against the story now: "now" under a minute (a time ahead
// of now reads "now" too), "12m", "3h", "yesterday" under two days, the long weekday within
// six days, else "Sep 20". Unreadable -> "".
export function whenWords(iso, nowMs, tz) {
  const at = Date.parse(String(iso ?? ""));
  const now = Number(nowMs);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "";
  const diff = now - at;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return Math.floor(diff / MINUTE) + "m";
  if (diff < DAY) return Math.floor(diff / HOUR) + "h";
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return fmt(at, tz, { weekday: "long" });
  return fmt(at, tz, { month: "short", day: "numeric" });
}

// "68° clear"; a celsius reading says so ("20°C clear"); null or no number -> "".
export function weatherWords(w) {
  if (!w || typeof w !== "object") return "";
  const temp = Number(w.temp);
  if (w.temp === null || w.temp === undefined || w.temp === "" || !Number.isFinite(temp)) return "";
  const deg = Math.round(temp) + "°" + (w.units === "celsius" ? "C" : "");
  const words = String(w.words ?? "").replace(/\s+/g, " ").trim();
  return words ? deg + " " + words : deg;
}

// The story clock's lead over the wall clock, measured at a read; 0 when unreadable.
export function tickOffset(storyNowIso, wallMs) {
  const story = Date.parse(String(storyNowIso ?? ""));
  const wall = Number(wallMs);
  if (!Number.isFinite(story) || !Number.isFinite(wall)) return 0;
  return story - wall;
}

// "11:42" in her zone: 12-hour, no am or pm, like a phone.
export function clockWords(ms, tz) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return "";
  const options = { hour: "numeric", minute: "2-digit", hour12: true };
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", tz ? { ...options, timeZone: tz } : options).formatToParts(d);
  } catch {
    try {
      parts = new Intl.DateTimeFormat("en-US", options).formatToParts(d);
    } catch {
      return "";
    }
  }
  const hour = parts.find((p) => p.type === "hour");
  const minute = parts.find((p) => p.type === "minute");
  return hour && minute ? hour.value + ":" + minute.value : "";
}

// "Saturday, September 26" in her zone.
export function dateWords(ms, tz) {
  return fmt(Number(ms), tz, { weekday: "long", month: "long", day: "numeric" });
}

// The CSS object-position for a picture: a master's focus [x, y] in percent, else 50% 30%.
export function focusPosition(focus) {
  if (Array.isArray(focus) && focus.length === 2) {
    const x = Number(focus[0]);
    const y = Number(focus[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return clampPct(x) + "% " + clampPct(y) + "%";
  }
  return "50% 30%";
}

function clampPct(v) {
  return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}

// The width of a progress line: "42%" of the track played; 0% without a length.
export function progressWidth(position, duration) {
  const p = Number(position);
  const d = Number(duration);
  if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0) return "0%";
  return clampPct((p / d) * 100) + "%";
}

// Her notes: "Thursday -- sign up at the bar", or "" when no next step is set.
export function noteNext(next) {
  if (!next || typeof next !== "object") return "";
  const day = String(next.day ?? "").trim();
  const title = String(next.title ?? "").trim();
  if (!title) return "";
  return day ? day + " -- " + title : title;
}

// The pictures a strip or grid can draw: a photo by its url, a clip only by its poster (a
// clip without one is left out, never drawn as a <video>). `limit` caps the list.
export function drawableRoll(items, limit) {
  const out = [];
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : Infinity;
  for (const it of Array.isArray(items) ? items : []) {
    if (out.length >= max) break;
    if (!it || typeof it !== "object" || typeof it.id !== "string" || !it.id) continue;
    const clip = it.kind === "clip";
    const src = clip ? it.poster : it.url;
    if (typeof src !== "string" || !src) continue;
    out.push({ id: it.id, clip, src });
  }
  return out;
}

// fix0927 review: a roll as the Her side shows it: the pictures she sent (newest first),
// then her masters (`master: true`), at most `limit`, with `keep` of the masters always given
// a place however many she has sent. Items drawableRoll would drop are dropped here first,
// so no reserved place goes to a picture that cannot be drawn. src/roll.ts rollWithMasters
// is the same rule on the server.
export function rollWithMasters(items, limit, keep) {
  const list = (Array.isArray(items) ? items : []).filter((it) => drawableRoll([it]).length === 1);
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : Infinity;
  const sent = list.filter((it) => it.master !== true);
  const masters = list.filter((it) => it.master === true);
  const want = Number.isFinite(Number(keep)) && Number(keep) > 0 ? Math.floor(Number(keep)) : 0;
  const reserve = Math.min(want, masters.length, max);
  return [...sent.slice(0, Math.max(0, max - reserve)), ...masters].slice(0, max);
}

// Her Maps app: only the places with stored coordinates.
export function pinnedPlaces(places) {
  const out = [];
  for (const p of Array.isArray(places) ? places : []) {
    if (!p || typeof p !== "object") continue;
    if (p.lat === null || p.lat === undefined || p.lon === null || p.lon === undefined) continue;
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!String(p.title ?? "").trim()) continue;
    out.push(p);
  }
  return out;
}

// A sent song's label ("Artist - Title") as its two lines; a label without the separator is
// the title alone.
export function songLines(label) {
  const s = String(label ?? "").replace(/\s+/g, " ").trim();
  const i = s.indexOf(" - ");
  if (i > 0 && i < s.length - 3) return { title: s.slice(i + 3).trim(), artist: s.slice(0, i).trim() };
  return { title: s, artist: "" };
}

// The playlist id GET /api/spotify names, when it is one Spotify would take; else "".
export function playlistIdOf(info) {
  if (!info || typeof info !== "object" || info.connected !== true) return "";
  const id = typeof info.playlistId === "string" ? info.playlistId : "";
  return /^[A-Za-z0-9]{1,62}$/.test(id) ? id : "";
}

// One key per list, so a minute's refresh redraws (and replays the arrival) only on change.
export function listKey(items, fields) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it) => fields.map((f) => String(it && it[f] !== undefined && it[f] !== null ? it[f] : "")).join("\u0001")).join("\u0002");
}
