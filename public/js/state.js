// State: the approved record. Now, Life, History, Facts, Unknowns, Inbox, Rulebook, Export.
import { api, h, chip, clear, download, flash, flagCodes, fmtDate, fmtTime, fromLocalInput, parseJson, today, toLocalInput } from "./api.js";

const $ = (id) => document.getElementById(id);
const TABS = ["now", "life", "history", "facts", "unknowns", "inbox", "rulebook", "export"];
const KINDS = ["avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown", "life"];
const LIFE_KINDS = [["routine", "Routines"], ["event", "Events"], ["person", "People"], ["place", "Places"], ["arc", "Arcs"]];
// Monday first on screen; the numbers follow JavaScript's getDay (Sunday = 0).
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NUMS = [1, 2, 3, 4, 5, 6, 0];
const OPINION_RE = /^\s*opinion\b/i;

const loaders = {
  now: loadNow,
  life: loadLife,
  history: loadHistory,
  facts: loadFacts,
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

async function loadNow() {
  try {
    const bundle = await api("GET", "/api/state");
    for (const ed of EDITORS) {
      fillEditor(ed, bundle[ed.entity]);
      loadVersions(ed);
    }
    fillMood(bundle.relationship && bundle.relationship.state ? bundle.relationship.state : {});
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
      if (ed.entity === "relationship") fillMood(r.state || {});
    } catch (e) {
      flash($(ed.status), e.code, "danger");
    } finally {
      btn.disabled = false;
    }
  });
}

// Mood and cooling off: two fields of the relationship state with their own controls.
function fillMood(st) {
  $("moodInput").value = st.mood ? String(st.mood) : "";
  $("coolInput").value = toLocalInput(st.cooling_off_until || null);
  const chips = $("moodChips");
  clear(chips);
  const until = st.cooling_off_until ? Date.parse(st.cooling_off_until) : NaN;
  if (Number.isFinite(until) && until > Date.now()) chips.append(chip("cooling off", "amber"));
}

async function saveMood(mood, coolingIso, note) {
  const slot = $("moodStatus");
  $("moodSave").disabled = true;
  $("moodClear").disabled = true;
  try {
    const bundle = await api("GET", "/api/state");
    const cur = bundle.relationship && bundle.relationship.state ? bundle.relationship.state : {};
    const next = { ...cur, mood, cooling_off_until: coolingIso };
    const r = await api("PUT", "/api/state/relationship", { state: next, note });
    fillEditor(EDITORS[0], r);
    fillMood(r.state || next);
    flash(slot, "saved v" + r.version, "ok");
    loadVersions(EDITORS[0]);
  } catch (e) {
    flash(slot, e.code, "danger");
  } finally {
    $("moodSave").disabled = false;
    $("moodClear").disabled = false;
  }
}

$("moodSave").addEventListener("click", () => saveMood(orNull($("moodInput").value), fromLocalInput($("coolInput").value), "mood"));
$("moodClear").addEventListener("click", () => {
  $("moodInput").value = "";
  $("coolInput").value = "";
  saveMood(null, null, "clear");
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

// ------------------------------------------------------------ Life

let lifeStatus = "active";
let lifeTz = "America/New_York";
let lifeData = { threads: [], log: [] };

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
    const [r, settings] = await Promise.all([
      api("GET", "/api/life?status=" + lifeStatus),
      api("GET", "/api/settings").catch(() => null),
    ]);
    if (settings && typeof settings.timezone === "string" && settings.timezone) lifeTz = settings.timezone;
    lifeData = { threads: Array.isArray(r.threads) ? r.threads : [], log: Array.isArray(r.log) ? r.log : [] };
  } catch (e) {
    flash(status("life"), e.code, "danger");
    return;
  }
  for (const [kind, label] of LIFE_KINDS) box.append(lifeGroup(kind, label, lifeData.threads.filter((t) => t.kind === kind)));
  renderLog();
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
  return h("div", { class: "thread-row" },
    h("div", { class: "t" }, t.title, " ", h("span", { class: "chips" }, summary, chip("v" + t.version), t.status !== "active" ? chip(t.status, "amber") : null)),
    h("div", { class: "actions" }, edit, toggle, slot),
    t.detail ? h("div", { class: "d", text: t.detail }) : null,
    editor);
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

// ------------------------------------------------------------ History

async function loadHistory() {
  const box = $("historyList");
  clear(box);
  try {
    const bundle = await api("GET", "/api/state");
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
      h("span", { class: "muted small", text: fmtTime(row.updated_at || row.created_at) })),
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
    const bundle = await api("GET", "/api/state");
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
  return h("div", { class: "card stack tight" },
    h("div", { class: "row" },
      chip("v" + f.version),
      f.source ? chip(f.source) : null,
      h("span", { class: "muted small", text: fmtTime(f.updated_at || f.created_at) })),
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
  const editKind = h("select", null, KINDS.map((k) => h("option", { value: k, selected: k === p.kind, text: k })));
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
