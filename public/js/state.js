// State: the approved record. Now, Timeline, Facts, Unknowns, Inbox, Rulebook, Export.
import { api, h, chip, clear, download, flash, fmtDate, fmtTime, today } from "./api.js";

const $ = (id) => document.getElementById(id);
const TABS = ["now", "timeline", "facts", "unknowns", "inbox", "rulebook", "export"];
const KINDS = ["avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown"];

const loaders = {
  now: loadNow,
  timeline: loadTimeline,
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
  } catch (e) {
    flash(status("now"), e.code, "danger");
  }
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
    } catch (e) {
      flash($(ed.status), e.code, "danger");
    } finally {
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------ Timeline

async function loadTimeline() {
  const box = $("timelineList");
  clear(box);
  try {
    const bundle = await api("GET", "/api/state");
    const rows = bundle.history || [];
    if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
    for (const row of rows) box.append(historyCard(row));
    box.append(historyAddCard());
  } catch (e) {
    flash(status("timeline"), e.code, "danger");
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
        loadTimeline();
      } catch (e) {
        save.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  const versions = h("div", { class: "stack tight hidden" });
  const showVersions = h("button", {
    type: "button", class: "btn", text: "Versions",
    onclick: () => toggleVersionList("history", row.id, versions, slot, loadTimeline, (v) => v.title),
  });
  const del = h("button", {
    type: "button", class: "btn danger", text: "Delete",
    onclick: async () => {
      if (!confirmLabel("Delete?")) return;
      del.disabled = true;
      try {
        await api("DELETE", "/api/history/" + encode(row.id));
        loadTimeline();
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
        loadTimeline();
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

async function loadFacts() {
  try {
    const bundle = await api("GET", "/api/state");
    const facts = bundle.facts || {};
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

  return h("div", { class: "card stack" },
    h("div", { class: "row" },
      chip(p.kind, "accent"),
      p.confidence ? chip(p.confidence, p.confidence === "high" ? "ok" : p.confidence === "low" ? "amber" : "") : null,
      p.scope ? chip(p.scope) : null,
      h("span", { class: "muted small", text: fmtTime(p.created_at) })),
    h("div", { class: "proposal-text", text: p.proposal }),
    p.evidence ? h("blockquote", { class: "evidence", text: p.evidence }) : null,
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
  const adaptations = rb.adaptations ?? rb.adaptationList ?? rb.overlay ?? null;
  const alwaysOn = rb.alwaysOn ?? rb.always_on ?? rb.ALWAYS_ON ?? null;
  if (adaptations) {
    extra.append(h("h2", { class: "section-title", text: "Adaptations" }));
    if (Array.isArray(adaptations)) {
      extra.append(h("ul", { class: "plain small" }, adaptations.map((a) => h("li", { text: typeof a === "string" ? a : JSON.stringify(a) }))));
    } else {
      extra.append(h("pre", { class: "rule", text: typeof adaptations === "string" ? adaptations : JSON.stringify(adaptations, null, 2) }));
    }
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

$("exportJson").addEventListener("click", async () => {
  const btn = $("exportJson");
  btn.disabled = true;
  try {
    const data = await api("GET", "/api/export");
    download("avelie-export-" + today() + ".json", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    flash(status("export"), "exported", "ok");
  } catch (e) {
    flash(status("export"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

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
