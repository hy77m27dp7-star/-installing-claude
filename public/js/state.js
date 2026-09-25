// State: the approved record. Now, Life, Wants, History, Facts, Memory, Voice, Notes,
// Unknowns, Inbox, Rulebook, Export.
import { api, h, chip, clear, download, flash, flagCodes, fmtDate, fmtTime, fromLocalInput, parseJson, today, toLocalInput, ago, truncate } from "./api.js";

const $ = (id) => document.getElementById(id);
const TABS = ["now", "life", "wants", "history", "facts", "memory", "voice", "notes", "unknowns", "inbox", "rulebook", "export"];
const KINDS = ["avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown", "life", "life_update", "want", "want_update", "ask", "ask_update", "grounding"];
const LIFE_KINDS = [["routine", "Routines"], ["event", "Events"], ["person", "People"], ["place", "Places"], ["arc", "Arcs"]];
// Monday first on screen; the numbers follow JavaScript's getDay (Sunday = 0).
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NUMS = [1, 2, 3, 4, 5, 6, 0];
const OPINION_RE = /^\s*opinion\b/i;
// Weights the owner sets by hand (SPEC_V3 BB): Low, Mid, High.
const WEIGHT_STEPS = [["0.2", "Low"], ["0.5", "Mid"], ["0.9", "High"]];
const WEIGHTED_THREADS = new Set(["person", "place", "arc"]);
const FADED_BELOW = 0.2;
// The voice bank's tag vocabulary (SPEC_V3 AA); the server refuses anything else.
const VOICE_TAGS = ["stranger", "familiar", "banter", "dry", "warm", "flirt", "annoyed", "after_friction", "repair", "tired", "sad", "excited", "morning", "day", "evening", "late", "apart", "together", "answering", "decline", "no", "own_day", "ask", "photo_ask", "photo_send", "song_send", "one_word", "fragment", "lowercase", "typo_fix"];
const KIND_WORD = { ai: "not how you talk", clever: "too clever", not_her: "not you", too_long: "too long", too_nice: "too nice", too_polished: "too polished", other: "note" };
const MAX_DECIDE_IDS = 500;

const loaders = {
  now: loadNow,
  life: loadLife,
  wants: loadWants,
  history: loadHistory,
  facts: loadFacts,
  memory: loadMemory,
  voice: loadVoice,
  notes: loadNotes,
  unknowns: loadUnknowns,
  inbox: loadInbox,
  rulebook: loadRulebook,
  export: loadExport,
};

function status(tab) {
  return $(tab + "-status");
}

function encode(id) {
  return encodeURIComponent(String(id));
}

function orNull(value) {
  const v = String(value ?? "").trim();
  return v ? v : null;
}

function confirmLabel(label) {
  return window.confirm(label);
}

function listOf(r, keys) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === "object") for (const k of keys) if (Array.isArray(r[k])) return r[k];
  return [];
}

// A group of filter chips: one pressed at a time, the value read from data-<attr>.
function filterGroup(id, attr, onPick) {
  const box = $(id);
  const buttons = [...box.querySelectorAll("button")];
  const pick = (value) => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
    onPick(value);
  };
  for (const b of buttons) b.addEventListener("click", () => pick(b.dataset[attr]));
  return { pick };
}

// ------------------------------------------------------------ tabs

function showTab(name) {
  if (name === "timeline") name = "history";
  if (!TABS.includes(name)) name = "now";
  for (const t of TABS) $("tab-" + t).classList.toggle("hidden", t !== name);
  document.querySelectorAll(".tabs button").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  loaders[name]();
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------ Now

const EDITORS = [
  { entity: "relationship", json: "relJson", version: "relVersion", note: "relNote", save: "relSave", status: "relStatus", versions: "relVersions" },
  { entity: "scene", json: "sceneJson", version: "sceneVersion", note: "sceneNote", save: "sceneSave", status: "sceneStatus", versions: "sceneVersions" },
];

let settingsCache = null;

async function loadSettingsOnce() {
  if (settingsCache) return settingsCache;
  try { settingsCache = await api("GET", "/api/settings"); } catch { settingsCache = {}; }
  return settingsCache;
}

async function loadNow() {
  try {
    const [bundle] = await Promise.all([api("GET", "/api/state"), loadSettingsOnce()]);
    for (const ed of EDITORS) {
      fillEditor(ed, bundle[ed.entity]);
      loadVersions(ed);
    }
    fillMood(bundle.relationship && bundle.relationship.state ? bundle.relationship.state : {}, bundle.relationship);
  } catch (e) {
    flash(status("now"), e.code, "danger");
  }
  loadChecks();
}

function fillEditor(ed, cur) {
  const ta = $(ed.json);
  ta.value = JSON.stringify(cur.state, null, 2);
  ta.dataset.version = String(cur.version);
  $(ed.version).textContent = "v" + cur.version;
}

async function loadVersions(ed) {
  const box = $(ed.versions);
  clear(box);
  let rows = [];
  try {
    rows = await api("GET", "/api/state/versions/" + ed.entity);
  } catch (e) {
    box.append(chip(e.code, "danger"));
    return;
  }
  const current = Number($(ed.json).dataset.version);
  if (!rows.length) box.append(chip("none"));
  for (const v of rows) {
    const restore = h("button", {
      type: "button",
      class: "btn small",
      text: "Restore",
      disabled: v.version === current,
      onclick: async () => {
        restore.disabled = true;
        try {
          await api("POST", "/api/state/restore", { entity: ed.entity, version: v.version });
          flash($(ed.status), "restored v" + v.version, "ok");
          loadNow();
        } catch (e) {
          restore.disabled = false;
          flash($(ed.status), e.code, "danger");
        }
      },
    });
    box.append(h("div", { class: "row version-row" },
      chip("v" + v.version, v.version === current ? "accent" : ""),
      h("span", { class: "muted small", text: fmtTime(v.created_at) }),
      v.source ? chip(v.source) : null,
      h("span", { class: "grow small", text: v.note || "" }),
      restore));
  }
}

for (const ed of EDITORS) {
  $(ed.save).addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse($(ed.json).value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
    } catch {
      flash($(ed.status), "invalid JSON", "danger");
      return;
    }
    const btn = $(ed.save);
    btn.disabled = true;
    try {
      const note = orNull($(ed.note).value);
      const r = await api("PUT", "/api/state/" + ed.entity, note ? { state: parsed, note } : { state: parsed });
      fillEditor(ed, r);
      $(ed.note).value = "";
      flash($(ed.status), "saved v" + r.version, "ok");
      loadVersions(ed);
      if (ed.entity === "relationship") fillMood(r.state || {}, r);
    } catch (e) {
      flash($(ed.status), e.code, "danger");
    } finally {
      btn.disabled = false;
    }
  });
}

// The mood phase the prompt sees (SPEC_V3 CC, moodNow): t = age / mood_days.
function moodPhase(st, versionCreatedAt) {
  if (!st || !st.mood) return null;
  const setAt = Date.parse(st.mood_set_at || versionCreatedAt || "");
  if (!Number.isFinite(setAt)) return "fresh";
  const days = Number(st.mood_days) || Number(settingsCache && settingsCache.moodDaysDefault) || 3;
  const t = (Date.now() - setAt) / (days * 86400000);
  if (t < 0.5) return "fresh";
  if (t < 1) return "fading";
  if (t < 2) return "faint";
  return "gone";
}

// Mood, mood days and cooling off: fields of the relationship state with their own controls.
function fillMood(st, version) {
  $("moodInput").value = st.mood ? String(st.mood) : "";
  $("moodDays").value = st.mood_days !== undefined && st.mood_days !== null ? String(st.mood_days) : "";
  $("coolInput").value = toLocalInput(st.cooling_off_until || null);
  const chips = $("moodChips");
  clear(chips);
  const phase = moodPhase(st, version && version.created_at);
  if (phase) chips.append(chip(phase, phase === "gone" ? "" : phase === "fresh" ? "amber" : "accent"));
  const until = st.cooling_off_until ? Date.parse(st.cooling_off_until) : NaN;
  if (Number.isFinite(until) && until > Date.now()) chips.append(chip("cooling off", "amber"));
}

// `patch` overwrites fields; `remove` drops them from the state (a cleared mood takes
// mood_set_at and mood_days with it; the server sets mood_set_at again on the next mood).
async function saveMood(patch, remove, note) {
  const slot = $("moodStatus");
  $("moodSave").disabled = true;
  $("moodClear").disabled = true;
  try {
    const bundle = await api("GET", "/api/state");
    const cur = bundle.relationship && bundle.relationship.state ? bundle.relationship.state : {};
    const next = { ...cur, ...patch };
    for (const k of remove) delete next[k];
    const r = await api("PUT", "/api/state/relationship", { state: next, note });
    fillEditor(EDITORS[0], r);
    fillMood(r.state || next, r);
    flash(slot, "saved v" + r.version, "ok");
    loadVersions(EDITORS[0]);
  } catch (e) {
    flash(slot, e.code, "danger");
  } finally {
    $("moodSave").disabled = false;
    $("moodClear").disabled = false;
  }
}

$("moodSave").addEventListener("click", () => {
  const daysRaw = $("moodDays").value.trim();
  const days = daysRaw ? Number(daysRaw) : null;
  if (daysRaw && (!Number.isInteger(days) || days < 1 || days > 14)) { flash($("moodStatus"), "mood days 1 to 14", "danger"); return; }
  const patch = { mood: orNull($("moodInput").value), cooling_off_until: fromLocalInput($("coolInput").value) };
  if (days !== null) patch.mood_days = days;
  saveMood(patch, days === null ? ["mood_days"] : [], "mood");
});
$("moodClear").addEventListener("click", () => {
  $("moodInput").value = "";
  $("moodDays").value = "";
  saveMood({ mood: null }, ["mood_set_at", "mood_days"], "clear");
});

// The checker chips live here, small and muted: the latest flagged replies.
async function loadChecks() {
  const box = $("checksList");
  clear(box);
  try {
    const convs = await api("GET", "/api/conversations");
    const c = (Array.isArray(convs) ? convs : []).find((x) => x.status === "active") || (Array.isArray(convs) ? convs[0] : null);
    if (!c) { box.append(h("div", { class: "chips" }, chip("none"))); return; }
    const rows = await api("GET", "/api/conversations/" + encode(c.id) + "/messages?channel=story&limit=80");
    const flagged = (Array.isArray(rows) ? rows : []).filter((m) => m.role === "assistant" && flagCodes(m.flags_json).length).slice(-12).reverse();
    if (!flagged.length) { box.append(h("div", { class: "chips" }, chip("clean", "ok"))); return; }
    for (const m of flagged) {
      box.append(h("div", { class: "check-row" },
        h("span", { text: fmtTime(m.created_at) }),
        h("span", { class: "chips" }, flagCodes(m.flags_json).map((code) => chip(code, "flag"))),
        h("span", { class: "snippet", text: String(m.content || "").slice(0, 90) })));
    }
  } catch (e) {
    box.append(h("div", { class: "chips" }, chip(e.code, "danger")));
  }
}

// ------------------------------------------------------------ weights (shared by Life, Facts, History, Memory)

// GET /api/memory?entity= as a map id -> row; null when the route is not there yet.
async function loadWeightMap(entity) {
  try {
    const r = await api("GET", "/api/memory?entity=" + encodeURIComponent(entity) + "&limit=500");
    const rows = listOf(r, ["rows", "items", "memory"]);
    const map = new Map();
    for (const row of rows) {
      const id = row.entityId || row.entity_id || row.id;
      if (id) map.set(String(id), row);
    }
    return map;
  } catch {
    return null;
  }
}

function weightValue(row) {
  const w = row && Number(row.weight);
  return Number.isFinite(w) ? w : null;
}

// Low / Mid / High, or the stored number when it is none of those.
function weightSelect(entity, id, row, slot, onSaved) {
  const current = weightValue(row);
  const sel = h("select", { "aria-label": "Weight" });
  const known = WEIGHT_STEPS.map(([v]) => Number(v));
  if (current !== null && !known.includes(current)) sel.append(h("option", { value: String(current), text: current.toFixed(2) }));
  for (const [v, label] of WEIGHT_STEPS) sel.append(h("option", { value: v, text: label }));
  sel.value = current !== null ? String(current) : "0.5";
  sel.addEventListener("change", async () => {
    sel.disabled = true;
    try {
      const r = await api("PUT", "/api/memory/" + encodeURIComponent(entity) + "/" + encode(id), { weight: Number(sel.value) });
      if (onSaved) onSaved(r);
    } catch (e) {
      flash(slot, e.code, "danger");
    } finally {
      sel.disabled = false;
    }
  });
  return h("span", { class: "weight-inline" }, "weight", sel);
}

// ------------------------------------------------------------ Life

let lifeStatus = "active";
let lifeTz = "America/New_York";
let lifeData = { threads: [], log: [] };
let threadWeights = null;
let portraitCandidates = new Map();
const portraitPending = new Set();

function setLifeStatus(s) {
  lifeStatus = s;
  $("lifeActive").setAttribute("aria-pressed", String(s === "active"));
  $("lifeDropped").setAttribute("aria-pressed", String(s === "dropped"));
  loadLife();
}

$("lifeActive").addEventListener("click", () => setLifeStatus("active"));
$("lifeDropped").addEventListener("click", () => setLifeStatus("dropped"));

async function loadLife() {
  const box = $("lifeGroups");
  clear(box);
  try {
    const [r, settings, weights, assets] = await Promise.all([
      api("GET", "/api/life?status=" + lifeStatus),
      loadSettingsOnce(),
      loadWeightMap("thread"),
      api("GET", "/api/assets").catch(() => null),
    ]);
    if (settings && typeof settings.timezone === "string" && settings.timezone) lifeTz = settings.timezone;
    lifeData = { threads: Array.isArray(r.threads) ? r.threads : [], log: Array.isArray(r.log) ? r.log : [] };
    threadWeights = weights;
    portraitCandidates = portraitMap(assets);
  } catch (e) {
    flash(status("life"), e.code, "danger");
    return;
  }
  for (const [kind, label] of LIFE_KINDS) box.append(lifeGroup(kind, label, lifeData.threads.filter((t) => t.kind === kind)));
  renderLog();
  loadToday();
}

// Portrait candidates by person: rows with role portrait whose notes name the thread.
function portraitMap(assets) {
  const map = new Map();
  if (!assets || typeof assets !== "object") return map;
  const seen = new Set();
  for (const list of Object.values(assets)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || !a.id || seen.has(a.id)) continue;
      seen.add(a.id);
      if (a.role !== "portrait" && !/^person:/.test(String(a.notes || ""))) continue;
      const m = /^person:([^|\s]+)/.exec(String(a.notes || ""));
      if (!m) continue;
      const list2 = map.get(m[1]) || [];
      list2.push(a);
      map.set(m[1], list2);
    }
  }
  return map;
}

function lifeGroup(kind, label, rows) {
  const list = h("div", null);
  const add = h("button", {
    type: "button", class: "btn small", text: "Add",
    onclick: () => {
      add.disabled = true;
      list.prepend(h("div", { class: "thread-row" }, h("div", { class: "editor" }, threadEditor({ kind }, () => { add.disabled = false; loadLife(); }))));
    },
  });
  if (!rows.length) list.append(h("div", { class: "chips" }, chip("none")));
  for (const t of rows) list.append(threadRow(t));
  return h("div", { class: "card stack tight" },
    h("div", { class: "row between" }, h("h2", { class: "section-title", text: label }), lifeStatus === "active" ? add : null),
    list);
}

function dayNames(days) {
  if (!Array.isArray(days) || !days.length) return "";
  return DAY_NUMS.filter((n) => days.includes(n)).map((n) => DAY_LABELS[DAY_NUMS.indexOf(n)]).join(" ");
}

function threadSummary(t) {
  const s = parseJson(t.schedule_json, null);
  const parts = [];
  if (t.kind === "routine" && s && Array.isArray(s.blocks)) {
    for (const b of s.blocks) parts.push(chip([dayNames(b.days), (b.start || "") + "-" + (b.end || ""), b.label || ""].filter(Boolean).join(" ")));
  }
  if (t.kind === "event" && s) {
    if (s.at) parts.push(chip(fmtTime(s.at), "accent"));
    if (s.label) parts.push(chip(s.label));
  }
  if (t.kind === "person" && t.relation) parts.push(chip(t.relation, "accent"));
  return parts;
}

function threadRow(t) {
  const editor = h("div", { class: "editor hidden" });
  const slot = h("span", { class: "chips" });
  const edit = h("button", {
    type: "button", class: "btn small", text: "Edit",
    onclick: () => {
      if (!editor.classList.contains("hidden")) { editor.classList.add("hidden"); clear(editor); return; }
      clear(editor);
      editor.append(threadEditor(t, () => loadLife(), () => { editor.classList.add("hidden"); clear(editor); }));
      editor.classList.remove("hidden");
    },
  });
  const dropped = t.status === "dropped";
  const toggle = h("button", {
    type: "button", class: dropped ? "btn small" : "btn small danger", text: dropped ? "Restore" : "Drop",
    onclick: async () => {
      if (!dropped && !confirmLabel("Drop?")) return;
      toggle.disabled = true;
      try {
        if (dropped) await api("POST", "/api/life/threads/" + encode(t.id) + "/restore", {});
        else await api("DELETE", "/api/life/threads/" + encode(t.id));
        loadLife();
      } catch (e) {
        toggle.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  const summary = threadSummary(t);
  const weighted = threadWeights && WEIGHTED_THREADS.has(t.kind) && t.status === "active";
  return h("div", { class: "thread-row" },
    h("div", { class: "t" }, t.title, " ", h("span", { class: "chips" }, summary, chip("v" + t.version), t.status !== "active" ? chip(t.status, "amber") : null)),
    h("div", { class: "actions" }, edit, toggle, slot),
    t.detail ? h("div", { class: "d", text: t.detail }) : null,
    weighted ? h("div", { class: "d" }, weightSelect("thread", t.id, threadWeights.get(String(t.id)), slot)) : null,
    t.kind === "person" && t.status === "active" ? portraitBlock(t, slot) : null,
    editor);
}

// The person's face: the approved portrait, a candidate to decide, or the field to make one.
function portraitBlock(t, slot) {
  const approvedId = t.portrait_asset_id ? String(t.portrait_asset_id) : "";
  const candidates = (portraitCandidates.get(String(t.id)) || []).filter((a) => a.approval_status === "candidate" && a.id !== approvedId);
  const pending = portraitPending.has(t.id);
  const controls = h("div", { class: "controls" });
  let face;
  if (pending) {
    face = h("span", { class: "face pending", "aria-label": "Portrait pending" });
  } else if (candidates.length) {
    const c = candidates[0];
    face = h("img", { class: "face", src: "/media/" + encode(c.id), alt: "" });
    const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
    const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
    const act = async (decision) => {
      approve.disabled = true;
      reject.disabled = true;
      try {
        await api("POST", "/api/images/" + encode(c.id) + "/decide", { decision });
        loadLife();
      } catch (e) {
        approve.disabled = false;
        reject.disabled = false;
        flash(slot, e.code, "danger");
      }
    };
    approve.addEventListener("click", () => act("approve"));
    reject.addEventListener("click", () => act("reject"));
    controls.append(h("div", { class: "row" }, chip("candidate", "amber"), approve, reject));
  } else if (approvedId) {
    face = h("img", { class: "face", src: "/media/" + encode(approvedId), alt: "" });
    const form = makePortraitForm(t, slot);
    form.classList.add("hidden");
    controls.append(h("div", { class: "row" }, chip("portrait", "ok"), h("button", { type: "button", class: "btn small", text: "Replace", onclick: () => form.classList.toggle("hidden") })), form);
  } else {
    face = h("span", { class: "face empty", "aria-hidden": "true", text: (t.title || "?").slice(0, 1) });
    controls.append(makePortraitForm(t, slot));
  }
  return h("div", { class: "portrait" }, face, controls);
}

function makePortraitForm(t, slot) {
  const desc = h("input", { type: "text", placeholder: "Description", maxlength: "500", "aria-label": "Portrait description" });
  const make = h("button", {
    type: "button", class: "btn small", text: "Make portrait",
    onclick: async () => {
      const description = desc.value.trim();
      if (!description) { flash(slot, "description", "danger"); return; }
      make.disabled = true;
      portraitPending.add(t.id);
      loadLife();
      try {
        // Held open like a photo: the page waits for the whole image call.
        await api("POST", "/api/life/threads/" + encode(t.id) + "/portrait", { description });
      } catch (e) {
        flash(status("life"), e.code + (e.detail && typeof e.detail === "string" ? " " + e.detail : ""), "danger");
      } finally {
        portraitPending.delete(t.id);
        loadLife();
      }
    },
  });
  return h("div", { class: "row" }, h("span", { class: "grow" }, desc), make);
}

// One editor for every kind; the fields change with the kind.
function threadEditor(t, done, cancel) {
  const kind = t.kind;
  const slot = h("span", { class: "chips" });
  const title = h("input", { type: "text", placeholder: kind === "person" ? "Name" : "Title", maxlength: "200", value: t.title || "" });
  const detailPlaceholder = { person: "Status", place: "What it looks like", arc: "Where it stands", event: "Detail", routine: "Detail" }[kind] || "Detail";
  const detail = h("textarea", { placeholder: detailPlaceholder, maxlength: "4000", value: t.detail || "" });
  const relation = kind === "person" ? h("input", { type: "text", placeholder: "Relation", maxlength: "100", value: t.relation || "" }) : null;
  let schedule = null;
  if (kind === "routine") schedule = scheduleEditor(t.schedule_json);
  if (kind === "event") schedule = eventEditor(t.schedule_json);
  const save = h("button", {
    type: "button", class: "btn primary", text: "Save",
    onclick: async () => {
      const name = title.value.trim();
      if (!name) { flash(slot, "title", "danger"); return; }
      const patch = { title: name, detail: orNull(detail.value) };
      if (relation) patch.relation = orNull(relation.value);
      if (schedule) patch.schedule_json = schedule.value();
      save.disabled = true;
      try {
        if (t.id) await api("PUT", "/api/life/threads/" + encode(t.id), patch);
        else await api("POST", "/api/life/threads", { kind, ...patch });
        done();
      } catch (e) {
        save.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  const cancelBtn = h("button", { type: "button", class: "btn ghost", text: "Cancel", onclick: () => (cancel ? cancel() : done()) });
  return h("div", { class: "stack tight" },
    relation ? h("div", { class: "cols-2" }, title, relation) : title,
    schedule ? schedule.el : null,
    detail,
    h("div", { class: "row" }, save, cancelBtn, slot));
}

// Weekly grid: blocks of days with a start, an end and a label, in her timezone.
function scheduleEditor(initial) {
  const sched = parseJson(initial, null) || {};
  const tz = typeof sched.tz === "string" && sched.tz ? sched.tz : lifeTz;
  const blocks = (Array.isArray(sched.blocks) ? sched.blocks : []).map((b) => ({
    days: Array.isArray(b.days) ? b.days.filter((d) => Number.isInteger(d)) : [],
    start: typeof b.start === "string" ? b.start : "09:00",
    end: typeof b.end === "string" ? b.end : "17:00",
    label: typeof b.label === "string" ? b.label : "",
  }));
  const list = h("div", null);
  const blockRow = (b, i) => {
    const days = h("div", { class: "days", role: "group", "aria-label": "Days" });
    DAY_NUMS.forEach((num, idx) => {
      const btn = h("button", {
        type: "button", text: DAY_LABELS[idx], "aria-pressed": String(b.days.includes(num)),
        onclick: () => {
          const has = b.days.includes(num);
          b.days = has ? b.days.filter((d) => d !== num) : [...b.days, num].sort((x, y) => x - y);
          btn.setAttribute("aria-pressed", String(!has));
        },
      });
      days.append(btn);
    });
    const start = h("input", { type: "time", value: b.start, "aria-label": "Start", oninput: () => { b.start = start.value; } });
    const end = h("input", { type: "time", value: b.end, "aria-label": "End", oninput: () => { b.end = end.value; } });
    const label = h("input", { type: "text", placeholder: "Label", maxlength: "80", value: b.label, oninput: () => { b.label = label.value; } });
    const remove = h("button", { type: "button", class: "btn small ghost", text: "Remove", onclick: () => { blocks.splice(i, 1); render(); } });
    return h("div", { class: "block-row" }, days, h("div", { class: "block-times" }, start, end, label, remove));
  };
  const render = () => {
    clear(list);
    blocks.forEach((b, i) => list.append(blockRow(b, i)));
  };
  render();
  const add = h("button", {
    type: "button", class: "btn small", text: "Add block",
    onclick: () => { blocks.push({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", label: "" }); render(); },
  });
  return {
    el: h("div", { class: "stack tight" }, h("div", { class: "row between" }, chip(tz), add), list),
    value: () => {
      const out = blocks.filter((b) => b.days.length && b.start && b.end).map((b) => {
        const o = { days: b.days, start: b.start, end: b.end };
        if (b.label.trim()) o.label = b.label.trim();
        return o;
      });
      return out.length ? JSON.stringify({ tz, blocks: out }) : null;
    },
  };
}

function eventEditor(initial) {
  const s = parseJson(initial, null) || {};
  const at = h("input", { type: "datetime-local", value: toLocalInput(s.at || null), "aria-label": "When" });
  const label = h("input", { type: "text", placeholder: "Label", maxlength: "120", value: typeof s.label === "string" ? s.label : "" });
  return {
    el: h("div", { class: "cols-2" }, at, label),
    value: () => {
      const iso = fromLocalInput(at.value);
      if (!iso && !label.value.trim()) return null;
      const o = {};
      if (iso) o.at = iso;
      if (label.value.trim()) o.label = label.value.trim();
      return JSON.stringify(o);
    },
  };
}

function renderLog() {
  const box = $("lifeLog");
  clear(box);
  const byId = new Map(lifeData.threads.map((t) => [t.id, t]));
  const rows = lifeData.log.slice().sort((a, b) => String(b.occurred || "").localeCompare(String(a.occurred || "")));
  if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
  for (const l of rows) {
    const t = l.thread_id ? byId.get(l.thread_id) : null;
    box.append(h("div", { class: "log-row" },
      h("span", { class: "when", text: fmtTime(l.occurred) }),
      h("span", { class: "note" }, t ? chip(t.title, "accent") : null, t ? " " : null, l.note)));
  }
  const sel = $("logThread");
  const keep = sel.value;
  clear(sel);
  sel.append(h("option", { value: "", text: "none" }));
  for (const t of lifeData.threads.filter((x) => x.status === "active")) sel.append(h("option", { value: t.id, text: t.kind + ": " + t.title }));
  sel.value = keep && byId.has(keep) ? keep : "";
  if (!$("logWhen").value) $("logWhen").value = toLocalInput(new Date().toISOString());
}

$("logAdd").addEventListener("click", async () => {
  const note = $("logNote").value.trim();
  const occurred = fromLocalInput($("logWhen").value) || new Date().toISOString();
  if (!note) { flash($("logStatus"), "note", "danger"); return; }
  const btn = $("logAdd");
  btn.disabled = true;
  try {
    const body = { occurred, note };
    const threadId = $("logThread").value;
    if (threadId) body.threadId = threadId;
    await api("POST", "/api/life/log", body);
    $("logNote").value = "";
    $("logWhen").value = "";
    loadLife();
  } catch (e) {
    flash($("logStatus"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// Today (SPEC_V3 DD): what she ate, wore, ran out to do; only the current local day.
async function loadToday() {
  const box = $("todayList");
  const now = $("todayNow");
  clear(box);
  clear(now);
  let g;
  try {
    g = await api("GET", "/api/grounding");
  } catch (e) {
    $("todayCard").classList.toggle("hidden", e.status === 404);
    box.append(h("div", { class: "chips" }, chip(e.code, "danger")));
    return;
  }
  $("todayCard").classList.remove("hidden");
  if (g && typeof g === "object") {
    if (g.timeOfDay) now.append(chip(String(g.timeOfDay)));
    const w = g.weather && typeof g.weather === "object" ? g.weather : null;
    if (w && w.words) now.append(chip((w.temp !== undefined && w.temp !== null ? Math.round(Number(w.temp)) + (w.units === "celsius" ? "C " : "F ") : "") + String(w.words), "accent"));
    const outfit = g.outfit && typeof g.outfit === "object" ? g.outfit.text : g.outfit;
    if (outfit) now.append(chip("wearing: " + truncate(String(outfit), 60)));
  }
  const rows = listOf(g && g.today, ["rows", "items"]).slice().sort((a, b) => String(a.occurred || "").localeCompare(String(b.occurred || "")));
  if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
  for (const r of rows) {
    const del = h("button", {
      type: "button", class: "btn small ghost del", text: "Delete",
      onclick: async () => {
        del.disabled = true;
        try {
          await api("DELETE", "/api/grounding/log/" + encode(r.id));
          loadToday();
        } catch (e) {
          del.disabled = false;
          flash($("todayStatus"), e.code, "danger");
        }
      },
    });
    box.append(h("div", { class: "today-row" },
      h("span", { class: "when", text: fmtTime(r.occurred) }),
      chip(r.kind || "misc", "accent"),
      h("span", { text: r.note || "" }),
      del));
  }
  if (!$("todayWhen").value) $("todayWhen").value = toLocalInput(new Date().toISOString());
}

$("todayAdd").addEventListener("click", async () => {
  const note = $("todayNote").value.trim();
  if (!note) { flash($("todayStatus"), "note", "danger"); return; }
  const btn = $("todayAdd");
  btn.disabled = true;
  try {
    const body = { kind: $("todayKind").value, note };
    const occurred = fromLocalInput($("todayWhen").value);
    if (occurred) body.occurred = occurred;
    await api("POST", "/api/grounding/log", body);
    $("todayNote").value = "";
    $("todayWhen").value = "";
    loadToday();
  } catch (e) {
    flash($("todayStatus"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ Wants (SPEC_V3 CC)

let wantsStatus = "active";
let asksStatus = "open";
let wantsData = { wants: [], asks: [] };

filterGroup("wantsFilter", "status", (v) => { wantsStatus = v; loadWants(); });
filterGroup("asksFilter", "status", (v) => { asksStatus = v; renderAsks(); });

async function loadWants() {
  const box = $("wantsList");
  clear(box);
  try {
    const r = await api("GET", "/api/wants?status=" + encodeURIComponent(wantsStatus));
    wantsData = { wants: listOf(r && r.wants !== undefined ? r.wants : r, ["wants"]), asks: listOf(r && r.asks, ["asks"]) };
  } catch (e) {
    flash(status("wants"), e.code, "danger");
    return;
  }
  if (!wantsData.wants.length) box.append(h("div", { class: "chips" }, chip("none")));
  for (const w of wantsData.wants) box.append(wantCard(w));
  renderAsks();
}

function progressBar(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  // CSSOM, not a style attribute: the page's CSP has no style-src 'unsafe-inline'.
  const fill = h("span");
  fill.style.width = v + "%";
  return h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(v) }, fill);
}

function wantCard(w) {
  const slot = h("span", { class: "chips" });
  const logBox = h("div", { class: "want-log hidden" });
  const noteField = h("input", { type: "text", placeholder: "Note", maxlength: "500", "aria-label": "Note" });
  const buttons = [];
  const lock = (on) => { for (const b of buttons) b.disabled = on; };
  const logIt = async (kind, delta) => {
    const note = noteField.value.trim();
    if (!note) { flash(slot, "note", "danger"); return; }
    lock(true);
    try {
      const body = { kind, note };
      if (delta !== undefined) body.delta = delta;
      await api("POST", "/api/wants/" + encode(w.id) + "/log", body);
      loadWants();
    } catch (e) {
      lock(false);
      flash(slot, e.code, "danger");
    }
  };
  const setStatus = async (st) => {
    if ((st === "dropped" || st === "done") && !confirmLabel(st === "dropped" ? "Drop?" : "Done?")) return;
    lock(true);
    try {
      await api("PUT", "/api/wants/" + encode(w.id), { status: st });
      loadWants();
    } catch (e) {
      lock(false);
      flash(slot, e.code, "danger");
    }
  };
  const btn = (label, cls, fn) => { const b = h("button", { type: "button", class: "btn small " + (cls || ""), text: label, onclick: fn }); buttons.push(b); return b; };
  const active = w.status === "active";
  const actions = h("div", { class: "row" });
  if (active) {
    actions.append(
      btn("Progress", "", () => logIt("progress", 10)),
      btn("Setback", "danger", () => logIt("setback", 10)),
      btn("Note", "", () => logIt("note")),
      btn("Pause", "quiet", () => setStatus("paused")),
      btn("Done", "quiet", () => setStatus("done")),
      btn("Drop", "danger quiet", () => setStatus("dropped")));
  } else if (w.status === "paused") {
    actions.append(btn("Resume", "", () => setStatus("active")), btn("Drop", "danger quiet", () => setStatus("dropped")));
  } else {
    actions.append(btn("Reopen", "", () => setStatus("active")));
  }
  const showLog = h("button", {
    type: "button", class: "btn small ghost", text: "Log",
    onclick: async () => {
      if (!logBox.classList.contains("hidden")) { logBox.classList.add("hidden"); return; }
      logBox.classList.remove("hidden");
      clear(logBox);
      try {
        const rows = listOf(await api("GET", "/api/wants/" + encode(w.id) + "/log"), ["rows", "log"]);
        if (!rows.length) logBox.append(chip("none"));
        for (const l of rows.slice().sort((a, b) => String(b.occurred || "").localeCompare(String(a.occurred || "")))) {
          logBox.append(h("div", { class: "log-row" },
            h("span", { class: "when", text: fmtTime(l.occurred || l.created_at) }),
            h("span", { class: "note" }, chip(l.kind + (l.delta ? " " + (l.kind === "setback" ? "-" : "+") + Math.abs(Number(l.delta)) : ""), l.kind === "setback" ? "amber" : l.kind === "progress" ? "ok" : ""), " ", l.note || "")));
        }
      } catch (e) {
        logBox.append(chip(e.code, "danger"));
      }
    },
  });
  const last = w.lastLog && typeof w.lastLog === "object" ? w.lastLog : null;
  const kv = [];
  if (w.why) kv.push(h("span", { class: "k", text: "why" }), h("span", { class: "v", text: w.why }));
  if (w.stakes) kv.push(h("span", { class: "k", text: "stakes" }), h("span", { class: "v", text: w.stakes }));
  if (w.next_step) kv.push(h("span", { class: "k", text: "next" }), h("span", { class: "v", text: w.next_step }));
  kv.push(h("span", { class: "k", text: "last moved" }), h("span", { class: "v", text: w.last_moved ? ago(w.last_moved) + (last && last.note ? ": " + last.note : "") : "never" }));
  return h("div", { class: "card want-card" },
    h("div", { class: "row between" },
      h("span", { class: "want-title", text: w.title }),
      h("span", { class: "chips" }, chip(w.status, active ? "ok" : "amber"), chip((Number(w.progress) || 0) + "%", "accent"), w.horizon_days ? chip(w.horizon_days + "d") : null)),
    progressBar(w.progress),
    kv.length ? h("div", { class: "kv" }, kv) : null,
    active ? noteField : null,
    h("div", { class: "row" }, actions, showLog, slot),
    logBox);
}

function renderAsks() {
  const box = $("asksList");
  clear(box);
  const rows = wantsData.asks.filter((a) => asksStatus === "all" || a.status === "open");
  if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
  const wantsById = new Map(wantsData.wants.map((w) => [w.id, w]));
  for (const a of rows) {
    const slot = h("span", { class: "chips" });
    const buttons = [];
    const set = async (st) => {
      for (const b of buttons) b.disabled = true;
      try {
        await api("PUT", "/api/asks/" + encode(a.id), { status: st });
        loadWants();
      } catch (e) {
        for (const b of buttons) b.disabled = false;
        flash(slot, e.code, "danger");
      }
    };
    const mk = (label, st, cls) => { const b = h("button", { type: "button", class: "btn small " + (cls || ""), text: label, onclick: () => set(st) }); buttons.push(b); return b; };
    const w = a.want_id ? wantsById.get(a.want_id) : null;
    box.append(h("div", { class: "ask-row" },
      h("div", { class: "t" }, a.text, " ", h("span", { class: "chips" },
        chip(a.status, a.status === "open" ? "amber" : a.status === "granted" ? "ok" : ""),
        chip(ago(a.asked_at || a.created_at)),
        a.brought_up ? chip("brought up " + a.brought_up) : null,
        w ? chip(w.title, "accent") : null)),
      a.status === "open" ? h("div", { class: "actions" }, mk("Grant", "granted"), mk("Decline", "declined", "danger"), mk("Let go", "let_go", "ghost"), slot) : slot));
  }
  const sel = $("askWant");
  const keep = sel.value;
  clear(sel);
  sel.append(h("option", { value: "", text: "no want" }));
  for (const w of wantsData.wants) sel.append(h("option", { value: w.id, text: w.title }));
  sel.value = keep && wantsById.has(keep) ? keep : "";
}

$("wantAdd").addEventListener("click", async () => {
  const title = $("wantTitle").value.trim();
  if (!title) { flash($("wantAddStatus"), "title", "danger"); return; }
  const progress = Number($("wantProgress").value);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) { flash($("wantAddStatus"), "progress 0 to 100", "danger"); return; }
  const btn = $("wantAdd");
  btn.disabled = true;
  try {
    const body = { title, progress };
    for (const [id, key] of [["wantWhy", "why"], ["wantStakes", "stakes"], ["wantNext", "next_step"]]) {
      const v = orNull($(id).value);
      if (v) body[key] = v;
    }
    await api("POST", "/api/wants", body);
    for (const id of ["wantTitle", "wantWhy", "wantStakes", "wantNext"]) $(id).value = "";
    $("wantProgress").value = "0";
    flash($("wantAddStatus"), "added", "ok");
    loadWants();
  } catch (e) {
    flash($("wantAddStatus"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

$("askAdd").addEventListener("click", async () => {
  const text = $("askText").value.trim();
  if (!text) { flash($("askStatus"), "text", "danger"); return; }
  const btn = $("askAdd");
  btn.disabled = true;
  try {
    const body = { text };
    if ($("askWant").value) body.wantId = $("askWant").value;
    await api("POST", "/api/asks", body);
    $("askText").value = "";
    loadWants();
  } catch (e) {
    flash($("askStatus"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ History

let historyWeights = null;

async function loadHistory() {
  const box = $("historyList");
  clear(box);
  try {
    const [bundle, weights] = await Promise.all([api("GET", "/api/state"), loadWeightMap("history")]);
    historyWeights = weights;
    const rows = bundle.history || [];
    if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
    for (const row of rows) box.append(historyCard(row));
    box.append(historyAddCard());
  } catch (e) {
    flash(status("history"), e.code, "danger");
  }
}

function historyFields(row) {
  const title = h("input", { type: "text", placeholder: "Title", maxlength: "200", value: row.title || "" });
  const occurred = h("input", { type: "text", placeholder: "Occurred", maxlength: "100", value: row.occurred || "" });
  const body = h("textarea", { placeholder: "Body", value: row.body || "" });
  const changed = h("textarea", { placeholder: "What changed", value: row.what_changed || "" });
  const keep = h("textarea", { placeholder: "Keep consistent", value: row.keep_consistent || "" });
  const source = h("input", { type: "text", placeholder: "Source", maxlength: "200", value: row.source || "" });
  const grid = h("div", { class: "stack tight" },
    h("div", { class: "cols-2" }, title, occurred),
    body,
    h("div", { class: "cols-2" }, changed, keep),
    source);
  return {
    grid,
    values: () => ({
      title: title.value.trim(),
      occurred: orNull(occurred.value),
      body: body.value.trim(),
      what_changed: orNull(changed.value),
      keep_consistent: orNull(keep.value),
      source: orNull(source.value),
    }),
  };
}

function historyCard(row) {
  const f = historyFields(row);
  const slot = h("span", { class: "chips" });
  const save = h("button", {
    type: "button", class: "btn primary", text: "Save",
    onclick: async () => {
      const v = f.values();
      if (!v.title || !v.body) { flash(slot, "title and body", "danger"); return; }
      save.disabled = true;
      try {
        await api("PUT", "/api/history/" + encode(row.id), v);
        loadHistory();
      } catch (e) {
        save.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  const versions = h("div", { class: "stack tight hidden" });
  const showVersions = h("button", {
    type: "button", class: "btn", text: "Versions",
    onclick: () => toggleVersionList("history", row.id, versions, slot, loadHistory, (v) => v.title),
  });
  const del = h("button", {
    type: "button", class: "btn danger", text: "Delete",
    onclick: async () => {
      if (!confirmLabel("Delete?")) return;
      del.disabled = true;
      try {
        await api("DELETE", "/api/history/" + encode(row.id));
        loadHistory();
      } catch (e) {
        del.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("div", { class: "card stack" },
    h("div", { class: "row" },
      chip("#" + row.seq, "accent"),
      chip("v" + row.version),
      h("span", { class: "muted small", text: fmtTime(row.updated_at || row.created_at) }),
      historyWeights ? weightSelect("history", row.id, historyWeights.get(String(row.id)), slot) : null),
    f.grid,
    h("div", { class: "row" }, save, showVersions, del, slot),
    versions);
}

function historyAddCard() {
  const f = historyFields({});
  const slot = h("span", { class: "chips" });
  const add = h("button", {
    type: "button", class: "btn primary", text: "Add",
    onclick: async () => {
      const v = f.values();
      if (!v.title || !v.body) { flash(slot, "title and body", "danger"); return; }
      add.disabled = true;
      try {
        await api("POST", "/api/history", v);
        loadHistory();
      } catch (e) {
        add.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("div", { class: "card stack" },
    h("h2", { class: "section-title", text: "Add" }),
    f.grid,
    h("div", { class: "row" }, add, slot));
}

// ------------------------------------------------------------ Facts

let factsMode = "all";
let factWeights = null;

function setFactsMode(mode) {
  factsMode = mode;
  $("factsAll").setAttribute("aria-pressed", String(mode === "all"));
  $("factsOpinions").setAttribute("aria-pressed", String(mode === "opinions"));
  $("factsColumns").classList.toggle("hidden", mode !== "all");
  $("factsOpinionsBox").classList.toggle("hidden", mode !== "opinions");
  loadFacts();
}

$("factsAll").addEventListener("click", () => setFactsMode("all"));
$("factsOpinions").addEventListener("click", () => setFactsMode("opinions"));

async function loadFacts() {
  try {
    const [bundle, weights] = await Promise.all([api("GET", "/api/state"), loadWeightMap("fact")]);
    factWeights = weights;
    const facts = bundle.facts || {};
    if (factsMode === "opinions") {
      renderOpinions(facts.avelie || []);
      return;
    }
    renderFactColumn($("factsFixed"), facts.fixed || [], null);
    renderFactColumn($("factsAvelie"), facts.avelie || [], "avelie");
    renderFactColumn($("factsJustin"), facts.justin || [], "justin");
  } catch (e) {
    flash(status("facts"), e.code, "danger");
  }
}

function renderFactColumn(box, rows, scope) {
  clear(box);
  if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
  for (const f of rows) box.append(scope ? factCard(f) : fixedFactCard(f));
  if (scope) box.append(factAddCard(scope));
}

// Opinions: subject "opinion: ..." on her scope, each with its version chain inline.
function renderOpinions(rows) {
  const box = $("factsOpinionsBox");
  clear(box);
  const ops = rows.filter((f) => OPINION_RE.test(String(f.subject || "")));
  if (!ops.length) { box.append(h("div", { class: "chips" }, chip("none"))); return; }
  for (const f of ops) {
    const chain = h("div", { class: "chain" });
    const card = factCard(f);
    card.append(chain);
    box.append(card);
    loadChain(f, chain);
  }
}

async function loadChain(f, box) {
  try {
    const rows = await api("GET", "/api/facts/" + encode(f.id) + "/versions");
    const list = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => a.version - b.version);
    if (list.length < 2) return;
    for (const v of list) {
      box.append(h("div", { class: "chain-row" },
        h("span", { class: "v", text: "v" + v.version }),
        h("span", { class: "d", text: fmtDate(v.created_at) }),
        h("span", { text: v.fact })));
    }
  } catch {
    /* the chain is optional */
  }
}

function fixedFactCard(f) {
  return h("div", { class: "card fact-fixed" },
    f.subject ? h("div", { class: "muted small", text: f.subject }) : null,
    h("div", { text: f.fact }));
}

function factCard(f) {
  const subject = h("input", { type: "text", placeholder: "Subject", maxlength: "200", value: f.subject || "" });
  const fact = h("textarea", { placeholder: "Fact", value: f.fact || "" });
  const disclosed = h("input", { type: "checkbox", checked: !!f.disclosed });
  const provisional = h("input", { type: "checkbox", checked: !!f.provisional });
  const slot = h("span", { class: "chips" });
  const versions = h("div", { class: "stack tight hidden" });
  const save = h("button", {
    type: "button", class: "btn primary", text: "Save",
    onclick: async () => {
      const text = fact.value.trim();
      if (!text) { flash(slot, "fact", "danger"); return; }
      save.disabled = true;
      try {
        await api("PUT", "/api/facts/" + encode(f.id), {
          fact: text,
          subject: orNull(subject.value),
          disclosed: disclosed.checked,
          provisional: provisional.checked,
        });
        loadFacts();
      } catch (e) {
        save.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  const del = h("button", {
    type: "button", class: "btn danger", text: "Delete",
    onclick: async () => {
      if (!confirmLabel("Delete?")) return;
      del.disabled = true;
      try {
        await api("DELETE", "/api/facts/" + encode(f.id));
        loadFacts();
      } catch (e) {
        del.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  const showVersions = h("button", {
    type: "button", class: "btn", text: "Versions",
    onclick: () => toggleVersionList("facts", f.id, versions, slot, loadFacts, (v) => (v.subject ? v.subject + ": " : "") + v.fact),
  });
  // Facts about him carry a weight (SPEC_V3 BB); her own never fade.
  const weighted = factWeights && f.scope === "justin";
  return h("div", { class: "card stack tight" },
    h("div", { class: "row" },
      chip("v" + f.version),
      f.source ? chip(f.source) : null,
      h("span", { class: "muted small", text: fmtTime(f.updated_at || f.created_at) }),
      weighted ? weightSelect("fact", f.id, factWeights.get(String(f.id)), slot) : null),
    subject,
    fact,
    h("div", { class: "row" },
      h("label", { class: "check" }, disclosed, "Disclosed"),
      h("label", { class: "check" }, provisional, "Provisional")),
    h("div", { class: "row" }, save, showVersions, del, slot),
    versions);
}

// Shared by facts and history: GET /api/<kind>/:id/versions, POST /api/<kind>/:versionId/restore.
async function toggleVersionList(kind, id, box, slot, reload, label) {
  if (!box.classList.contains("hidden")) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  clear(box);
  try {
    const rows = await api("GET", "/api/" + kind + "/" + encode(id) + "/versions");
    if (!rows.length) box.append(chip("none"));
    for (const v of rows) {
      const restore = h("button", {
        type: "button", class: "btn small", text: "Restore",
        disabled: v.status === "approved",
        onclick: async () => {
          restore.disabled = true;
          try {
            await api("POST", "/api/" + kind + "/" + encode(v.id) + "/restore");
            reload();
          } catch (e) {
            restore.disabled = false;
            flash(slot, e.code, "danger");
          }
        },
      });
      box.append(h("div", { class: "row version-row" },
        chip("v" + v.version, v.status === "approved" ? "accent" : ""),
        chip(v.status),
        h("span", { class: "grow small", text: label(v) }),
        restore));
    }
  } catch (e) {
    box.append(chip(e.code, "danger"));
  }
}

function factAddCard(scope) {
  const subject = h("input", { type: "text", placeholder: "Subject", maxlength: "200" });
  const fact = h("textarea", { placeholder: "Fact" });
  const disclosed = h("input", { type: "checkbox", checked: scope === "avelie" });
  const provisional = h("input", { type: "checkbox" });
  const slot = h("span", { class: "chips" });
  const add = h("button", {
    type: "button", class: "btn primary", text: "Add",
    onclick: async () => {
      const text = fact.value.trim();
      if (!text) { flash(slot, "fact", "danger"); return; }
      add.disabled = true;
      try {
        await api("POST", "/api/facts", {
          scope,
          subject: orNull(subject.value),
          fact: text,
          disclosed: disclosed.checked,
          provisional: provisional.checked,
        });
        loadFacts();
      } catch (e) {
        add.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("div", { class: "card stack tight" },
    h("h2", { class: "section-title", text: "Add" }),
    subject,
    fact,
    h("div", { class: "row" },
      h("label", { class: "check" }, disclosed, "Disclosed"),
      h("label", { class: "check" }, provisional, "Provisional")),
    h("div", { class: "row" }, add, slot));
}

// ------------------------------------------------------------ Memory (SPEC_V3 BB)

let memoryEntity = "fact";

filterGroup("memoryFilter", "entity", (v) => { memoryEntity = v; loadMemory(); });

async function loadMemory() {
  const tbody = $("memoryRows");
  clear(tbody);
  let rows;
  try {
    rows = listOf(await api("GET", "/api/memory?entity=" + encodeURIComponent(memoryEntity) + "&limit=200"), ["rows", "items", "memory"]);
  } catch (e) {
    tbody.append(h("tr", null, h("td", { colspan: "7" }, chip(e.code, "danger"))));
    loadRecalls();
    return;
  }
  rows = rows.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  if (!rows.length) tbody.append(h("tr", null, h("td", { colspan: "7" }, chip("none"))));
  for (const r of rows) tbody.append(memoryRow(r));
  loadRecalls();
}

function memoryRow(r) {
  const id = String(r.entityId || r.entity_id || r.id || "");
  const entity = String(r.entity || memoryEntity);
  const text = r.text || r.fact || r.title || r.note || id;
  const score = Number(r.score);
  // The server says whether the row is in the prompt (shown); the score line is the fallback.
  const faded = typeof r.shown === "boolean" ? !r.shown : (r.faded === true || (Number.isFinite(score) && score < FADED_BELOW));
  const slot = h("span", { class: "chips" });
  const lastTouched = r.lastTouched || r.last_touched || null;
  const remind = h("button", {
    type: "button", class: "btn small", text: "Remind her",
    onclick: async () => {
      remind.disabled = true;
      try {
        await api("PUT", "/api/memory/" + encodeURIComponent(entity) + "/" + encode(id), { lastTouched: new Date().toISOString() });
        loadMemory();
      } catch (e) {
        remind.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("tr", null,
    h("td", null, chip(entity)),
    h("td", { class: "text" }, truncate(String(text), 200), faded ? " " : null, faded ? chip("faded", "amber") : null),
    h("td", null, weightSelect(entity, id, r, slot, () => loadMemory())),
    h("td", { text: lastTouched ? ago(lastTouched) : "" , title: lastTouched || "" }),
    h("td", { class: "num", text: String(Number(r.touches) || 0) }),
    h("td", { class: "num score", text: Number.isFinite(score) ? score.toFixed(2) : "" }),
    h("td", null, h("span", { class: "row" }, remind, slot)));
}

async function loadRecalls() {
  const box = $("recallsList");
  clear(box);
  let rows;
  try {
    rows = listOf(await api("GET", "/api/memory/recalls?limit=50"), ["rows", "recalls", "items"]);
  } catch (e) {
    box.append(h("div", { class: "chips" }, chip(e.code, "danger")));
    return;
  }
  if (!rows.length) { box.append(h("div", { class: "chips" }, chip("none"))); return; }
  for (const r of rows) {
    box.append(h("div", { class: "log-row" },
      h("span", { class: "when", text: fmtTime(r.created_at || r.at) }),
      h("span", { class: "note" }, chip(r.mode || "provisional"), " ", r.text_shown || r.textShown || r.text || "")));
  }
}

// ------------------------------------------------------------ Voice bank (SPEC_V3 AA)

let voiceStatus = "unapproved";
let voiceTag = "";
let voiceLines = [];
let voiceTags = [];
const voiceSelected = new Set();

filterGroup("voiceStatusFilter", "status", (v) => { voiceStatus = v; loadVoice(); });

function lineTags(l) {
  if (Array.isArray(l.tags)) return l.tags;
  const parsed = parseJson(l.tags_json, null);
  return Array.isArray(parsed) ? parsed : [];
}

async function loadVoice() {
  const box = $("voiceList");
  clear(box);
  voiceSelected.clear();
  $("voiceSelectAll").checked = false;
  let r;
  try {
    r = await api("GET", "/api/voicebank?status=" + encodeURIComponent(voiceStatus) + (voiceTag ? "&tag=" + encodeURIComponent(voiceTag) : ""));
  } catch (e) {
    flash(status("voice"), e.code, "danger");
    return;
  }
  voiceLines = listOf(r && r.lines !== undefined ? r.lines : r, ["lines", "rows"]);
  voiceTags = Array.isArray(r && r.tags) && r.tags.length ? r.tags.map(String) : VOICE_TAGS;
  const counts = r && r.counts && typeof r.counts === "object" ? r.counts : null;
  const cbox = $("voiceCounts");
  clear(cbox);
  if (counts) for (const k of ["unapproved", "approved", "rejected"]) if (counts[k] !== undefined) cbox.append(chip(k + " " + counts[k], k === "approved" ? "ok" : k === "rejected" ? "" : "amber"));
  renderTagFilter();
  // The bulk decisions act on unapproved lines only (the route's rule), so they show on
  // that filter alone.
  const deciding = voiceStatus === "unapproved";
  $("voiceApproveSelected").classList.toggle("hidden", !deciding);
  $("voiceRejectSelected").classList.toggle("hidden", !deciding);
  $("voiceApproveTag").classList.toggle("hidden", !deciding);
  $("voiceApproveTag").disabled = !voiceTag;
  if (!voiceLines.length) box.append(h("div", { class: "chips" }, chip("none")));
  for (const l of voiceLines) box.append(voiceRow(l));
  renderNewTags();
}

function renderTagFilter() {
  const box = $("voiceTagFilter");
  clear(box);
  const all = h("button", { type: "button", text: "any tag", "aria-pressed": String(!voiceTag), onclick: () => { voiceTag = ""; loadVoice(); } });
  box.append(all);
  for (const t of voiceTags) {
    box.append(h("button", { type: "button", text: t, "aria-pressed": String(voiceTag === t), onclick: () => { voiceTag = voiceTag === t ? "" : t; loadVoice(); } }));
  }
}

// Tag chips as toggles; at most four, the first is the primary.
function tagPicker(initial, onChange) {
  const picked = [...initial];
  const box = h("div", { class: "tag-picker", role: "group", "aria-label": "Tags" });
  const paint = () => {
    for (const b of box.querySelectorAll("button")) b.setAttribute("aria-pressed", String(picked.includes(b.dataset.tag)));
  };
  for (const t of voiceTags) {
    box.append(h("button", {
      type: "button", text: t, "data-tag": t,
      onclick: () => {
        const i = picked.indexOf(t);
        if (i >= 0) picked.splice(i, 1);
        else if (picked.length < 4) picked.push(t);
        paint();
        if (onChange) onChange(picked.slice());
      },
    }));
  }
  paint();
  return { el: box, value: () => picked.slice() };
}

function voiceRow(l) {
  const slot = h("span", { class: "chips" });
  const pick = h("input", { type: "checkbox", "aria-label": "Select", checked: voiceSelected.has(l.id) });
  pick.addEventListener("change", () => { if (pick.checked) voiceSelected.add(l.id); else voiceSelected.delete(l.id); });
  const text = h("input", { type: "text", class: "text", value: l.text || "", maxlength: "160", "aria-label": "Line" });
  const tags = lineTags(l);
  let tagsNow = tags.slice();
  const tagsBox = h("div", { class: "tags" }, tags.map((t, i) => chip(t, i === 0 ? "accent" : "")));
  const picker = h("div", { class: "hidden" });
  const editTags = h("button", {
    type: "button", class: "btn small ghost", text: "Tags",
    onclick: () => {
      if (!picker.classList.contains("hidden")) { picker.classList.add("hidden"); return; }
      clear(picker);
      picker.append(tagPicker(tagsNow, (v) => { tagsNow = v; }).el);
      picker.classList.remove("hidden");
    },
  });
  const buttons = [];
  const lock = (on) => { for (const b of buttons) b.disabled = on; };
  const save = h("button", {
    type: "button", class: "btn small", text: "Save",
    onclick: async () => {
      const t = text.value.trim();
      if (!t) { flash(slot, "text", "danger"); return; }
      if (!tagsNow.length) { flash(slot, "tags", "danger"); return; }
      lock(true);
      try {
        const patch = {};
        if (t !== l.text) patch.text = t;
        if (JSON.stringify(tagsNow) !== JSON.stringify(tags)) patch.tags = tagsNow;
        if (Object.keys(patch).length) await api("PUT", "/api/voicebank/" + encode(l.id), patch);
        loadVoice();
      } catch (e) {
        lock(false);
        flash(slot, e.code, "danger");
      }
    },
  });
  const decide = async (decision) => {
    lock(true);
    try {
      await api("POST", "/api/voicebank/" + encode(l.id) + "/decide", { decision });
      loadVoice();
    } catch (e) {
      lock(false);
      flash(slot, e.code, "danger");
    }
  };
  const approve = h("button", { type: "button", class: "btn small primary", text: "Approve", onclick: () => decide("approve") });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject", onclick: () => decide("reject") });
  buttons.push(save, approve, reject);
  const st = l.status || "unapproved";
  const meta = h("span", { class: "chips" },
    chip(st, st === "approved" ? "ok" : st === "rejected" ? "" : "amber"),
    l.origin ? chip(l.origin) : null,
    Number(l.uses) > 0 ? chip("used " + l.uses) : null);
  // A decision is offered only where the route takes one: an unapproved line (a decided
  // line answers 409 already_decided).
  return h("div", { class: "line-row" },
    h("span", { class: "pick" }, pick),
    text,
    h("div", { class: "actions" }, save, st === "unapproved" ? approve : null, st === "unapproved" ? reject : null, editTags, meta, slot),
    h("div", { class: "tags" }, tagsBox, picker));
}

let newTagPicker = null;

function renderNewTags() {
  const box = $("voiceNewTags");
  clear(box);
  newTagPicker = tagPicker([], null);
  box.append(newTagPicker.el);
}

async function decideMany(ids, decision, btn) {
  const slot = status("voice");
  const list = ids.slice(0, MAX_DECIDE_IDS);
  if (!list.length) { flash(slot, "none selected", "danger"); return; }
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/voicebank/decide", { ids: list, decision });
    flash(slot, "changed " + (r && r.changed !== undefined ? r.changed : list.length), "ok");
    loadVoice();
  } catch (e) {
    flash(slot, e.code, "danger");
  } finally {
    btn.disabled = false;
  }
}

$("voiceSelectAll").addEventListener("change", () => {
  const on = $("voiceSelectAll").checked;
  voiceSelected.clear();
  for (const cb of $("voiceList").querySelectorAll("input[type=checkbox]")) cb.checked = on;
  if (on) for (const l of voiceLines) voiceSelected.add(l.id);
});
$("voiceApproveSelected").addEventListener("click", () => decideMany([...voiceSelected], "approve", $("voiceApproveSelected")));
$("voiceRejectSelected").addEventListener("click", () => decideMany([...voiceSelected], "reject", $("voiceRejectSelected")));
$("voiceApproveTag").addEventListener("click", async () => {
  if (!voiceTag) return;
  const btn = $("voiceApproveTag");
  btn.disabled = true;
  try {
    const r = await api("GET", "/api/voicebank?status=unapproved&tag=" + encodeURIComponent(voiceTag));
    const ids = listOf(r && r.lines !== undefined ? r.lines : r, ["lines", "rows"]).map((l) => l.id);
    await decideMany(ids, "approve", btn);
  } catch (e) {
    flash(status("voice"), e.code, "danger");
    btn.disabled = false;
  }
});
// The whole bank at once (Justin's answer to the spec's question 6): every unapproved line.
$("voiceApproveAll").addEventListener("click", async () => {
  if (!confirmLabel("Approve every unapproved line?")) return;
  const btn = $("voiceApproveAll");
  btn.disabled = true;
  try {
    const r = await api("GET", "/api/voicebank?status=unapproved");
    const ids = listOf(r && r.lines !== undefined ? r.lines : r, ["lines", "rows"]).map((l) => l.id);
    await decideMany(ids, "approve", btn);
  } catch (e) {
    flash(status("voice"), e.code, "danger");
    btn.disabled = false;
  }
});

$("voiceAdd").addEventListener("click", async () => {
  const text = $("voiceNewText").value.trim();
  const tags = newTagPicker ? newTagPicker.value() : [];
  if (!text) { flash($("voiceAddStatus"), "text", "danger"); return; }
  if (!tags.length) { flash($("voiceAddStatus"), "tags", "danger"); return; }
  const btn = $("voiceAdd");
  btn.disabled = true;
  try {
    await api("POST", "/api/voicebank", { text, tags });
    $("voiceNewText").value = "";
    flash($("voiceAddStatus"), "added", "ok");
    loadVoice();
  } catch (e) {
    flash($("voiceAddStatus"), e.message && e.code === "validation" ? e.message : e.code, "danger wrap");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ Notes (SPEC_V3 AA, the corrections ledger)

let notesStatus = "active";

filterGroup("notesFilter", "status", (v) => { notesStatus = v; loadNotes(); });

async function loadNotes() {
  const box = $("notesList");
  clear(box);
  let rows;
  try {
    rows = listOf(await api("GET", "/api/corrections?status=" + encodeURIComponent(notesStatus)), ["rows", "corrections"]);
  } catch (e) {
    flash(status("notes"), e.code, "danger");
    return;
  }
  rows = rows.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
  for (const c of rows) box.append(noteRow(c));
}

function noteRow(c) {
  const slot = h("span", { class: "chips" });
  const retired = c.status === "retired";
  const toggle = h("button", {
    type: "button", class: retired ? "btn small" : "btn small ghost", text: retired ? "Restore" : "Retire",
    onclick: async () => {
      toggle.disabled = true;
      try {
        await api("POST", "/api/corrections/" + encode(c.id) + "/" + (retired ? "restore" : "retire"), {});
        loadNotes();
      } catch (e) {
        toggle.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("div", { class: "note-row" + (retired ? " retired" : "") },
    h("div", { class: "row between" },
      h("span", { class: "chips" }, chip(KIND_WORD[c.kind] || c.kind || "note", "accent"), chip(c.status || "active", retired ? "" : "ok"), c.voice_line_id ? chip("in the bank") : null, h("span", { class: "muted small", text: fmtTime(c.created_at) })),
      h("span", { class: "row" }, toggle, slot)),
    c.note ? h("div", { class: "small", text: c.note }) : null,
    h("div", { class: "orig", "data-label": "she wrote", text: c.original || "" }),
    c.rewrite ? h("div", { class: "rew", "data-label": "his version", text: c.rewrite }) : null);
}

// ------------------------------------------------------------ Unknowns

async function loadUnknowns() {
  const box = $("unknownsList");
  clear(box);
  try {
    const bundle = await api("GET", "/api/state");
    const rows = bundle.unknowns || [];
    if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
    for (const u of rows) box.append(unknownCard(u));
  } catch (e) {
    flash(status("unknowns"), e.code, "danger");
  }
}

function unknownCard(u) {
  const slot = h("span", { class: "chips" });
  const open = u.status !== "resolved";
  const resolution = h("input", { type: "text", placeholder: "Resolution", maxlength: "500", value: u.resolution || "" });
  const action = h("button", {
    type: "button", class: open ? "btn primary" : "btn", text: open ? "Resolve" : "Reopen",
    onclick: async () => {
      action.disabled = true;
      try {
        const patch = open
          ? { status: "resolved", resolution: orNull(resolution.value) }
          : { status: "open" };
        await api("PUT", "/api/unknowns/" + encode(u.id), patch);
        loadUnknowns();
      } catch (e) {
        action.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("div", { class: "card stack tight" },
    h("div", { class: "row" },
      chip(u.status, open ? "amber" : "ok"),
      h("span", { class: "muted small", text: fmtTime(u.updated_at || u.created_at) })),
    h("div", { text: u.topic }),
    u.note ? h("div", { class: "muted small", text: u.note }) : null,
    open ? resolution : (u.resolution ? h("div", { class: "small", text: u.resolution }) : null),
    h("div", { class: "row" }, action, slot));
}

$("unknownAdd").addEventListener("click", async () => {
  const topic = $("unknownTopic").value.trim();
  if (!topic) { flash(status("unknowns"), "topic", "danger"); return; }
  const btn = $("unknownAdd");
  btn.disabled = true;
  try {
    await api("POST", "/api/unknowns", { topic, note: orNull($("unknownNote").value) });
    $("unknownTopic").value = "";
    $("unknownNote").value = "";
    loadUnknowns();
  } catch (e) {
    flash(status("unknowns"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ Inbox

async function loadInbox() {
  const box = $("inboxList");
  clear(box);
  try {
    const rows = await api("GET", "/api/proposals?status=pending");
    if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
    for (const p of rows) box.append(proposalCard(p));
  } catch (e) {
    flash(status("inbox"), e.code, "danger");
  }
}

function proposalCard(p) {
  const slot = h("span", { class: "chips" });
  const editText = h("textarea", { placeholder: "Proposal", value: p.proposal || "" });
  const kinds = KINDS.includes(p.kind) ? KINDS : [p.kind, ...KINDS];
  const editKind = h("select", null, kinds.map((k) => h("option", { value: k, selected: k === p.kind, text: k })));
  editKind.value = p.kind;
  const editBox = h("div", { class: "stack tight hidden" });
  const buttons = [];

  const decide = async (body) => {
    for (const b of buttons) b.disabled = true;
    try {
      await api("POST", "/api/proposals/" + encode(p.id) + "/decide", body);
      loadInbox();
    } catch (e) {
      for (const b of buttons) b.disabled = false;
      flash(slot, e.code, "danger");
    }
  };

  const approve = h("button", { type: "button", class: "btn primary", text: "Approve", onclick: () => decide({ decision: "approve" }) });
  const edit = h("button", { type: "button", class: "btn", text: "Edit", onclick: () => editBox.classList.toggle("hidden") });
  const reject = h("button", { type: "button", class: "btn danger", text: "Reject", onclick: () => decide({ decision: "reject" }) });
  const saveEdit = h("button", {
    type: "button", class: "btn primary", text: "Save",
    onclick: () => {
      const text = editText.value.trim();
      if (!text) { flash(slot, "proposal", "danger"); return; }
      decide({ decision: "edit", edited: { proposal: text, kind: editKind.value } });
    },
  });
  const cancelEdit = h("button", { type: "button", class: "btn ghost", text: "Cancel", onclick: () => editBox.classList.add("hidden") });
  buttons.push(approve, edit, reject, saveEdit);
  editBox.append(editText, editKind, h("div", { class: "row" }, saveEdit, cancelEdit));

  const payload = parseJson(p.payload_json, null);
  const payloadChips = [];
  if (payload && typeof payload === "object") {
    for (const [k, v] of Object.entries(payload)) {
      if (v === null || v === undefined || v === "") continue;
      payloadChips.push(chip(k + " " + (typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40))));
    }
  }

  return h("div", { class: "card stack" },
    h("div", { class: "row" },
      chip(p.kind, "accent"),
      p.confidence ? chip(p.confidence, p.confidence === "high" ? "ok" : p.confidence === "low" ? "amber" : "") : null,
      p.scope ? chip(p.scope) : null,
      h("span", { class: "muted small", text: fmtTime(p.created_at) })),
    h("div", { class: "proposal-text", text: p.proposal }),
    p.evidence ? h("blockquote", { class: "evidence", text: p.evidence }) : null,
    payloadChips.length ? h("div", { class: "chips" }, payloadChips) : null,
    p.decision_note ? h("div", { class: "chips" }, chip(String(p.decision_note).slice(0, 80), "danger wrap")) : null,
    h("div", { class: "row" }, approve, edit, reject, slot),
    editBox);
}

// ------------------------------------------------------------ Rulebook

async function loadRulebook() {
  try {
    const sys = await api("GET", "/api/system");
    $("constitutionVersion").textContent = sys.constitutionVersion || "";
    $("promptVersion").textContent = sys.promptVersion || "";
  } catch (e) {
    flash(status("rulebook"), e.code, "danger");
  }
  const extra = $("rulebookExtra");
  clear(extra);
  extra.classList.add("hidden");
  let rb = null;
  try { rb = await api("GET", "/api/rulebook"); } catch { rb = null; }
  if (!rb || typeof rb !== "object") return;
  const adaptations = rb.adaptations ?? rb.adaptationList ?? null;
  const overlay = rb.overlay ?? null;
  const alwaysOn = rb.alwaysOn ?? rb.always_on ?? rb.ALWAYS_ON ?? null;
  if (adaptations) {
    extra.append(h("h2", { class: "section-title", text: "Adaptations" }));
    if (Array.isArray(adaptations)) {
      extra.append(h("ul", { class: "plain small" }, adaptations.map((a) => h("li", { text: typeof a === "string" ? a : JSON.stringify(a) }))));
    } else {
      extra.append(h("pre", { class: "rule", text: typeof adaptations === "string" ? adaptations : JSON.stringify(adaptations, null, 2) }));
    }
  }
  if (overlay) {
    extra.append(h("h2", { class: "section-title", text: "Overlay" }));
    extra.append(h("pre", { class: "rule", text: typeof overlay === "string" ? overlay : JSON.stringify(overlay, null, 2) }));
  }
  if (alwaysOn) {
    extra.append(h("h2", { class: "section-title", text: "Always on" }));
    extra.append(h("pre", { class: "rule", text: typeof alwaysOn === "string" ? alwaysOn : JSON.stringify(alwaysOn, null, 2) }));
  }
  if (extra.childElementCount) extra.classList.remove("hidden");
}

// ------------------------------------------------------------ Export

async function loadExport() {
  const box = $("transcriptList");
  clear(box);
  try {
    const convs = await api("GET", "/api/conversations");
    if (!convs.length) box.append(chip("none"));
    for (const c of convs) {
      const btn = h("button", {
        type: "button", class: "btn small", text: "Transcript",
        onclick: () => exportTranscript(c.id, btn),
      });
      box.append(h("div", { class: "row version-row" },
        h("span", { class: "grow", text: (c.title || "chat") + " " + fmtDate(c.created_at) }),
        h("span", { class: "muted small mono", text: c.id }),
        btn));
    }
  } catch (e) {
    flash(status("export"), e.code, "danger");
  }
}

async function exportTranscript(id, btn) {
  btn.disabled = true;
  try {
    const text = await api("GET", "/api/export/transcript/" + encode(id));
    const body = typeof text === "string" ? text : JSON.stringify(text ?? "", null, 2);
    download("avelie-transcript-" + id + "-" + today() + ".txt", new Blob([body], { type: "text/plain" }));
  } catch (e) {
    flash(status("export"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
}

async function exportFile(btn, path, name, type, asJson) {
  btn.disabled = true;
  try {
    const data = await api("GET", path);
    const body = asJson ? JSON.stringify(data, null, 2) : (typeof data === "string" ? data : JSON.stringify(data ?? "", null, 2));
    download(name, new Blob([body], { type }));
    flash(status("export"), "exported", "ok");
  } catch (e) {
    flash(status("export"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
}

$("exportJson").addEventListener("click", () => exportFile($("exportJson"), "/api/export", "avelie-export-" + today() + ".json", "application/json", true));
$("exportCharacter").addEventListener("click", () => exportFile($("exportCharacter"), "/api/export/character", "avelie-character-" + today() + ".json", "application/json", true));
$("exportBible").addEventListener("click", () => exportFile($("exportBible"), "/api/export/character.md", "avelie-character-" + today() + ".md", "text/markdown", false));

$("importBtn").addEventListener("click", async () => {
  const file = $("importFile").files[0];
  if (!file) { flash(status("export"), "no file", "danger"); return; }
  let payload;
  try {
    payload = JSON.parse(await file.text());
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("object");
  } catch {
    flash(status("export"), "invalid JSON", "danger");
    return;
  }
  if (!confirmLabel("Import " + file.name + "?")) return;
  const btn = $("importBtn");
  btn.disabled = true;
  const result = $("importResult");
  clear(result);
  try {
    const r = await api("POST", "/api/import", payload);
    result.append(chip("snapshot " + (r.snapshotId || ""), "ok"));
    for (const [k, v] of Object.entries(r.counts || {})) result.append(chip(k + " " + v));
    $("importFile").value = "";
  } catch (e) {
    flash(status("export"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ boot

showTab(location.hash.slice(1) || "now");
