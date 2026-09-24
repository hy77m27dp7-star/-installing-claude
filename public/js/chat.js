// Chat: conversations, the story thread, her photos, the composer and the operator switch.
import { api, h, chip, clear, fmtDate, fmtTime, flagCodes, storeGet, storeSet } from "./api.js";

const POLL_MS = 3000;
const POLL_MAX = 40;
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
  pendingKey: null,
  pollers: new Map(),
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
  for (const m of rows) els.thread.append(renderMessage(m, flagCodes(m.flags_json)));
  scrollBottom();
}

function renderMessage(m, flags) {
  const his = m.role === "user";
  const op = m.channel === "operator";
  const el = h("div", { class: "msg " + (his ? "his" : "hers") + (op ? " op" : ""), "data-id": m.id || "" });
  el.append(h("div", { class: "bubble", text: m.content }));
  if (!his && !op) {
    if (flags && flags.length) el.append(h("div", { class: "flags" }, flags.map((f) => chip(f))));
    const photo = renderPhoto(m);
    if (photo) el.append(photo);
  }
  el.append(h("div", { class: "time", text: fmtTime(m.created_at) }));
  return el;
}

function scrollBottom() {
  els.thread.scrollTop = els.thread.scrollHeight;
}

// ------------------------------------------------------------ photos

function renderPhoto(m) {
  const status = m.image_status;
  if (status === "pending") {
    if (m.id) startPoll(m.id);
    return h("div", { class: "photo" }, h("div", { class: "photo-pending", "aria-label": "Photo pending" }));
  }
  if (status === "ready" && m.image_id) {
    if (state.rejected.has(m.image_id)) return null;
    const wrap = h("div", { class: "photo" }, h("img", { src: "/media/" + encodeURIComponent(m.image_id), alt: "" }));
    if (!state.approved.has(m.image_id)) wrap.append(photoActions(m.image_id, wrap));
    return wrap;
  }
  if (status === "failed") return h("div", { class: "photo" }, chip("photo failed"));
  return null;
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

function startPoll(messageId) {
  if (state.pollers.has(messageId)) return;
  let count = 0;
  const timer = setInterval(async () => {
    count++;
    let m = null;
    try { m = await api("GET", "/api/messages/" + encodeURIComponent(messageId)); } catch { m = null; }
    if (!state.pollers.has(messageId)) return;
    if (m && m.image_status !== "pending") {
      stopPoll(messageId);
      replacePhoto(m);
      return;
    }
    if (count >= POLL_MAX) {
      stopPoll(messageId);
      replacePhoto({ id: messageId, image_status: "timeout" });
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

function replacePhoto(m) {
  const el = findMessageEl(m.id);
  if (!el) return;
  const old = el.querySelector(".photo");
  const fresh = m.image_status === "timeout"
    ? h("div", { class: "photo" }, chip("photo pending"))
    : renderPhoto(m);
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
      if (!state.pendingKey) state.pendingKey = crypto.randomUUID();
      const r = await api("POST", "/api/conversations/" + encodeURIComponent(id) + "/turn", {
        content: text,
        idempotencyKey: state.pendingKey,
      });
      state.pendingKey = null;
      if (state.currentId === id && !state.operator) {
        const flags = r.flags && r.flags.length ? flagCodes(r.flags) : flagCodes(r.assistantMessage && r.assistantMessage.flags_json);
        if (r.userMessage) els.thread.append(renderMessage(r.userMessage, []));
        if (r.assistantMessage) els.thread.append(renderMessage(r.assistantMessage, flags));
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
els.input.addEventListener("input", grow);
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
