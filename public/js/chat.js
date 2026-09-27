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
// v5 (SPEC_V5 sections 1, 4, 9): the held-clock chip in the scene bar, the `place needed`
// chip on the Together form, and the song card's "know it" / "not for me" buttons.
// exp (DESIGN_EXPERIENCE 3.4 to 3.6): chapters with their own names and a rename at the
// head of the thread, the place line under her name, one tools sheet, a heart that keeps
// her line, the workings only behind their switch, pictures that open in the chat's own
// lightbox, failures in words, day separators, and her photograph (or the place) behind it.
import {
  api, apiForm, h, chip, clear, fmtDate, fmtTime, fmtDuration, flagCodes, parseJson, registerServiceWorker, storeGet, storeSet, svgIcon,
} from "./api.js";
import { splitReply, bubbleDelayMs, pauseForId, PAUSE_MS, dotsLeadMs } from "./bubbles.js";
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
// exp: a long press on her line opens the reaction bar; ten pixels of movement is a scroll.
const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;
// At this width and under the sheets are bottom sheets over the scrim; over it, popovers.
const PHONE_QUERY = "(max-width: 760px)";
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
  // v4 (optional, so an older shell still runs)
  nowPlaying: $("nowPlaying"),
  // v5 (optional, so an older shell still runs)
  clockChip: $("clockChip"),
  placeNeeded: $("placeNeeded"),
  // exp (DESIGN_EXPERIENCE 3.3; every one optional, so an older shell still runs)
  backdrop: $("backdrop"),
  whoAvatar: $("whoAvatar"),
  placeLine: $("placeLine"),
  nowLine: $("nowLine"),
  chapterHead: $("chapterHead"),
  chapterEdit: $("chapterEdit"),
  chapterDate: $("chapterDate"),
  recBar: $("recBar"),
  recTime: $("recTime"),
  recCancel: $("recCancel"),
  recSend: $("recSend"),
  toolStudio: $("toolStudio"),
  lightbox: $("lightbox"),
  lbClose: $("lbClose"),
  lbPrev: $("lbPrev"),
  lbNext: $("lbNext"),
  lbMedia: $("lbMedia"),
  lbDate: $("lbDate"),
  lbPlace: $("lbPlace"),
  lbSave: $("lbSave"),
  lbOpen: $("lbOpen"),
  lbDecide: $("lbDecide"),
  lbKeep: $("lbKeep"),
  lbReject: $("lbReject"),
  lbAgain: $("lbAgain"),
  // fix0927 lane A: the controls in plain sight (every one optional, so an older shell
  // still runs): the Together / Texting pill and Call in the bar, Send a photo and Voice
  // note beside the box, the Let her start chip above it.
  modePill: $("modePill"),
  tvBtn: $("tvBtn"),
  modeTogether: $("modeTogether"),
  modeTexting: $("modeTexting"),
  barCall: $("barCall"),
  composerPhoto: $("composerPhoto"),
  composerMic: $("composerMic"),
  startRow: $("startRow"),
  startChip: $("startChip"),
};

// The menu's controls and their twins in plain sight: one handler, one state, both places.
const callButtons = () => [els.callBtn, els.barCall].filter(Boolean);
const micButtons = () => [els.micBtn, els.composerMic].filter(Boolean);
const photoButtons = () => [els.attachBtn, els.composerPhoto].filter(Boolean);
const sceneButtons = () => [els.sceneTogether, els.sceneApart, els.modeTogether, els.modeTexting].filter(Boolean);

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
  // fix0927: true until the first chapter is read, so the chip never flashes at boot.
  threadLoading: true,
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
  // v5: the artists he marked, by artistNorm (read once per page from GET /api/known-artists).
  knownArtists: null,
  knownArtistsLoad: null,
  clockSeq: 0,
  // exp
  // Her story rows on screen, by message id (the reaction bar and the lightbox read them).
  rows: new Map(),
  // GET /api/wallpaper, read once per page: { url, focus } or null.
  wallpaper: undefined,
  backdropSrc: "",
  backdropSeq: 0,
  // The open reaction bar: { bar, bubble, m }.
  react: null,
  press: null,
  // The open lightbox: { items, index }.
  lightbox: null,
  // Picture id -> place words, from GET /api/roll (read on the first open).
  rollPlaces: null,
  // The control that opened the open sheet; focus goes back to it.
  sheetReturn: null,
  renaming: false,
  titleRefresh: false,
  // fix0927 lane A: when the last story row landed (the Let her start chip reads it), the
  // timer that shows the chip once her line is two minutes old, and the voice note playing.
  lastStoryAt: null,
  startTimer: null,
  voicePlaying: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------ conversations

// exp 3.4 item 1: a chapter's name is the server's displayTitle (his rename, else the place,
// else the day), then the stored title, then the day in words.
function convLabel(c) {
  if (!c) return dayTitle(new Date().toISOString());
  const shown = typeof c.displayTitle === "string" ? c.displayTitle.trim() : "";
  if (shown) return shown;
  const stored = typeof c.title === "string" ? c.title.trim() : "";
  return stored || dayTitle(c.firstAt || c.created_at);
}

function herTz() {
  const tz = state.settings ? state.settings.timezone : null;
  return typeof tz === "string" && tz ? tz : undefined;
}

// Intl parts in her timezone, or the browser's when the zone is unknown.
function partsOf(d, opts, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).formatToParts(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).formatToParts(d);
  }
}

// "Thursday night": the weekday and the part of her day (5 to 11 morning, 12 to 16
// afternoon, 17 to 20 evening, else night), the words the server names a new chapter with.
function dayTitle(iso) {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) return "";
  const parts = partsOf(d, { weekday: "long", hour: "numeric", hour12: false }, herTz());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  const hour = Number(get("hour")) % 24;
  const part = hour >= 5 && hour <= 11 ? "morning" : hour >= 12 && hour <= 16 ? "afternoon" : hour >= 17 && hour <= 20 ? "evening" : "night";
  return (get("weekday") + " " + part).trim();
}

// "Saturday, Sep 26": the chapter's first day, under its name.
function longDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

// "Saturday, September 26": a picture's day in the lightbox.
function fullDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// The local calendar day of an instant ("2026-09-26"), what the day separators compare.
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// "Today", "Yesterday", the weekday within six days, else "Sep 20".
function dayWords(iso, now) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const base = now instanceof Date ? now : new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(base) - start(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days <= 6) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// The rail's time: the hour today, else the day words.
function chapterWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const words = dayWords(iso);
  return words === "Today" ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : words;
}

// The chapter's last line, one line (CSS clips it); his lines start "You: ".
function previewLine(c) {
  const p = c && c.preview && typeof c.preview === "object" ? c.preview : null;
  const text = p && typeof p.text === "string" ? p.text.trim() : "";
  if (!text) return "";
  return (p.role === "user" ? "You: " : "") + text;
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
    const active = c.id === state.currentId;
    const preview = previewLine(c);
    const btn = h("button", {
      type: "button",
      class: "chapter-open",
      "aria-current": active ? "true" : null,
      onclick: () => { select(c.id); closeSidebar(); },
    },
    h("span", { class: "chapter-title", text: convLabel(c) }),
    h("span", { class: "chapter-when", text: chapterWhen(c.lastAt || c.last_message_at || c.created_at) }),
    preview ? h("span", { class: "chapter-preview", text: preview }) : null);
    els.convList.append(h("li", { class: "chapter-row" + (active ? " active" : "") }, btn));
  }
}

function currentConversation() {
  return state.conversations.find((x) => x.id === state.currentId) || null;
}

// exp 3.4 item 2: the chapter head at the top of the thread: its name (a button, tap to
// rename) and its first day in words. With no chapter yet, the day's name and today.
function updateTitle() {
  const c = currentConversation();
  const title = convLabel(c);
  if (els.convTitle) {
    els.convTitle.textContent = title;
    els.convTitle.setAttribute("aria-label", title + ", rename");
  }
  if (els.chapterDate) els.chapterDate.textContent = longDay(c ? c.firstAt || c.created_at : new Date().toISOString());
}

// The name he gave it, or empty when the name is automatic.
function hisTitle(c) {
  if (!c) return "";
  if (c.titleFrom && c.titleFrom !== "his") return "";
  return typeof c.title === "string" ? c.title.trim() : "";
}

function startRename() {
  if (!els.chapterEdit || !els.convTitle || state.renaming) return;
  const c = currentConversation();
  state.renaming = true;
  els.chapterEdit.value = hisTitle(c);
  els.chapterEdit.placeholder = convLabel(c);
  els.convTitle.classList.add("hidden");
  els.chapterEdit.classList.remove("hidden");
  els.chapterEdit.focus();
  els.chapterEdit.select();
}

// The flag drops before the field hides, so the blur that hiding causes saves nothing.
function endRename() {
  state.renaming = false;
  if (els.chapterEdit) els.chapterEdit.classList.add("hidden");
  if (els.convTitle) els.convTitle.classList.remove("hidden");
}

function cancelRename() {
  if (!state.renaming) return;
  endRename();
  if (els.convTitle) els.convTitle.focus();
}

// Enter or blur saves: PUT /api/conversations/:id { title }, an empty name sends null
// (back to the automatic one). A name typed on an empty page makes the chapter first.
async function saveRename() {
  if (!state.renaming) return;
  const raw = els.chapterEdit.value.replace(/\s+/g, " ").trim();
  const c = currentConversation();
  endRename();
  if (raw === hisTitle(c)) return;
  if (!c && !raw) return;
  try {
    const id = await ensureConversation();
    const view = await api("PUT", "/api/conversations/" + encodeURIComponent(id), { title: raw || null });
    if (view && typeof view === "object" && view.id) mergeConversation(view);
  } catch (e) {
    showError(e.code || "error", false);
  }
}

// The head, the rail row and state.conversations take the server's answer.
function mergeConversation(view) {
  const i = state.conversations.findIndex((x) => x.id === view.id);
  if (i >= 0) state.conversations[i] = { ...state.conversations[i], ...view };
  else state.conversations.unshift(view);
  renderConversations();
  updateTitle();
}

// After a turn in a chapter whose name is not his, the list is read once more, so a new
// chapter takes its place or day name as soon as the server has one. Quiet on failure.
function refreshTitlesAfterTurn(id) {
  const c = state.conversations.find((x) => x.id === id);
  if (c && c.titleFrom === "his") return;
  if (state.titleRefresh) return;
  state.titleRefresh = true;
  api("GET", "/api/conversations")
    .then((rows) => {
      if (!Array.isArray(rows)) return;
      state.conversations = rows.filter((x) => x && x.status !== "drift");
      renderConversations();
      updateTitle();
    })
    .catch(() => { /* the names stay as they are */ })
    .finally(() => { state.titleRefresh = false; });
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
  closeReactBar(false);
  state.dotsHold = false;
  // The chapter head stays the thread's first child and the dots its last.
  els.thread.replaceChildren(...(els.chapterHead ? [els.chapterHead] : []), els.typing);
  state.rows = new Map();
  state.lastStoryRole = null;
  state.lastStoryAt = null;
  // fix0927 review: while a chapter's rows are on their way (or failed to come), "no role
  // yet" is not an empty chapter, so Let her start stays hidden until they are in.
  state.threadLoading = !!id;
  setTasting(null);
  refreshTyping();
  updateStartButton();
  if (!id) { showEmptyHer(); return; }
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
    if (m.channel === "story") {
      state.lastStoryRole = m.role;
      state.lastStoryAt = storyAt(m);
    }
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
  if (!els.thread.querySelector(":scope > [data-id]") && !state.deliveries.size) showEmptyHer();
  state.threadLoading = false;
  updateStartButton();
  scrollBottom();
  restoreTasting(id, seq);
}

// An empty chapter: under its head, her face in its ring, and nothing else.
function showEmptyHer() {
  if (els.thread.querySelector(":scope > .empty-her")) return;
  const img = makeAvatar(96);
  img.classList.remove("msg-avatar");
  img.classList.add("ring");
  els.thread.insertBefore(h("div", { class: "empty-her", "aria-hidden": "true" }, img), els.typing);
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
// A newly arrived one rises in (opts.rise); the empty chapter's face gives way to it.
function appendMessage(el, opts) {
  const id = el.getAttribute("data-id");
  if (id && findMessageEl(id)) return;
  const empty = els.thread.querySelector(":scope > .empty-her");
  if (empty) empty.remove();
  if (opts && opts.rise) el.classList.add("rise");
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
  layoutDays();
}

// exp 3.4 item 9: a separator between days, kept in place rather than rebuilt, so the
// thread's polite region does not announce the same day twice.
function layoutDays() {
  const now = new Date();
  const want = new Map();
  let prev = "";
  for (const el of els.thread.querySelectorAll(":scope > [data-at]")) {
    const at = el.getAttribute("data-at") || "";
    const key = dayKey(at);
    if (!key) continue;
    if (prev && key !== prev) want.set(el, [key, dayWords(at, now)]);
    prev = key;
  }
  for (const sep of [...els.thread.querySelectorAll(":scope > .day-sep")]) {
    const next = sep.nextElementSibling;
    const w = next ? want.get(next) : null;
    if (!w || sep.getAttribute("data-day") !== w[0]) sep.remove();
    else if (sep.textContent !== w[1]) sep.textContent = w[1];
  }
  for (const [el, [key, words]] of want) {
    const before = el.previousElementSibling;
    if (before && before.classList.contains("day-sep") && before.getAttribute("data-day") === key) continue;
    el.before(h("div", { class: "day-sep", "data-day": key, text: words }));
  }
}

// The typing indicator carries the same avatar before its dots.
function mountTypingAvatar() {
  if (!els.typing || els.typing.querySelector(".msg-avatar")) return;
  els.typing.prepend(makeAvatar(AVATAR_PX));
}

function noteRole(m) {
  if (m && m.channel === "story") {
    state.lastStoryRole = m.role;
    state.lastStoryAt = storyAt(m);
    updateStartButton();
  }
}

// When a story row landed: its delivery time when it had one, else when it was written, else
// now (a row straight from a turn).
function storyAt(m) {
  for (const iso of [m && m.deliver_at, m && m.created_at]) {
    if (iso && Number.isFinite(Date.parse(iso))) return iso;
  }
  return new Date().toISOString();
}

function updateStartButton() {
  const show = !state.operator && state.lastStoryRole !== "user" && !state.tasting;
  els.letHerStart.classList.toggle("hidden", !show);
  updateStartChip();
}

// fix0927 lane A: Let her start in plain sight, a chip above the composer, when the chapter
// has nothing in it yet, or when the last line is hers and two minutes old (she said her
// piece and he has not answered). Never while a turn runs, a reply is on its way, a call is
// live, a tasting waits or the workings show.
const START_CHIP_MS = 2 * 60 * 1000;

// Pure (the unit test evaluates it): { loading, lastRole, lastAt, operator, tasting, busy,
// onCall, pending } and the time now -> whether the chip shows.
function startChipShows(s, now) {
  if (!s || s.loading || s.operator || s.tasting || s.busy || s.onCall || s.pending) return false;
  if (!s.lastRole) return true;
  if (s.lastRole !== "assistant") return false;
  const at = Date.parse(s.lastAt || "");
  if (!Number.isFinite(at)) return false;
  return now - at >= START_CHIP_MS;
}

function startChipState() {
  return {
    loading: !!state.threadLoading,
    lastRole: state.lastStoryRole,
    lastAt: state.lastStoryAt,
    operator: state.operator,
    tasting: !!state.tasting,
    busy: state.inFlight || state.arriving > 0,
    onCall: !!(state.call && !state.call.ended),
    pending: state.deliveries.size > 0,
  };
}

function updateStartChip() {
  if (!els.startRow) return;
  clearTimeout(state.startTimer);
  state.startTimer = null;
  const s = startChipState();
  const now = Date.now();
  const show = startChipShows(s, now);
  els.startRow.classList.toggle("hidden", !show);
  if (els.startChip) els.startChip.disabled = !show;
  // Her line is not two minutes old yet: look again when it is.
  if (!show && s.lastRole === "assistant") {
    const wait = Date.parse(s.lastAt || "") + START_CHIP_MS - now;
    if (Number.isFinite(wait) && wait > 0) state.startTimer = setTimeout(updateStartChip, Math.min(wait + 250, 0x7fffffff));
  }
}

// Her *actions*: a bubble that is only an action reads as a stage line (the .action bubble,
// no ground, italic, the asterisks gone); an action inside a line is set in italics. Built
// from text nodes, never markup; the stored text never changes.
const ACTION_WHOLE = /^\*([^*\n]+)\*$/;
const ACTION_INLINE = /\*([^*\n]+)\*/g;

function fillWithActions(el, text) {
  const s = String(text || "");
  let last = 0;
  ACTION_INLINE.lastIndex = 0;
  let m;
  while ((m = ACTION_INLINE.exec(s))) {
    if (m.index > last) el.append(document.createTextNode(s.slice(last, m.index)));
    el.append(h("em", { class: "act", text: m[1].trim() }));
    last = m.index + m[0].length;
  }
  if (last < s.length) el.append(document.createTextNode(s.slice(last)));
  return el;
}

function bubbleEl(text) {
  const whole = ACTION_WHOLE.exec(String(text || "").trim());
  if (whole) return h("div", { class: "bubble action", text: whole[1].trim() });
  return fillWithActions(h("div", { class: "bubble" }), text);
}

// fix0927 lane A: one element per piece of splitReply (bubbles.js), in reading order. An
// action is its own stage line; a speech piece is a bubble whose *emphasis* is an em. Built
// from text nodes, never markup.
function pieceEl(piece) {
  if (piece.kind === "action") return h("div", { class: "bubble action", text: piece.text });
  const b = h("div", { class: "bubble" });
  for (const r of piece.runs) b.append(r.em ? h("em", { class: "emph", text: r.text }) : document.createTextNode(r.text));
  return b;
}

// A line as its bubbles and stage lines; an empty line keeps one empty bubble as before.
function lineEls(text, opts) {
  const pieces = splitReply(text, opts);
  return pieces.length ? pieces.map(pieceEl) : [bubbleEl(String(text || ""))];
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
    if (m.audio_key || op) {
      const b = h("div", { class: "bubble" });
      if (m.audio_key) b.append(h("span", { class: "mic-chip", "aria-label": "Voice", role: "img" }, svgIcon("mic")));
      if (op) b.append(document.createTextNode(m.content || ""));
      else fillWithActions(b, m.content || "");
      bubbles.append(b);
    } else {
      // His *actions* read the same way as hers; his line is never cut for length.
      bubbles.append(...lineEls(m.content, { long: false }));
    }
  } else {
    // fix0927 lane A: her actions are their own stage lines wherever they sit in a paragraph.
    // 2026-09-27, Justin: "if she is doing audio i dont want to see the text": a line of hers
    // with audio shows only her voice.
    const spokenOnly = !op && !!m.audio_key;
    const parts = op ? [bubbleEl(m.content || "")] : spokenOnly ? [] : lineEls(m.content);
    // exp 3.4 item 5: each bubble of a line of hers with an id opens the reaction bar.
    const reacts = !op && !!m.id;
    for (const b of parts) {
      if (reacts) {
        b.setAttribute("tabindex", "0");
        b.setAttribute("aria-haspopup", "menu");
      }
      bubbles.append(b);
    }
    if (reacts) {
      state.rows.set(m.id, m);
      if (markOf(m) === "keep") bubbles.append(keptMark());
    }
  }
  el.append(bubbles);
  const extras = h("div", { class: "extras" });
  if (his) {
    const thumbs = hisThumbs(m);
    if (thumbs) extras.append(thumbs);
  } else if (!op) {
    if (m.audio_key && m.id) extras.append(voiceNote(m.id));
    const photo = renderPhoto(m, errorCode, error);
    if (photo) extras.append(photo);
    const song = songCard(m);
    if (song) extras.append(song);
    const media = mediaCard(m);
    if (media) extras.append(media);
    // His rewrite of her line is the workings (Studio material), never the plain thread.
    const version = state.operator ? hisVersion(m) : null;
    if (version) extras.append(version);
  }
  if (extras.childElementCount) el.append(extras);
  el.append(metaRow(m));
  return el;
}

// ------------------------------------------------------------ her voice notes (fix0927 lane A)

// Play and pause, drawn with the SVG namespace (no markup is parsed).
const VN_PATHS = { play: ["M8 5.5v13l11-6.5z"], pause: ["M8.5 5v14", "M15.5 5v14"] };

function vnIcon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of [["viewBox", "0 0 24 24"], ["fill", name === "play" ? "currentColor" : "none"], ["stroke", "currentColor"], ["stroke-width", "2.4"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) svg.setAttribute(k, v);
  for (const d of VN_PATHS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// Pure (the unit test evaluates it): what the row's time reads. The length once it is known
// while the note sits at its start; the time played while it plays or waits part way;
// nothing before the length is known and nothing is playing.
function voiceNoteLabel(current, duration, fmt) {
  const d = Number(duration);
  const c = Number(current) || 0;
  const known = Number.isFinite(d) && d > 0;
  if (c > 0.05) return fmt(c);
  return known ? fmt(d) : "";
}

// Her voice note as a small row in the thread's own look: a round play button, a thin line
// that fills as it plays, and the length once the metadata is in (preload="metadata"). The
// source stays /media/audio/<messageId>. A note that cannot load hides the whole row. One
// note plays at a time.
function voiceNote(messageId) {
  const audio = h("audio", { preload: "metadata", src: "/media/audio/" + encodeURIComponent(messageId) });
  const btn = h("button", { type: "button", class: "vn-play", "aria-label": "Play voice note", "aria-pressed": "false" }, vnIcon("play"));
  const fill = h("span", { class: "vn-fill" });
  const track = h("div", { class: "vn-track", role: "progressbar", "aria-label": "Voice note played", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const time = h("span", { class: "vn-time" });
  const row = h("div", { class: "audio-note voice-note" }, btn, track, time, audio);
  const paint = () => {
    const d = audio.duration;
    const f = Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0, audio.currentTime / d)) : 0;
    fill.style.transform = "scaleX(" + f.toFixed(4) + ")";
    track.setAttribute("aria-valuenow", String(Math.round(f * 100)));
    time.textContent = voiceNoteLabel(audio.currentTime, d, fmtDuration);
  };
  const playing = (on) => {
    row.classList.toggle("playing", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "Pause voice note" : "Play voice note");
    btn.replaceChildren(vnIcon(on ? "pause" : "play"));
  };
  btn.addEventListener("click", () => {
    if (!audio.paused) {
      audio.pause();
      return;
    }
    const other = state.voicePlaying;
    if (other && other !== audio && !other.paused) other.pause();
    state.voicePlaying = audio;
    if (audio.currentTime > 0) {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => playing(false));
    } else playWoken(audio);
  });
  audio.addEventListener("loadedmetadata", paint);
  audio.addEventListener("durationchange", paint);
  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("play", () => playing(true));
  audio.addEventListener("pause", () => playing(false));
  audio.addEventListener("ended", () => {
    playing(false);
    audio.currentTime = 0;
    paint();
  });
  audio.addEventListener("error", () => {
    row.classList.add("hidden");
    if (state.voicePlaying === audio) state.voicePlaying = null;
  });
  return row;
}

// A run's time as a phone shows it: "9:04 PM", no leading zero and no date (the day
// separators carry the day).
function clockTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// exp 3.4 item 6: the default thread is only the conversation (and the kept hearts). The
// inline why, note, keep and drop and the flags show only while the workings are on.
function metaRow(m) {
  const row = h("div", { class: "meta" }, h("span", { class: "time", text: clockTime(m.created_at) }));
  const hers = m.role === "assistant" && m.channel !== "operator" && m.id;
  // fix0927: the note under her reply is always there (Not her, Too clever, his own note);
  // the redesign had hidden it behind a double-click or a long press.
  if (hers) row.append(h("button", { type: "button", class: "note-btn", text: "note", "aria-label": "Note on this reply", onclick: () => toggleNoteSheet(m) }));
  // 2026-09-27, Justin: "what fucking heart". The heart (keep this line) and why sit beside
  // the note, always; before they lived only in the double-click bar.
  if (hers) {
    let heart = null;
    heart = h("button", {
      type: "button", class: "meta-heart", "aria-pressed": String(markOf(m) === "keep"), "aria-label": "Keep this line", title: "Keep this line",
      onclick: async () => {
        await toggleKeep(m, heart);
        heart.setAttribute("aria-pressed", String(markOf(m) === "keep"));
      },
    }, heartIcon());
    row.append(heart);
    row.append(h("button", { type: "button", class: "why", text: "why", "aria-label": "Why she said this", onclick: () => openWhy(m) }));
  }
  if (state.operator && hers) {
    row.append(markButton(m));
    const extra = state.chipsFor.get(m.id);
    if (extra && extra.length) row.append(h("span", { class: "chips" }, extra));
    const codes = flagCodes(m.flags_json);
    if (codes.length) row.append(h("span", { class: "chips" }, codes.map((c) => chip(c, "flag"))));
  }
  return row;
}

// The meta row again after the heart changed a mark while the workings show it.
function refreshMeta(m) {
  const el = findMessageEl(m.id);
  const meta = el ? el.querySelector(":scope > .meta") : null;
  if (!meta) return;
  meta.replaceWith(metaRow(m));
  layoutRuns();
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
  // The Spotify add's status and its Retry are the workings (exp 3.4 item 6).
  if (known && state.operator) slot.append(chip(known[0], known[1]));
  if (state.operator && m.id && (status === "failed" || status === "not_found")) {
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
        slot.append(chip(errorWords(e.code), "danger"), retry);
      }
    });
    slot.append(retry);
  }
  if (m.id && status === "pending") refreshSongLater(m.id);
  // One way to play on the card: the play circle when the song has a uri. The Spotify link
  // and "my Spotify" are the workings; a song without a uri keeps the link as its only way.
  const card = h("div", { class: "song-card", "data-uri": uri },
    uri ? null : h("span", { class: "note", "aria-hidden": "true" }, svgIcon("note")),
    h("span", { class: "song-text" },
      h("span", { class: "song-title", text: title }),
      artist ? h("span", { class: "song-artist", text: artist }) : null),
    !uri || state.operator ? h("a", { class: "song-link", href, target: "_blank", rel: "noopener noreferrer", text: "Open in Spotify" }) : null,
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
    if (state.operator) {
      card.append(play, remote, remoteNote, embed);
    } else {
      card.prepend(play);
      card.append(embed);
    }
    paintPlayButton(play);
  }
  if (m.id && artist) card.append(songFeedback(m.id, artist));
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
    else note.append(chip(errorWords(d.code), "danger"));
  }
});

// ------------------------------------------------------------ the song loop (v5 section 9)

// The same normalisation src/songs.ts uses for artist_norm: lowercase, a leading "the "
// dropped, & read as "and", everything but letters and digits one space; when nothing is
// left after dropping "the " (an artist named "The !!!"), the name with its "the".
function artistNorm(a) {
  const lower = String(a || "").toLowerCase().replace(/\s+/g, " ").trim();
  const clean = (x) => x.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  return clean(lower.replace(/^the\s+/, "")) || clean(lower);
}

const FEEDBACK = [["known", "know it", "known"], ["disliked", "not for me", "not for me"]];

function loadKnownArtists() {
  if (state.knownArtistsLoad) return state.knownArtistsLoad;
  state.knownArtistsLoad = (async () => {
    const map = new Map();
    try {
      const r = await api("GET", "/api/known-artists");
      for (const kind of ["known", "disliked"]) {
        for (const row of r && Array.isArray(r[kind]) ? r[kind] : []) {
          if (row && row.id) map.set(row.artist_norm || artistNorm(row.artist), { id: row.id, kind: row.kind || kind });
        }
      }
    } catch {
      /* the route is not there: the buttons still post */
    }
    state.knownArtists = map;
    paintSongFeedback();
    return map;
  })();
  return state.knownArtistsLoad;
}

function songFeedback(messageId, artist) {
  const norm = artistNorm(artist);
  const group = h("span", { class: "song-feedback", role: "group", "aria-label": "His ears", "data-artist": norm });
  const slot = h("span", { class: "chips feedback-chip" });
  for (const [kind, label] of FEEDBACK) {
    const btn = h("button", { type: "button", class: "btn small quiet", "data-kind": kind, "aria-pressed": "false", text: label });
    btn.addEventListener("click", () => pressFeedback(messageId, norm, kind, group));
    group.append(btn);
  }
  group.append(slot);
  paintFeedbackGroup(group);
  if (!state.knownArtists) loadKnownArtists();
  return group;
}

function paintFeedbackGroup(group) {
  const row = state.knownArtists ? state.knownArtists.get(group.dataset.artist || "") : null;
  const kind = row ? row.kind : null;
  for (const btn of group.querySelectorAll("button[data-kind]")) btn.setAttribute("aria-pressed", String(btn.dataset.kind === kind));
  const slot = group.querySelector(".feedback-chip");
  if (!slot) return;
  clear(slot);
  const f = FEEDBACK.find((x) => x[0] === kind);
  if (f) slot.append(chip(f[2], kind === "known" ? "accent" : "amber"));
}

function paintSongFeedback(norm) {
  for (const g of document.querySelectorAll(".song-feedback")) {
    if (norm === undefined || g.dataset.artist === norm) paintFeedbackGroup(g);
  }
}

async function pressFeedback(messageId, norm, kind, group) {
  const buttons = [...group.querySelectorAll("button[data-kind]")];
  for (const b of buttons) b.disabled = true;
  try {
    await loadKnownArtists();
    const cur = state.knownArtists ? state.knownArtists.get(norm) : null;
    if (cur && cur.kind === kind) {
      // A second press on the pressed one takes the artist off his list.
      await api("DELETE", "/api/known-artists/" + encodeURIComponent(cur.id));
      state.knownArtists.delete(norm);
    } else {
      const row = await api("POST", "/api/messages/" + encodeURIComponent(messageId) + "/song-feedback", { kind });
      if (row && row.id) state.knownArtists.set(row.artist_norm || norm, { id: row.id, kind: row.kind || kind });
    }
    paintSongFeedback(norm);
  } catch (e) {
    const slot = group.querySelector(".feedback-chip");
    if (slot) { clear(slot); slot.append(chip(errorWords(e.code), "danger")); }
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

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
  if (!state.operator) return;
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
      slot.append(chip(errorWords(e.code), "danger"));
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
    paintKept(m.id, mark);
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
  document.body.classList.toggle("her-typing", on);
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
    appendMessage(el, { rise: true });
    scrollBottom();
    noteRole(m);
    return;
  }
  const bubbles = [...el.querySelectorAll(".bubbles > .bubble")];
  const tail = [...el.children].filter((c) => !c.classList.contains("bubbles") && !c.classList.contains("msg-avatar"));
  for (const b of bubbles) b.classList.add("hidden");
  for (const t of tail) t.classList.add("hidden");
  appendMessage(el, { rise: true });
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
  updateStartChip();
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
  else updateStartChip();
}

function handleTurnResponse(r, id) {
  if (!r || state.currentId !== id || state.operator) return;
  const seq = state.loadSeq;
  if (r.userMessage) {
    appendMessage(renderMessage(r.userMessage), { rise: true });
    noteRole(r.userMessage);
  }
  const a = r.assistantMessage;
  if (a) {
    // A tasting that voided itself came back as a plain reply; say so on the message.
    if (a.id && flagCodes(r.flags).includes("tasting_void")) state.chipsFor.set(a.id, [chip("tasting void", "amber")]);
    const deliverAt = a.deliver_at || a.deliverAt || r.deliverAt || null;
    if (r.spoken === true && a.id) {
      // Her voice only: a pending voice row now, the player when the audio lands.
      const el = renderMessage({ ...a, audio_key: "pending" });
      const pend = el.querySelector(".voice-note");
      if (pend) pend.replaceWith(pendingVoiceRow());
      else el.append(pendingVoiceRow());
      appendMessage(el, { rise: true });
      noteRole(a);
      waitForSpoken(a.id, id);
    } else if (futureIso(deliverAt)) scheduleDelivery({ ...a, deliver_at: deliverAt }, seq);
    else arrive(a, seq);
  }
  scrollBottom();
}

// 2026-09-27, Justin: "i had to click the play button for the playback". An iPhone only lets
// a page start sound by itself on an audio element a tap has already played once. The first
// tap anywhere unlocks one shared player (a silent clip), and her spoken lines auto-play on it.
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
function unlockHerAudio() {
  if (state.herAudio) return;
  try {
    const a = new Audio();
    a.setAttribute("playsinline", "");
    a.src = SILENT_WAV;
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    state.herAudio = a;
  } catch {
    // no shared player: the row's own button still plays her
  }
}
document.addEventListener("click", unlockHerAudio, { capture: true });
document.addEventListener("touchend", unlockHerAudio, { capture: true });

// While her voice is being made: three soft dots in the voice row's place.
function pendingVoiceRow() {
  return h("div", { class: "audio-note voice-note voice-pending", role: "status", "aria-label": "Voice coming" }, h("span", { class: "vp-dots", "aria-hidden": "true" }, h("span"), h("span"), h("span")));
}

// The output device (Bluetooth above all) wakes a beat late and eats her first word: play a
// moment of silence first, then her line.
function playWoken(audio) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      state.wakeCtx = state.wakeCtx || new AC();
      const ctx = state.wakeCtx;
      if (ctx.state === "suspended") ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.45), ctx.sampleRate);
      src.connect(ctx.destination);
      src.start();
    }
  } catch {
    // no wake: play anyway
  }
  setTimeout(() => {
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, 450);
}

// Dirty talk mode: her line is spoken in her own voice; the audio lands a few seconds after
// the reply. Wait for it (up to 45 s), put the voice row on her message and play it.
async function waitForSpoken(messageId, conversationId) {
  const src = "/media/audio/" + encodeURIComponent(messageId);
  for (let i = 0; i < 45; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    if (state.currentId !== conversationId) return;
    const el = findMessageEl(messageId);
    if (!el) continue;
    let ok = false;
    try {
      const res = await fetch(src, { headers: { Range: "bytes=0-1" }, credentials: "same-origin", cache: "no-store" });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) continue;
    let row = el.querySelector(".voice-note:not(.voice-pending)");
    if (!row) {
      row = voiceNote(messageId);
      const pend = el.querySelector(".voice-pending");
      const meta = el.querySelector(".meta");
      if (pend) pend.replaceWith(row);
      else if (meta) el.insertBefore(row, meta);
      else el.append(row);
    }
    const rowAudio = row.querySelector("audio");
    if (!rowAudio) return;
    const other = state.voicePlaying;
    if (other && !other.paused) other.pause();
    // The tap-unlocked shared player plays her on its own (an iPhone refuses a new element);
    // the row keeps its own button for a replay.
    const audio = state.herAudio || rowAudio;
    if (audio !== rowAudio) audio.src = src;
    state.voicePlaying = audio;
    playWoken(audio);
    dtHeard(audio);
    return;
  }
  // No audio came: a call hands the turn back to him.
  if (state.dt && state.dt.on) dtListen(state.dt);
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
    appendMessage(renderMessage(userMessage), { rise: true });
    noteRole(userMessage);
  }
  const wrap = h("div", { class: "msg hers tasting", "data-id": "tasting:" + t.tastingId });
  const panels = h("div", { class: "tasting-panels" });
  const buttons = [];
  const slot = h("span", { class: "chips" });
  const lock = (on) => { for (const b of buttons) b.disabled = on; };
  const panelFor = (c) => {
    const bubbles = h("div", { class: "bubbles" });
    bubbles.append(...lineEls(c.text));
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
      slot.append(chip(errorWords(e.code), "danger"));
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
    refreshTitlesAfterTurn(conversationId);
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
    appendMessage(renderMessage(assistantMessage), { rise: true });
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
  return h("div", { class: "call-card", "data-id": "call:" + callId, "data-at": first.created_at || "" }, line, list);
}

// The Call row in the menu and the Call button in the bar show the live call together.
function markCalling(on) {
  for (const b of callButtons()) {
    b.classList.toggle("calling", on);
    b.setAttribute("aria-pressed", String(on));
  }
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
      markCalling(false);
      updateSendState();
      if (state.currentId === id) loadThread();
    },
  });
  state.call = call;
  markCalling(true);
  updateSendState();
  try {
    await call.start();
  } catch (e) {
    state.call = null;
    markCalling(false);
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
    const asset = state.assets.get(m.image_id);
    const withHim = !!(asset && Number(asset.with_him) === 1);
    // exp 3.4 item 7: the picture alone in its frame; a tap opens the chat's lightbox,
    // where Save and Full size live. The workings add its chips and its decision row.
    const wrap = h("div", { class: "photo" + (withHim ? " with-him" : "") },
      pictureButton(m, "photo", "/media/" + encodeURIComponent(m.image_id), ""));
    const chips = workingsChips(m.image_id, withHim);
    if (chips) wrap.append(chips);
    if (state.operator && !isApproved(m.image_id)) wrap.append(photoActions(m, m.image_id, wrap));
    return wrap;
  }
  if (status === "failed") return staleFailure(m, errorCode) ? null : failedPicture(m, errorCode, error, false);
  return null;
}

// A picture that failed long ago leaves her thread: it shows for FAILED_KEEP_MS after her
// line (or when this page just saw it fail), and always with the workings on.
const FAILED_KEEP_MS = 12 * 60 * 60 * 1000;
function staleFailure(m, errorCode) {
  if (state.operator || errorCode) return false;
  const at = Date.parse(m && m.created_at);
  return Number.isFinite(at) && Date.now() - at > FAILED_KEEP_MS;
}

function isApproved(imageId) {
  const a = state.assets.get(imageId);
  return state.approved.has(imageId) || !!(a && a.approval_status === "approved");
}

// The picture as a button (Enter or a tap opens the lightbox). A clip shows its poster (or
// its first frame) with a play badge; it plays in the lightbox.
function pictureButton(m, kind, src, poster) {
  const btn = h("button", {
    type: "button",
    class: "photo-open",
    "aria-label": "Open picture",
    "data-image": m.image_id,
    "data-kind": kind,
    "data-msg": m.id || "",
    "data-when": m.created_at || "",
    "data-poster": poster || null,
  });
  if (kind === "clip") {
    if (poster) btn.append(h("img", { src: poster, alt: "", loading: "lazy", decoding: "async" }));
    else btn.append(h("video", { src, muted: true, playsinline: true, preload: "metadata", "aria-hidden": "true" }));
    btn.append(h("span", { class: "play-badge", "aria-hidden": "true" }));
  } else {
    btn.append(h("img", { src, alt: "", loading: "lazy", decoding: "async" }));
  }
  btn.addEventListener("click", () => openLightbox(m.image_id));
  return btn;
}

// The picture's status chips: the workings only.
function workingsChips(imageId, withHim) {
  if (!state.operator) return null;
  const list = [];
  if (withHim) list.push(chip("us", "us"));
  if (!isApproved(imageId)) list.push(chip("candidate", "amber"));
  return list.length ? h("div", { class: "chips" }, list) : null;
}

// exp 3.4 item 8: a picture that did not come through reads as words, with a retry icon
// where a retry exists (a photo's generate call; a clip has none from the chat). The codes
// show only with the workings on.
function failedPicture(m, errorCode, error, clip) {
  const line = h("div", { class: "pic-failed", role: "status" }, h("span", { text: "didn't come through" }));
  const retryable = !clip && !(error && error.retryable === false) && !!(m.id && m.image_id);
  if (retryable) {
    const retry = h("button", { type: "button", class: "icon-btn", "aria-label": "Try again" }, retryIcon());
    retry.addEventListener("click", () => {
      retry.disabled = true;
      replacePhoto({ ...m, image_status: "pending" });
    });
    line.append(retry);
  }
  const wrap = h("div", { class: clip ? "photo video-bubble failed" : "photo" }, line);
  if (state.operator) {
    const row = h("div", { class: "photo-actions" }, chip(clip ? "clip failed" : "photo failed"));
    if (errorCode) row.append(chip(errorCode, "danger"));
    const detail = error && typeof error.detail === "string" ? error.detail : "";
    if (detail && detail !== errorCode) row.append(chip(detail));
    wrap.append(row);
  }
  return wrap;
}

function retryIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.7"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) svg.setAttribute(k, v);
  for (const d of ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
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

// The two decisions and the re-ask, shared by the workings row and the lightbox: the same
// routes the row has always called.
async function decidePicture(imageId, decision) {
  await api("POST", "/api/images/" + encodeURIComponent(imageId) + "/decide", { decision });
  if (decision === "approve") state.approved.add(imageId);
  else state.rejected.add(imageId);
  const a = state.assets.get(imageId);
  if (a) rememberAsset({ ...a, approval_status: decision === "approve" ? "approved" : "rejected" });
  state.rollPlaces = null;
}

// Reject this one and ask again with the same description; the message follows the new picture.
async function regeneratePicture(m, imageId) {
  const r = await api("POST", "/api/images/" + encodeURIComponent(imageId) + "/regenerate", {});
  state.rejected.add(imageId);
  const asset = r && r.asset ? r.asset : null;
  if (asset) rememberAsset(asset);
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
}

// The workings' Approve / Reject / Regenerate row under a candidate picture.
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
      await decidePicture(imageId, decision);
      if (decision === "approve") row.remove();
      else wrap.remove();
      replacePhoto({ ...m, image_id: imageId, image_status: "ready" });
    } catch (e) {
      fail(e);
    }
  };
  const regenerate = async () => {
    lock(true);
    try {
      await regeneratePicture(m, imageId);
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

// A video bubble: the source photo as its poster while the clip is being made (polled until
// ready), then the clip as a picture button that plays in the lightbox; the workings add
// Approve / Reject until he decides.
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
    const wrap = h("div", { class: "photo video-bubble" }, pictureButton(m, "clip", url, poster));
    const chips = workingsChips(id, !!(asset && Number(asset.with_him) === 1));
    if (chips) wrap.append(chips);
    if (state.operator && !isApproved(id)) wrap.append(clipActions(m, id, wrap));
    return wrap;
  }
  return staleFailure(m, errorCode) ? null : failedPicture(m, errorCode, error, true);
}

function clipActions(m, id, wrap) {
  const row = h("div", { class: "photo-actions" });
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const act = async (decision) => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      await decidePicture(id, decision);
      if (decision === "approve") row.remove();
      else wrap.remove();
      replacePhoto({ ...m, image_id: id, image_status: "ready" });
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
  for (const b of micButtons()) b.disabled = busy || state.operator;
  for (const b of photoButtons()) b.disabled = busy || state.operator;
  // A tasting carries no photos (the multipart route runs a plain turn), so Taste waits
  // until the attachments are gone rather than silently spending one ordinary turn.
  els.tasteBtn.disabled = busy || state.operator || state.attachments.length > 0 || !els.input.value.trim();
  els.tasteBtn.classList.toggle("hidden", !(state.settings && state.settings.tastingEnabled === true) || state.operator);
  for (const b of callButtons()) {
    b.classList.toggle("hidden", !callVisible() || state.operator);
    b.disabled = onCall ? false : (state.inFlight || state.arriving > 0);
  }
  updateStartChip();
}

function setInFlight(on) {
  state.inFlight = on;
  updateSendState();
  refreshTyping();
}

// exp 3.4 item 8: a failure reads as words, never a code. Pure (the unit test evaluates it):
// the codes of the server map to four phrases, anything else that looks like a code
// (lowercase with an underscore) to the failure phrase, and a label this page already
// writes in words passes through unchanged.
const ERROR_WORDS = [
  [["budget_exceeded", "tasting_budget_exceeded", "price_unknown"], "Today's limit reached"],
  [["in_progress", "idempotency_conflict", "tasting_pending"], "Still on the last one"],
  [["provider_failed", "provider_refused", "provider_not_configured", "image_failed", "internal", "error", "timeout"], "Didn't come through"],
  [["validation", "too_large", "unsupported_media_type"], "Couldn't send that"],
  [["microphone"], "Microphone is off"],
];

function errorWords(code) {
  const c = typeof code === "string" ? code.trim() : "";
  if (!c) return "Didn't come through";
  for (const [codes, words] of ERROR_WORDS) if (codes.includes(c)) return words;
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(c)) return "Didn't come through";
  return c;
}

// The words; with the workings on, the raw code follows them ("Didn't come through --
// provider_failed").
function showError(code, retry) {
  const raw = typeof code === "string" ? code.trim() : "";
  const words = errorWords(code);
  els.errorChip.textContent = state.operator && raw && raw !== words ? words + " -- " + raw : words;
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
        appendMessage(renderMessage({ id: "", role: "user", channel: "operator", content: text, created_at: now }), { rise: true });
        appendMessage(renderMessage({ id: "", role: "assistant", channel: "operator", content: String(r.reply || ""), created_at: now }), { rise: true });
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
          if (state.tv && state.tv.on) {
            body.tv = true;
            if (state.tv.held && state.tv.held.text) body.tvGame = state.tv.held.text;
          }
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
    if (!state.operator) refreshTitlesAfterTurn(id);
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
    refreshTitlesAfterTurn(id);
    loadNow(false);
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

// exp 3.4 item 4: a voice note starts from the tools sheet's row (a tap, not a hold). The
// recording bar takes the composer's place: its time, Send (the existing sendVoice) and
// Cancel; the 60 s cap stops and sends.
function initMic() {
  const supported = navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
  if (!supported) {
    for (const b of micButtons()) b.classList.add("hidden");
    return;
  }
  els.micBtn.addEventListener("click", () => {
    closeMenus(false);
    startRecording();
  });
  // fix0927 lane A: the same tap-to-record from the mic beside the box.
  if (els.composerMic) els.composerMic.addEventListener("click", () => {
    closeMenus(false);
    startRecording();
  });
  if (els.recSend) els.recSend.addEventListener("click", () => stopRecording());
  if (els.recCancel) els.recCancel.addEventListener("click", () => cancelRecording());
}

// The Voice note row in the menu and the mic beside the box show the recording together.
function markRecording(on) {
  for (const b of micButtons()) {
    b.classList.toggle("recording", on);
    b.setAttribute("aria-pressed", String(on));
  }
}

function composerBox() {
  return els.composer.querySelector(".composer-box");
}

function showRecBar(rec) {
  if (!els.recBar) return;
  const box = composerBox();
  if (box) box.classList.add("hidden");
  els.recBar.classList.remove("hidden");
  paintRecTime(rec);
  rec.ticker = setInterval(() => paintRecTime(rec), 250);
  if (els.recSend) els.recSend.focus();
}

function hideRecBar() {
  if (!els.recBar) return;
  const hadFocus = els.recBar.contains(document.activeElement);
  els.recBar.classList.add("hidden");
  const box = composerBox();
  if (box) box.classList.remove("hidden");
  if (hadFocus) els.input.focus();
}

function paintRecTime(rec) {
  if (els.recTime) els.recTime.textContent = fmtDuration(Math.max(0, Date.now() - rec.startedAt) / 1000);
}

async function startRecording() {
  if (state.rec || state.inFlight || state.operator || state.tasting) return;
  const rec = { stream: null, recorder: null, chunks: [], startedAt: Date.now(), released: false, cancelled: false, timer: null, ticker: null };
  state.rec = rec;
  markRecording(true);
  showRecBar(rec);
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showError("microphone", false);
    resetRecording(rec);
    return;
  }
  if (rec.released || rec.cancelled || state.rec !== rec) {
    // Send or Cancel was pressed while the permission prompt was up: nothing was recorded.
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
  paintRecTime(rec);
  rec.timer = setTimeout(() => stopRecording(), MAX_VOICE_MS);
}

function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  rec.released = true;
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
}

function cancelRecording() {
  const rec = state.rec;
  if (!rec) return;
  rec.cancelled = true;
  rec.released = true;
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
  else resetRecording(rec);
}

function finishRecording(rec) {
  const mime = (rec.recorder && rec.recorder.mimeType) || "audio/webm";
  const blob = new Blob(rec.chunks, { type: mime });
  const ms = Date.now() - rec.startedAt;
  resetRecording(rec);
  if (rec.cancelled) return;
  if (ms < MIN_VOICE_MS || !blob.size) return;
  if (blob.size > MAX_VOICE_BYTES) { showError("4 MB max", false); return; }
  sendVoice(blob, mime);
}

function resetRecording(rec) {
  if (state.rec === rec) state.rec = null;
  if (rec) {
    clearTimeout(rec.timer);
    clearInterval(rec.ticker);
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  }
  markRecording(false);
  hideRecBar();
}

async function sendVoice(blob, mime, opts) {
  if (state.inFlight || state.tasting) return;
  setInFlight(true);
  hideError();
  try {
    const id = await ensureConversation();
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
    const fd = new FormData();
    fd.append("audio", blob, "voice." + ext);
    fd.append("idempotencyKey", crypto.randomUUID());
    if (opts && opts.speak) fd.append("speak", "1");
    if (state.tv && state.tv.on) {
      fd.append("tv", "1");
      if (state.tv.held && state.tv.held.text) fd.append("tvGame", state.tv.held.text);
    }
    const r = await apiForm("POST", "/api/conversations/" + encodeURIComponent(id) + "/voice", fd);
    handleTurnResponse(r, id);
    touchConversation(id);
    refreshTitlesAfterTurn(id);
    // Dirty talk call: a reply that is not spoken hands the turn straight back to him.
    if (state.dt && state.dt.on && !(r && r.spoken === true)) setTimeout(() => dtListen(state.dt), 1500);
  } catch (e) {
    // On the call, a recording with nothing in it is not an error: keep listening.
    const onCall = state.dt && state.dt.on;
    if (!(onCall && e && e.code === "empty_transcript")) showError(e.code || "error", false);
    if (onCall) setTimeout(() => dtListen(state.dt), e && e.code === "empty_transcript" ? 100 : 1500);
  } finally {
    setInFlight(false);
  }
}

// ------------------------------------------------------------ watch the game (2026-09-27)

// Justin: "there should be a watch game button". On: every turn of his carries the live game
// (the server adds it and her game rules), the page checks the game every 20 s, and a big
// play (a score, a turnover, halftime) gets her own reaction, out loud on the call. Off: none.
const TV_POLL_MS = 5000;
const TV_REACT_GAP_MS = 45000;
// ESPN's feed runs ahead of his TV (he said "shes ahead of me"): she sees the game as it
// stood this long ago, the way his broadcast shows it.
const TV_DELAY_MS = 55000; // 45 s: about 20 s ahead of his TV; 65 s: about 20 s behind (2026-09-27)
const TV_KEY = "avelie.tv";

function tvPaint() {
  if (!els.tvBtn) return;
  const on = !!(state.tv && state.tv.on);
  els.tvBtn.setAttribute("aria-pressed", String(on));
  els.tvBtn.classList.toggle("on", on);
  const label = els.tvBtn.querySelector(".tv-label");
  if (label) label.textContent = on ? (state.tv.score ? state.tv.score.replace("Detroit Lions", "DET").replace("New York Jets", "NYJ") : "Watching") : "Watch game";
}

function tvToggle() {
  if (state.tv && state.tv.on) tvStop();
  else tvStart();
}

function tvStart() {
  state.tv = { on: true, prev: null, lastReactAt: 0, timer: null, score: "", history: [], held: null };
  storeSet(TV_KEY, "1");
  tvPaint();
  tvPoll();
  state.tv.timer = setInterval(tvPoll, TV_POLL_MS);
}

function tvStop() {
  if (state.tv) clearInterval(state.tv.timer);
  state.tv = null;
  storeSet(TV_KEY, "");
  tvPaint();
}

const TV_BIG_RE = /\b(?:touchdown|intercept\w*|fumble[sd]?|field goal|safety|sacked|blocked|recovered|penalty|for (?:1[5-9]|[2-9]\d) yards)\b/i;

// The game as his TV shows it: the newest snapshot at least TV_DELAY_MS old (the oldest one
// while the page has not been watching that long).
function tvHeld(tv) {
  const h = tv.history;
  if (!h.length) return null;
  const cut = Date.now() - TV_DELAY_MS;
  let pick = h[0];
  for (const x of h) if (x.t <= cut) pick = x;
  return pick.game;
}

async function tvPoll() {
  const tv = state.tv;
  if (!tv || !tv.on || document.hidden) return;
  let game = null;
  try {
    const r = await api("GET", "/api/tv");
    game = r && r.game ? r.game : null;
  } catch {
    return;
  }
  if (!game || state.tv !== tv) return;
  tv.history.push({ t: Date.now(), game });
  while (tv.history.length > 400) tv.history.shift();
  const seen = tvHeld(tv);
  if (!seen) return;
  // Only a snapshot he has now seen on his TV counts, once.
  if (tv.held && tv.held === seen) return;
  tv.held = seen;
  game = seen;
  tv.score = game.state === "pre" ? "" : game.score;
  tvPaint();
  const prev = tv.prev;
  tv.prev = { score: game.score, last: game.last, detail: game.detail };
  if (!prev || game.state !== "in") return;
  const big = game.score !== prev.score
    || (game.last && game.last !== prev.last && TV_BIG_RE.test(game.last))
    || (game.detail !== prev.detail && /halftime|end of|final/i.test(game.detail));
  if (!big || Date.now() - tv.lastReactAt < TV_REACT_GAP_MS) return;
  tvReact(tv);
}

// Her own reaction. Never over him: not while he is typing a send, recording, or mid-sentence
// on the call (that recording is dropped and the mic closed while she talks).
async function tvReact(tv) {
  if (state.inFlight || state.rec || state.tasting) return;
  const id = state.currentId;
  if (!id) return;
  const dt = state.dt && state.dt.on ? state.dt : null;
  if (dt && dt.recorder && dt.recorder.state === "recording") {
    if (dt.heard) return; // he is talking: the next big play gets her
    dt.discard = true;
    dt.recorder.stop();
    dtCloseMic(dt);
  }
  tv.lastReactAt = Date.now();
  setInFlight(true);
  try {
    const held = tv.held || null;
    const r = await api("POST", "/api/conversations/" + encodeURIComponent(id) + "/open", { reason: "tv", speak: !!dt, ...(held ? { tvGame: held.text, tvLast: held.last || "" } : {}) });
    handleTurnResponse(r, id);
    touchConversation(id);
    if (dt && !(r && r.spoken === true)) setTimeout(() => dtListen(state.dt), 1000);
  } catch {
    if (dt) setTimeout(() => dtListen(state.dt), 500);
  } finally {
    setInFlight(false);
  }
}

// ------------------------------------------------------------ dirty talk call (2026-09-27)

// Justin: "i thought i was gonna do this on the call so we can talk to each other". In a bed
// scene the Call button runs this hands-free loop: it listens, stops when he has gone quiet
// for 1.3 s, sends what he said as a voice turn, her answer comes back spoken in her own voice
// (waitForSpoken plays it), and when she finishes it listens again. Hang up ends it.
const DT_INTIMATE_RE = /\b(?:kiss(?:ing|ed|es)?|making out|make out|undress(?:ing|ed)?|naked|bra|shirt (?:off|open|up)|under (?:my|her|his|your) shirt|in (?:my |her |his |the )?bed|on (?:my|her|his|your) lap|hot and heavy|breathing hard|straddl\w*|sex|fuck\w*|sleep(?:ing)? together|bedroom|hands? (?:on|under) (?:my|her|his|your))\b/i;
const DT_QUIET_MS = 1300;
const DT_LEVEL = 0.045;
// At least this much of him above the level before a recording counts as speech.
const DT_VOICED_MS = 400;

// Her own ElevenLabs voice is set up: every call is the hands-free loop in her voice (the
// realtime call's stock voice is the fallback only).
function herVoiceReady() {
  const s = state.settings;
  return !!(s && s.voiceProvider === "elevenlabs" && typeof s.elevenLabsVoiceId === "string" && s.elevenLabsVoiceId.trim());
}

function sceneIsIntimate() {
  const s = state.scene;
  if (!s || typeof s !== "object") return false;
  if (s.intimate === true) return true;
  if (s.intimate === false || s.status !== "together") return false;
  return DT_INTIMATE_RE.test([s.summary, s.last_beat, s.location].filter((x) => typeof x === "string").join(" "));
}

function dtToggle() {
  if (state.dt) dtEnd();
  else dtStart();
}

function dtBar(dt) {
  const status = h("span", { class: "dt-status", role: "status", text: "connecting" });
  const end = h("button", { type: "button", class: "btn small dt-end", text: "Hang up", onclick: () => dtEnd() });
  // 2026-09-27: on his iPhone nothing was ever sent (the level never crossed the fixed line).
  // Done ends his turn by hand; the dot moves with his voice so he can see the mic hears him.
  const done = h("button", { type: "button", class: "btn small dt-done", text: "Done", onclick: () => dtDone() });
  const dot = h("span", { class: "dt-level", "aria-hidden": "true" });
  dt.dot = dot;
  const face = h("img", { class: "avatar ring dt-face", alt: "", width: "36", height: "36", "data-avatar": "her" });
  const who = els.whoAvatar;
  if (who && who.src) face.src = who.src;
  const bar = h("div", { class: "dt-call glass strong" }, face, h("span", { class: "dt-name", text: "Avelie" }), dot, status, done, end);
  dt.bar = bar;
  dt.status = status;
  els.composer.parentNode.insertBefore(bar, els.composer);
  for (const b of callButtons()) { b.classList.add("calling"); b.setAttribute("aria-pressed", "true"); }
}

function dtSay(dt, text) {
  if (dt && dt.status) dt.status.textContent = text;
}

async function dtStart() {
  if (state.dt || state.inFlight || state.tasting || (state.call && state.call.live)) return;
  unlockHerAudio();
  const dt = { on: true, stream: null, ctx: null, analyser: null, recorder: null, chunks: [], heard: false, quietSince: 0, startedAt: 0, poll: null, bar: null, status: null };
  state.dt = dt;
  dtBar(dt);
  const AC = window.AudioContext || window.webkitAudioContext;
  dt.ctx = new AC();
  dt.analyser = dt.ctx.createAnalyser();
  dt.analyser.fftSize = 1024;
  // 2026-09-27: her first words were still eaten when she auto-played. For the whole call the
  // output plays constant silence, so the speakers or headphones never fall asleep between
  // her lines and there is nothing to wake when she starts.
  try {
    const buf = dt.ctx.createBuffer(1, dt.ctx.sampleRate, dt.ctx.sampleRate);
    const loop = dt.ctx.createBufferSource();
    loop.buffer = buf;
    loop.loop = true;
    const gain = dt.ctx.createGain();
    gain.gain.value = 0.0001;
    loop.connect(gain);
    gain.connect(dt.ctx.destination);
    loop.start();
    dt.keepAwake = loop;
  } catch {
    // no keep-awake: the padded silence in her files still helps
  }
  if (dt.ctx.state === "suspended") dt.ctx.resume().catch(() => {});
  dtListen(dt);
}

// 2026-09-27: an open mic while she plays made the Mac duck her first words (and puts
// Bluetooth headphones into their low-quality headset mode), so the mic is closed after each
// of his turns and opened again here, only when it is his turn.
async function dtOpenMic(dt) {
  if (dt.stream && dt.stream.getAudioTracks().some((t) => t.readyState === "live")) return true;
  try {
    dt.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch {
    showError("microphone", false);
    dtEnd();
    return false;
  }
  if (!dt.on || state.dt !== dt) { dt.stream.getTracks().forEach((t) => t.stop()); return false; }
  try { if (dt.src) dt.src.disconnect(); } catch { /* already gone */ }
  dt.src = dt.ctx.createMediaStreamSource(dt.stream);
  dt.src.connect(dt.analyser);
  if (dt.ctx.state !== "running") { try { await dt.ctx.resume(); } catch { /* the Done button still works */ } }
  return true;
}

function dtCloseMic(dt) {
  if (dt && dt.stream) dt.stream.getTracks().forEach((t) => t.stop());
  if (dt) dt.stream = null;
}

async function dtListen(dt) {
  if (!dt || !dt.on || state.dt !== dt) return;
  if (dt.recorder && dt.recorder.state === "recording") return;
  if (dt.opening) return;
  dt.opening = true;
  const ok = await dtOpenMic(dt);
  dt.opening = false;
  if (!ok || !dt.on || state.dt !== dt) return;
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  try {
    dt.recorder = new MediaRecorder(dt.stream, mime ? { mimeType: mime } : undefined);
  } catch {
    showError("microphone", false);
    dtEnd();
    return;
  }
  dt.chunks = [];
  dt.levels = [];
  dt.voicedMs = 0;
  dt.heard = false;
  dt.quietSince = 0;
  dt.startedAt = Date.now();
  dt.recorder.addEventListener("dataavailable", (e) => { if (e.data && e.data.size) dt.chunks.push(e.data); });
  dt.recorder.addEventListener("stop", () => dtSend(dt));
  dt.recorder.start();
  dtSay(dt, "listening");
  const buf = new Uint8Array(dt.analyser.fftSize);
  clearInterval(dt.poll);
  dt.poll = setInterval(() => {
    if (!dt.on || !dt.recorder || dt.recorder.state !== "recording") { clearInterval(dt.poll); return; }
    dt.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    const level = Math.sqrt(sum / buf.length);
    const now = Date.now();
    // The room's own level, learned while he is quiet; speech is a clear step above it (an
    // iPhone's mic runs far quieter than a Mac's, so a fixed line never fired there).
    // 2026-09-27, Justin: "i have to click done for this shit". The phone's own gain lifts the
    // room once he stops, so a slow average never saw the quiet. The floor is the quietest
    // moment of the last 1.5 s (the gaps between his words keep it honest while he talks).
    dt.levels = dt.levels || [];
    dt.levels.push(level);
    if (dt.levels.length > 15) dt.levels.shift();
    const floor = Math.min(...dt.levels);
    const line = Math.min(DT_LEVEL, Math.max(0.006, floor * 2.2 + 0.004));
    if (dt.dot) dt.dot.style.transform = "scale(" + (1 + Math.min(1.5, level / Math.max(line, 0.001))).toFixed(2) + ")";
    if (level > line) {
      dt.voicedMs = (dt.voicedMs || 0) + 100;
      if (dt.voicedMs >= DT_VOICED_MS) dt.heard = true;
      dt.quietSince = 0;
    }
    else if (dt.heard && !dt.quietSince) dt.quietSince = now;
    if ((dt.heard && dt.quietSince && now - dt.quietSince > DT_QUIET_MS) || now - dt.startedAt > MAX_VOICE_MS) {
      clearInterval(dt.poll);
      dt.recorder.stop();
    }
  }, 100);
}

// Done: he says his turn is over; what was recorded goes, whatever the level said.
function dtDone() {
  const dt = state.dt;
  if (!dt || !dt.on || !dt.recorder || dt.recorder.state !== "recording") return;
  if (Date.now() - dt.startedAt < MIN_VOICE_MS) return;
  dt.forced = true;
  clearInterval(dt.poll);
  dt.recorder.stop();
}

function dtSend(dt) {
  if (!dt.on || state.dt !== dt) return;
  if (dt.discard) { dt.discard = false; return; }
  if (dt.forced) { dt.forced = false; dt.heard = true; }
  const mime = (dt.recorder && dt.recorder.mimeType) || "audio/webm";
  const blob = new Blob(dt.chunks, { type: mime });
  // His turn is over: the mic closes while she answers.
  if (dt.heard && blob.size >= 2000) dtCloseMic(dt);
  // Nothing said (or a click of noise): keep listening.
  if (!dt.heard || blob.size < 2000) { dtListen(dt); return; }
  if (blob.size > MAX_VOICE_BYTES) { dtListen(dt); return; }
  dtSay(dt, "...");
  sendVoice(blob, mime, { speak: true });
}

// Her spoken line started: say so; when it ends, listen again.
function dtHeard(audio) {
  const dt = state.dt;
  if (!dt || !dt.on || !audio) return;
  dtSay(dt, "she's talking");
  const again = () => setTimeout(() => dtListen(state.dt), 250);
  audio.addEventListener("ended", again, { once: true });
  audio.addEventListener("error", again, { once: true });
}

function dtEnd() {
  const dt = state.dt;
  state.dt = null;
  if (!dt) return;
  dt.on = false;
  clearInterval(dt.poll);
  try { if (dt.recorder && dt.recorder.state !== "inactive") dt.recorder.stop(); } catch { /* already stopped */ }
  dtCloseMic(dt);
  try { if (dt.keepAwake) dt.keepAwake.stop(); } catch { /* already stopped */ }
  if (dt.ctx) dt.ctx.close().catch(() => {});
  if (dt.bar) dt.bar.remove();
  for (const b of callButtons()) { b.classList.remove("calling"); b.setAttribute("aria-pressed", "false"); }
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
  loadNow(true);
}

function renderScene() {
  const s = state.scene ? state.scene.status : null;
  // The sheet's pair and the bar's pill (fix0927 lane A) light the same mode.
  for (const b of [els.sceneTogether, els.modeTogether]) if (b) b.setAttribute("aria-pressed", String(s === "together"));
  for (const b of [els.sceneApart, els.modeTexting]) if (b) b.setAttribute("aria-pressed", String(s === "apart"));
  if (els.placeLine) {
    const text = placeLineText(state.scene);
    els.placeLine.textContent = text;
    els.placeLine.classList.toggle("hidden", !text);
  }
}

// fix0927: her mood and what she is wearing, one small line under the place line. The old
// chat drawer showed both; the redesign had left them only on Studio > Record. Read from
// GET /api/phone, at most once a minute, after load and after each of her replies.
function nowLineText(p) {
  if (!p || typeof p !== "object") return "";
  const parts = [];
  const mood = p.mood && typeof p.mood.mood === "string" ? p.mood.mood.replace(/\s+/g, " ").trim() : "";
  if (mood) parts.push(mood);
  const outfit = p.outfit && typeof p.outfit.text === "string" ? p.outfit.text.replace(/\s+/g, " ").trim().replace(/[.]+$/, "") : "";
  if (outfit) parts.push("wearing " + outfit.charAt(0).toLowerCase() + outfit.slice(1));
  return parts.join(" \u00b7 ");
}

let nowLoadedAt = 0;
async function loadNow(force) {
  if (!els.nowLine) return;
  const t = Date.now();
  if (!force && t - nowLoadedAt < 60000) return;
  nowLoadedAt = t;
  try {
    const text = nowLineText(await api("GET", "/api/phone"));
    els.nowLine.textContent = text;
    els.nowLine.title = text;
    els.nowLine.classList.toggle("hidden", !text);
  } catch {
    // the line is a nicety; the chat never waits on it
  }
}

// "the record store" from "at the record store, at the used bins": one leading "at " or
// "in " dropped, then cut at the first ",", ";" or " -- " (the rest is stage direction).
function placeWords(location) {
  const s = String(location || "").replace(/\s+/g, " ").trim().replace(/^(at|in)\s+/i, "");
  const cuts = [",", ";", " -- "].map((c) => s.indexOf(c)).filter((i) => i >= 0);
  return (cuts.length ? s.slice(0, Math.min(...cuts)) : s).trim();
}

// exp 3.4 item 3: the one line under her name: where the two of you are.
function placeLineText(scene) {
  if (!scene || typeof scene !== "object") return "";
  if (scene.status === "together") {
    const where = placeWords(scene.location);
    return where ? "together at " + where : "together";
  }
  if (scene.status === "apart") return "texting";
  return "";
}

// v5 section 1: while a together scene holds her clock, the bar reads "held Tue 9:04pm".
function heldLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "held";
  const tz = state.settings && typeof state.settings.timezone === "string" ? state.settings.timezone : undefined;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d);
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return "held " + get("weekday") + " " + get("hour") + ":" + get("minute") + get("dayPeriod").toLowerCase();
}

function renderClock(view) {
  if (!els.clockChip) return;
  const held = view && view.enabled !== false && view.frozen === true && view.open && view.open.frozenAt;
  els.clockChip.textContent = held ? heldLabel(view.open.frozenAt) : "";
  els.clockChip.classList.toggle("hidden", !held);
}

async function loadClock(view) {
  if (!els.clockChip) return;
  const seq = ++state.clockSeq;
  let v = view && typeof view === "object" ? view : null;
  if (!v) {
    try { v = await api("GET", "/api/clock"); } catch { v = null; }
  }
  if (seq === state.clockSeq) renderClock(v);
}

function showPlaceNeeded(on) {
  if (els.placeNeeded) els.placeNeeded.classList.toggle("hidden", !on);
}

async function setScene(status, location) {
  const base = state.scene && typeof state.scene === "object" ? state.scene : {};
  const next = { ...base, status, location: location || null };
  if (status === "together" && location) storeSet(PLACE_KEY, location);
  for (const b of sceneButtons()) b.disabled = true;
  showPlaceNeeded(false);
  let place;
  let clock;
  let needPlace = false;
  try {
    const r = await api("PUT", "/api/state/scene", { state: next, note: "toggle" });
    state.scene = r && r.state ? r.state : next;
    // v4: the route names the place it matched, with or without a picture.
    place = r && r.place !== undefined ? r.place : undefined;
    // v5: the route carries the clock after its sync.
    clock = r && r.clock && typeof r.clock === "object" ? r.clock : undefined;
    state.placeRows = null;
  } catch (e) {
    // v5 section 4: a together scene needs a place; the form says so and stays open.
    if (status === "together" && e.status === 400) needPlace = true;
    else showError(e.code || "error", false);
  } finally {
    for (const b of sceneButtons()) b.disabled = false;
    renderScene();
    applyPlaceBackground(place);
    loadClock(clock);
  }
  if (needPlace) {
    await openPlaces();
    showPlaceNeeded(true);
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

// exp 3.4 item 10: behind the thread, the place's picture when the two of you are together
// at a place that has one, else her wallpaper of the day (GET /api/wallpaper). The source
// is set by script, the crop through the CSSOM, and .ready fades it in once it loads.
function setBackdrop(src, focus) {
  const img = els.backdrop;
  if (!img) return;
  const pos = Array.isArray(focus) && focus.length === 2 && focus.every((n) => Number.isFinite(Number(n)))
    ? Number(focus[0]) + "% " + Number(focus[1]) + "%" : "";
  if (pos) img.style.objectPosition = pos;
  else img.style.removeProperty("object-position");
  if (!src) {
    state.backdropSrc = "";
    img.classList.remove("ready");
    img.removeAttribute("src");
    return;
  }
  if (state.backdropSrc === src) return;
  state.backdropSrc = src;
  img.classList.remove("ready");
  img.src = src;
}

function wireBackdrop() {
  const img = els.backdrop;
  if (!img) return;
  img.addEventListener("load", () => { if (state.backdropSrc) img.classList.add("ready"); });
  img.addEventListener("error", () => {
    const failed = state.backdropSrc;
    setBackdrop("", null);
    // A place picture that will not load gives way to her wallpaper.
    if (failed.startsWith("/media/place/") && state.wallpaper) setBackdrop(state.wallpaper.url, state.wallpaper.focus);
  });
}

// Read once per page; null when the route is not there or answers nothing usable.
async function loadWallpaper() {
  if (state.wallpaper !== undefined) return state.wallpaper;
  let w = null;
  try {
    const r = await api("GET", "/api/wallpaper");
    if (r && typeof r.url === "string" && r.url.startsWith("/")) w = { url: r.url, focus: Array.isArray(r.focus) ? r.focus : null };
  } catch {
    w = null;
  }
  state.wallpaper = w;
  return w;
}

// `known` is what the scene PUT just answered ({ id, picture } or null); undefined means
// look the place up (today's lookup).
async function applyPlaceBackground(known) {
  const seq = ++state.backdropSeq;
  const s = state.scene;
  let placeId = null;
  if (s && s.status === "together" && s.location) {
    if (known !== undefined) {
      placeId = known && known.picture && known.id ? known.id : null;
    } else {
      const rows = await loadPlaces(false);
      if (seq !== state.backdropSeq) return;
      const want = placeNorm(s.location);
      const hit = (rows || []).find((p) => placeNorm(p.title) === want && p.picture);
      placeId = hit ? hit.id : null;
    }
  }
  if (placeId) {
    setBackdrop("/media/place/" + encodeURIComponent(placeId), null);
    return;
  }
  const w = await loadWallpaper();
  if (seq !== state.backdropSeq) return;
  setBackdrop(w ? w.url : "", w ? w.focus : null);
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
  const btn = h("button", { type: "button", class: "btn small quiet place-btn", onclick: () => { closeMenus(true); setScene("together", title); } });
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

// The scene sheet opens from the place line (or, while that line is hidden, from the
// tools button), or from the control passed in (the bar's Together, fix0927 lane A), with
// today's picker inside it.
async function openPlaces(from) {
  const anchor = from || (els.placeLine && !els.placeLine.classList.contains("hidden") ? els.placeLine : els.moreBtn);
  openSheet(els.placesPop, anchor);
  showPlaceNeeded(false);
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
  return [els.photosDrawer, els.whyDrawer].filter(Boolean);
}

function closeDrawers() {
  for (const d of drawers()) {
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
  }
  els.photosBtn.setAttribute("aria-expanded", "false");
  syncScrim();
}

function isPhoneWidth() {
  return !!(window.matchMedia && window.matchMedia(PHONE_QUERY).matches);
}

function openSheetEl() {
  return [els.moreMenu, els.placesPop].find((s) => s && !s.classList.contains("hidden")) || null;
}

// The scrim sits under the sidebar and the drawers, and under a sheet at phone width (a
// popover over 760 has none).
function syncScrim() {
  const sheet = !!openSheetEl() && isPhoneWidth();
  const open = els.sidebar.classList.contains("open") || drawers().some((d) => d.classList.contains("open")) || sheet;
  els.scrim.classList.toggle("hidden", !open);
}

// exp 3.3: at 760 and under a bottom sheet over the scrim (the stylesheet places it; any
// inline position is cleared); over 760 a popover under its button, `top` its bottom + 8
// and `right` the window's width minus its right, set through the CSSOM.
function placeSheet(sheet, anchor) {
  if (!sheet) return;
  const rect = anchor && anchor.getClientRects().length ? anchor.getBoundingClientRect() : null;
  if (isPhoneWidth() || !rect) {
    sheet.style.removeProperty("top");
    sheet.style.removeProperty("right");
    return;
  }
  sheet.style.top = Math.round(rect.bottom + 8) + "px";
  sheet.style.right = Math.round(window.innerWidth - rect.right) + "px";
}

function openSheet(sheet, anchor) {
  closeMenus(false);
  closeReactBar(false);
  sheet.classList.remove("hidden");
  placeSheet(sheet, anchor);
  if (anchor) anchor.setAttribute("aria-expanded", "true");
  state.sheetReturn = anchor || null;
  syncScrim();
}

// Closes both sheets; `returnFocus` gives the focus back to the control that opened one.
function closeMenus(returnFocus) {
  const open = openSheetEl();
  els.moreMenu.classList.add("hidden");
  els.moreBtn.setAttribute("aria-expanded", "false");
  els.placesPop.classList.add("hidden");
  if (els.placeLine) els.placeLine.setAttribute("aria-expanded", "false");
  if (els.modeTogether) els.modeTogether.setAttribute("aria-expanded", "false");
  const back = state.sheetReturn;
  state.sheetReturn = null;
  syncScrim();
  if (returnFocus && open && back && typeof back.focus === "function") back.focus();
}

function toggleMore() {
  if (!els.moreMenu.classList.contains("hidden")) {
    closeMenus(true);
    return;
  }
  openSheet(els.moreMenu, els.moreBtn);
  const first = focusables(els.moreMenu)[0];
  if (first) first.focus();
}

// What Tab may reach inside a sheet, the reaction bar or the lightbox.
function focusables(root) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll(sel)].filter((el) => !el.closest(".hidden") && el.getClientRects().length > 0);
}

// Tab and Shift+Tab stay inside `root`.
function trapTab(e, root) {
  const list = focusables(root);
  if (!list.length) { e.preventDefault(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const inside = root.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
}

// fix0927 review: her masters 01 to 05 (never master-00, the face crop), as the Album's
// "Her" row shows them (src/album.ts HER_MASTER_IDS).
const HER_MASTER_IDS = ["master-01", "master-02", "master-03", "master-04", "master-05"];

// Her pictures: the ones she SENT (approved, a message behind each; a picture the owner fired
// from Studio or the API stays in Studio > Pictures), newest first, then her masters.
async function openPhotos() {
  openDrawer(els.photosDrawer);
  clear(els.photosList);
  let scenes = [];
  let masters = [];
  try {
    const assets = await api("GET", "/api/assets");
    scenes = (Array.isArray(assets.scenes) ? assets.scenes : [])
      .filter((a) => a && typeof a.message_id === "string" && a.message_id.trim());
    masters = (Array.isArray(assets.masters) ? assets.masters : [])
      .filter((m) => m && HER_MASTER_IDS.includes(m.id) && m.approval_status === "approved" && typeof m.file === "string" && m.file.trim())
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch (e) {
    els.photosList.append(chip(errorWords(e.code), "danger"));
    return;
  }
  scenes.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  if (!scenes.length && !masters.length) {
    els.photosList.append(h("p", { class: "empty-label", text: "No pictures yet" }));
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
  // A master opens in the Album's lightbox (album.js reads /album#<id>).
  for (const m of masters) {
    const file = String(m.file).split(/[\\/]/).pop() || "";
    if (!file) continue;
    els.photosList.append(h("button", { type: "button", class: "photo-row", onclick: () => { window.location.href = "/album#" + encodeURIComponent(m.id); } },
      h("img", { src: "/images/masters/" + encodeURIComponent(file), alt: "", loading: "lazy" }),
      h("span", { class: "photo-text" },
        h("span", { class: "photo-date", text: "Her" }))));
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
    els.whyBody.append(h("div", { class: "chips" }, chip(errorWords(e.code), "danger")));
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

// ------------------------------------------------------------ keeping her line (exp 3.4 item 5)

function heartIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of [["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.7"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z");
  svg.append(p);
  return svg;
}

// The small accent heart at the corner of a kept line, in both modes.
function keptMark() {
  return h("span", { class: "kept-mark", role: "img", "aria-label": "kept" }, heartIcon());
}

function paintKept(id, mark) {
  const el = id ? findMessageEl(id) : null;
  const box = el ? el.querySelector(":scope > .bubbles") : null;
  if (!box) return;
  const cur = box.querySelector(":scope > .kept-mark");
  if (mark === "keep" && !cur) box.append(keptMark());
  else if (mark !== "keep" && cur) cur.remove();
}

// The bubble of hers under an event, with its row.
function herBubble(target) {
  const b = target && target.closest ? target.closest(".bubble[aria-haspopup]") : null;
  if (!b || !els.thread.contains(b)) return null;
  const msg = b.closest(".msg.hers[data-id]");
  const id = msg ? msg.getAttribute("data-id") : "";
  const m = id ? state.rows.get(id) : null;
  return m ? { bubble: b, m } : null;
}

// One bar at a time: the heart (Keep), note and why. Above the bubble, below it when there
// is no room; placed through the CSSOM.
function openReactBar(bubble, m) {
  if (state.react && state.react.bubble === bubble) return;
  closeReactBar(false);
  closeMenus(false);
  const heart = h("button", { type: "button", class: "react-btn react-keep", role: "menuitemcheckbox", "aria-checked": String(markOf(m) === "keep"), "aria-label": "Keep" }, heartIcon());
  const note = h("button", { type: "button", class: "react-btn", role: "menuitem", text: "note" });
  const why = h("button", { type: "button", class: "react-btn", role: "menuitem", text: "why" });
  const bar = h("div", { class: "react-bar glass strong", role: "menu", "aria-label": "React" }, heart, note, why);
  heart.addEventListener("click", () => toggleKeep(m, heart));
  note.addEventListener("click", () => { closeReactBar(false); toggleNoteSheet(m); });
  why.addEventListener("click", () => { closeReactBar(false); openWhy(m); });
  bar.addEventListener("keydown", (e) => {
    const items = [heart, note, why];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeReactBar(true); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
    else if (e.key === "Tab") trapTab(e, bar);
  });
  document.body.append(bar);
  placeReactBar(bar, bubble);
  state.react = { bar, bubble, m };
  heart.focus();
}

function placeReactBar(bar, bubble) {
  bar.style.position = "fixed";
  bar.style.zIndex = "60";
  const r = bubble.getBoundingClientRect();
  const floor = Math.max(8, els.thread.getBoundingClientRect().top);
  let top = r.top - bar.offsetHeight - 8;
  if (top < floor) top = r.bottom + 8;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - bar.offsetWidth - 8));
  bar.style.top = Math.round(top) + "px";
  bar.style.left = Math.round(left) + "px";
}

function closeReactBar(returnFocus) {
  const r = state.react;
  if (!r) return;
  state.react = null;
  r.bar.remove();
  if (returnFocus && r.bubble.isConnected) r.bubble.focus();
}

// The heart sets the mark `keep` on a line that is not kept and clears it on a kept one
// (the routes the Keep control has always used); it never drops.
async function toggleKeep(m, heart) {
  const was = markOf(m);
  const next = was === "keep" ? "none" : "keep";
  heart.setAttribute("aria-checked", String(next === "keep"));
  heart.disabled = true;
  try {
    if (next === "none") await api("DELETE", "/api/messages/" + encodeURIComponent(m.id) + "/mark");
    else await api("POST", "/api/messages/" + encodeURIComponent(m.id) + "/mark", { mark: "keep" });
    state.marks.set(m.id, next);
    paintKept(m.id, next);
    if (state.operator) refreshMeta(m);
  } catch (e) {
    heart.setAttribute("aria-checked", String(was === "keep"));
    showError(e.code || "error", false);
  } finally {
    heart.disabled = false;
  }
  // The pressed heart pops before the bar goes.
  await sleep(reducedMotion() ? 0 : 280);
  if (state.react && state.react.bar.contains(heart)) closeReactBar(true);
}

// A double-click or double-tap, a long press (450 ms, cancelled by 10 px of movement), the
// context menu, or Enter / Space on the focused bubble.
function wireReactions() {
  const thread = els.thread;
  const cancelPress = () => {
    if (state.press) clearTimeout(state.press.timer);
    state.press = null;
  };
  thread.addEventListener("dblclick", (e) => {
    const hit = herBubble(e.target);
    if (!hit) return;
    e.preventDefault();
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && typeof sel.removeAllRanges === "function") sel.removeAllRanges();
    openReactBar(hit.bubble, hit.m);
  });
  thread.addEventListener("contextmenu", (e) => {
    const hit = herBubble(e.target);
    if (!hit) return;
    e.preventDefault();
    cancelPress();
    openReactBar(hit.bubble, hit.m);
  });
  thread.addEventListener("pointerdown", (e) => {
    cancelPress();
    if (e.button !== undefined && e.button !== 0) return;
    const hit = herBubble(e.target);
    if (!hit) return;
    const press = { x: e.clientX, y: e.clientY, timer: null };
    press.timer = setTimeout(() => {
      if (state.press !== press) return;
      state.press = null;
      openReactBar(hit.bubble, hit.m);
    }, LONG_PRESS_MS);
    state.press = press;
  });
  thread.addEventListener("pointermove", (e) => {
    const p = state.press;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) cancelPress();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) thread.addEventListener(ev, cancelPress);
  thread.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const hit = herBubble(e.target);
    if (!hit || e.target !== hit.bubble) return;
    e.preventDefault();
    openReactBar(hit.bubble, hit.m);
  });
  thread.addEventListener("scroll", () => { cancelPress(); closeReactBar(false); }, { passive: true });
  // A tap anywhere outside the bar closes it.
  document.addEventListener("pointerdown", (e) => {
    const r = state.react;
    if (r && !r.bar.contains(e.target) && !r.bubble.contains(e.target)) closeReactBar(false);
  });
}

// ------------------------------------------------------------ the lightbox (exp 3.4 item 7)

// The pictures of the open chapter, in thread order.
function lightboxItems() {
  return [...els.thread.querySelectorAll(".photo-open[data-image]")].map((b) => ({
    id: b.getAttribute("data-image") || "",
    kind: b.getAttribute("data-kind") === "clip" ? "clip" : "photo",
    msg: b.getAttribute("data-msg") || "",
    at: b.getAttribute("data-when") || "",
    poster: b.getAttribute("data-poster") || "",
  })).filter((x) => x.id);
}

// The place of each approved picture, as the Album shows it (GET /api/roll), read once.
async function loadRollPlaces() {
  if (state.rollPlaces) return state.rollPlaces;
  const map = new Map();
  try {
    const r = await api("GET", "/api/roll?limit=200");
    for (const it of r && Array.isArray(r.items) ? r.items : []) {
      const where = it && typeof it.place === "string" ? placeWords(it.place) : "";
      if (it && it.id && where) map.set(it.id, where);
    }
  } catch {
    /* no place line */
  }
  state.rollPlaces = map;
  return map;
}

function openLightbox(imageId) {
  if (!els.lightbox || !els.lbMedia) {
    window.open("/media/" + encodeURIComponent(imageId), "_blank", "noopener");
    return;
  }
  const items = lightboxItems();
  const index = items.findIndex((x) => x.id === imageId);
  if (index < 0) return;
  closeReactBar(false);
  closeMenus(false);
  state.lightbox = { items, index };
  els.lightbox.classList.remove("hidden");
  showLightboxItem();
  loadRollPlaces().then(() => { if (state.lightbox) paintLightboxPlace(); });
  (els.lbClose || els.lightbox).focus();
}

function showLightboxItem() {
  const lb = state.lightbox;
  if (!lb) return;
  const it = lb.items[lb.index];
  const url = "/media/" + encodeURIComponent(it.id);
  const old = els.lbMedia.querySelector("video");
  if (old) old.pause();
  clear(els.lbMedia);
  if (it.kind === "clip") {
    const v = h("video", { src: url, controls: true, autoplay: true, playsinline: true, preload: "metadata" });
    if (it.poster) v.setAttribute("poster", it.poster);
    v.addEventListener("loadeddata", () => v.classList.add("loaded"));
    els.lbMedia.append(v);
  } else {
    const img = h("img", { src: url, alt: "", decoding: "async" });
    img.addEventListener("load", () => img.classList.add("loaded"));
    els.lbMedia.append(img);
  }
  if (els.lbDate) els.lbDate.textContent = fullDay(it.at);
  paintLightboxPlace();
  if (els.lbSave) els.lbSave.setAttribute("href", url + "?download=1");
  if (els.lbOpen) els.lbOpen.setAttribute("href", url);
  const had = document.activeElement;
  if (els.lbPrev) els.lbPrev.disabled = lb.index <= 0;
  if (els.lbNext) els.lbNext.disabled = lb.index >= lb.items.length - 1;
  // An arrow that just reached the end gives the focus to Close rather than to nothing.
  if ((had === els.lbPrev || had === els.lbNext) && had.disabled && els.lbClose) els.lbClose.focus();
  paintDecide(it);
}

function paintLightboxPlace() {
  const lb = state.lightbox;
  if (!lb || !els.lbPlace) return;
  const it = lb.items[lb.index];
  const where = state.rollPlaces ? state.rollPlaces.get(it.id) || "" : "";
  els.lbPlace.textContent = where;
  els.lbPlace.classList.toggle("hidden", !where);
}

// While the picture is not approved: Keep, Not her and Again (a clip has no Again).
function paintDecide(it) {
  if (!els.lbDecide) return;
  const undecided = !isApproved(it.id) && !state.rejected.has(it.id);
  els.lbDecide.classList.toggle("hidden", !undecided);
  if (els.lbAgain) els.lbAgain.classList.toggle("hidden", it.kind === "clip");
  for (const b of [els.lbKeep, els.lbReject, els.lbAgain]) if (b) b.disabled = false;
  decideStatus("");
}

function decideStatus(text) {
  if (!els.lbDecide) return;
  let slot = els.lbDecide.querySelector(".tool-status");
  if (!slot && !text) return;
  if (!slot) {
    slot = h("span", { class: "tool-status", role: "status" });
    els.lbDecide.append(slot);
  }
  slot.textContent = text;
  slot.classList.toggle("hidden", !text);
}

async function lightboxDecide(action) {
  const lb = state.lightbox;
  if (!lb) return;
  const it = lb.items[lb.index];
  const base = state.rows.get(it.msg) || { id: it.msg, conversation_id: state.currentId };
  const m = { ...base, image_id: it.id, image_status: "ready" };
  const buttons = [els.lbKeep, els.lbReject, els.lbAgain].filter(Boolean);
  for (const b of buttons) b.disabled = true;
  try {
    if (action === "again") await regeneratePicture(m, it.id);
    else {
      await decidePicture(it.id, action);
      replacePhoto(m);
    }
  } catch (e) {
    for (const b of buttons) b.disabled = false;
    const raw = typeof e.code === "string" ? e.code : "";
    const words = errorWords(raw);
    decideStatus(state.operator && raw && raw !== words ? words + " -- " + raw : words);
    return;
  }
  if (action === "approve") {
    els.lbDecide.classList.add("hidden");
    if (els.lbClose) els.lbClose.focus();
  } else {
    // The picture left the thread (rejected, or replaced by a new one).
    closeLightbox();
  }
}

function stepLightbox(delta) {
  const lb = state.lightbox;
  if (!lb) return;
  const next = lb.index + delta;
  if (next < 0 || next >= lb.items.length) return;
  lb.index = next;
  showLightboxItem();
}

function closeLightbox() {
  const lb = state.lightbox;
  if (!lb || !els.lightbox) return;
  state.lightbox = null;
  const v = els.lbMedia.querySelector("video");
  if (v) v.pause();
  clear(els.lbMedia);
  els.lightbox.classList.add("hidden");
  const it = lb.items[lb.index];
  const esc = (x) => (window.CSS && CSS.escape ? CSS.escape(x) : x.replace(/["\\]/g, "\\$&"));
  const back = it ? els.thread.querySelector('.photo-open[data-image="' + esc(it.id) + '"]') : null;
  if (back) back.focus();
  else els.input.focus();
}

function lightboxKey(e) {
  if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepLightbox(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stepLightbox(1); }
  else if (e.key === "Tab") trapTab(e, els.lightbox);
}

function wireLightbox() {
  if (!els.lightbox) return;
  if (els.lbClose) els.lbClose.addEventListener("click", closeLightbox);
  if (els.lbPrev) els.lbPrev.addEventListener("click", () => stepLightbox(-1));
  if (els.lbNext) els.lbNext.addEventListener("click", () => stepLightbox(1));
  if (els.lbKeep) els.lbKeep.addEventListener("click", () => lightboxDecide("approve"));
  if (els.lbReject) els.lbReject.addEventListener("click", () => lightboxDecide("reject"));
  if (els.lbAgain) els.lbAgain.addEventListener("click", () => lightboxDecide("again"));
  // A tap on the dark around the picture closes it.
  els.lightbox.addEventListener("click", (e) => { if (e.target === els.lightbox) closeLightbox(); });
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
  updateSendState();
});
els.retryBtn.addEventListener("click", () => send());
// The tools sheet: every row closes the sheet, then acts.
els.tasteBtn.addEventListener("click", () => { closeMenus(false); send({ tasting: true }); });
// fix0927 lane A: each of these acts the same from the menu and from its twin in sight.
// Dirty talk call: in a bed scene the Call button runs the hands-free loop (dtToggle), never
// the realtime call (OpenAI will not do explicit talk).
if (els.tvBtn) {
  els.tvBtn.addEventListener("click", () => tvToggle());
  if (storeGet(TV_KEY) === "1") tvStart();
}

const onCallClick = () => { closeMenus(false); if (state.dt || herVoiceReady()) dtToggle(); else startCall(); };
const onStartClick = () => { closeMenus(false); letHerStart(); };
const onPhotoClick = () => { closeMenus(false); els.fileInput.click(); };
// fix0927 review: already texting, a tap writes nothing (no new scene version, no audit row,
// and her apart place is kept).
const onTextingClick = () => {
  closeMenus(true);
  if (state.scene && state.scene.status === "apart") return;
  setScene("apart", null);
};
const onPlaceToggle = (from) => (els.placesPop.classList.contains("hidden") ? openPlaces(from) : closeMenus(true));
for (const b of callButtons()) b.addEventListener("click", onCallClick);
els.callMute.addEventListener("click", () => {
  if (!state.call) return;
  const on = els.callMute.getAttribute("aria-pressed") !== "true";
  state.call.mute(on);
});
els.callEnd.addEventListener("click", () => { if (state.call) state.call.end("hangup"); });
els.newChat.addEventListener("click", newChat);
els.openDrawer.addEventListener("click", openSidebar);
els.closeDrawer.addEventListener("click", closeSidebar);
els.scrim.addEventListener("click", () => { closeSidebar(); closeDrawers(); closeMenus(true); });
for (const b of [els.letHerStart, els.startChip]) if (b) b.addEventListener("click", onStartClick);
// The scene sheet: Together goes to the place picker in it, Texting sets the scene.
els.sceneTogether.addEventListener("click", () => {
  if (els.placesPop.classList.contains("hidden")) openPlaces();
  else els.placeInput.focus();
});
for (const b of [els.sceneApart, els.modeTexting]) if (b) b.addEventListener("click", onTextingClick);
// The bar's pill: Together opens the place sheet under it (the place line's toggle).
if (els.modeTogether) els.modeTogether.addEventListener("click", () => onPlaceToggle(els.modeTogether));
els.placeSet.addEventListener("click", () => { const where = els.placeInput.value.trim(); closeMenus(true); setScene("together", where || null); });
els.placeCancel.addEventListener("click", () => closeMenus(true));
els.placeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); els.placeSet.click(); } });
if (els.placeLine) els.placeLine.addEventListener("click", () => onPlaceToggle());
els.photosBtn.addEventListener("click", () => {
  closeMenus(false);
  if (els.photosDrawer.classList.contains("open")) closeDrawers();
  else openPhotos();
});
els.photosClose.addEventListener("click", closeDrawers);
els.whyClose.addEventListener("click", closeDrawers);
document.addEventListener("visibilitychange", onVisible);
window.addEventListener("avelie:player", onPlayerEvent);
els.moreBtn.addEventListener("click", toggleMore);
for (const b of photoButtons()) b.addEventListener("click", onPhotoClick);
els.fileInput.addEventListener("change", () => addFiles(els.fileInput.files || []));
els.timingToggle.addEventListener("change", () => {
  state.timing = els.timingToggle.checked ? "human" : "instant";
  storeSet(TIMING_KEY, state.timing);
});
els.operatorToggle.addEventListener("change", () => {
  state.operator = els.operatorToggle.checked;
  els.composer.classList.toggle("operator", state.operator);
  document.body.classList.toggle("backstage", state.operator);
  closeReactBar(false);
  hideError();
  stopPollers();
  updateSendState();
  loadThread();
});
// The chapter head: a tap renames; Enter or blur saves, Escape cancels.
if (els.convTitle) els.convTitle.addEventListener("click", startRename);
if (els.chapterEdit) {
  els.chapterEdit.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      saveRename();
      if (els.convTitle) els.convTitle.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    }
  });
  els.chapterEdit.addEventListener("blur", () => { saveRename(); });
}
wireReactions();
wireLightbox();
wireBackdrop();
document.addEventListener("click", (e) => {
  const t = e.target;
  const inside = t && t.closest && (t.closest("#moreMenu") || t.closest("#placesPop") || t.closest("#moreBtn") || t.closest("#placeLine") || t.closest("#modePill"));
  if (!inside) closeMenus(false);
});
document.addEventListener("keydown", (e) => {
  if (state.lightbox) { lightboxKey(e); return; }
  const sheet = openSheetEl();
  if (e.key === "Escape") {
    if (state.react) { closeReactBar(true); return; }
    if (sheet) { closeMenus(true); return; }
    closeDrawers();
    closeSidebar();
    return;
  }
  if (e.key === "Tab" && sheet) trapTab(e, sheet);
});
window.addEventListener("resize", () => {
  grow();
  closeReactBar(false);
  const sheet = openSheetEl();
  if (sheet) placeSheet(sheet, state.sheetReturn);
  syncScrim();
});

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
  loadClock();
  const stored = storeGet(STORE_KEY);
  const pick = state.conversations.find((c) => c.id === stored) || state.conversations[0];
  if (pick) await select(pick.id);
  else {
    // No chapter yet: the head with the day's name, her face, and the first send makes it.
    updateStartButton();
    updateTitle();
    showEmptyHer();
  }
  grow();
}

init();
