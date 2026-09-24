// Chat: conversations, the story thread, her photos, the composer and the operator switch.
import { api, h, chip, clear, fmtDate, fmtTime, flagCodes, storeGet, storeSet } from "./api.js";

const POLL_MS = 3000;
// Longer than the server's claim lease (4 min), so a request another tab holds either
// finishes or expires while this page still watches.
const POLL_MAX = 90;
const STORE_KEY = "avelie.conversation";

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"),
  scrim: $("scrim"),
  openDrawer: $("openDrawer"),
  closeDrawer: $("closeDrawer"),
  newChat: $("newChat"),
  convList: $("convList"),
  convTitle: $("convTitle"),
  thread: $("thread"),
  typing: $("typing"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  operatorToggle: $("operatorToggle"),
  errorRow: $("errorRow"),
  errorChip: $("errorChip"),
  retryBtn: $("retryBtn"),
};

const state = {
  conversations: [],
  currentId: null,
  operator: false,
  inFlight: false,
  // The idempotency key of a send that has not been answered yet, with the conversation
  // and text it belongs to. Reused only for the same text in the same conversation.
  pending: null,
  pollers: new Map(),
  generating: new Set(),
  approved: new Set(),
  rejected: new Set(),
  loadSeq: 0,
};

// ------------------------------------------------------------ conversations

function convLabel(c) {
  return c.title || "chat " + fmtDate(c.created_at);
}

async function loadConversations() {
  try {
    state.conversations = await api("GET", "/api/conversations");
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
      onclick: () => { select(c.id); closeDrawer(); },
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
    closeDrawer();
    els.input.focus();
  } catch (e) {
    showError(e.code, false);
  } finally {
    els.newChat.disabled = false;
  }
}

// ------------------------------------------------------------ thread

async function loadThread() {
  const seq = ++state.loadSeq;
  const id = state.currentId;
  clear(els.thread);
  if (!id) return;
  const channel = state.operator ? "operator" : "story";
  let rows = [];
  try {
    const [messages, assets] = await Promise.all([
      api("GET", "/api/conversations/" + encodeURIComponent(id) + "/messages?channel=" + channel),
      state.operator ? Promise.resolve(null) : api("GET", "/api/assets").catch(() => null),
    ]);
    if (seq !== state.loadSeq) return;
    rows = Array.isArray(messages) ? messages : [];
    if (assets) {
      state.approved = new Set((assets.scenes || []).map((a) => a.id));
      state.rejected = new Set((assets.rejected || []).map((a) => a.id));
    }
  } catch (e) {
    if (seq === state.loadSeq) showError(e.code, false);
    return;
  }
  for (const m of rows) appendMessage(renderMessage(m, flagCodes(m.flags_json)));
  scrollBottom();
}

// A message already in the thread (a replayed turn after a reload) is not added twice.
function appendMessage(el) {
  const id = el.getAttribute("data-id");
  if (id && findMessageEl(id)) return;
  els.thread.append(el);
}

function renderMessage(m, flags, errorCode, error) {
  const his = m.role === "user";
  const op = m.channel === "operator";
  const el = h("div", { class: "msg " + (his ? "his" : "hers") + (op ? " op" : ""), "data-id": m.id || "" });
  el.append(h("div", { class: "bubble", text: m.content }));
  if (!his && !op) {
    if (flags && flags.length) el.append(h("div", { class: "flags" }, flags.map((f) => chip(f))));
    const photo = renderPhoto(m, errorCode, error);
    if (photo) el.append(photo);
  }
  el.append(h("div", { class: "time", text: fmtTime(m.created_at) }));
  return el;
}

function scrollBottom() {
  els.thread.scrollTop = els.thread.scrollHeight;
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
    if (!state.approved.has(m.image_id)) wrap.append(photoActions(m.image_id, wrap));
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

function photoActions(imageId, wrap) {
  const row = h("div", { class: "photo-actions" });
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const act = async (decision) => {
    approve.disabled = true;
    reject.disabled = true;
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
  const old = el.querySelector(".photo");
  const fresh = renderPhoto(m, errorCode, error);
  if (old) {
    if (fresh) old.replaceWith(fresh);
    else old.remove();
  } else if (fresh) {
    el.insertBefore(fresh, el.querySelector(".time"));
  }
}

// ------------------------------------------------------------ composer

function grow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + "px";
}

function setInFlight(on) {
  state.inFlight = on;
  els.sendBtn.disabled = on;
  els.retryBtn.disabled = on;
  els.typing.classList.toggle("hidden", !on);
  if (on) scrollBottom();
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
  if (!text || state.inFlight) return;
  setInFlight(true);
  hideError();
  try {
    const id = await ensureConversation();
    if (state.operator) {
      const r = await api("POST", "/api/operator", { content: text, conversationId: id });
      if (state.currentId === id && state.operator) {
        const now = new Date().toISOString();
        els.thread.append(renderMessage({ id: "", role: "user", channel: "operator", content: text, created_at: now }, []));
        els.thread.append(renderMessage({ id: "", role: "assistant", channel: "operator", content: String(r.reply || ""), created_at: now }, []));
        scrollBottom();
      }
    } else {
      const pending = pendingFor(id, text);
      state.pending = pending;
      let r;
      try {
        r = await api("POST", "/api/conversations/" + encodeURIComponent(id) + "/turn", {
          content: text,
          idempotencyKey: pending.key,
        });
      } catch (e) {
        // A key the server already tied to something else can never succeed again.
        if (e.status === 409) state.pending = null;
        throw e;
      }
      state.pending = null;
      if (state.currentId === id && !state.operator) {
        const flags = r.flags && r.flags.length ? flagCodes(r.flags) : flagCodes(r.assistantMessage && r.assistantMessage.flags_json);
        if (r.userMessage) appendMessage(renderMessage(r.userMessage, []));
        if (r.assistantMessage) appendMessage(renderMessage(r.assistantMessage, flags));
        scrollBottom();
      }
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

// ------------------------------------------------------------ drawer

function openDrawer() {
  els.sidebar.classList.add("open");
  els.scrim.classList.remove("hidden");
  els.openDrawer.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  els.sidebar.classList.remove("open");
  els.scrim.classList.add("hidden");
  els.openDrawer.setAttribute("aria-expanded", "false");
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
els.openDrawer.addEventListener("click", openDrawer);
els.closeDrawer.addEventListener("click", closeDrawer);
els.scrim.addEventListener("click", closeDrawer);
els.operatorToggle.addEventListener("change", () => {
  state.operator = els.operatorToggle.checked;
  els.composer.classList.toggle("operator", state.operator);
  hideError();
  stopPollers();
  loadThread();
});

async function init() {
  els.operatorToggle.checked = false;
  await loadConversations();
  const stored = storeGet(STORE_KEY);
  const pick = state.conversations.find((c) => c.id === stored) || state.conversations[0];
  if (pick) await select(pick.id);
  grow();
}

init();
