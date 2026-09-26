// Chat: the thread as a phone conversation. Her words stand alone by default; the
// backstage (flags, the operator channel) shows only while the Operator switch is on.
// v3: a Note sheet and a Keep / Drop mark under her messages, the "his version" line,
// blind tastings (two panels, one pick), and phone calls (the Call button, the sheet, the
// call card in the thread).
// v4 (SPEC_V4 sections 0, 1, 3, 4, 6, 8, A1, A3): her avatar beside her bubbles and the
// typing dots, run-based timestamps, the dots lead in real mode and the reload on return,
// the phone slide-in, the song card's status chip, Retry and play control with the
// now-playing strip, the `us` chip, the video bubble, the place picker's prefill chain
// and the place picture behind the thread.
import {
  api, apiForm, h, chip, clear, fmtDate, fmtTime, fmtDuration, flagCodes, parseJson, registerServiceWorker, storeGet, storeSet, svgIcon,
} from "./api.js";
import { splitBubbles, bubbleDelayMs, pauseForId, PAUSE_MS, dotsLeadMs } from "./bubbles.js";
import { createCall } from "./call.js";
// player.js (A1) owns the Spotify device and answers the avelie:play / pause / next events
// this page and the phone drawer dispatch; importing it only registers those listeners.
import "./player.js";
// nav.js builds the header at load and exports avatarImg(size) (SPEC_V4 section 0); the
// namespace import keeps this page alive on a tree where the export has not landed yet.
import * as nav from "./nav.js";

const POLL_MS = 3000;
// Longer than the server's claim lease (4 min), so a request another tab holds either
// finishes or expires while this page still watches.
const POLL_MAX = 90;
const STORE_KEY = "avelie.conversation";
const TIMING_KEY = "bubbleTiming";
const TASTING_KEY = "avelie.tasting.";
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_VOICE_MS = 60000;
const MAX_VOICE_BYTES = 4 * 1024 * 1024;
const MIN_VOICE_MS = 600;
// A press shorter than this is a tap: the recording keeps going until the next tap (2026-09-26:
// the first hold always died when he let go to click Allow on the permission prompt).
const TAP_MS = 350;
const DESC_CHARS = 60;
// The Note sheet's kinds: label on screen, kind on the wire (the first maps to `ai`).
const NOTE_KINDS = [
  ["ai", "Not her voice"], ["clever", "Too clever"], ["not_her", "Not her"], ["too_long", "Too long"],
  ["too_nice", "Too nice"], ["too_polished", "Too polished"], ["other", "Other"],
];
const MARK_CYCLE = { none: "keep", keep: "drop", drop: "none" };
const MARK_LABEL = { none: "keep", keep: "kept", drop: "dropped" };
// v4
const PLACE_KEY = "avelie.lastPlace";
// Messages of one sender within this gap read as one run: one avatar, one time.
const RUN_GAP_MS = 10 * 60 * 1000;
const AVATAR_PX = 28;
// A song whose Spotify add is still pending is read once more after this long.
const SONG_REFRESH_MS = 8000;
// A clip is driven forward by polling (the task only moves when a page asks), 5 s apart
// for up to 10 minutes, as the Images page does.
const CLIP_POLL_MS = 5000;
const CLIP_POLL_MAX = 120;
const PLACES_TTL_MS = 60000;

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"),
  scrim: $("scrim"),
  openDrawer: $("openDrawer"),
  closeDrawer: $("closeDrawer"),
  newChat: $("newChat"),
  convList: $("convList"),
  convTitle: $("convTitle"),
  sceneTogether: $("sceneTogether"),
  sceneApart: $("sceneApart"),
  placesPop: $("placesPop"),
  placesList: $("placesList"),
  placeInput: $("placeInput"),
  placeSet: $("placeSet"),
  placeCancel: $("placeCancel"),
  letHerStart: $("letHerStart"),
  callBtn: $("callBtn"),
  photosBtn: $("photosBtn"),
  moreBtn: $("moreBtn"),
  moreMenu: $("moreMenu"),
  timingToggle: $("timingToggle"),
  operatorToggle: $("operatorToggle"),
  thread: $("thread"),
  typing: $("typing"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  tasteBtn: $("tasteBtn"),
  attachBtn: $("attachBtn"),
  fileInput: $("fileInput"),
  attachStrip: $("attachStrip"),
  micBtn: $("micBtn"),
  errorRow: $("errorRow"),
  errorChip: $("errorChip"),
  retryBtn: $("retryBtn"),
  lockRow: $("lockRow"),
  photosDrawer: $("photosDrawer"),
  photosList: $("photosList"),
  photosClose: $("photosClose"),
  whyDrawer: $("whyDrawer"),
  whyBody: $("whyBody"),
  whyClose: $("whyClose"),
  callSheet: $("callSheet"),
  callStatus: $("callStatus"),
  callTimer: $("callTimer"),
  callCaptions: $("callCaptions"),
  callReason: $("callReason"),
  callMute: $("callMute"),
  callEnd: $("callEnd"),
  callAudio: $("callAudio"),
  // v4 (markup by the design lane; every one optional so an older shell still runs)
  phoneBtn: $("phoneBtn"),
  phoneDrawer: $("phoneDrawer"),
  phoneDrawerBody: $("phoneDrawerBody"),
  phoneClose: $("phoneClose"),
  nowPlaying: $("nowPlaying"),
};

const state = {
  conversations: [],
  currentId: null,
  operator: false,
  inFlight: false,
  arriving: 0,
  // The idempotency key of a send that has not been answered yet, with the conversation
  // and text it belongs to. Reused only for the same text in the same conversation.
  pending: null,
  pollers: new Map(),
  generating: new Set(),
  approved: new Set(),
  rejected: new Set(),
  loadSeq: 0,
  timing: storeGet(TIMING_KEY) === "instant" ? "instant" : "human",
  scene: null,
  places: [],
  media: new Map(),
  attachments: [],
  deliveries: new Map(),
  dotsHold: false,
  lastStoryRole: null,
  cache: { state: null, life: null },
  rec: null,
  // v3
  settings: null,
  corrections: new Map(),
  marks: new Map(),
  calls: new Map(),
  chipsFor: new Map(),
  tasting: null,
  call: null,
  // v4
  // Every visual_assets row the assets route lists, by id: the role tells a clip from a
  // photo, with_him marks the `us` chip.
  assets: new Map(),
  clipPollers: new Map(),
  // Source photo per clip id (its poster), read from the claim note while it generates.
  clipSources: new Map(),
  songTimers: new Map(),
  // Messages whose pending song status was already read once more (one refresh, not a loop).
  songRefreshed: new Set(),
  player: { state: "off", track: null, position: 0, duration: 0, at: 0, reason: null, embedSrc: null },
  playerTicker: null,
  placeRows: null,
  placeRowsAt: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------ conversations

function convLabel(c) {
  return c.title || "chat " + fmtDate(c.created_at);
}

async function loadConversations() {
  try {
    const rows = await api("GET", "/api/conversations");
    state.conversations = (Array.isArray(rows) ? rows : []).filter((c) => c.status !== "drift");
  } catch (e) {
    state.conversations = [];
    showError(e.code, false);
  }
  renderConversations();
}

function renderConversations() {
  clear(els.convList);
  for (const c of state.conversations) {
    const btn = h("button", {
      type: "button",
      class: c.id === state.currentId ? "active" : "",
      onclick: () => { select(c.id); closeSidebar(); },
    },
    h("span", { class: "conv-name", text: convLabel(c) }),
    h("span", { class: "conv-date", text: fmtDate(c.last_message_at || c.created_at) }));
    els.convList.append(h("li", null, btn));
  }
}

function updateTitle() {
  const c = state.conversations.find((x) => x.id === state.currentId);
  els.convTitle.textContent = c ? convLabel(c) : "";
}

function touchConversation(id) {
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  c.last_message_at = new Date().toISOString();
  state.conversations = [c, ...state.conversations.filter((x) => x.id !== id)];
  renderConversations();
}

async function select(id) {
  state.currentId = id;
  state.pending = null;
  storeSet(STORE_KEY, id);
  stopPollers();
  hideError();
  renderConversations();
  updateTitle();
  await loadThread();
}

async function ensureConversation() {
  if (state.currentId) return state.currentId;
  const c = await api("POST", "/api/conversations", {});
  state.conversations.unshift(c);
  state.currentId = c.id;
  storeSet(STORE_KEY, c.id);
  renderConversations();
  updateTitle();
  return c.id;
}

async function newChat() {
  els.newChat.disabled = true;
  try {
    const c = await api("POST", "/api/conversations", {});
    state.conversations.unshift(c);
    await select(c.id);
    closeSidebar();
    els.input.focus();
  } catch (e) {
    showError(e.code, false);
  } finally {
    els.newChat.disabled = false;
  }
}

// ------------------------------------------------------------ thread

function alive(seq) {
  return seq === state.loadSeq;
}

async function loadThread() {
  const seq = ++state.loadSeq;
  const id = state.currentId;
  clearDeliveries();
  state.dotsHold = false;
  clear(els.thread);
  els.thread.append(els.typing);
  state.lastStoryRole = null;
  setTasting(null);
  refreshTyping();
  updateStartButton();
  if (!id) return;
  const query = state.operator ? "?includePending=1" : "?channel=story&includePending=1";
  let rows = [];
  try {
    const [messages, assets] = await Promise.all([
      api("GET", "/api/conversations/" + encodeURIComponent(id) + "/messages" + query),
      api("GET", "/api/assets").catch(() => null),
      loadMedia(),
      loadCorrections(),
      loadCalls(id),
    ]);
    if (!alive(seq)) return;
    rows = Array.isArray(messages) ? messages : [];
    if (assets) {
      state.approved = new Set((assets.scenes || []).map((a) => a.id));
      state.rejected = new Set((assets.rejected || []).map((a) => a.id));
      indexAssets(assets);
    }
  } catch (e) {
    if (alive(seq)) showError(e.code, false);
    return;
  }
  // Call rows sit in the thread as one card per call, never as bubbles.
  let group = null;
  const flush = () => {
    if (group) appendMessage(renderCallCard(group.callId, group.rows));
    group = null;
  };
  for (const m of rows) {
    if (m.channel === "story") state.lastStoryRole = m.role;
    if (m.call_id && m.channel === "story") {
      if (group && group.callId === m.call_id) group.rows.push(m);
      else { flush(); group = { callId: m.call_id, rows: [m] }; }
      continue;
    }
    flush();
    if (m.role === "assistant" && m.channel === "story" && futureIso(m.deliver_at)) {
      scheduleDelivery(m, seq);
    } else {
      appendMessage(renderMessage(m));
    }
  }
  flush();
  layoutRuns();
  updateStartButton();
  scrollBottom();
  restoreTasting(id, seq);
}

// The assets route answers lists by status; the thread wants one map by id.
function indexAssets(assets) {
  state.assets = new Map();
  if (!assets || typeof assets !== "object") return;
  for (const list of Object.values(assets)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) if (a && a.id) state.assets.set(a.id, a);
  }
}

function rememberAsset(a) {
  if (a && a.id) state.assets.set(a.id, a);
}

// The library rows her media cards resolve against. Optional: a missing route hides nothing else.
async function loadMedia() {
  try {
    const r = await api("GET", "/api/media");
    const list = Array.isArray(r) ? r : (r && (r.items || r.media || r.rows)) || [];
    state.media = new Map(list.filter((x) => x && x.id).map((x) => [x.id, x]));
  } catch {
    /* library not available */
  }
}

// The active corrections, by message: the "his version" line under her text.
async function loadCorrections() {
  try {
    const r = await api("GET", "/api/corrections?status=active");
    const list = Array.isArray(r) ? r : (r && (r.rows || r.corrections)) || [];
    state.corrections = new Map();
    for (const c of list) {
      const mid = c && (c.message_id || c.messageId);
      if (!mid) continue;
      const prev = state.corrections.get(mid);
      if (!prev || String(c.created_at || "") > String(prev.created_at || "")) state.corrections.set(mid, c);
    }
  } catch {
    /* the ledger is optional for rendering */
  }
}

// The calls of this conversation: their length for the card line.
async function loadCalls(conversationId) {
  try {
    const r = await api("GET", "/api/calls?conversationId=" + encodeURIComponent(conversationId) + "&limit=200");
    const list = Array.isArray(r) ? r : (r && (r.rows || r.calls)) || [];
    state.calls = new Map(list.filter((c) => c && c.id).map((c) => [c.id, c]));
  } catch {
    /* no calls route: the card measures from its rows */
  }
}

function futureIso(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > Date.now();
}

// A message already in the thread (a replayed turn after a reload) is not added twice.
function appendMessage(el) {
  const id = el.getAttribute("data-id");
  if (id && findMessageEl(id)) return;
  els.thread.insertBefore(el, els.typing);
  layoutRuns();
}

// ------------------------------------------------------------ runs (v4 section 0)

// Her avatar: nav.js renders the header's one and hands out copies at any size; on a shell
// without that export the header image is cloned, and with no header image at all an empty
// one keeps the column aligned.
function makeAvatar(size) {
  let img = null;
  if (typeof nav.avatarImg === "function") {
    try { img = nav.avatarImg(size); } catch { img = null; }
  }
  if (!(img instanceof HTMLImageElement)) {
    const header = document.getElementById("avatar");
    img = h("img", { class: "avatar", alt: "", decoding: "async" });
    if (header && header.src) {
      img.src = header.src;
      img.style.objectPosition = header.style.objectPosition || "";
    }
    img.dataset.avatar = "her";
  }
  img.classList.add("avatar", "msg-avatar");
  img.setAttribute("width", String(size));
  img.setAttribute("height", String(size));
  img.setAttribute("alt", "");
  return img;
}

function avatarSpacer() {
  return h("span", { class: "msg-avatar spacer", "aria-hidden": "true" });
}

function runOf(el) {
  const at = Date.parse(el.getAttribute("data-at") || "");
  return { role: el.classList.contains("his") ? "his" : "hers", op: el.classList.contains("op"), at: Number.isFinite(at) ? at : NaN };
}

// A run is one sender's messages within ten minutes of each other. The first of a run of
// hers carries her avatar, the rest a spacer; the time shows on the first of a run and on
// the last message of the thread. Recomputed on every change (the thread is small).
function layoutRuns() {
  const list = [...els.thread.querySelectorAll(".msg[data-at]")];
  let prev = null;
  list.forEach((el, i) => {
    const cur = runOf(el);
    const sameRun = !!prev && !cur.op && !prev.op && prev.role === cur.role
      && Number.isFinite(cur.at) && Number.isFinite(prev.at) && cur.at >= prev.at && cur.at - prev.at <= RUN_GAP_MS;
    el.classList.toggle("run-first", !sameRun);
    el.classList.toggle("run-rest", sameRun);
    if (cur.role === "hers" && !cur.op) {
      const slot = el.querySelector(":scope > .msg-avatar");
      const wantImg = !sameRun;
      const isImg = slot instanceof HTMLImageElement;
      if (!slot) el.prepend(wantImg ? makeAvatar(AVATAR_PX) : avatarSpacer());
      else if (wantImg && !isImg) slot.replaceWith(makeAvatar(AVATAR_PX));
      else if (!wantImg && isImg) slot.replaceWith(avatarSpacer());
    }
    const time = el.querySelector(":scope > .meta > .time");
    if (time) time.classList.toggle("hidden", sameRun && i !== list.length - 1);
    prev = cur;
  });
}

// The typing indicator carries the same avatar before its dots.
function mountTypingAvatar() {
  if (!els.typing || els.typing.querySelector(".msg-avatar")) return;
  els.typing.prepend(makeAvatar(AVATAR_PX));
}

function noteRole(m) {
  if (m && m.channel === "story") {
    state.lastStoryRole = m.role;
    updateStartButton();
  }
}

function updateStartButton() {
  const show = !state.operator && state.lastStoryRole !== "user" && !state.tasting;
  els.letHerStart.classList.toggle("hidden", !show);
}

function bubbleEl(text) {
  return h("div", { class: "bubble", text });
}

function renderMessage(m, errorCode, error) {
  const his = m.role === "user";
  const op = m.channel === "operator";
  const el = h("div", { class: "msg " + (his ? "his" : "hers") + (op ? " op" : ""), "data-id": m.id || "", "data-at": m.created_at || new Date().toISOString() });
  // Hers sit in a 28px avatar column (the stylesheet's grid); the first of a run gets the
  // image in layoutRuns, the rest keep the spacer. An operator row keeps the column too.
  if (!his) el.append(avatarSpacer());
  const bubbles = h("div", { class: "bubbles" });
  if (his) {
    const b = h("div", { class: "bubble" });
    if (m.audio_key) b.append(h("span", { class: "mic-chip", "aria-label": "Voice", role: "img" }, svgIcon("mic")));
    b.append(document.createTextNode(m.content || ""));
    bubbles.append(b);
  } else {
    const parts = op ? [m.content || ""] : splitBubbles(m.content);
    for (const p of parts.length ? parts : [m.content || ""]) bubbles.append(bubbleEl(p));
  }
  el.append(bubbles);
  const extras = h("div", { class: "extras" });
  if (his) {
    const thumbs = hisThumbs(m);
    if (thumbs) extras.append(thumbs);
  } else if (!op) {
    if (m.audio_key && m.id) {
      extras.append(h("div", { class: "audio-note" },
        h("audio", { controls: true, preload: "none", src: "/media/audio/" + encodeURIComponent(m.id) })));
    }
    const photo = renderPhoto(m, errorCode, error);
    if (photo) extras.append(photo);
    const song = songCard(m);
    if (song) extras.append(song);
    const media = mediaCard(m);
    if (media) extras.append(media);
    const version = hisVersion(m);
    if (version) extras.append(version);
  }
  if (extras.childElementCount) el.append(extras);
  el.append(metaRow(m));
  return el;
}

function metaRow(m) {
  const row = h("div", { class: "meta" }, h("span", { class: "time", text: fmtTime(m.created_at) }));
  if (m.role === "assistant" && m.channel !== "operator" && m.id) {
    row.append(h("button", { type: "button", class: "why", text: "why", onclick: () => openWhy(m) }));
    row.append(h("button", { type: "button", class: "note-btn", text: "note", onclick: () => toggleNoteSheet(m) }));
    row.append(markButton(m));
    const extra = state.chipsFor.get(m.id);
    if (extra && extra.length) row.append(h("span", { class: "chips" }, extra));
    if (state.operator) {
      const codes = flagCodes(m.flags_json);
      if (codes.length) row.append(h("span", { class: "chips" }, codes.map((c) => chip(c, "flag"))));
    }
  }
  return row;
}

// His photos: images_json holds keys and sizes; the bytes come from /media/inbox/:id/:n.
function hisThumbs(m) {
  const raw = parseJson(m.images_json, null);
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.images) ? raw.images : [];
  if (!list.length || !m.id) return null;
  const wrap = h("div", { class: "thumbs" });
  list.forEach((img, n) => {
    const src = "/media/inbox/" + encodeURIComponent(m.id) + "/" + n;
    wrap.append(h("a", { href: src, target: "_blank", rel: "noopener" }, h("img", { src, alt: "", loading: "lazy" })));
  });
  return wrap;
}

// The chip the card shows for each Spotify add outcome; pending and off show nothing.
const SONG_STATUS = { added: ["added", "ok"], already: ["already", ""], not_found: ["not found", "amber"], failed: ["failed", "danger"] };

function spotifyUrl(v) {
  return typeof v === "string" && v.startsWith("https://open.spotify.com/") ? v : "";
}

function songCard(m) {
  const song = parseJson(m.song_json, null);
  if (!song || typeof song !== "object" || !song.title) return null;
  const artist = String(song.artist || "");
  const title = String(song.title || "");
  // The track itself once the add found it (v4), else the search as before.
  let href = spotifyUrl(song.trackUrl) || spotifyUrl(song.searchUrl);
  if (!href) href = "https://open.spotify.com/search/" + encodeURIComponent((artist + " " + title).trim());
  const uri = typeof song.uri === "string" && song.uri.startsWith("spotify:track:") ? song.uri : "";
  const status = typeof m.spotify_status === "string" ? m.spotify_status : "";
  const slot = h("span", { class: "song-status chips" });
  const known = SONG_STATUS[status];
  if (known) slot.append(chip(known[0], known[1]));
  if (m.id && (status === "failed" || status === "not_found")) {
    const retry = h("button", { type: "button", class: "btn small quiet song-retry", text: "Retry" });
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        const r = await api("POST", "/api/messages/" + encodeURIComponent(m.id) + "/spotify", {});
        const next = r && typeof r.status === "string" ? r.status : "pending";
        state.songRefreshed.delete(m.id);
        replaceSong({ ...m, spotify_status: next });
        if (next === "pending") refreshSongLater(m.id);
      } catch (e) {
        retry.disabled = false;
        clear(slot);
        slot.append(chip(e.code || "error", "danger"), retry);
      }
    });
    slot.append(retry);
  }
  if (m.id && status === "pending") refreshSongLater(m.id);
  const card = h("div", { class: "song-card", "data-uri": uri },
    h("span", { class: "note", "aria-hidden": "true" }, svgIcon("note")),
    h("span", { class: "song-text" },
      h("span", { class: "song-title", text: title }),
      artist ? h("span", { class: "song-artist", text: artist }) : null),
    h("a", { class: "song-link", href, target: "_blank", rel: "noopener noreferrer", text: "Open in Spotify" }),
    slot);
  // A1: the play control, shown whenever the song has a uri (the device is made on the first
  // press). player.js renders the embed into this card's .song-embed slot when the SDK cannot
  // play (no Premium, iOS Safari); the button then gives way to it. The card never talks to
  // Spotify itself.
  if (uri) {
    const embed = h("div", { class: "song-embed hidden" });
    const play = h("button", { type: "button", class: "icon-btn song-play", "aria-label": "Play", "data-uri": uri }, svgIcon("play"));
    play.addEventListener("click", () => {
      const p = state.player;
      const mine = p.track && p.track.uri === uri;
      if (mine && p.state === "playing") window.dispatchEvent(new CustomEvent("avelie:pause"));
      else window.dispatchEvent(new CustomEvent("avelie:play", { detail: { uri, target: embed } }));
    });
    // Play on my Spotify: the song starts on his own Spotify app (Mac or phone), which always
    // plays the whole track, even where this page cannot (the side pane has no protected audio).
    const remote = h("button", { type: "button", class: "btn small song-remote", "aria-label": "Play on my Spotify", text: "my Spotify" });
    const remoteNote = h("span", { class: "song-remote-note" });
    remote.addEventListener("click", () => {
      clear(remoteNote);
      remoteNote.append(chip("starting"));
      window.dispatchEvent(new CustomEvent("avelie:play-remote", { detail: { uri } }));
    });
    card.append(play, remote, remoteNote, embed);
    paintPlayButton(play);
  }
  return card;
}

// Where "my Spotify" landed, shown on the card that asked: the device's name, or what to do.
window.addEventListener("avelie:remote", (e) => {
  const d = e.detail || {};
  for (const card of document.querySelectorAll(".song-card")) {
    if (card.getAttribute("data-uri") !== d.uri) continue;
    const note = card.querySelector(".song-remote-note");
    if (!note) continue;
    clear(note);
    if (d.ok) note.append(chip("on " + d.device, "ok"));
    else if (d.code === "no_device") note.append(chip("open Spotify on your phone or Mac first", "amber"));
    else note.append(chip(d.code || "error", "danger"));
  }
});

// One more read of the message after a moment: the add runs after the reply was stored.
// Once per message per page load; a status still pending after that waits for a reload.
function refreshSongLater(id) {
  if (!id || state.songTimers.has(id) || state.songRefreshed.has(id)) return;
  state.songRefreshed.add(id);
  const timer = setTimeout(async () => {
    state.songTimers.delete(id);
    let fresh = null;
    try { fresh = await api("GET", "/api/messages/" + encodeURIComponent(id)); } catch { fresh = null; }
    if (fresh && fresh.id) replaceSong(fresh);
  }, SONG_REFRESH_MS);
  state.songTimers.set(id, timer);
}

function replaceSong(m) {
  const el = findMessageEl(m.id);
  if (!el) return;
  const extras = el.querySelector(".extras");
  const old = extras ? extras.querySelector(".song-card") : null;
  const fresh = songCard(m);
  if (old && fresh) old.replaceWith(fresh);
}

function mediaCard(m) {
  if (!m.media_id) return null;
  const id = String(m.media_id);
  const row = state.media.get(id) || {};
  const src = "/media/library/" + encodeURIComponent(id);
  const mime = String(row.mime || "");
  const kind = String(row.kind || "");
  const card = h("div", { class: "media-card" });
  if (row.title) card.append(h("span", { class: "media-title", text: row.title }));
  if (kind === "video" || mime.startsWith("video/")) {
    card.append(h("video", { controls: true, preload: "metadata", playsinline: true, src }));
  } else if (kind === "clip" || mime.startsWith("audio/")) {
    card.append(h("audio", { controls: true, preload: "none", src }));
  } else if (kind === "image" || mime.startsWith("image/")) {
    card.append(h("a", { href: src, target: "_blank", rel: "noopener" }, h("img", { src, alt: row.title || "", loading: "lazy" })));
  } else {
    card.append(h("a", { href: src, target: "_blank", rel: "noopener", text: row.title || "Open" }));
  }
  return card;
}

function scrollBottom() {
  els.thread.scrollTop = els.thread.scrollHeight;
}

// ------------------------------------------------------------ player (v4 A1)

// The page never calls Spotify. player.js (the Spotify lane) owns the device and speaks
// through window events: this page dispatches avelie:play / avelie:pause / avelie:next
// and renders whatever avelie:player reports.

function pauseIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const x of [6, 14]) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", "4");
    r.setAttribute("width", "4");
    r.setAttribute("height", "16");
    r.setAttribute("rx", "1");
    svg.append(r);
  }
  return svg;
}

function nextIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M5 4l11 8-11 8z");
  const r = document.createElementNS(NS, "rect");
  r.setAttribute("x", "17");
  r.setAttribute("y", "4");
  r.setAttribute("width", "3");
  r.setAttribute("height", "16");
  svg.append(p, r);
  return svg;
}

// The strip comes from the shell (#nowPlaying with #npTitle, #npArtist, #npProgress,
// #npTime, #npPause, #npNext); an older shell gets the same markup built here under the
// thread. The progress bar is the stylesheet's .progress: a span whose width is set
// through the CSSOM.
function nowPlayingEl() {
  if (els.nowPlaying && els.nowPlaying.querySelector("#npTitle")) return els.nowPlaying;
  const strip = els.nowPlaying || h("div", { class: "now-playing hidden", id: "nowPlaying", "aria-label": "Now playing", "aria-hidden": "true" });
  clear(strip);
  strip.append(
    h("span", { class: "np-note", "aria-hidden": "true" }, svgIcon("note")),
    h("div", { class: "np-text" },
      h("span", { class: "np-title", id: "npTitle" }),
      h("span", { class: "np-artist", id: "npArtist" }),
      h("div", { class: "progress np-progress", id: "npProgress", role: "progressbar", "aria-label": "Position", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, h("span"))),
    h("span", { class: "np-time", id: "npTime" }),
    h("button", { type: "button", class: "icon-btn", id: "npPause", "aria-label": "Pause", "aria-pressed": "false" }, pauseIcon()),
    h("button", { type: "button", class: "icon-btn", id: "npNext", "aria-label": "Next" }, nextIcon()));
  if (!els.nowPlaying) {
    const wrap = els.thread.parentElement;
    if (wrap) wrap.insertBefore(strip, els.composer);
    else document.body.append(strip);
    els.nowPlaying = strip;
  }
  return strip;
}

function wireNowPlaying() {
  const strip = nowPlayingEl();
  if (strip.dataset.wired === "1") return strip;
  strip.dataset.wired = "1";
  const pause = strip.querySelector("#npPause");
  const next = strip.querySelector("#npNext");
  if (pause) pause.addEventListener("click", () => {
    const p = state.player;
    if (p.state === "playing") window.dispatchEvent(new CustomEvent("avelie:pause"));
    else window.dispatchEvent(new CustomEvent("avelie:play", { detail: p.track ? { uri: p.track.uri } : {} }));
  });
  if (next) next.addEventListener("click", () => window.dispatchEvent(new CustomEvent("avelie:next")));
  return strip;
}

function paintPlayButton(btn) {
  const p = state.player;
  const uri = btn.getAttribute("data-uri") || "";
  const card = btn.closest(".song-card");
  const embedded = !!(card && card.querySelector(".song-embed iframe"));
  btn.classList.toggle("hidden", embedded || p.reason === "player_off");
  const mine = !!(p.track && p.track.uri === uri && p.state === "playing");
  btn.classList.toggle("playing", mine);
  btn.setAttribute("aria-label", mine ? "Pause" : "Play");
  btn.setAttribute("aria-pressed", String(mine));
  clear(btn);
  btn.append(mine ? pauseIcon() : svgIcon("play"));
}

function paintPlayButtons() {
  for (const b of els.thread.querySelectorAll(".song-play")) paintPlayButton(b);
}

function playerPosition() {
  const p = state.player;
  const elapsed = p.state === "playing" && p.at ? Date.now() - p.at : 0;
  return Math.min(p.duration || 0, Math.max(0, (p.position || 0) + elapsed));
}

function paintProgress(strip) {
  const p = state.player;
  const position = playerPosition();
  const pct = p.duration > 0 ? Math.min(100, Math.round((position / p.duration) * 1000) / 10) : 0;
  const bar = strip.querySelector("#npProgress");
  const fill = bar ? bar.querySelector("span") : null;
  if (fill) fill.style.width = pct + "%";
  if (bar) bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  const time = strip.querySelector("#npTime");
  if (time) time.textContent = p.duration > 0 ? fmtDuration(position / 1000) + " / " + fmtDuration(p.duration / 1000) : "";
}

function renderNowPlaying() {
  const strip = wireNowPlaying();
  const p = state.player;
  // The embed player.js put into the strip itself (a play with no card, the phone drawer's
  // playlist) keeps the strip open while the state is off.
  const embedHere = p.state === "off" && !!p.embedSrc && !!strip.querySelector("iframe.spotify-embed");
  const show = ((p.state === "playing" || p.state === "paused") && !!p.track) || embedHere;
  strip.classList.toggle("hidden", !show);
  strip.setAttribute("aria-hidden", String(!show));
  if (!show || embedHere) { stopPlayerTicker(); return; }
  const title = strip.querySelector("#npTitle");
  const artist = strip.querySelector("#npArtist");
  if (title) title.textContent = String(p.track.name || "");
  if (artist) artist.textContent = String(p.track.artist || "");
  paintProgress(strip);
  const pause = strip.querySelector("#npPause");
  if (pause) {
    clear(pause);
    pause.append(p.state === "playing" ? pauseIcon() : svgIcon("play"));
    pause.setAttribute("aria-label", p.state === "playing" ? "Pause" : "Play");
    pause.setAttribute("aria-pressed", String(p.state === "playing"));
  }
  if (p.state === "playing") startPlayerTicker();
  else stopPlayerTicker();
}

function startPlayerTicker() {
  if (state.playerTicker) return;
  state.playerTicker = setInterval(() => {
    if (state.player.state !== "playing" || !els.nowPlaying) return;
    paintProgress(els.nowPlaying);
  }, 1000);
}

function stopPlayerTicker() {
  if (state.playerTicker) clearInterval(state.playerTicker);
  state.playerTicker = null;
}

function onPlayerEvent(e) {
  const d = e && e.detail && typeof e.detail === "object" ? e.detail : {};
  const st = ["ready", "playing", "paused", "off"].includes(d.state) ? d.state : "off";
  const track = d.track && typeof d.track === "object" && typeof d.track.uri === "string" ? { name: String(d.track.name || ""), artist: String(d.track.artist || ""), uri: d.track.uri } : null;
  state.player = {
    state: st, track, position: Number(d.position) || 0, duration: Number(d.duration) || 0, at: Date.now(),
    reason: typeof d.reason === "string" ? d.reason : null, embedSrc: typeof d.embedSrc === "string" ? d.embedSrc : null,
  };
  paintPlayButtons();
  renderNowPlaying();
}

// ------------------------------------------------------------ notes, marks (v3 AA, II)

// The "his version" line: the active correction's rewrite, muted, under her text.
function hisVersion(m) {
  const c = m.id ? state.corrections.get(m.id) : null;
  const rewrite = c && typeof c.rewrite === "string" ? c.rewrite.trim() : "";
  if (!rewrite) return null;
  return h("div", { class: "his-version" }, h("span", { class: "who", text: "his version" }), rewrite);
}

function refreshHisVersion(m) {
  const el = findMessageEl(m.id);
  if (!el) return;
  let extras = el.querySelector(".extras");
  const old = extras ? extras.querySelector(".his-version") : null;
  const fresh = hisVersion(m);
  if (old) {
    if (fresh) old.replaceWith(fresh);
    else old.remove();
  } else if (fresh) {
    if (!extras) {
      extras = h("div", { class: "extras" });
      el.insertBefore(extras, el.querySelector(".meta"));
    }
    extras.append(fresh);
  }
  if (extras && !extras.childElementCount) extras.remove();
}

function toggleNoteSheet(m) {
  const el = findMessageEl(m.id);
  if (!el) return;
  const open = el.querySelector(".note-sheet");
  if (open) { open.remove(); return; }
  el.append(noteSheet(m));
  el.querySelector(".note-sheet textarea").focus();
  el.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

function noteSheet(m) {
  let kind = null;
  const slot = h("span", { class: "chips" });
  const kinds = h("div", { class: "kinds", role: "group", "aria-label": "Kind" });
  const kindButtons = NOTE_KINDS.map(([value, label]) => {
    const b = h("button", { type: "button", text: label, "aria-pressed": "false" });
    b.addEventListener("click", () => {
      kind = value;
      for (const k of kindButtons) k.setAttribute("aria-pressed", String(k === b));
    });
    return b;
  });
  kinds.append(...kindButtons);
  const note = h("textarea", { placeholder: "Note", maxlength: "500", "aria-label": "Note" });
  const rewrite = h("textarea", { placeholder: "How you would have said it", maxlength: "1000", "aria-label": "Rewrite" });
  const toBankDefault = !(state.settings && state.settings.correctionRewriteToBank === false);
  const toBank = h("input", { type: "checkbox", checked: toBankDefault });
  const save = h("button", { type: "button", class: "btn small primary", text: "Save" });
  const cancel = h("button", { type: "button", class: "btn small ghost", text: "Cancel", onclick: () => sheet.remove() });
  save.addEventListener("click", async () => {
    if (!kind) { clear(slot); slot.append(chip("kind", "danger")); return; }
    const body = { messageId: m.id, kind };
    const n = note.value.trim();
    const r = rewrite.value.trim();
    if (n) body.note = n;
    if (r) { body.rewrite = r; body.toBank = toBank.checked; }
    save.disabled = true;
    try {
      const row = await api("POST", "/api/corrections", body);
      if (row && typeof row === "object") state.corrections.set(m.id, row);
      sheet.remove();
      refreshHisVersion(m);
    } catch (e) {
      save.disabled = false;
      clear(slot);
      slot.append(chip(e.code || "error", "danger"));
    }
  });
  const sheet = h("div", { class: "note-sheet" },
    kinds,
    note,
    rewrite,
    h("div", { class: "row between" },
      h("label", { class: "check" }, toBank, "Add to voice bank"),
      h("span", { class: "row" }, slot, cancel, save)));
  return sheet;
}

// Keep / Drop: one control cycling none, keep, drop. The row's own `mark` (when the API
// carries it) seeds the state; otherwise this page remembers what it set.
function markOf(m) {
  if (state.marks.has(m.id)) return state.marks.get(m.id);
  const raw = m.mark && typeof m.mark === "object" ? m.mark.mark : m.mark;
  return raw === "keep" || raw === "drop" ? raw : "none";
}

function markButton(m) {
  const btn = h("button", { type: "button", class: "mark" });
  const paint = (mark) => {
    btn.textContent = MARK_LABEL[mark];
    btn.className = "mark" + (mark === "none" ? "" : " " + mark);
    btn.setAttribute("aria-label", mark === "none" ? "Keep" : mark === "keep" ? "Kept" : "Dropped");
  };
  paint(markOf(m));
  btn.addEventListener("click", async () => {
    const next = MARK_CYCLE[markOf(m)];
    btn.disabled = true;
    try {
      if (next === "none") await api("DELETE", "/api/messages/" + encodeURIComponent(m.id) + "/mark");
      else await api("POST", "/api/messages/" + encodeURIComponent(m.id) + "/mark", { mark: next });
      state.marks.set(m.id, next);
      paint(next);
    } catch (e) {
      showError(e.code || "error", false);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// ------------------------------------------------------------ timing

function refreshTyping() {
  let waiting = false;
  for (const d of state.deliveries.values()) if (d.dots) waiting = true;
  const on = state.inFlight || state.dotsHold || waiting;
  els.typing.classList.toggle("hidden", !on);
  if (on) scrollBottom();
}

async function dots(ms, seq) {
  if (!alive(seq)) return;
  state.dotsHold = true;
  refreshTyping();
  await sleep(ms);
}

async function quiet(ms, seq) {
  if (!alive(seq)) return;
  state.dotsHold = false;
  refreshTyping();
  await sleep(ms);
}

// Her reply lands bubble by bubble: dots, a wait sized to the bubble, the bubble.
async function arrive(m, seq) {
  if (!m || !m.id || findMessageEl(m.id)) return;
  const el = renderMessage(m);
  const instant = state.timing === "instant" || m.role === "user" || m.channel === "operator" || !!m.call_id;
  if (instant) {
    appendMessage(el);
    scrollBottom();
    noteRole(m);
    return;
  }
  const bubbles = [...el.querySelectorAll(".bubbles > .bubble")];
  const tail = [...el.children].filter((c) => !c.classList.contains("bubbles") && !c.classList.contains("msg-avatar"));
  for (const b of bubbles) b.classList.add("hidden");
  for (const t of tail) t.classList.add("hidden");
  appendMessage(el);
  // Her avatar shows with her first bubble, not before it (the typing dots carry their own).
  const avatarSlot = () => el.querySelector(":scope > .msg-avatar");
  if (avatarSlot()) avatarSlot().classList.add("hidden");
  state.arriving++;
  updateSendState();
  try {
    const pause = pauseForId(m.id);
    for (let i = 0; i < bubbles.length; i++) {
      const delay = bubbleDelayMs(bubbles[i].textContent);
      if (i === 0 && pause) {
        await dots(delay / 2, seq);
        await quiet(PAUSE_MS, seq);
        await dots(delay / 2, seq);
      } else {
        await dots(delay, seq);
      }
      if (!alive(seq)) return;
      state.dotsHold = false;
      refreshTyping();
      if (i === 0 && avatarSlot()) avatarSlot().classList.remove("hidden");
      bubbles[i].classList.remove("hidden");
      bubbles[i].classList.add("enter");
      scrollBottom();
    }
    for (const t of tail) t.classList.remove("hidden");
    scrollBottom();
    noteRole(m);
  } finally {
    if (avatarSlot()) avatarSlot().classList.remove("hidden");
    state.arriving--;
    state.dotsHold = false;
    refreshTyping();
    updateSendState();
  }
}

// Real mode: her reply exists but is not hers to send yet. No dots while it is minutes
// away (she is not typing for six minutes); the dots start DOTS_LEAD_MS before it lands
// (bubbles.js dotsLeadMs), then the bubbles arrive at her cadence. Two timers: the dots
// and the arrival.
function scheduleDelivery(m, seq) {
  const at = Date.parse(m.deliver_at || m.deliverAt || "");
  const now = Date.now();
  const ms = at - now;
  if (!(ms > 0)) {
    arrive(m, seq);
    return;
  }
  if (state.deliveries.has(m.id)) return;
  const entry = { at, dots: false, dotsTimer: null, arriveTimer: null };
  const lead = dotsLeadMs(at, now);
  entry.dotsTimer = setTimeout(() => {
    entry.dotsTimer = null;
    if (!state.deliveries.has(m.id)) return;
    entry.dots = true;
    refreshTyping();
  }, Math.min(lead, 0x7fffffff));
  entry.arriveTimer = setTimeout(() => {
    entry.arriveTimer = null;
    state.deliveries.delete(m.id);
    refreshTyping();
    if (alive(seq)) arrive(m, seq);
  }, Math.min(ms, 0x7fffffff));
  state.deliveries.set(m.id, entry);
  refreshTyping();
}

function clearDeliveries() {
  for (const d of state.deliveries.values()) {
    if (d.dotsTimer) clearTimeout(d.dotsTimer);
    if (d.arriveTimer) clearTimeout(d.arriveTimer);
  }
  state.deliveries.clear();
}

// A hidden tab throttles timers: when the page comes back and a scheduled reply's time
// has passed, the thread is read again (the reply is in it now) instead of trusting a
// timer that may never have fired.
function onVisible() {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  let passed = false;
  for (const d of state.deliveries.values()) if (d.at <= now) passed = true;
  if (passed && state.currentId) loadThread();
}

function handleTurnResponse(r, id) {
  if (!r || state.currentId !== id || state.operator) return;
  const seq = state.loadSeq;
  if (r.userMessage) {
    appendMessage(renderMessage(r.userMessage));
    noteRole(r.userMessage);
  }
  const a = r.assistantMessage;
  if (a) {
    // A tasting that voided itself came back as a plain reply; say so on the message.
    if (a.id && flagCodes(r.flags).includes("tasting_void")) state.chipsFor.set(a.id, [chip("tasting void", "amber")]);
    const deliverAt = a.deliver_at || a.deliverAt || r.deliverAt || null;
    if (futureIso(deliverAt)) scheduleDelivery({ ...a, deliver_at: deliverAt }, seq);
    else arrive(a, seq);
  }
  scrollBottom();
}

// ------------------------------------------------------------ tastings (v3 HH)

function isTastingResponse(r) {
  return !!(r && typeof r === "object" && r.tastingId && Array.isArray(r.candidates));
}

function tastingStoreKey(conversationId) {
  return TASTING_KEY + conversationId;
}

function setTasting(t) {
  state.tasting = t;
  els.composer.classList.toggle("locked", !!t);
  els.lockRow.classList.toggle("hidden", !t);
  els.input.disabled = !!t;
  updateSendState();
  updateStartButton();
}

function candidateList(t) {
  const list = Array.isArray(t.candidates) ? t.candidates : [];
  const order = { left: 0, right: 1 };
  return list.slice().sort((a, b) => (order[a.side] ?? 2) - (order[b.side] ?? 2));
}

// Two panels, Left and Right, blind. The bubbles land with human timing in both at once.
function renderTasting(t, userMessage) {
  const seq = state.loadSeq;
  const conversationId = state.currentId;
  if (userMessage) {
    appendMessage(renderMessage(userMessage));
    noteRole(userMessage);
  }
  const wrap = h("div", { class: "msg hers tasting", "data-id": "tasting:" + t.tastingId });
  const panels = h("div", { class: "tasting-panels" });
  const buttons = [];
  const slot = h("span", { class: "chips" });
  const lock = (on) => { for (const b of buttons) b.disabled = on; };
  const panelFor = (c) => {
    const bubbles = h("div", { class: "bubbles" });
    const parts = splitBubbles(c.text);
    for (const p of parts.length ? parts : [String(c.text || "")]) bubbles.append(bubbleEl(p));
    const choose = h("button", { type: "button", class: "btn small primary", text: "This one", disabled: true, onclick: () => pick(c.side) });
    buttons.push(choose);
    const extras = [];
    if (c.photo) extras.push(chip("photo"));
    if (c.song && typeof c.song === "object" && c.song.title) extras.push(chip("song: " + String(c.song.title).slice(0, 40)));
    if (state.operator) for (const code of flagCodes(c.flags)) extras.push(chip(code, "flag"));
    return h("div", { class: "tasting-panel", "data-side": c.side },
      h("span", { class: "side", text: c.side === "left" ? "Left" : "Right" }),
      bubbles,
      extras.length ? h("div", { class: "chips" }, extras) : null,
      h("div", { class: "row" }, choose));
  };
  for (const c of candidateList(t)) panels.append(panelFor(c));
  const neither = h("button", { type: "button", class: "btn small ghost", text: "Neither", disabled: true, onclick: () => pick("neither") });
  buttons.push(neither);
  wrap.append(panels, h("div", { class: "tasting-foot" }, neither, t.expiresAt ? chip("until " + fmtTime(t.expiresAt)) : null, slot));
  appendMessage(wrap);
  scrollBottom();
  revealPanels(wrap, seq).then(() => { if (alive(seq)) lock(false); });

  async function pick(choice) {
    lock(true);
    clear(slot);
    let r;
    try {
      r = await api("POST", "/api/tastings/" + encodeURIComponent(t.tastingId) + "/pick", { pick: choice });
    } catch (e) {
      slot.append(chip(e.code || "error", "danger"));
      if (e.status === 409 || e.status === 404) finishTasting(conversationId, wrap, null);
      else lock(false);
      return;
    }
    if (choice === "neither") {
      finishTasting(conversationId, wrap, null);
      offerRetry(conversationId, t);
      return;
    }
    const info = r && r.tasting && typeof r.tasting === "object" ? r.tasting : {};
    const winner = info[choice] && typeof info[choice] === "object" ? info[choice] : null;
    for (const p of wrap.querySelectorAll(".tasting-panel")) {
      p.classList.toggle("chosen", p.dataset.side === choice);
      p.classList.toggle("lost", p.dataset.side !== choice);
    }
    await sleep(reducedMotion() ? 0 : 450);
    const a = r && r.assistantMessage && typeof r.assistantMessage === "object" ? r.assistantMessage : null;
    if (a && a.id && winner) state.chipsFor.set(a.id, [chip(String(winner.provider || "") + " " + String(winner.model || ""), "accent")]);
    finishTasting(conversationId, wrap, a);
    touchConversation(conversationId);
  }
}

// Both panels at once, each bubble after its own delay; instant timing shows them whole.
async function revealPanels(wrap, seq) {
  const instant = state.timing === "instant";
  const jobs = [];
  for (const panel of wrap.querySelectorAll(".tasting-panel")) {
    const bubbles = [...panel.querySelectorAll(".bubble")];
    if (instant) continue;
    for (const b of bubbles) b.classList.add("hidden");
    jobs.push((async () => {
      for (const b of bubbles) {
        await sleep(bubbleDelayMs(b.textContent));
        if (!alive(seq)) return;
        b.classList.remove("hidden");
        b.classList.add("enter");
        scrollBottom();
      }
    })());
  }
  await Promise.all(jobs);
}

function finishTasting(conversationId, wrap, assistantMessage) {
  storeSet(tastingStoreKey(conversationId), null);
  if (state.currentId === conversationId) setTasting(null);
  wrap.remove();
  if (assistantMessage && state.currentId === conversationId) {
    appendMessage(renderMessage(assistantMessage));
    noteRole(assistantMessage);
    scrollBottom();
  }
}

// After Neither the user message stays with no reply; Retry (the same key) runs a plain
// turn, and so does Taste on that key (a key already tasted cannot be tasted again; the
// server answers 409 idempotency_conflict, and spends nothing).
function offerRetry(conversationId, t) {
  if (state.currentId !== conversationId) return;
  const text = typeof t.text === "string" ? t.text : "";
  if (t.key && text) {
    state.pending = { key: t.key, conversationId, text, tasted: true };
    els.input.value = text;
    grow();
  }
  showError("neither", !!(t.key && text));
}

// A pending tasting survives a reload: its id, key and text are kept per conversation.
async function restoreTasting(conversationId, seq) {
  const raw = storeGet(tastingStoreKey(conversationId));
  if (!raw) return;
  let saved = null;
  try { saved = JSON.parse(raw); } catch { saved = null; }
  if (!saved || !saved.id) { storeSet(tastingStoreKey(conversationId), null); return; }
  let t = null;
  try { t = await api("GET", "/api/tastings/" + encodeURIComponent(saved.id)); } catch { t = null; }
  if (!alive(seq)) return;
  const row = t && t.tasting && typeof t.tasting === "object" ? { ...t.tasting, candidates: t.candidates || t.tasting.candidates } : t;
  if (!row || row.status !== "pending" || !Array.isArray(row.candidates)) {
    storeSet(tastingStoreKey(conversationId), null);
    return;
  }
  const shaped = { tastingId: saved.id, candidates: row.candidates, expiresAt: row.expiresAt || row.expires_at || null, key: saved.key, text: saved.text };
  setTasting(shaped);
  renderTasting(shaped, null);
}

// ------------------------------------------------------------ calls (v3 EE)

function callVisible() {
  const p = state.settings ? state.settings.callProvider : null;
  return typeof p === "string" && p !== "off";
}

function renderCallCard(callId, rows) {
  const first = rows[0] || {};
  const last = rows[rows.length - 1] || first;
  const call = state.calls.get(callId);
  let seconds = call && Number.isFinite(Number(call.seconds)) ? Number(call.seconds) : NaN;
  if (!Number.isFinite(seconds)) seconds = Math.max(0, (Date.parse(last.created_at || "") - Date.parse(first.created_at || "")) / 1000);
  const label = "Call, " + fmtDuration(seconds) + ", " + fmtTime(call && call.started_at ? call.started_at : first.created_at);
  const list = h("div", { class: "rows hidden" });
  for (const m of rows) {
    const who = m.role === "user" ? "him" : "her";
    const cap = h("div", { class: "cap " + who });
    const w = h("span", { class: "who", text: who === "him" ? "you" : "her" });
    if (who === "him") cap.append(document.createTextNode(m.content || ""), w);
    else cap.append(w, document.createTextNode(m.content || ""));
    list.append(cap);
  }
  if (!rows.length) list.append(h("div", { class: "chips" }, chip("no words")));
  const line = h("button", { type: "button", class: "call-line", "aria-expanded": "false" }, svgIcon("phone"), document.createTextNode(label));
  line.addEventListener("click", () => {
    const open = list.classList.contains("hidden");
    list.classList.toggle("hidden", !open);
    line.setAttribute("aria-expanded", String(open));
  });
  return h("div", { class: "call-card", "data-id": "call:" + callId }, line, list);
}

async function startCall() {
  if (state.call && state.call.live) return;
  if (state.inFlight || state.arriving) return;
  let id;
  try {
    id = await ensureConversation();
  } catch (e) {
    showError(e.code || "error", false);
    return;
  }
  hideError();
  const call = createCall({
    conversationId: id,
    els: { sheet: els.callSheet, status: els.callStatus, timer: els.callTimer, captions: els.callCaptions, reason: els.callReason, mute: els.callMute, end: els.callEnd, audio: els.callAudio },
    onEnd: () => {
      state.call = null;
      els.callBtn.classList.remove("calling");
      els.callBtn.setAttribute("aria-pressed", "false");
      updateSendState();
      if (state.currentId === id) loadThread();
    },
  });
  state.call = call;
  els.callBtn.classList.add("calling");
  els.callBtn.setAttribute("aria-pressed", "true");
  updateSendState();
  try {
    await call.start();
  } catch (e) {
    state.call = null;
    els.callBtn.classList.remove("calling");
    els.callBtn.setAttribute("aria-pressed", "false");
    updateSendState();
    showError(e.code || "error", false);
  }
}

// ------------------------------------------------------------ photos

// A pending photo is generated by a request this page holds open (the server cannot keep
// working in the background long enough for an image call). The server refuses a second
// request for the same picture while one is running, in which case the page just polls.
// A clip (v4 A3) rides on the same message columns as a photo; the asset's role (or its
// vid_ id before the assets route has listed it) tells them apart.
function isClip(m) {
  const id = m && typeof m.image_id === "string" ? m.image_id : "";
  if (!id) return false;
  const a = state.assets.get(id);
  if (a && typeof a.role === "string") return a.role === "video";
  return id.startsWith("vid_");
}

function renderPhoto(m, errorCode, error) {
  if (isClip(m)) return renderClip(m, errorCode, error);
  const status = m.image_status;
  if (status === "pending") {
    if (m.id) requestPhoto(m);
    return h("div", { class: "photo" }, h("div", { class: "photo-pending", "aria-label": "Photo pending" }));
  }
  if (status === "ready" && m.image_id) {
    if (state.rejected.has(m.image_id)) return null;
    const url = "/media/" + encodeURIComponent(m.image_id);
    const asset = state.assets.get(m.image_id);
    const withHim = !!(asset && Number(asset.with_him) === 1);
    // The picture opens at full size in its own tab; Save fetches the same bytes as a file.
    const wrap = h("div", { class: "photo" + (withHim ? " with-him" : "") },
      h("a", { href: url, target: "_blank", rel: "noopener", class: "photo-link", title: "Open full size" }, h("img", { src: url, alt: "" })),
      h("div", { class: "photo-links" },
        h("a", { href: url, target: "_blank", rel: "noopener" }, "Open full size"),
        h("a", { href: url + "?download=1", download: "avelie-" + m.image_id + ".png" }, "Save"),
        withHim ? chip("us", "us") : null));
    if (!state.approved.has(m.image_id)) wrap.append(photoActions(m, m.image_id, wrap));
    return wrap;
  }
  if (status === "failed") {
    const row = h("div", { class: "photo-actions" }, chip("photo failed"));
    if (errorCode) row.append(chip(errorCode, "danger"));
    const detail = error && typeof error.detail === "string" ? error.detail : "";
    if (detail && detail !== errorCode) row.append(chip(detail));
    const retryable = !(error && error.retryable === false);
    if (m.id && m.image_id && retryable) {
      const retry = h("button", { type: "button", class: "btn small", text: "Retry" });
      retry.addEventListener("click", () => {
        retry.disabled = true;
        replacePhoto({ ...m, image_status: "pending" });
      });
      row.append(retry);
    }
    return h("div", { class: "photo" }, row);
  }
  return null;
}

async function requestPhoto(m) {
  const id = m.id;
  if (!id || state.generating.has(id)) return;
  state.generating.add(id);
  const conversationId = m.conversation_id || state.currentId;
  try {
    await api("POST", "/api/images/generate", { conversationId, messageId: id });
    replacePhoto(await api("GET", "/api/messages/" + encodeURIComponent(id)));
  } catch (e) {
    if (e.status === 409) {
      // Another request (another tab, an earlier attempt) holds it; watch the message.
      let fresh = null;
      try { fresh = await api("GET", "/api/messages/" + encodeURIComponent(id)); } catch { fresh = null; }
      if (fresh && fresh.image_status !== "pending") replacePhoto(fresh);
      else startPoll({ ...m, conversation_id: conversationId });
    } else {
      replacePhoto({ ...m, image_status: "failed" }, e.code || "error", e);
    }
  } finally {
    state.generating.delete(id);
  }
}

function photoActions(m, imageId, wrap) {
  const row = h("div", { class: "photo-actions" });
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const regen = h("button", { type: "button", class: "btn small quiet", text: "Regenerate" });
  const buttons = [approve, reject, regen];
  const lock = (on) => { for (const b of buttons) b.disabled = on; };
  const fail = (e) => {
    lock(false);
    row.querySelectorAll(".chip").forEach((c) => c.remove());
    row.append(chip(e.code || "error", "danger"));
  };
  const act = async (decision) => {
    lock(true);
    try {
      await api("POST", "/api/images/" + encodeURIComponent(imageId) + "/decide", { decision });
      if (decision === "approve") {
        state.approved.add(imageId);
        row.remove();
      } else {
        state.rejected.add(imageId);
        wrap.remove();
      }
    } catch (e) {
      fail(e);
    }
  };
  // Reject this one and ask again with the same description; the message follows the new picture.
  const regenerate = async () => {
    lock(true);
    try {
      const r = await api("POST", "/api/images/" + encodeURIComponent(imageId) + "/regenerate", {});
      state.rejected.add(imageId);
      const asset = r && r.asset ? r.asset : null;
      let fresh = null;
      if (m.id) {
        try { fresh = await api("GET", "/api/messages/" + encodeURIComponent(m.id)); } catch { fresh = null; }
      }
      if (fresh && fresh.image_id && fresh.image_id !== imageId) {
        replacePhoto(fresh);
      } else if (asset && asset.id) {
        const status = asset.approval_status === "candidate" ? "ready" : asset.approval_status === "failed" ? "failed" : "pending";
        replacePhoto({ ...m, image_id: asset.id, image_status: status });
      } else {
        replacePhoto({ ...m, image_status: "failed" }, "regenerate", { retryable: false });
      }
    } catch (e) {
      fail(e);
    }
  };
  approve.addEventListener("click", () => act("approve"));
  reject.addEventListener("click", () => act("reject"));
  regen.addEventListener("click", regenerate);
  row.append(approve, reject, regen);
  return row;
}

function startPoll(m) {
  const messageId = m.id;
  if (state.pollers.has(messageId)) return;
  let count = 0;
  let last = m;
  const timer = setInterval(async () => {
    count++;
    let fresh = null;
    try { fresh = await api("GET", "/api/messages/" + encodeURIComponent(messageId)); } catch { fresh = null; }
    if (!state.pollers.has(messageId)) return;
    if (fresh) last = fresh;
    if (fresh && fresh.image_status !== "pending") {
      stopPoll(messageId);
      replacePhoto(fresh);
      return;
    }
    if (count >= POLL_MAX) {
      // Whoever held the request is gone or stuck; Retry re-requests (the server takes
      // over an expired claim) and the polling starts again on a 409.
      stopPoll(messageId);
      replacePhoto({ ...last, image_status: "failed" }, "timeout");
    }
  }, POLL_MS);
  state.pollers.set(messageId, timer);
}

function stopPoll(id) {
  const t = state.pollers.get(id);
  if (t) clearInterval(t);
  state.pollers.delete(id);
}

function stopPollers() {
  for (const id of [...state.pollers.keys()]) stopPoll(id);
  for (const id of [...state.clipPollers.keys()]) stopClipPoll(id);
  for (const t of state.songTimers.values()) clearTimeout(t);
  state.songTimers.clear();
}

function findMessageEl(id) {
  const esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  return els.thread.querySelector('[data-id="' + esc + '"]');
}

function replacePhoto(m, errorCode, error) {
  const el = findMessageEl(m.id);
  if (!el) return;
  let extras = el.querySelector(".extras");
  const old = extras ? extras.querySelector(".photo") : null;
  const fresh = renderPhoto(m, errorCode, error);
  if (old) {
    if (fresh) old.replaceWith(fresh);
    else old.remove();
  } else if (fresh) {
    if (!extras) {
      extras = h("div", { class: "extras" });
      el.insertBefore(extras, el.querySelector(".meta"));
    }
    extras.prepend(fresh);
  }
  if (extras && !extras.childElementCount) extras.remove();
}

// ------------------------------------------------------------ clips (v4 A3)

// The source photo a generating clip was made from sits in its claim note
// ("source:<id>|task:...|since ..."); it is the bubble's poster.
function clipSourceOf(asset) {
  const notes = asset && typeof asset.notes === "string" ? asset.notes : "";
  if (!notes.startsWith("source:")) return "";
  const head = notes.split("|")[0] || "";
  return head.slice("source:".length).trim();
}

function clipStatus(m) {
  const a = state.assets.get(m.image_id);
  const s = a ? a.approval_status : "";
  if (s === "generating" || s === "pending") return "pending";
  if (s === "candidate" || s === "approved") return "ready";
  if (s === "failed") return "failed";
  return m.image_status === "ready" ? "ready" : m.image_status === "failed" ? "failed" : "pending";
}

// A video bubble: the source photo as its poster and a play control while the clip is
// being made (polled until ready), then the player from /media/:id with the same Open
// full size and Save links a photo has, and Approve / Reject until he decides.
function renderClip(m, errorCode, error) {
  const id = m.image_id;
  if (!id) return null;
  if (state.rejected.has(id)) return null;
  const asset = state.assets.get(id);
  const source = clipSourceOf(asset) || state.clipSources.get(id) || "";
  if (source) state.clipSources.set(id, source);
  const poster = source ? "/media/" + encodeURIComponent(source) : "";
  const status = clipStatus(m);
  const url = "/media/" + encodeURIComponent(id);
  if (status === "pending") {
    if (m.id) startClipPoll(m);
    const frame = h("div", { class: "video-pending", role: "img", "aria-label": "Clip pending" });
    if (poster) frame.append(h("img", { src: poster, alt: "", loading: "lazy" }));
    return h("div", { class: "photo video-bubble" }, frame);
  }
  if (status === "ready") {
    const video = h("video", { controls: true, playsinline: true, preload: "metadata", src: url });
    if (poster) video.setAttribute("poster", poster);
    const wrap = h("div", { class: "photo video-bubble" },
      video,
      h("div", { class: "video-links photo-links" },
        h("a", { href: url, target: "_blank", rel: "noopener" }, "Open full size"),
        h("a", { href: url + "?download=1", download: "avelie-" + id + ".mp4" }, "Save")));
    if (!state.approved.has(id) && !(asset && asset.approval_status === "approved")) wrap.append(clipActions(m, id, wrap));
    return wrap;
  }
  const row = h("div", { class: "photo-actions" }, chip("clip failed"));
  if (errorCode) row.append(chip(errorCode, "danger"));
  const detail = error && typeof error.detail === "string" ? error.detail : "";
  if (detail && detail !== errorCode) row.append(chip(detail));
  return h("div", { class: "photo video-bubble failed" }, row);
}

function clipActions(m, id, wrap) {
  const row = h("div", { class: "photo-actions" });
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const act = async (decision) => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      await api("POST", "/api/images/" + encodeURIComponent(id) + "/decide", { decision });
      if (decision === "approve") {
        state.approved.add(id);
        row.remove();
      } else {
        state.rejected.add(id);
        wrap.remove();
      }
    } catch (e) {
      approve.disabled = false;
      reject.disabled = false;
      row.querySelectorAll(".chip").forEach((c) => c.remove());
      row.append(chip(e.code || "error", "danger"));
    }
  };
  approve.addEventListener("click", () => act("approve"));
  reject.addEventListener("click", () => act("reject"));
  row.append(approve, reject);
  return row;
}

// The poll drives the task forward (a clip only moves when a page asks) and then the
// message is read again so the bubble re-renders from what the server says.
function startClipPoll(m) {
  const id = m.image_id;
  if (!id || state.clipPollers.has(id)) return;
  let count = 0;
  const timer = setInterval(async () => {
    count++;
    let r = null;
    try {
      r = await api("POST", "/api/video/" + encodeURIComponent(id) + "/poll", {});
    } catch (e) {
      if (e.status === 409 && e.code === "in_progress") return;
      if (e.status === 409 && e.code === "already_generated") {
        // Another tab or device finished it first: read the assets and the message again and
        // show the clip as it now is (a clip decided elsewhere as rejected goes).
        stopClipPoll(id);
        try { indexAssets(await api("GET", "/api/assets")); } catch { /* keep what the page has */ }
        const a = state.assets.get(id);
        if (a && a.approval_status === "rejected") state.rejected.add(id);
        if (!a || a.approval_status === "generating" || a.approval_status === "pending") rememberAsset({ ...(a || {}), id, approval_status: "candidate" });
        let fresh = null;
        try { fresh = await api("GET", "/api/messages/" + encodeURIComponent(m.id)); } catch { fresh = null; }
        const base = fresh && fresh.id ? fresh : m;
        replacePhoto({ ...base, image_id: id, image_status: "ready" });
        return;
      }
      if (e.status === 404 || e.status === 422 || e.status === 409) {
        stopClipPoll(id);
        replacePhoto({ ...m, image_status: "failed" }, e.code || "error", e);
      }
      return;
    }
    if (!state.clipPollers.has(id)) return;
    if (r && r.asset) rememberAsset(r.asset);
    const status = r && r.status;
    if (status === "candidate" || status === "approved" || status === "failed") {
      stopClipPoll(id);
      let fresh = null;
      try { fresh = await api("GET", "/api/messages/" + encodeURIComponent(m.id)); } catch { fresh = null; }
      const base = fresh && fresh.id ? fresh : m;
      replacePhoto({ ...base, image_id: id, image_status: status === "failed" ? "failed" : "ready" });
      return;
    }
    if (count >= CLIP_POLL_MAX) {
      stopClipPoll(id);
      replacePhoto({ ...m, image_status: "failed" }, "timeout");
    }
  }, CLIP_POLL_MS);
  state.clipPollers.set(id, timer);
}

function stopClipPoll(id) {
  const t = state.clipPollers.get(id);
  if (t) clearInterval(t);
  state.clipPollers.delete(id);
}

// ------------------------------------------------------------ composer

// An empty box keeps its CSS height: measuring it would freeze a wrapped placeholder
// (a narrow first layout) into the field.
function grow() {
  if (!els.input.value) {
    els.input.style.height = "";
    return;
  }
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + "px";
}

function updateSendState() {
  const busy = state.inFlight || state.arriving > 0 || !!state.tasting;
  const onCall = !!(state.call && !state.call.ended);
  els.sendBtn.disabled = busy;
  els.retryBtn.disabled = busy;
  els.letHerStart.disabled = busy || onCall;
  els.micBtn.disabled = busy || state.operator;
  els.attachBtn.disabled = busy || state.operator;
  // A tasting carries no photos (the multipart route runs a plain turn), so Taste waits
  // until the attachments are gone rather than silently spending one ordinary turn.
  els.tasteBtn.disabled = busy || state.operator || state.attachments.length > 0;
  els.tasteBtn.classList.toggle("hidden", !(state.settings && state.settings.tastingEnabled === true) || state.operator);
  els.callBtn.classList.toggle("hidden", !callVisible() || state.operator);
  els.callBtn.disabled = onCall ? false : (state.inFlight || state.arriving > 0);
}

function setInFlight(on) {
  state.inFlight = on;
  updateSendState();
  refreshTyping();
}

function showError(code, retry) {
  els.errorChip.textContent = code || "error";
  els.errorRow.classList.remove("hidden");
  els.retryBtn.classList.toggle("hidden", !retry);
}

function hideError() {
  els.errorRow.classList.add("hidden");
  els.retryBtn.classList.add("hidden");
}

// The same key goes out again only for the same text in the same conversation (the
// Retry control); anything else is a new turn with a new key.
function pendingFor(conversationId, text) {
  const p = state.pending;
  if (p && p.conversationId === conversationId && p.text === text) return p;
  return { key: crypto.randomUUID(), conversationId, text };
}

async function send(opts) {
  const wantTasting = !!(opts && opts.tasting);
  const text = els.input.value.trim();
  if (!text || state.inFlight || state.arriving || state.tasting) return;
  setInFlight(true);
  hideError();
  let id = null;
  try {
    id = await ensureConversation();
    if (state.operator) {
      const r = await api("POST", "/api/operator", { content: text, conversationId: id });
      if (state.currentId === id && state.operator) {
        const now = new Date().toISOString();
        appendMessage(renderMessage({ id: "", role: "user", channel: "operator", content: text, created_at: now }));
        appendMessage(renderMessage({ id: "", role: "assistant", channel: "operator", content: String(r.reply || ""), created_at: now }));
        scrollBottom();
      }
    } else {
      const pending = pendingFor(id, text);
      state.pending = pending;
      // A key that already went through a tasting (Neither) is sent as a plain turn.
      const tasting = wantTasting && !pending.tasted;
      const path = "/api/conversations/" + encodeURIComponent(id) + "/turn";
      let r;
      try {
        if (state.attachments.length) {
          const fd = new FormData();
          fd.append("content", text);
          fd.append("idempotencyKey", pending.key);
          if (tasting) fd.append("tasting", "true");
          for (const f of state.attachments) fd.append("image", f, f.name || "image");
          r = await apiForm("POST", path, fd);
        } else {
          const body = { content: text, idempotencyKey: pending.key };
          if (tasting) body.tasting = true;
          r = await api("POST", path, body);
        }
      } catch (e) {
        // A key the server already tied to something else can never succeed again.
        if (e.status === 409 && e.code !== "tasting_pending") state.pending = null;
        throw e;
      }
      state.pending = null;
      state.attachments = [];
      renderAttachments();
      if (isTastingResponse(r)) {
        if (state.currentId === id) {
          const shaped = { ...r, key: pending.key, text };
          storeSet(tastingStoreKey(id), JSON.stringify({ id: r.tastingId, key: pending.key, text }));
          setTasting(shaped);
          renderTasting(shaped, r.userMessage || null);
        }
      } else {
        handleTurnResponse(r, id);
      }
    }
    touchConversation(id);
    els.input.value = "";
    grow();
  } catch (e) {
    showError(e.code || "error", e.code !== "tasting_pending");
    // A tasting started elsewhere (the Mac, another tab): the 409 names it, so this page
    // shows the two panels and lets him pick here instead of answering every Send with a chip.
    if (e.code === "tasting_pending" && id && typeof e.detail === "string" && e.detail && state.currentId === id && !state.tasting) {
      storeSet(tastingStoreKey(id), JSON.stringify({ id: e.detail }));
      restoreTasting(id, state.loadSeq).catch(() => { /* the chip already says what is pending */ });
    }
  } finally {
    setInFlight(false);
    els.input.focus();
  }
}

// She opens: a turn with no message from him.
async function letHerStart() {
  if (state.inFlight || state.arriving || state.tasting) return;
  setInFlight(true);
  hideError();
  try {
    const id = await ensureConversation();
    const r = await api("POST", "/api/conversations/" + encodeURIComponent(id) + "/open", {});
    handleTurnResponse(r, id);
    touchConversation(id);
  } catch (e) {
    showError(e.code || "error", false);
  } finally {
    setInFlight(false);
  }
}

// ------------------------------------------------------------ attachments

function addFiles(files) {
  for (const f of files) {
    if (state.attachments.length >= MAX_IMAGES) { showError("max " + MAX_IMAGES + " photos", false); break; }
    if (!IMAGE_TYPES.has(f.type)) { showError("jpeg, png or webp", false); continue; }
    if (f.size > MAX_IMAGE_BYTES) { showError("8 MB max", false); continue; }
    state.attachments.push(f);
  }
  els.fileInput.value = "";
  renderAttachments();
}

// Thumbnails as data URLs: the page's CSP allows data: images and not blob: ones.
function renderAttachments() {
  clear(els.attachStrip);
  els.attachStrip.classList.toggle("hidden", !state.attachments.length);
  updateSendState();
  state.attachments.forEach((f, i) => {
    const img = h("img", { alt: "" });
    const reader = new FileReader();
    reader.addEventListener("load", () => { img.src = String(reader.result || ""); });
    reader.readAsDataURL(f);
    const remove = h("button", { type: "button", "aria-label": "Remove", onclick: () => { state.attachments.splice(i, 1); renderAttachments(); } }, svgIcon("x"));
    els.attachStrip.append(h("div", { class: "thumb" }, img, remove));
  });
}

// ------------------------------------------------------------ voice in

function initMic() {
  const supported = navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
  if (!supported) {
    els.micBtn.classList.add("hidden");
    return;
  }
  els.micBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    // A recording left running by a tap stops (and sends) on the next press.
    if (state.rec) { stopRecording(); return; }
    if (els.micBtn.setPointerCapture) {
      try { els.micBtn.setPointerCapture(e.pointerId); } catch { /* not needed */ }
    }
    startRecording();
  });
  for (const ev of ["pointerup", "pointercancel"]) els.micBtn.addEventListener(ev, () => {
    const rec = state.rec;
    if (!rec) return;
    // Let go while the permission prompt is up, or a short tap: keep recording until the next tap.
    if (!rec.stream || Date.now() - rec.pressedAt < TAP_MS) {
      rec.tap = true;
      els.micBtn.setAttribute("aria-label", "Tap to stop");
      return;
    }
    stopRecording();
  });
  els.micBtn.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (state.rec) stopRecording();
      else startRecording();
    }
  });
  els.micBtn.addEventListener("contextmenu", (e) => e.preventDefault());
}

async function startRecording() {
  if (state.rec || state.inFlight || state.operator || state.tasting) return;
  const rec = { stream: null, recorder: null, chunks: [], startedAt: Date.now(), pressedAt: Date.now(), released: false, tap: false, timer: null };
  state.rec = rec;
  els.micBtn.classList.add("recording");
  els.micBtn.setAttribute("aria-pressed", "true");
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showError("microphone", false);
    resetRecording(rec);
    return;
  }
  if (rec.released || state.rec !== rec) {
    // The hold ended while the permission prompt was up.
    resetRecording(rec);
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  try {
    rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  } catch {
    showError("microphone", false);
    resetRecording(rec);
    return;
  }
  rec.recorder.addEventListener("dataavailable", (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); });
  rec.recorder.addEventListener("stop", () => finishRecording(rec));
  rec.recorder.start();
  rec.startedAt = Date.now();
  rec.timer = setTimeout(() => stopRecording(), MAX_VOICE_MS);
}

function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  rec.released = true;
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
}

function finishRecording(rec) {
  const mime = (rec.recorder && rec.recorder.mimeType) || "audio/webm";
  const blob = new Blob(rec.chunks, { type: mime });
  const ms = Date.now() - rec.startedAt;
  resetRecording(rec);
  if (ms < MIN_VOICE_MS || !blob.size) return;
  if (blob.size > MAX_VOICE_BYTES) { showError("4 MB max", false); return; }
  sendVoice(blob, mime);
}

function resetRecording(rec) {
  if (state.rec === rec) state.rec = null;
  if (rec) {
    clearTimeout(rec.timer);
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  }
  els.micBtn.classList.remove("recording");
  els.micBtn.setAttribute("aria-pressed", "false");
  els.micBtn.setAttribute("aria-label", "Hold to record");
}

async function sendVoice(blob, mime) {
  if (state.inFlight || state.tasting) return;
  setInFlight(true);
  hideError();
  try {
    const id = await ensureConversation();
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
    const fd = new FormData();
    fd.append("audio", blob, "voice." + ext);
    fd.append("idempotencyKey", crypto.randomUUID());
    const r = await apiForm("POST", "/api/conversations/" + encodeURIComponent(id) + "/voice", fd);
    handleTurnResponse(r, id);
    touchConversation(id);
  } catch (e) {
    showError(e.code || "error", false);
  } finally {
    setInFlight(false);
  }
}

// ------------------------------------------------------------ scene, settings

async function loadScene() {
  try {
    const bundle = await api("GET", "/api/state");
    state.cache.state = bundle;
    state.scene = bundle && bundle.scene && bundle.scene.state ? bundle.scene.state : null;
  } catch {
    state.scene = null;
  }
  renderScene();
  applyPlaceBackground(undefined);
}

function renderScene() {
  const s = state.scene ? state.scene.status : null;
  els.sceneTogether.setAttribute("aria-pressed", String(s === "together"));
  els.sceneApart.setAttribute("aria-pressed", String(s === "apart"));
}

async function setScene(status, location) {
  const base = state.scene && typeof state.scene === "object" ? state.scene : {};
  const next = { ...base, status, location: location || null };
  if (status === "together" && location) storeSet(PLACE_KEY, location);
  els.sceneTogether.disabled = true;
  els.sceneApart.disabled = true;
  let place;
  try {
    const r = await api("PUT", "/api/state/scene", { state: next, note: "toggle" });
    state.scene = r && r.state ? r.state : next;
    // v4: the route names the place it matched, with or without a picture.
    place = r && r.place !== undefined ? r.place : undefined;
    state.placeRows = null;
  } catch (e) {
    showError(e.code || "error", false);
  } finally {
    els.sceneTogether.disabled = false;
    els.sceneApart.disabled = false;
    renderScene();
    applyPlaceBackground(place);
  }
}

// ------------------------------------------------------------ places (v4 section 8)

// The same normalisation src/places.ts uses for its title_norm: lowercase, one space.
function placeNorm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Her known places (the places table, after its sync with her life threads), cached a
// minute; null when the route is not there.
async function loadPlaces(force) {
  if (!force && state.placeRows && Date.now() - state.placeRowsAt < PLACES_TTL_MS) return state.placeRows;
  try {
    const r = await api("GET", "/api/places");
    const list = Array.isArray(r) ? r : r && Array.isArray(r.places) ? r.places : [];
    state.placeRows = list.filter((p) => p && p.id && p.title);
    state.placeRowsAt = Date.now();
  } catch {
    state.placeRows = null;
  }
  return state.placeRows;
}

function setPlaceUrl(id) {
  if (id) els.thread.style.setProperty("--place-url", "url(/media/place/" + encodeURIComponent(id) + ")");
  else els.thread.style.removeProperty("--place-url");
}

// The picture of the scene's place behind the thread (the stylesheet paints .thread::before
// from --place-url under the veil): set when the scene is together at a place that has a
// picture, removed when apart, none, or the place has no picture. `known` is what the
// scene PUT just answered ({ id, picture } or null); undefined means look it up.
async function applyPlaceBackground(known) {
  const s = state.scene;
  if (!s || s.status !== "together" || !s.location) { setPlaceUrl(null); return; }
  if (known !== undefined) {
    setPlaceUrl(known && known.picture && known.id ? known.id : null);
    return;
  }
  const rows = await loadPlaces(false);
  if (!state.scene || state.scene.status !== "together" || state.scene.location !== s.location) return;
  const want = placeNorm(s.location);
  const hit = (rows || []).find((p) => placeNorm(p.title) === want && p.picture);
  setPlaceUrl(hit ? hit.id : null);
}

// The box is never empty when a place is known: the scene's own place when together,
// else the newest Together scene version's place, else the last place set on this device.
async function prefillPlace() {
  if (state.scene && state.scene.status === "together" && state.scene.location) return String(state.scene.location);
  try {
    const rows = await api("GET", "/api/state/versions/scene?limit=50");
    for (const v of Array.isArray(rows) ? rows : []) {
      const st = parseJson(v && v.state_json, null);
      if (st && st.status === "together" && typeof st.location === "string" && st.location.trim()) return st.location.trim();
    }
  } catch {
    /* no versions to read: the stored place is next */
  }
  return storeGet(PLACE_KEY) || "";
}

function placeButton(title, thumbId) {
  const btn = h("button", { type: "button", class: "btn small quiet place-btn", onclick: () => { closeMenus(); setScene("together", title); } });
  if (thumbId) btn.append(h("img", { class: "place-thumb", src: "/media/place/" + encodeURIComponent(thumbId), alt: "", width: "40", height: "40", loading: "lazy" }));
  btn.append(document.createTextNode(title));
  return btn;
}

// What the page shows depends on a few settings: the Call button, the Taste button,
// the Note sheet's bank checkbox.
async function loadSettings() {
  try {
    const s = await api("GET", "/api/settings");
    state.settings = s && typeof s === "object" ? s : null;
  } catch {
    state.settings = null;
  }
  updateSendState();
}

async function loadLife() {
  try {
    const r = await api("GET", "/api/life?status=active");
    state.cache.life = r;
    state.places = (r && Array.isArray(r.threads) ? r.threads : []).filter((t) => t.kind === "place");
  } catch {
    state.cache.life = null;
    state.places = [];
  }
}

async function openPlaces() {
  closeMenus();
  els.placesPop.classList.remove("hidden");
  els.placeInput.value = state.scene && state.scene.status === "together" && state.scene.location ? String(state.scene.location) : "";
  clear(els.placesList);
  const [where, rows] = await Promise.all([prefillPlace(), loadPlaces(true)]);
  if (els.placesPop.classList.contains("hidden")) return;
  if (!els.placeInput.value && where) els.placeInput.value = where;
  if (rows) {
    for (const p of rows) els.placesList.append(placeButton(String(p.title), p.picture ? p.id : null));
  } else {
    // No places route: her life's place threads, as before.
    await loadLife();
    if (els.placesPop.classList.contains("hidden")) return;
    for (const p of state.places) els.placesList.append(placeButton(p.title, null));
  }
  els.placeInput.focus();
}

// ------------------------------------------------------------ drawers, menus

function openSidebar() {
  els.sidebar.classList.add("open");
  els.scrim.classList.remove("hidden");
  els.openDrawer.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.openDrawer.setAttribute("aria-expanded", "false");
  syncScrim();
}

function openDrawer(drawer) {
  closeMenus();
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  els.scrim.classList.remove("hidden");
  if (drawer === els.photosDrawer) els.photosBtn.setAttribute("aria-expanded", "true");
}

function drawers() {
  return [els.photosDrawer, els.whyDrawer, els.phoneDrawer].filter(Boolean);
}

function closeDrawers() {
  for (const d of drawers()) {
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
  }
  els.photosBtn.setAttribute("aria-expanded", "false");
  if (els.phoneBtn) els.phoneBtn.setAttribute("aria-expanded", "false");
  syncScrim();
}

function syncScrim() {
  const open = els.sidebar.classList.contains("open") || drawers().some((d) => d.classList.contains("open"));
  els.scrim.classList.toggle("hidden", !open);
}

// ------------------------------------------------------------ her phone (v4 section 1)

// The ids phone.js renders into (SPEC_V4 section 0), minus the places list: the drawer
// is read-only, and the chat page's own #placesList is the scene picker.
const PHONE_IDS = ["phoneStatus", "phoneNow", "phoneWhere", "phoneWeather", "phoneOutfit", "phoneMood", "phoneWants", "phoneAsks", "phoneToday", "phoneListening", "phoneMap"];

// The slide-in shows the same panel the Phone page does, from the same route, rendered by
// the same function (phone.js, loaded when the drawer opens, never at page load).
async function openPhone() {
  if (!els.phoneDrawer || !els.phoneDrawerBody) return;
  openDrawer(els.phoneDrawer);
  els.phoneBtn.setAttribute("aria-expanded", "true");
  const body = els.phoneDrawerBody;
  clear(body);
  body.append(h("div", { class: "chips" }, chip("loading")));
  let mod = null;
  let phone = null;
  try {
    [mod, phone] = await Promise.all([import("./phone.js"), api("GET", "/api/phone")]);
  } catch (e) {
    clear(body);
    body.append(h("div", { class: "chips" }, chip(e && e.code ? e.code : "phone", "danger")));
    return;
  }
  if (!els.phoneDrawer.classList.contains("open")) return;
  clear(body);
  const panel = h("div", { class: "phone-panel drawer-phone" });
  for (const id of PHONE_IDS) {
    if (!document.getElementById(id)) panel.append(h("div", { id, class: "phone-" + id.slice(5).toLowerCase() }));
  }
  body.append(panel);
  try {
    if (mod && typeof mod.renderPhone === "function") mod.renderPhone(panel, phone, { places: false, tap: false, readOnly: true });
    else body.append(h("div", { class: "chips" }, chip("phone", "danger")));
  } catch {
    body.append(h("div", { class: "chips" }, chip("phone", "danger")));
  }
  // Read-only in the drawer: no places list, no status line for it, no tap on the map.
  for (const id of ["placesList", "placesStatus"]) {
    const stray = body.querySelector("#" + id);
    if (stray) stray.remove();
  }
  const map = body.querySelector("svg.map");
  if (map) map.classList.add("read-only");
}

function closeMenus() {
  els.moreMenu.classList.add("hidden");
  els.moreBtn.setAttribute("aria-expanded", "false");
  els.placesPop.classList.add("hidden");
}

function toggleMore() {
  const open = els.moreMenu.classList.contains("hidden");
  closeMenus();
  if (open) {
    els.moreMenu.classList.remove("hidden");
    els.moreBtn.setAttribute("aria-expanded", "true");
  }
}

async function openPhotos() {
  openDrawer(els.photosDrawer);
  clear(els.photosList);
  let scenes = [];
  try {
    const assets = await api("GET", "/api/assets");
    scenes = Array.isArray(assets.scenes) ? assets.scenes.slice() : [];
  } catch (e) {
    els.photosList.append(chip(e.code || "error", "danger"));
    return;
  }
  scenes.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  if (!scenes.length) {
    els.photosList.append(h("div", { class: "chips" }, chip("none")));
    return;
  }
  for (const a of scenes) {
    const desc = String(a.prompt || "").slice(0, DESC_CHARS);
    els.photosList.append(h("button", { type: "button", class: "photo-row", onclick: () => jumpTo(a) },
      h("img", { src: "/media/" + encodeURIComponent(a.id), alt: "", loading: "lazy" }),
      h("span", { class: "photo-text" },
        h("span", { class: "photo-date", text: fmtDate(a.created_at) }),
        desc ? h("span", { class: "photo-desc", text: desc }) : null)));
  }
}

// A photo in the open conversation scrolls to its message; any other opens the picture.
function jumpTo(asset) {
  const el = asset.message_id ? findMessageEl(String(asset.message_id)) : null;
  if (el) {
    closeDrawers();
    el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  } else {
    window.open("/media/" + encodeURIComponent(asset.id), "_blank", "noopener");
  }
}

// ------------------------------------------------------------ why

async function ensureCaches() {
  const jobs = [];
  if (!state.cache.state) jobs.push(api("GET", "/api/state").then((b) => { state.cache.state = b; }).catch(() => {}));
  if (!state.cache.life) jobs.push(loadLife());
  await Promise.all(jobs);
}

function factById(id) {
  const s = state.cache.state;
  if (!s || !s.facts) return null;
  for (const k of ["fixed", "avelie", "justin"]) {
    for (const f of s.facts[k] || []) if (f.id === id) return f;
  }
  return null;
}

function historyById(id) {
  const s = state.cache.state;
  return s && Array.isArray(s.history) ? s.history.find((x) => x.id === id) || null : null;
}

function unknownById(id) {
  const s = state.cache.state;
  return s && Array.isArray(s.unknowns) ? s.unknowns.find((x) => x.id === id) || null : null;
}

function threadById(id) {
  const l = state.cache.life;
  return l && Array.isArray(l.threads) ? l.threads.find((x) => x.id === id) || null : null;
}

function labelOf(item, resolve) {
  if (item && typeof item === "object") return String(item.title || item.text || item.subject || item.topic || item.id || "");
  const id = String(item);
  const row = resolve(id);
  if (!row) return id;
  if (row.title) return row.title;
  if (row.topic) return row.topic;
  if (row.fact) return (row.subject ? row.subject + ": " : "") + row.fact;
  return id;
}

function whySection(title, items) {
  if (!items || !items.length) return null;
  return h("div", { class: "why-section" }, h("h3", { text: title }), h("ul", null, items));
}

function whyRow(text) {
  return h("li", { text: String(text).slice(0, 160) });
}

async function openWhy(m) {
  openDrawer(els.whyDrawer);
  clear(els.whyBody);
  let ctx;
  try {
    [ctx] = await Promise.all([api("GET", "/api/messages/" + encodeURIComponent(m.id) + "/context"), ensureCaches()]);
  } catch (e) {
    els.whyBody.append(h("div", { class: "chips" }, chip(e.code || "error", "danger")));
    return;
  }
  if (!ctx || typeof ctx !== "object") {
    els.whyBody.append(h("div", { class: "chips" }, chip("none")));
    return;
  }
  const used = new Set();
  const take = (k) => { used.add(k); return ctx[k]; };
  const runRows = [];
  for (const [label, key] of [["Prompt", "promptVersion"], ["Provider", "provider"], ["Model", "model"], ["Recent messages", "recentMessageCount"], ["Shape", "shapeCue"], ["Signature", "signature"]]) {
    const v = take(key);
    if (v !== undefined && v !== null && v !== "") runRows.push(h("span", { class: "k", text: label }), h("span", { class: "v", text: String(v) }));
  }
  if (runRows.length) els.whyBody.append(h("div", { class: "why-section" }, h("div", { class: "kv" }, runRows)));

  const history = asList(take("historyIds")).map((x) => whyRow(labelOf(x, historyById)));
  els.whyBody.append(whySection("History", history));

  const factIds = take("factIds");
  let facts = [];
  if (factIds && typeof factIds === "object" && !Array.isArray(factIds)) {
    for (const k of Object.keys(factIds)) facts.push(...asList(factIds[k]).map((x) => whyRow(labelOf(x, factById))));
  } else {
    facts = asList(factIds).map((x) => whyRow(labelOf(x, factById)));
  }
  els.whyBody.append(whySection("Facts", facts));

  els.whyBody.append(whySection("Life", asList(take("threadIds")).map((x) => {
    const row = typeof x === "object" ? x : threadById(String(x));
    const kind = row && row.kind ? row.kind + ": " : "";
    return whyRow(kind + labelOf(x, threadById));
  })));

  els.whyBody.append(whySection("Callbacks", asList(take("callbacks")).map((c) => {
    if (c && typeof c === "object") {
      const li = h("li");
      if (c.ageDays !== undefined && c.ageDays !== null) li.append(h("span", { class: "age", text: c.ageDays + "d" }));
      li.append(document.createTextNode(String(c.text || c.title || c.sourceId || "").slice(0, 160)));
      return li;
    }
    return whyRow(c);
  })));

  els.whyBody.append(whySection("Unknowns", asList(take("unknownIds")).map((x) => whyRow(labelOf(x, unknownById)))));

  const tasting = take("tasting");
  if (tasting && typeof tasting === "object") {
    const rows = [];
    for (const k of ["winner", "loser"]) {
      const p = tasting[k];
      if (p && typeof p === "object") rows.push(whyRow(k + ": " + String(p.provider || "") + " " + String(p.model || "")));
    }
    els.whyBody.append(whySection("Tasting", rows));
  }

  const flags = flagCodes(take("flags"));
  if (flags.length) els.whyBody.append(h("div", { class: "why-section" }, h("h3", { text: "Flags" }), h("div", { class: "chips" }, flags.map((f) => chip(f, "flag")))));

  const rest = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (used.has(k) || v === null || v === undefined) continue;
    rest.push(h("span", { class: "k", text: k }), h("span", { class: "v", text: typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v) }));
  }
  if (rest.length) els.whyBody.append(h("div", { class: "why-section" }, h("div", { class: "kv" }, rest)));
  if (!els.whyBody.childElementCount) els.whyBody.append(h("div", { class: "chips" }, chip("none")));
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

// ------------------------------------------------------------ wiring

els.composer.addEventListener("submit", (e) => { e.preventDefault(); send(); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
els.input.addEventListener("input", () => {
  grow();
  if (state.pending && els.input.value.trim() !== state.pending.text) state.pending = null;
});
els.retryBtn.addEventListener("click", () => send());
els.tasteBtn.addEventListener("click", () => send({ tasting: true }));
els.callBtn.addEventListener("click", startCall);
els.callMute.addEventListener("click", () => {
  if (!state.call) return;
  const on = els.callMute.getAttribute("aria-pressed") !== "true";
  state.call.mute(on);
});
els.callEnd.addEventListener("click", () => { if (state.call) state.call.end("hangup"); });
els.newChat.addEventListener("click", newChat);
els.openDrawer.addEventListener("click", openSidebar);
els.closeDrawer.addEventListener("click", closeSidebar);
els.scrim.addEventListener("click", () => { closeSidebar(); closeDrawers(); closeMenus(); });
els.letHerStart.addEventListener("click", letHerStart);
els.sceneTogether.addEventListener("click", openPlaces);
els.sceneApart.addEventListener("click", () => { closeMenus(); setScene("apart", null); });
els.placeSet.addEventListener("click", () => { const where = els.placeInput.value.trim(); closeMenus(); setScene("together", where || null); });
els.placeCancel.addEventListener("click", closeMenus);
els.placeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); els.placeSet.click(); } });
els.photosBtn.addEventListener("click", () => (els.photosDrawer.classList.contains("open") ? closeDrawers() : openPhotos()));
els.photosClose.addEventListener("click", closeDrawers);
els.whyClose.addEventListener("click", closeDrawers);
if (els.phoneBtn) els.phoneBtn.addEventListener("click", () => (els.phoneDrawer && els.phoneDrawer.classList.contains("open") ? closeDrawers() : openPhone()));
if (els.phoneClose) els.phoneClose.addEventListener("click", closeDrawers);
document.addEventListener("visibilitychange", onVisible);
window.addEventListener("avelie:player", onPlayerEvent);
els.moreBtn.addEventListener("click", toggleMore);
els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => addFiles(els.fileInput.files || []));
els.timingToggle.addEventListener("change", () => {
  state.timing = els.timingToggle.checked ? "human" : "instant";
  storeSet(TIMING_KEY, state.timing);
});
els.operatorToggle.addEventListener("change", () => {
  state.operator = els.operatorToggle.checked;
  els.composer.classList.toggle("operator", state.operator);
  document.body.classList.toggle("backstage", state.operator);
  hideError();
  stopPollers();
  updateSendState();
  loadThread();
});
document.addEventListener("click", (e) => {
  const inMenu = e.target.closest && (e.target.closest(".menu-wrap") || e.target.closest("#moreMenu") || e.target.closest("#placesPop"));
  if (!inMenu) closeMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenus(); closeDrawers(); closeSidebar(); }
});
window.addEventListener("resize", grow);

async function init() {
  els.operatorToggle.checked = false;
  els.timingToggle.checked = state.timing !== "instant";
  initMic();
  mountTypingAvatar();
  updateSendState();
  try {
    await api("GET", "/api/me");
    registerServiceWorker();
  } catch {
    /* the gate answers before this page loads; nothing to register */
  }
  await Promise.all([loadConversations(), loadScene(), loadSettings()]);
  const stored = storeGet(STORE_KEY);
  const pick = state.conversations.find((c) => c.id === stored) || state.conversations[0];
  if (pick) await select(pick.id);
  else updateStartButton();
  grow();
}

init();
