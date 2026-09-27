// Memory (SPEC_V4 section 7): what she remembers about him, drawn. One read of
// GET /api/memory/map. v5 (SPEC_V5 sections 3, 7, 9) adds her read of him (#memoryViews,
// each with "not true"), his ears (#memoryArtists, each with Remove) and the guess chip on
// an inferred fact; those two buttons are the only writes here. The shell and the ids are the design lane's
// (public/memory.html), and so are the classes app.css draws, used here by their names:
//   .memory-legend                   the four phase chips (chip.phase-<phase>)
//   .memory-field                    the field of facts about him (and the sealed ones)
//   a.tile.low|mid|high              a fact tile, sized by weight
//   .tile.phase-<phase>              shaded by phase (vivid, firm, fading, faded)
//   .tile .subject / .text / .tile-foot (the "back" chip rides in the foot)
//   .tile.envelope                   an untold fact, closed: the subject and a "sealed" chip
//   .mem-list / .mem-row             the fading and returned lists (.text, .age)
//   .mem-timeline / .mem-node        the history line and its nodes (.title, .when)
//   .kept-row                        kept automatically today (kind chip, .text, .when)
//   .view-row                        one read of him (.text, .progress meter, chips, "not true")
//   .artist-row                      one artist on his list (name, Remove)
//   .chip.guess                      an inferred fact (her guess, not his words)
// Any run-time value goes through data attributes and classes; no style attribute.
import { api, h, clear, chip, flash, fmtDate, fmtTime, ago, truncate, parseJson, storeSet } from "./api.js";

const PHASES = ["vivid", "firm", "fading", "faded"];
// The weight bands of src/memory.ts (LOW_WEIGHT_MAX 0.34, HIGH_WEIGHT_MIN 0.67).
const LOW_MAX = 0.34;
const HIGH_MIN = 0.67;
const STATE_MEMORY = "/state#memory";
const TEXT_MAX = 160;
// The key the chat page reads to reopen a conversation (public/js/chat.js).
const CONVERSATION_KEY = "avelie.conversation";
const VIEW_STATUS = { active: ["active", "ok"], proven_wrong: ["proven wrong", "amber"], retired: ["retired", ""] };

// Guarded so the module can be imported under Node (a test) without a document.
const $ = (id) => (typeof document === "undefined" ? null : document.getElementById(id));
const els = {
  status: $("memoryStatus"),
  legend: $("memoryLegend"),
  facts: $("memoryFacts"),
  fading: $("memoryFading"),
  returned: $("memoryReturned"),
  history: $("memoryHistory"),
  sealed: $("memorySealed"),
  kept: $("memoryKept"),
  views: $("memoryViews"),
  artists: $("memoryArtists"),
};

function phaseOf(v) {
  return PHASES.includes(v) ? v : "faded";
}

function sizeOf(weight) {
  const w = Number(weight);
  if (!Number.isFinite(w) || w < LOW_MAX) return "low";
  if (w < HIGH_MIN) return "mid";
  return "high";
}

function listOf(r, key) {
  return r && Array.isArray(r[key]) ? r[key] : [];
}

function none(el) {
  el.append(h("div", { class: "list-row" }, chip("none")));
}

function fill(el, rows, render) {
  if (!el) return;
  clear(el);
  if (!rows.length) { none(el); return; }
  for (const r of rows) el.append(render(r));
}

// "Sep 4" for an ISO date; the row's own words when it is not one (occurred is free text).
function whenLabel(value) {
  if (!value) return "";
  const d = fmtDate(value);
  return d || String(value);
}

function scoreLabel(f) {
  const s = Number(f.score);
  return Number.isFinite(s) ? s.toFixed(2) : "";
}

// ------------------------------------------------------------ legend

function renderLegend(m) {
  const box = els.legend;
  if (!box) return;
  box.classList.add("memory-legend");
  clear(box);
  const counts = m.counts || {};
  for (const p of PHASES) box.append(chip(p + " " + (Number(counts[p]) || 0), "phase-" + p));
  if (Number(counts.returned) > 0) box.append(chip("back " + counts.returned, "back"));
  if (m.settings && m.settings.memoryDecayEnabled === false) box.append(chip("decay off", "amber"));
}

// ------------------------------------------------------------ the field

function tile(f) {
  const phase = phaseOf(f.phase);
  const size = sizeOf(f.weight);
  const el = h("a", {
    class: "tile " + size + " phase-" + phase + (f.returned ? " returned" : ""),
    href: STATE_MEMORY,
    "data-id": String(f.id || ""),
    "data-phase": phase,
    "data-size": size,
    title: [phase, scoreLabel(f), f.lastTouched ? ago(f.lastTouched) : ""].filter(Boolean).join(" "),
  });
  if (f.subject) el.append(h("span", { class: "subject", text: String(f.subject) }));
  el.append(h("span", { class: "text", text: truncate(String(f.text || ""), TEXT_MAX) }));
  el.append(h("span", { class: "tile-foot" },
    h("span", { text: f.lastTouched ? ago(f.lastTouched) : "" }),
    f.inferred === true ? chip("guess", "guess") : null,
    f.returned ? chip("back", "back") : null));
  return el;
}

function renderFacts(facts) {
  const box = els.facts;
  if (!box) return;
  box.classList.add("memory-field");
  fill(box, facts, tile);
}

// ------------------------------------------------------------ fading and returned

function factRow(f, extraChip) {
  const phase = phaseOf(f.phase);
  return h("a", { class: "mem-row phase-" + phase, href: STATE_MEMORY, "data-id": String(f.id || "") },
    h("span", { class: "text" },
      chip(phase, "phase-" + phase),
      extraChip || null,
      f.subject ? h("span", { class: "subject", text: " " + String(f.subject) + " " }) : " ",
      h("span", { text: truncate(String(f.text || ""), TEXT_MAX) })),
    h("span", { class: "age", text: f.lastTouched ? ago(f.lastTouched) : "", title: f.lastTouched || "" }));
}

function renderFading(facts) {
  if (els.fading) els.fading.classList.add("mem-list");
  const rows = facts.filter((f) => f.phase === "fading" || f.phase === "faded");
  fill(els.fading, rows, (f) => factRow(f, null));
}

function renderReturned(facts) {
  if (els.returned) els.returned.classList.add("mem-list");
  const rows = facts.filter((f) => f.returned === true);
  fill(els.returned, rows, (f) => factRow(f, chip("back", "back")));
}

// ------------------------------------------------------------ the history timeline

// The node's dot is the stylesheet's (.mem-node::before); the node carries the phase class.
function node(e) {
  const phase = phaseOf(e.phase);
  return h("div", { class: "mem-node phase-" + phase, "data-id": String(e.id || ""), "data-seq": String(Number(e.seq) || 0) },
    h("span", { class: "when" }, h("span", { text: whenLabel(e.occurred) || whenLabel(e.createdAt) }), " ", chip(phase, "phase-" + phase)),
    h("span", { class: "title", text: String(e.title || "") }));
}

function renderHistory(history) {
  const box = els.history;
  if (!box) return;
  box.classList.add("mem-timeline");
  const rows = history.slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  fill(box, rows, node);
}

// ------------------------------------------------------------ sealed

// A closed envelope per untold fact (.tile.envelope; the flap is the stylesheet's): the
// subject only. Nothing opens it.
function envelope(s) {
  return h("div", { class: "tile envelope", "data-id": String(s.id || "") },
    h("span", { class: "subject", text: String(s.subject || "(untitled)") }),
    h("span", { class: "tile-foot" }, chip("sealed", "sealed")));
}

function renderSealed(sealed) {
  const box = els.sealed;
  if (!box) return;
  box.classList.add("memory-field");
  fill(box, sealed, envelope);
}

// ------------------------------------------------------------ kept today

function keptRow(p) {
  return h("div", { class: "kept-row", "data-id": String(p.id || "") },
    chip(String(p.kind || "").replace(/_/g, " "), "accent"),
    h("span", { class: "text", text: truncate(String(p.proposal || ""), 200) }),
    h("span", { class: "when", text: fmtTime(p.decidedAt) }));
}

function renderKept(kept) {
  fill(els.kept, kept, keptRow);
}

// ------------------------------------------------------------ her read of him (v5 section 3)

function meter(value) {
  const v = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
  const fill = h("span");
  // CSSOM, never a style attribute (the CSP has no style-src 'unsafe-inline').
  fill.style.width = v + "%";
  return h("div", { class: "progress", role: "progressbar", "aria-label": "Confidence", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(v) }, fill);
}

// The evidence chip opens the chat on the conversation of the first evidence message.
function evidenceChip(ids) {
  const n = ids.length;
  if (!n) return chip("0 evidence");
  const btn = h("button", { type: "button", class: "btn small quiet evidence", text: n + " evidence" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const m = await api("GET", "/api/messages/" + encodeURIComponent(String(ids[0])));
      if (m && m.conversation_id) storeSet(CONVERSATION_KEY, m.conversation_id);
      location.href = "/";
    } catch (e) {
      btn.disabled = false;
      btn.replaceWith(chip(e.code || "error", "danger"));
    }
  });
  return btn;
}

function viewRow(v) {
  const status = VIEW_STATUS[v.status] || [String(v.status || ""), ""];
  const evidence = parseJson(v.evidence_json, []);
  const ids = Array.isArray(evidence) ? evidence.filter((x) => typeof x === "string" && x) : [];
  const slot = h("span", { class: "chips" });
  const notTrue = v.status === "active"
    ? h("button", { type: "button", class: "btn small danger quiet", text: "not true" })
    : null;
  if (notTrue) {
    notTrue.addEventListener("click", async () => {
      notTrue.disabled = true;
      try {
        await api("POST", "/api/views/" + encodeURIComponent(String(v.id)) + "/retire", {});
        load();
      } catch (e) {
        notTrue.disabled = false;
        flash(slot, e.code || "error", "danger");
      }
    });
  }
  return h("div", { class: "view-row status-" + String(v.status || "").replace(/[^a-z_]/g, ""), "data-id": String(v.id || "") },
    h("span", { class: "text", text: String(v.view || "") }),
    meter(v.confidence),
    h("span", { class: "chips" },
      chip(status[0], status[1]),
      v.subject ? chip(String(v.subject)) : null,
      h("span", { class: "when", text: v.updated_at ? ago(v.updated_at) : "" })),
    h("span", { class: "row" }, evidenceChip(ids), notTrue, slot));
}

function renderViews(views) {
  // Superseded versions are history, not reads: the page shows what she holds and what fell.
  const rows = views.filter((v) => v && v.status !== "superseded");
  const order = { active: 0, proven_wrong: 1, retired: 2 };
  rows.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
  fill(els.views, rows, viewRow);
}

// ------------------------------------------------------------ his ears (v5 section 9)

function artistRow(a) {
  const slot = h("span", { class: "chips" });
  const remove = h("button", { type: "button", class: "btn small ghost", text: "Remove" });
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      await api("DELETE", "/api/known-artists/" + encodeURIComponent(String(a.id)));
      load();
    } catch (e) {
      remove.disabled = false;
      flash(slot, e.code || "error", "danger");
    }
  });
  return h("div", { class: "artist-row", "data-id": String(a.id || "") },
    h("span", { class: "text", text: String(a.artist || "") }),
    a.source ? chip(String(a.source)) : null,
    remove, slot);
}

function renderArtists(k) {
  const box = els.artists;
  if (!box) return;
  clear(box);
  const known = k && Array.isArray(k.known) ? k.known : [];
  const disliked = k && Array.isArray(k.disliked) ? k.disliked : [];
  for (const [label, rows, kind] of [["known", known, "accent"], ["not for me", disliked, "amber"]]) {
    const list = h("div", { class: "artist-list" });
    fill(list, rows, artistRow);
    box.append(h("div", { class: "stack tight" }, h("div", { class: "chips" }, chip(label + " " + rows.length, kind)), list));
  }
}

// ------------------------------------------------------------ load

function render(m) {
  const facts = listOf(m, "facts");
  renderLegend(m);
  renderFacts(facts);
  renderFading(facts);
  renderReturned(facts);
  renderHistory(listOf(m, "history"));
  renderSealed(listOf(m, "sealed"));
  renderKept(listOf(m, "keptToday"));
  renderViews(listOf(m, "views"));
  renderArtists(m.knownArtists);
}

export async function load() {
  let m;
  try {
    m = await api("GET", "/api/memory/map");
  } catch (e) {
    flash(els.status, e.code || "error", "danger");
    return null;
  }
  clear(els.status);
  render(m || {});
  return m;
}

if (typeof document !== "undefined") load();
