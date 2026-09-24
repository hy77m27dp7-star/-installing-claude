// Chat: the thread as a phone conversation. Her words stand alone by default; the
// backstage (flags, the operator channel) shows only while the Operator switch is on.
import {
  api, apiForm, h, chip, clear, fmtDate, fmtTime, flagCodes, parseJson, registerServiceWorker, storeGet, storeSet, svgIcon,
} from "./api.js";
import { splitBubbles, bubbleDelayMs, pauseForId, PAUSE_MS } from "./bubbles.js";

const POLL_MS = 3000;
// Longer than the server's claim lease (4 min), so a request another tab holds either
// finishes or expires while this page still watches.
const POLL_MAX = 90;
const STORE_KEY = "avelie.conversation";
const TIMING_KEY = "bubbleTiming";
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_VOICE_MS = 60000;
const MAX_VOICE_BYTES = 4 * 1024 * 1024;
const MIN_VOICE_MS = 600;
const DESC_CHARS = 60;

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
  attachBtn: $("attachBtn"),
  fileInput: $("fileInput"),
  attachStrip: $("attachStrip"),
  micBtn: $("micBtn"),
  errorRow: $("errorRow"),
  errorChip: $("errorChip"),
  retryBtn: $("retryBtn"),
  photosDrawer: $("photosDrawer"),
  photosList: $("photosList"),
  photosClose: $("photosClose"),
  whyDrawer: $("whyDrawer"),
  whyBody: $("whyBody"),
  whyClose: $("whyClose"),
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
    ]);
    if (!alive(seq)) return;
    rows = Array.isArray(messages) ? messages : [];
    if (assets) {
      state.approved = new Set((assets.scenes || []).map((a) => a.id));
      state.rejected = new Set((assets.rejected || []).map((a) => a.id));
    }
  } catch (e) {
    if (alive(seq)) showError(e.code, false);
    return;
  }
  for (const m of rows) {
    if (m.channel === "story") state.lastStoryRole = m.role;
    if (m.role === "assistant" && m.channel === "story" && futureIso(m.deliver_at)) {
      scheduleDelivery(m, seq);
    } else {
      appendMessage(renderMessage(m));
    }
  }
  updateStartButton();
  scrollBottom();
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
}

function noteRole(m) {
  if (m && m.channel === "story") {
    state.lastStoryRole = m.role;
    updateStartButton();
  }
}

function updateStartButton() {
  const show = !state.operator && state.lastStoryRole !== "user";
  els.letHerStart.classList.toggle("hidden", !show);
}

function bubbleEl(text) {
  return h("div", { class: "bubble", text });
}

function renderMessage(m, errorCode, error) {
  const his = m.role === "user";
  const op = m.channel === "operator";
  const el = h("div", { class: "msg " + (his ? "his" : "hers") + (op ? " op" : ""), "data-id": m.id || "" });
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
  }
  if (extras.childElementCount) el.append(extras);
  el.append(metaRow(m));
  return el;
}

function metaRow(m) {
  const row = h("div", { class: "meta" }, h("span", { text: fmtTime(m.created_at) }));
  if (m.role === "assistant" && m.channel !== "operator" && m.id) {
    row.append(h("button", { type: "button", class: "why", text: "why", onclick: () => openWhy(m) }));
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

function songCard(m) {
  const song = parseJson(m.song_json, null);
  if (!song || typeof song !== "object" || !song.title) return null;
  const artist = String(song.artist || "");
  const title = String(song.title || "");
  let href = typeof song.searchUrl === "string" && song.searchUrl.startsWith("https://open.spotify.com/") ? song.searchUrl : "";
  if (!href) href = "https://open.spotify.com/search/" + encodeURIComponent((artist + " " + title).trim());
  return h("div", { class: "song-card" },
    h("span", { class: "note", "aria-hidden": "true" }, svgIcon("note")),
    h("span", { class: "song-text" },
      h("span", { class: "song-title", text: title }),
      artist ? h("span", { class: "song-artist", text: artist }) : null),
    h("a", { class: "song-link", href, target: "_blank", rel: "noopener noreferrer", text: "Open in Spotify" }));
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

// ------------------------------------------------------------ timing

function refreshTyping() {
  const on = state.inFlight || state.dotsHold || state.deliveries.size > 0;
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
  const instant = state.timing === "instant" || m.role === "user" || m.channel === "operator";
  if (instant) {
    appendMessage(el);
    scrollBottom();
    noteRole(m);
    return;
  }
  const bubbles = [...el.querySelectorAll(".bubbles > .bubble")];
  const tail = [...el.children].filter((c) => !c.classList.contains("bubbles"));
  for (const b of bubbles) b.classList.add("hidden");
  for (const t of tail) t.classList.add("hidden");
  appendMessage(el);
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
      bubbles[i].classList.remove("hidden");
      bubbles[i].classList.add("enter");
      scrollBottom();
    }
    for (const t of tail) t.classList.remove("hidden");
    scrollBottom();
    noteRole(m);
  } finally {
    state.arriving--;
    state.dotsHold = false;
    refreshTyping();
    updateSendState();
  }
}

// Real mode: her reply exists but is not hers to send yet. Dots until its time.
function scheduleDelivery(m, seq) {
  const at = Date.parse(m.deliver_at || m.deliverAt || "");
  const ms = at - Date.now();
  if (!(ms > 0)) {
    arrive(m, seq);
    return;
  }
  if (state.deliveries.has(m.id)) return;
  const timer = setTimeout(() => {
    state.deliveries.delete(m.id);
    refreshTyping();
    if (alive(seq)) arrive(m, seq);
  }, Math.min(ms, 0x7fffffff));
  state.deliveries.set(m.id, timer);
  refreshTyping();
}

function clearDeliveries() {
  for (const t of state.deliveries.values()) clearTimeout(t);
  state.deliveries.clear();
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
    const deliverAt = a.deliver_at || a.deliverAt || r.deliverAt || null;
    if (futureIso(deliverAt)) scheduleDelivery({ ...a, deliver_at: deliverAt }, seq);
    else arrive(a, seq);
  }
  scrollBottom();
}

// ------------------------------------------------------------ photos

// A pending photo is generated by a request this page holds open (the server cannot keep
// working in the background long enough for an image call). The server refuses a second
// request for the same picture while one is running, in which case the page just polls.
function renderPhoto(m, errorCode, error) {
  const status = m.image_status;
  if (status === "pending") {
    if (m.id) requestPhoto(m);
    return h("div", { class: "photo" }, h("div", { class: "photo-pending", "aria-label": "Photo pending" }));
  }
  if (status === "ready" && m.image_id) {
    if (state.rejected.has(m.image_id)) return null;
    const wrap = h("div", { class: "photo" }, h("img", { src: "/media/" + encodeURIComponent(m.image_id), alt: "" }));
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
  const busy = state.inFlight || state.arriving > 0;
  els.sendBtn.disabled = busy;
  els.retryBtn.disabled = busy;
  els.letHerStart.disabled = busy;
  els.micBtn.disabled = busy || state.operator;
  els.attachBtn.disabled = busy || state.operator;
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

async function send() {
  const text = els.input.value.trim();
  if (!text || state.inFlight || state.arriving) return;
  setInFlight(true);
  hideError();
  try {
    const id = await ensureConversation();
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
      const path = "/api/conversations/" + encodeURIComponent(id) + "/turn";
      let r;
      try {
        if (state.attachments.length) {
          const fd = new FormData();
          fd.append("content", text);
          fd.append("idempotencyKey", pending.key);
          for (const f of state.attachments) fd.append("image", f, f.name || "image");
          r = await apiForm("POST", path, fd);
        } else {
          r = await api("POST", path, { content: text, idempotencyKey: pending.key });
        }
      } catch (e) {
        // A key the server already tied to something else can never succeed again.
        if (e.status === 409) state.pending = null;
        throw e;
      }
      state.pending = null;
      state.attachments = [];
      renderAttachments();
      handleTurnResponse(r, id);
    }
    touchConversation(id);
    els.input.value = "";
    grow();
  } catch (e) {
    showError(e.code || "error", true);
  } finally {
    setInFlight(false);
    els.input.focus();
  }
}

// She opens: a turn with no message from him.
async function letHerStart() {
  if (state.inFlight || state.arriving) return;
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
    if (els.micBtn.setPointerCapture) {
      try { els.micBtn.setPointerCapture(e.pointerId); } catch { /* not needed */ }
    }
    startRecording();
  });
  for (const ev of ["pointerup", "pointercancel"]) els.micBtn.addEventListener(ev, () => stopRecording());
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
  if (state.rec || state.inFlight || state.operator) return;
  const rec = { stream: null, recorder: null, chunks: [], startedAt: Date.now(), released: false, timer: null };
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
}

async function sendVoice(blob, mime) {
  if (state.inFlight) return;
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

// ------------------------------------------------------------ scene

async function loadScene() {
  try {
    const bundle = await api("GET", "/api/state");
    state.cache.state = bundle;
    state.scene = bundle && bundle.scene && bundle.scene.state ? bundle.scene.state : null;
  } catch {
    state.scene = null;
  }
  renderScene();
}

function renderScene() {
  const s = state.scene ? state.scene.status : null;
  els.sceneTogether.setAttribute("aria-pressed", String(s === "together"));
  els.sceneApart.setAttribute("aria-pressed", String(s === "apart"));
}

async function setScene(status, location) {
  const base = state.scene && typeof state.scene === "object" ? state.scene : {};
  const next = { ...base, status, location: location || null };
  els.sceneTogether.disabled = true;
  els.sceneApart.disabled = true;
  try {
    const r = await api("PUT", "/api/state/scene", { state: next, note: "toggle" });
    state.scene = r && r.state ? r.state : next;
  } catch (e) {
    showError(e.code || "error", false);
  } finally {
    els.sceneTogether.disabled = false;
    els.sceneApart.disabled = false;
    renderScene();
  }
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
  await loadLife();
  if (els.placesPop.classList.contains("hidden")) return;
  for (const p of state.places) {
    els.placesList.append(h("button", {
      type: "button", class: "btn small quiet", text: p.title,
      onclick: () => { closeMenus(); setScene("together", p.title); },
    }));
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

function closeDrawers() {
  for (const d of [els.photosDrawer, els.whyDrawer]) {
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
  }
  els.photosBtn.setAttribute("aria-expanded", "false");
  syncScrim();
}

function syncScrim() {
  const open = els.sidebar.classList.contains("open") || els.photosDrawer.classList.contains("open") || els.whyDrawer.classList.contains("open");
  els.scrim.classList.toggle("hidden", !open);
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
  for (const [label, key] of [["Prompt", "promptVersion"], ["Provider", "provider"], ["Model", "model"], ["Recent messages", "recentMessageCount"]]) {
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
  updateSendState();
  try {
    await api("GET", "/api/me");
    registerServiceWorker();
  } catch {
    /* the gate answers before this page loads; nothing to register */
  }
  await Promise.all([loadConversations(), loadScene()]);
  const stored = storeGet(STORE_KEY);
  const pick = state.conversations.find((c) => c.id === stored) || state.conversations[0];
  if (pick) await select(pick.id);
  else updateStartButton();
  grow();
}

init();
