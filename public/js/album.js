// Album: her camera roll (SPEC_V4 section 5, A3 for the clips). One route
// (GET /api/album), Polaroid cards newest first: the picture (a link to the full size),
// the date (a tap opens the chat on that conversation), the place from the scene at the
// time, an "us" chip on a two-of-you picture, a "candidate" chip until he decides, a
// "clip" chip on a video, Save, and Approve / Reject on a candidate through the decide
// route. The filter row switches the group; Load older pages with nextBefore.
//
// Layout and the hover tilt live in the stylesheet (.polaroid with a.shot, .pfoot, .pdate,
// .chips and .pactions, and the chips .chip.place, .chip.us, .chip.candidate; owned by
// the design lane, used here by those names). This file only adds `reduced-motion` on the grid when the viewer
// prefers it, so the tilt rule can key off either the media query or the class. Nothing
// here writes a style attribute (the CSP has no unsafe-inline).
import { api, h, chip, clear, flash, storeSet } from "./api.js";

const PAGE = 100;
const GROUPS = ["all", "approved", "candidates", "us"];
// The key the chat page reads to reopen a conversation (public/js/chat.js).
const CONVERSATION_KEY = "avelie.conversation";

const $ = (id) => document.getElementById(id);

const state = {
  group: "all",
  nextBefore: null,
  loading: false,
  count: 0,
};

function encode(id) {
  return encodeURIComponent(String(id));
}

export function mediaUrl(id, download) {
  return "/media/" + encode(id) + (download ? "?download=1" : "");
}

// "Sep 25" this year, "Sep 25, 2025" otherwise; empty for an unreadable time.
export function dateLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

export function groupFromHash(hash) {
  const g = String(hash || "").replace(/^#/, "");
  return GROUPS.includes(g) ? g : "all";
}

// ------------------------------------------------------------ cards

function openChat(item) {
  if (item.conversationId) storeSet(CONVERSATION_KEY, item.conversationId);
  location.assign("/");
}

function mediaFor(item) {
  if (item.kind === "clip") {
    return h("video", {
      src: mediaUrl(item.id),
      preload: "metadata",
      playsinline: true,
      muted: true,
      "aria-label": "Clip",
    });
  }
  return h("img", {
    src: mediaUrl(item.id),
    alt: item.description || "",
    loading: "lazy",
    decoding: "async",
  });
}

function chipsFor(item) {
  const out = [];
  if (item.place) out.push(chip(item.place, "place"));
  if (item.withHim) out.push(chip("us", "us"));
  if (item.kind === "clip") out.push(chip("clip"));
  if (item.status !== "approved") out.push(chip("candidate", "candidate"));
  return out;
}

function decideButtons(item, card, slot) {
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const lock = (on) => { approve.disabled = on; reject.disabled = on; };
  const act = async (decision) => {
    lock(true);
    try {
      await api("POST", "/api/images/" + encode(item.id) + "/decide", { decision });
    } catch (e) {
      lock(false);
      flash(slot, e.code || "error", "danger");
      return;
    }
    if (decision === "approve") {
      const next = { ...item, status: "approved" };
      card.replaceWith(cardFor(next));
      flash(slot, "approved", "ok");
    } else {
      card.remove();
      state.count = Math.max(0, state.count - 1);
      if (!state.count) showEmpty();
      flash(slot, "rejected", "");
    }
  };
  approve.addEventListener("click", () => act("approve"));
  reject.addEventListener("click", () => act("reject"));
  return [approve, reject];
}

export function cardFor(item) {
  const classes = ["polaroid"];
  if (item.status !== "approved") classes.push("candidate");
  if (item.withHim) classes.push("us");
  if (item.kind === "clip") classes.push("clip");
  const card = h("article", { class: classes.join(" "), "data-id": item.id, "data-status": item.status });
  const status = $("albumStatus");

  const pic = h("a", {
    class: "shot",
    href: mediaUrl(item.id),
    target: "_blank",
    rel: "noopener",
    title: item.description || "",
    "aria-label": item.kind === "clip" ? "Open clip" : "Open full size",
  }, mediaFor(item));

  const date = h("button", {
    type: "button",
    class: "pdate",
    "aria-label": "Open the chat on " + (dateLabel(item.at) || "this day"),
    onclick: () => openChat(item),
  }, h("time", { datetime: item.at, text: dateLabel(item.at) }));

  const actions = [h("a", { class: "btn small quiet", href: mediaUrl(item.id, true), download: "", text: "Save" })];
  if (item.status !== "approved") actions.push(...decideButtons(item, card, status));

  card.append(
    pic,
    h("div", { class: "pfoot" },
      date,
      h("div", { class: "chips" }, chipsFor(item)),
      h("div", { class: "pactions" }, actions)));
  return card;
}

// ------------------------------------------------------------ paging

function showEmpty() {
  const grid = $("albumGrid");
  if (grid && !grid.querySelector(".polaroid")) {
    clear(grid);
    grid.append(chip("none"));
  }
}

function setOlder(nextBefore) {
  state.nextBefore = nextBefore || null;
  const older = $("albumOlder");
  if (older) {
    older.classList.toggle("hidden", !state.nextBefore);
    older.disabled = false;
  }
}

async function load(append) {
  if (state.loading) return;
  state.loading = true;
  const grid = $("albumGrid");
  const older = $("albumOlder");
  if (older) older.disabled = true;
  if (!append) {
    clear(grid);
    state.count = 0;
    state.nextBefore = null;
  }
  const q = new URLSearchParams({ limit: String(PAGE), group: state.group });
  if (append && state.nextBefore) q.set("before", state.nextBefore);
  try {
    const page = await api("GET", "/api/album?" + q.toString());
    const items = Array.isArray(page && page.items) ? page.items : [];
    if (!append) clear(grid);
    for (const item of items) grid.append(cardFor(item));
    state.count += items.length;
    if (!state.count) showEmpty();
    setOlder(page && page.nextBefore);
  } catch (e) {
    flash($("albumStatus"), e.code || "error", "danger");
    if (older) older.disabled = false;
  } finally {
    state.loading = false;
  }
}

function setGroup(group) {
  state.group = GROUPS.includes(group) ? group : "all";
  const filter = $("albumFilter");
  if (filter) {
    for (const b of filter.querySelectorAll("button[data-group]")) {
      const on = b.dataset.group === state.group;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  const hash = state.group === "all" ? "" : "#" + state.group;
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + hash);
  load(false);
}

function watchMotion(grid) {
  if (typeof matchMedia !== "function") return;
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => grid.classList.toggle("reduced-motion", mq.matches);
  apply();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", apply);
}

// ------------------------------------------------------------ boot

function boot() {
  const grid = $("albumGrid");
  if (!grid) return;
  grid.classList.add("album-grid");
  watchMotion(grid);
  const filter = $("albumFilter");
  if (filter) {
    filter.addEventListener("click", (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest("button[data-group]") : null;
      if (b && filter.contains(b)) setGroup(b.dataset.group);
    });
  }
  const older = $("albumOlder");
  if (older) older.addEventListener("click", () => load(true));
  window.addEventListener("hashchange", () => {
    const g = groupFromHash(location.hash);
    if (g !== state.group) setGroup(g);
  });
  setGroup(groupFromHash(location.hash));
}

if (typeof document !== "undefined" && document.querySelector("main.page.album")) boot();
