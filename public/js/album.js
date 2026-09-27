// Album: her camera roll (DESIGN_EXPERIENCE 5.4). One route, GET /api/roll, 24 at a time
// (More asks for the next 24 with &before=). Pictures of the two of you go to the Us row
// at the top; the rest are grouped by local month, each month opening on its newest
// picture edge to edge with the month set over it, the others in the edge grid under it.
// A tap opens the lightbox: the picture or the clip, the day and the place, Save and Full
// size. Nothing here decides a picture (that lives in Studio), nothing sits under a tile,
// and nothing writes a style attribute (the CSP has no unsafe-inline).
import { api, h, clear } from "./api.js";
import { monthKey, monthLabel, dayWords, tileLabel, countLabel } from "./months.js";

const ROLL = "/api/roll?limit=24";
const HASH_PAGES = 5;

const $ = (id) => document.getElementById(id);

const state = {
  items: new Map(),      // id -> roll item, every one loaded so far
  months: new Map(),     // month key -> { section, grid }
  nextBefore: null,
  loading: null,         // the page in flight, so a second ask waits on it
  count: 0,
  firstDone: false,
  openId: null,
  returnTo: null,
  hashId: null,
};

export function mediaUrl(id, download) {
  return "/media/" + encodeURIComponent(String(id)) + (download ? "?download=1" : "");
}

function nowIso() {
  return new Date().toISOString();
}

// ------------------------------------------------------------ tiles

function markLoaded(el) {
  el.classList.add("loaded");
}

function pictureFor(item) {
  if (item.kind === "clip" && !item.poster) {
    const video = h("video", { src: mediaUrl(item.id), muted: true, playsinline: true, preload: "none" });
    video.muted = true;
    // Nothing loads until it plays, so there is nothing to fade in: show the frame now.
    markLoaded(video);
    return video;
  }
  const src = item.kind === "clip" ? item.poster : mediaUrl(item.id);
  const img = h("img", { alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("load", () => markLoaded(img), { once: true });
  img.src = src;
  return img;
}

export function tileFor(item, hero) {
  const classes = ["roll-tile"];
  if (item.kind === "clip") classes.push("clip");
  if (hero) classes.push("month-hero");
  const tile = h("a", {
    class: classes.join(" "),
    href: mediaUrl(item.id),
    "data-id": item.id,
    "aria-label": tileLabel(item, nowIso()),
  }, pictureFor(item));
  if (item.kind === "clip") tile.append(h("span", { class: "play-badge", "aria-hidden": "true" }));
  if (hero) tile.append(h("span", { class: "month-over display", "aria-hidden": "true", text: monthLabel(monthKey(item.at), nowIso()) }));
  return tile;
}

function monthFor(key, first) {
  const known = state.months.get(key);
  if (known) return known;
  const label = monthLabel(key, nowIso());
  const section = h("section", { class: "gallery-section", "data-month": key, "aria-label": label || "Pictures" });
  const grid = h("div", { class: "gallery edge" });
  section.append(tileFor(first, true), grid);
  // Newest month first: before the first month on screen that is older than this one.
  const holder = $("albumMonths");
  let before = null;
  for (const other of holder.querySelectorAll("section.gallery-section[data-month]")) {
    const k = other.getAttribute("data-month") || "";
    if (key !== "" && (k === "" || k < key)) { before = other; break; }
  }
  holder.insertBefore(section, before);
  const entry = { section, grid, fresh: true };
  state.months.set(key, entry);
  return entry;
}

function place(item) {
  if (item.us) {
    $("usGrid").append(tileFor(item, false));
    $("usSection").classList.remove("hidden");
    return;
  }
  const key = monthKey(item.at);
  const entry = monthFor(key, item);
  if (entry.fresh) { entry.fresh = false; return; } // this item is the month's hero
  entry.grid.append(tileFor(item, false));
}

// ------------------------------------------------------------ paging

function showCount() {
  $("albumCount").textContent = countLabel(state.count, Boolean(state.nextBefore));
}

function setMore(nextBefore) {
  state.nextBefore = nextBefore || null;
  const more = $("albumOlder");
  more.classList.toggle("hidden", !state.nextBefore);
  more.disabled = false;
}

async function fetchPage() {
  const more = $("albumOlder");
  more.disabled = true;
  const path = state.firstDone && state.nextBefore ? ROLL + "&before=" + encodeURIComponent(state.nextBefore) : ROLL;
  try {
    const page = await api("GET", path);
    const items = Array.isArray(page && page.items) ? page.items : [];
    for (const item of items) {
      if (!item || typeof item.id !== "string" || state.items.has(item.id)) continue;
      state.items.set(item.id, item);
      place(item);
      state.count += 1;
    }
    const first = !state.firstDone;
    state.firstDone = true;
    setMore(page && page.nextBefore);
    $("albumEmpty").classList.toggle("hidden", !(first && state.count === 0));
    showCount();
    syncWalk();
    return items.length;
  } catch {
    // Quiet on her page: the More button stays, and a tap asks again.
    more.classList.remove("hidden");
    more.disabled = false;
    return 0;
  }
}

function loadPage() {
  if (!state.loading) state.loading = fetchPage().finally(() => { state.loading = null; });
  return state.loading;
}

// ------------------------------------------------------------ the lightbox

function tiles() {
  return Array.from(document.querySelectorAll("#usGrid .roll-tile, #albumMonths .roll-tile"));
}

function tileById(id) {
  return tiles().find((t) => t.getAttribute("data-id") === id) || null;
}

function isOpen() {
  return !$("lightbox").classList.contains("hidden");
}

function syncWalk() {
  if (!state.openId || !isOpen()) return;
  const list = tiles();
  const i = list.findIndex((t) => t.getAttribute("data-id") === state.openId);
  $("lbPrev").disabled = i <= 0;
  $("lbNext").disabled = i < 0 || (i >= list.length - 1 && !state.nextBefore);
  const active = document.activeElement;
  if (active instanceof HTMLButtonElement && active.disabled) $("lbClose").focus();
}

function mediaIn(item) {
  if (item.kind === "clip") {
    const video = h("video", { src: mediaUrl(item.id), controls: true, autoplay: true, playsinline: true });
    if (item.poster) video.setAttribute("poster", item.poster);
    return video;
  }
  return h("img", { src: mediaUrl(item.id), alt: tileLabel(item, nowIso()), decoding: "async" });
}

function show(id) {
  const item = state.items.get(id);
  if (!item) return false;
  state.openId = id;
  const box = $("lbMedia");
  clear(box);
  box.append(mediaIn(item));
  $("lbDate").textContent = dayWords(item.at, nowIso());
  const placeEl = $("lbPlace");
  const where = typeof item.place === "string" ? item.place.trim() : "";
  placeEl.textContent = where;
  placeEl.classList.toggle("hidden", !where);
  const save = $("lbSave");
  save.setAttribute("href", mediaUrl(item.id, true));
  save.setAttribute("download", "");
  $("lbOpen").setAttribute("href", mediaUrl(item.id));
  syncWalk();
  return true;
}

function open(id, from) {
  const lb = $("lightbox");
  const wasOpen = isOpen();
  if (!wasOpen) state.returnTo = from || tileById(id) || document.activeElement;
  if (!show(id)) return;
  if (!wasOpen) {
    lb.classList.remove("hidden");
    $("lbClose").focus();
  }
  syncWalk();
}

function close() {
  if (!isOpen()) return;
  $("lightbox").classList.add("hidden");
  clear($("lbMedia")); // stops a clip
  const back = (state.openId && tileById(state.openId)) || state.returnTo;
  state.openId = null;
  state.returnTo = null;
  if (state.hashId && location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
    state.hashId = null;
  }
  if (back && typeof back.focus === "function") back.focus();
}

async function step(dir) {
  if (!state.openId) return;
  let list = tiles();
  let i = list.findIndex((t) => t.getAttribute("data-id") === state.openId);
  if (i < 0) return;
  if (dir > 0 && i >= list.length - 1) {
    if (!state.nextBefore) return;
    await loadPage();
    list = tiles();
    i = list.findIndex((t) => t.getAttribute("data-id") === state.openId);
    if (i < 0 || i >= list.length - 1) return;
  }
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const id = list[j].getAttribute("data-id");
  if (id) show(id);
}

function focusables() {
  return Array.from($("lightbox").querySelectorAll("button:not([disabled]), a[href], video[controls]"))
    .filter((el) => !el.classList.contains("hidden"));
}

function onKey(ev) {
  if (!isOpen()) return;
  if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
  if (ev.key === "ArrowLeft") { ev.preventDefault(); step(-1); return; }
  if (ev.key === "ArrowRight") { ev.preventDefault(); step(1); return; }
  if (ev.key !== "Tab") return;
  const list = focusables();
  if (!list.length) { ev.preventDefault(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const inside = $("lightbox").contains(document.activeElement);
  if (ev.shiftKey && (document.activeElement === first || !inside)) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && (document.activeElement === last || !inside)) { ev.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------ #<id> from the phone

function hashId() {
  const raw = String(location.hash || "").replace(/^#/, "");
  if (!raw) return "";
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function openFromHash() {
  const id = hashId();
  if (!id) return;
  let pages = 0;
  while (!state.items.has(id) && state.nextBefore && pages < HASH_PAGES) {
    pages += 1;
    const got = await loadPage();
    if (!got) break;
  }
  if (!state.items.has(id)) return;
  state.hashId = id;
  const tile = tileById(id);
  if (tile && typeof tile.scrollIntoView === "function") tile.scrollIntoView({ block: "center" });
  open(id, tile);
}

// ------------------------------------------------------------ boot

function onTileClick(ev) {
  const target = ev.target instanceof Element ? ev.target.closest("a.roll-tile") : null;
  if (!target) return;
  // A middle click or a new-tab gesture keeps the plain link.
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const id = target.getAttribute("data-id");
  if (!id || !state.items.has(id)) return;
  ev.preventDefault();
  open(id, target);
}

async function boot() {
  const main = document.querySelector("main.page.album");
  main.addEventListener("click", onTileClick);
  $("albumOlder").addEventListener("click", () => loadPage());
  const lb = $("lightbox");
  $("lbClose").addEventListener("click", close);
  $("lbPrev").addEventListener("click", () => step(-1));
  $("lbNext").addEventListener("click", () => step(1));
  lb.addEventListener("click", (ev) => { if (ev.target === lb) close(); });
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", () => { openFromHash(); });
  await loadPage();
  await openFromHash();
}

const IDS = ["albumCount", "usSection", "usGrid", "albumMonths", "albumEmpty", "albumOlder", "lightbox", "lbClose", "lbPrev", "lbNext", "lbMedia", "lbDate", "lbPlace", "lbSave", "lbOpen"];

if (typeof document !== "undefined" && document.querySelector("main.page.album") && IDS.every((id) => $(id))) boot();

