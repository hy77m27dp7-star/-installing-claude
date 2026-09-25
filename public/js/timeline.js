// Timeline: one read-only scroll of what happened, newest at the bottom. The server
// merges and sorts (GET /api/timeline); this file renders, filters by kind, and pages
// further back with "Load older". A message item opens the chat on its conversation.
import { api, h, clear, chip, flash, fmtTime, storeSet } from "./api.js";

const PAGE = 200;
// The key the chat page reads to reopen a conversation (public/js/chat.js).
const CONVERSATION_KEY = "avelie.conversation";
const KIND_LABEL = {
  history: "history",
  photo: "photo",
  media: "media",
  life: "life",
  relationship: "relationship",
  scene: "scene",
  first_text: "first text",
  // v3
  call: "call",
  want: "want",
  ask: "ask",
  correction: "note",
  portrait: "portrait",
};
const KIND_CHIP = {
  history: "accent",
  photo: "",
  media: "",
  life: "",
  relationship: "amber",
  scene: "amber",
  first_text: "ok",
  call: "accent",
  want: "",
  ask: "amber",
  correction: "",
  portrait: "",
};

const $ = (id) => document.getElementById(id);
const els = {
  list: $("timelineList"),
  status: $("timeline-status"),
  count: $("timeline-count"),
  older: $("olderBtn"),
  kind: $("kindFilter"),
};

const state = {
  items: [],
  nextBefore: null,
  kind: "",
  loading: false,
};

function itemsOf(r) {
  if (Array.isArray(r)) return r;
  return (r && Array.isArray(r.items)) ? r.items : [];
}

// The server's names (API.md: at, type, title, text, link, id) with the older aliases kept.
function dateOf(i) {
  return i.at || i.date || i.occurred || i.created_at || "";
}

function typeOf(i) {
  return i.type || i.kind || "";
}

function linkOf(i) {
  const l = i.link || i.href;
  return typeof l === "string" && l.startsWith("/") ? l : null;
}

function isMessageItem(i) {
  return Boolean(i.messageId) && linkOf(i) === "/";
}

function rememberConversation(i) {
  if (i.conversationId) storeSet(CONVERSATION_KEY, i.conversationId);
}

function row(i) {
  const kind = typeOf(i);
  const link = linkOf(i);
  const when = h("span", { class: "small muted mono", text: fmtTime(dateOf(i)) });
  const tag = chip(KIND_LABEL[kind] || kind, KIND_CHIP[kind] || "");
  const title = link
    ? h("a", { href: link, text: i.title || kind, onclick: () => { if (isMessageItem(i)) rememberConversation(i); } })
    : h("span", { text: i.title || kind });
  const text = i.text ? h("span", { class: "muted small", text: i.text }) : null;

  if (kind === "photo" && i.imageId) {
    return h("a", { class: "photo-row", href: link || "/images", "data-kind": kind, onclick: () => rememberConversation(i) },
      h("img", { src: "/media/" + encodeURIComponent(i.imageId), alt: "", loading: "lazy" }),
      h("span", { class: "photo-text" },
        h("span", { class: "row" }, tag, when),
        i.text ? h("span", { class: "photo-desc", text: i.text }) : null));
  }

  return h("div", { class: "list-row", "data-kind": kind }, tag, when, title, text);
}

function render() {
  clear(els.list);
  const shown = state.kind ? state.items.filter((i) => typeOf(i) === state.kind) : state.items;
  if (!shown.length) {
    els.list.append(h("div", { class: "list-row" }, chip("none")));
  } else {
    for (const i of shown) els.list.append(row(i));
  }
  clear(els.count);
  els.count.append(chip(shown.length + (state.kind ? " " + (KIND_LABEL[state.kind] || state.kind) : "")));
  els.older.classList.toggle("hidden", !state.nextBefore);
}

async function load(before) {
  if (state.loading) return;
  state.loading = true;
  els.older.disabled = true;
  try {
    const path = "/api/timeline?limit=" + PAGE + (before ? "&before=" + encodeURIComponent(before) : "");
    const r = await api("GET", path);
    const page = itemsOf(r);
    const known = new Set(state.items.map((i) => i.id));
    const fresh = page.filter((i) => !known.has(i.id));
    state.items = before ? fresh.concat(state.items) : fresh;
    state.nextBefore = (r && !Array.isArray(r) && r.nextBefore) || (page.length >= PAGE && page[0] ? dateOf(page[0]) : null);
    const keepFrom = before ? document.documentElement.scrollHeight - window.scrollY : null;
    render();
    if (before) {
      window.scrollTo(0, document.documentElement.scrollHeight - keepFrom);
    } else {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
  } catch (e) {
    flash(els.status, e.code || "error", "danger");
  } finally {
    state.loading = false;
    els.older.disabled = false;
  }
}

els.older.addEventListener("click", () => load(state.nextBefore));

els.kind.addEventListener("change", () => {
  state.kind = els.kind.value || "";
  render();
  window.scrollTo(0, document.documentElement.scrollHeight);
});

load(null);
