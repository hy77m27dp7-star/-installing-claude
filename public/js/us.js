// Us: the story of the two of you, set like a magazine feature (DESIGN_EXPERIENCE 6.4).
// One GET of /api/us at load, nothing written back. Where they stand and since when, her
// names for each other, the chapters, the moments, the places they have been together and
// the lines of hers he kept. Every section stays hidden while its list is empty. A chapter
// or a kept line opens the chat on its conversation. The hero face is filled by nav.js.
import { api, h, clear, storeSet } from "./api.js";
import { capDate, dayWords, spanWords, sentenceCase } from "./months.js";

// The key the chat page opens a conversation from (public/js/chat.js).
const CONVERSATION_KEY = "avelie.conversation";
const PLACE_THUMBS = 6;

const $ = (id) => document.getElementById(id);

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === "string" ? v.trim() : "");

function nowIso() {
  return new Date().toISOString();
}

function setLine(el, words) {
  el.textContent = words;
  el.classList.toggle("hidden", !words);
}

function showSection(sectionId, holder, count) {
  $(sectionId).classList.toggle("hidden", count === 0);
  if (count === 0) clear(holder);
}

// A tap stores the conversation and lets the link carry him to the chat ("/").
function toChat(conversationId) {
  return () => { if (conversationId) storeSet(CONVERSATION_KEY, conversationId); };
}

export function chapterItem(ch) {
  const when = spanWords(ch.from, ch.to);
  return h("li", null,
    h("a", { class: "chapter-card", href: "/", "data-id": ch.id, onclick: toChat(ch.id) },
      h("span", { class: "chapter-title", text: text(ch.title) }),
      when ? h("span", { class: "chapter-when", text: when }) : null));
}

export function momentItem(m) {
  const when = capDate(m.at);
  return h("li", { class: "moment" },
    when ? h("time", { class: "moment-when", datetime: m.at, text: when }) : null,
    h("span", { class: "moment-title", text: text(m.title) }));
}

export function placeItem(p, index) {
  const first = capDate(p.first);
  const times = Math.floor(Number(p.times) || 0);
  const thumb = p.picture && p.placeId && index < PLACE_THUMBS
    ? h("img", { class: "place-thumb", src: "/media/place/" + encodeURIComponent(p.placeId), alt: "", loading: "lazy", decoding: "async" })
    : null;
  return h("li", { class: "place-together" },
    thumb,
    h("span", { class: "place-name", text: text(p.title) }),
    first ? h("span", { class: "place-first", text: "first on " + first }) : null,
    times > 1 ? h("span", { class: "place-times", text: times + " times" }) : null);
}

export function keptItem(k) {
  const when = capDate(k.at);
  return h("a", { class: "kept-quote", href: "/", "data-conversation": k.conversationId || "", onclick: toChat(k.conversationId) },
    h("blockquote", { class: "kept-text", text: text(k.text) }),
    when ? h("span", { class: "kicker kept-when", text: when }) : null);
}

function fill(holderId, sectionId, rows, build) {
  const holder = $(holderId);
  clear(holder);
  let n = 0;
  rows.forEach((row, i) => {
    if (!row || typeof row !== "object") return;
    const el = build(row, i);
    if (el) { holder.append(el); n += 1; }
  });
  showSection(sectionId, holder, n);
}

export function render(view) {
  const v = view && typeof view === "object" ? view : {};
  setLine($("usStanding"), sentenceCase(v.standing));
  const since = dayWords(v.since, nowIso());
  setLine($("usSince"), since ? "since " + since : "");
  const names = list(v.nicknames).map(text).filter(Boolean);
  setLine($("usNames"), names.join(" / "));

  fill("usChapters", "chaptersSection", list(v.chapters).filter((c) => c && text(c.title)), chapterItem);
  fill("usMoments", "momentsSection", list(v.moments).filter((m) => m && text(m.title)), momentItem);
  fill("usPlaces", "placesSection", list(v.places).filter((p) => p && text(p.title)), placeItem);
  fill("usKept", "keptSection", list(v.kept).filter((k) => k && text(k.text)), keptItem);
}

async function boot() {
  try {
    render(await api("GET", "/api/us"));
  } catch {
    // Quiet on her page: every section simply stays hidden.
  }
}

const IDS = ["usStanding", "usSince", "usNames", "chaptersSection", "usChapters", "momentsSection", "usMoments", "placesSection", "usPlaces", "keptSection", "usKept"];

if (typeof document !== "undefined" && document.querySelector("main.us-page") && IDS.every((id) => $(id))) boot();
