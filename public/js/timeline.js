// Timeline: one read-only scroll of what happened, newest at the bottom. The server
// merges and sorts (GET /api/timeline); this file renders, filters by kind, and pages
// further back with "Load older". A message item opens the chat on its conversation.
// Experience pass (DESIGN_EXPERIENCE 7.4): words first. By default only the items that carry
// `story` (the event in words, GET /api/timeline 8.8) show, each as a .story-line (the date in
// italic, the sentence, a small glyph by type); "Show the log" (#logToggle, remembered per
// browser as avelie.timelineLog) shows every item as the log rows (.list-row, .photo-row).
import { api, h, clear, chip, flash, fmtTime, storeGet, storeSet } from "./api.js";

const PAGE = 200;
// The key the chat page reads to reopen a conversation (public/js/chat.js).
const CONVERSATION_KEY = "avelie.conversation";
const LOG_KEY = "avelie.timelineLog";
const SVG_NS = "http://www.w3.org/2000/svg";
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
  // v5
  beat: "beat",
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
  beat: "accent",
};
// The glyph beside a story line: line icons, 24 viewBox, stroke currentColor (section 2.7).
const GLYPH = {
  history: "M6 4h12v16l-6-4-6 4z",
  photo: "M4 7h3l2-2h6l2 2h3v12H4zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  media: "M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  life: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  relationship: "M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z",
  scene: "M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  first_text: "M4 5h16v11H9l-5 4z",
  call: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  want: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z",
  ask: "M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.2V15M12 19h.01",
  beat: "M5 21V4M5 4h11l-2 4 2 4H5",
};
const GLYPH_DEFAULT = "M12 12h.01";

const $ = (id) => document.getElementById(id);
const els = {
  list: $("timelineList"),
  status: $("timeline-status"),
  count: $("timeline-count"),
  older: $("olderBtn"),
  kind: $("kindFilter"),
  log: $("logToggle"),
};

const state = {
  items: [],
  nextBefore: null,
  kind: "",
  log: storeGet(LOG_KEY) === "1",
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

function storyOf(i) {
  return typeof i.story === "string" && i.story.trim() ? i.story.trim() : "";
}

// "Thu, Sep 25, 6:37 pm": the day and the hour the thing happened.
function storyWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return day + ", " + time;
}

function glyph(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", GLYPH[kind] || GLYPH_DEFAULT);
  svg.append(path);
  return svg;
}

// One event in words: the glyph, the date in italic, the sentence (a link when it has one).
function storyLine(i) {
  const kind = typeOf(i);
  const link = linkOf(i);
  const words = storyOf(i);
  const text = link
    ? h("a", { class: "story-text", href: link, text: words, onclick: () => { if (isMessageItem(i) || kind === "photo") rememberConversation(i); } })
    : h("span", { class: "story-text", text: words });
  return h("div", { class: "story-line", "data-kind": kind },
    glyph(kind),
    h("span", { class: "story-when", text: storyWhen(dateOf(i)) }),
    text);
}

function render() {
  clear(els.list);
  const ofKind = state.kind ? state.items.filter((i) => typeOf(i) === state.kind) : state.items;
  const shown = state.log ? ofKind : ofKind.filter((i) => storyOf(i));
  if (!shown.length) {
    els.list.append(h("div", { class: "empty-label", text: "Nothing yet" }));
  } else {
    for (const i of shown) els.list.append(state.log ? row(i) : storyLine(i));
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

if (els.log) {
  els.log.checked = state.log;
  els.log.addEventListener("change", () => {
    state.log = els.log.checked;
    storeSet(LOG_KEY, state.log ? "1" : "0");
    render();
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
}

els.kind.addEventListener("change", () => {
  state.kind = els.kind.value || "";
  render();
  window.scrollTo(0, document.documentElement.scrollHeight);
});

load(null);
