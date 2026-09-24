// Images: masters with hashes and Verify, the candidate queue, approved scenes, the rejected
// list, and the library of media she may send.
import { api, apiForm, h, chip, clear, flash, bytesLabel, fmtTime } from "./api.js";

const $ = (id) => document.getElementById(id);
const TABS = ["photos", "library"];
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

let verifyResults = null;

function basename(file) {
  const parts = String(file || "").split("/");
  return parts[parts.length - 1] || String(file || "");
}

function hashPrefix(sha) {
  return sha ? String(sha).slice(0, 16) : "none";
}

function encode(id) {
  return encodeURIComponent(String(id));
}

// ------------------------------------------------------------ tabs

function showTab(name) {
  if (!TABS.includes(name)) name = "photos";
  for (const t of TABS) $("tab-" + t).classList.toggle("hidden", t !== name);
  document.querySelectorAll(".tabs button").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "photos") load();
  else loadLibrary();
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------ photos

async function load() {
  try {
    const a = await api("GET", "/api/assets");
    renderMasters(a.masters || []);
    renderCandidates(a.candidates || []);
    renderScenes(a.scenes || []);
    renderRejected(a.rejected || []);
  } catch (e) {
    flash($("images-status"), e.code, "danger");
  }
}

function verifyChip(id) {
  if (!verifyResults) return null;
  const r = verifyResults.get(id);
  if (!r) return chip("missing", "danger");
  return chip(r.ok ? "PASS" : "FAIL", r.ok ? "ok" : "danger");
}

function renderMasters(rows) {
  const box = $("masters");
  clear(box);
  if (!rows.length) box.append(chip("none"));
  for (const m of rows) {
    box.append(h("div", { class: "img-card", "data-id": m.id },
      h("img", { src: "/images/masters/" + encodeURIComponent(basename(m.file)), alt: "", loading: "lazy" }),
      h("div", { class: "body" },
        h("div", { class: "mono", text: basename(m.file) }),
        h("div", { class: "row" },
          h("span", { class: "mono muted", title: m.sha256 || "", text: hashPrefix(m.sha256) }),
          h("span", { class: "muted small", text: bytesLabel(m.bytes) })),
        h("div", { class: "chips verify-slot" }, verifyChip(m.id)))));
  }
}

$("verifyBtn").addEventListener("click", async () => {
  const btn = $("verifyBtn");
  btn.disabled = true;
  const all = $("verifyAll");
  clear(all);
  try {
    const r = await api("POST", "/api/assets/verify");
    verifyResults = new Map((r.results || []).map((x) => [x.id, x]));
    for (const card of $("masters").querySelectorAll(".img-card")) {
      const slot = card.querySelector(".verify-slot");
      if (!slot) continue;
      clear(slot);
      const c = verifyChip(card.dataset.id);
      if (c) slot.append(c);
    }
    all.append(chip(r.allOk ? "ALL PASS" : "FAIL", r.allOk ? "ok" : "danger"));
  } catch (e) {
    all.append(chip(e.code || "error", "danger"));
  } finally {
    btn.disabled = false;
  }
});

function decideButtons(id, slot) {
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const regen = h("button", { type: "button", class: "btn small quiet", text: "Regenerate" });
  const all = [approve, reject, regen];
  const lock = (on) => { for (const b of all) b.disabled = on; };
  const act = async (decision) => {
    lock(true);
    try {
      await api("POST", "/api/images/" + encode(id) + "/decide", { decision });
      load();
    } catch (e) {
      lock(false);
      flash(slot, e.code, "danger");
    }
  };
  approve.addEventListener("click", () => act("approve"));
  reject.addEventListener("click", () => act("reject"));
  // Reject and ask again with the same description; the page holds the request open.
  regen.addEventListener("click", async () => {
    lock(true);
    try {
      await api("POST", "/api/images/" + encode(id) + "/regenerate", {});
      load();
    } catch (e) {
      lock(false);
      flash(slot, e.code, "danger");
    }
  });
  return all;
}

function imageCard(a, withButtons) {
  const slot = h("span", { class: "chips" });
  return h("div", { class: "img-card", "data-id": a.id },
    h("img", { src: "/media/" + encode(a.id), alt: "", loading: "lazy" }),
    h("div", { class: "body" },
      a.prompt ? h("div", { class: "prompt", text: a.prompt }) : null,
      h("div", { class: "chips" },
        a.provider ? chip(a.provider) : null,
        a.model ? chip(a.model) : null,
        h("span", { class: "mono muted", title: a.sha256 || "", text: hashPrefix(a.sha256) })),
      h("div", { class: "muted small", text: fmtTime(a.decided_at || a.created_at) }),
      withButtons ? h("div", { class: "row" }, decideButtons(a.id, slot), slot) : null));
}

function renderCandidates(rows) {
  const box = $("candidates");
  clear(box);
  if (!rows.length) box.append(chip("none"));
  for (const a of rows) box.append(imageCard(a, true));
}

function renderScenes(rows) {
  const box = $("scenes");
  clear(box);
  if (!rows.length) box.append(chip("none"));
  for (const a of rows) box.append(imageCard(a, false));
}

function renderRejected(rows) {
  const box = $("rejected");
  clear(box);
  if (!rows.length) box.append(chip("none"));
  for (const a of rows) {
    box.append(h("div", { class: "list-row" },
      h("span", { class: "mono", text: a.id }),
      h("span", { class: "mono muted", title: a.sha256 || "", text: hashPrefix(a.sha256) }),
      h("span", { class: "muted small", text: fmtTime(a.decided_at || a.created_at) }),
      h("span", { class: "grow small", text: a.notes || "" })));
  }
}

// ------------------------------------------------------------ library

async function loadLibrary() {
  const box = $("libraryList");
  clear(box);
  let rows;
  try {
    const r = await api("GET", "/api/media");
    rows = Array.isArray(r) ? r : (r && (r.items || r.media || r.rows)) || [];
  } catch (e) {
    box.append(chip(e.code, "danger"));
    return;
  }
  if (!rows.length) box.append(chip("none"));
  for (const m of rows) box.append(libraryRow(m));
}

function libraryRow(m) {
  const slot = h("span", { class: "chips" });
  const del = h("button", {
    type: "button", class: "btn small danger", text: "Delete",
    onclick: async () => {
      if (!window.confirm("Delete?")) return;
      del.disabled = true;
      try {
        await api("DELETE", "/api/media/" + encode(m.id));
        loadLibrary();
      } catch (e) {
        del.disabled = false;
        flash(slot, e.code, "danger");
      }
    },
  });
  return h("div", { class: "list-row" },
    chip(m.kind || "other", "accent"),
    h("span", { class: "grow" },
      h("span", { text: m.title || m.id }),
      m.description ? h("span", { class: "muted small", text: " " + m.description }) : null),
    h("span", { class: "muted small", text: bytesLabel(m.bytes) }),
    h("span", { class: "muted small", text: fmtTime(m.created_at) }),
    h("a", { class: "btn small", href: "/media/library/" + encode(m.id), target: "_blank", rel: "noopener", text: "Open" }),
    del,
    slot);
}

$("mediaUpload").addEventListener("click", async () => {
  const slot = $("upload-status");
  const file = $("mediaFile").files[0];
  const title = $("mediaTitle").value.trim();
  if (!file) { flash(slot, "no file", "danger"); return; }
  if (!title) { flash(slot, "title", "danger"); return; }
  if (file.size > MAX_MEDIA_BYTES) { flash(slot, "25 MB max", "danger"); return; }
  const btn = $("mediaUpload");
  btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append("file", file, file.name || "media");
    fd.append("title", title);
    fd.append("description", $("mediaDescription").value.trim());
    fd.append("kind", $("mediaKind").value);
    await apiForm("POST", "/api/media", fd);
    $("mediaFile").value = "";
    $("mediaTitle").value = "";
    $("mediaDescription").value = "";
    flash(slot, "uploaded", "ok");
    loadLibrary();
  } catch (e) {
    flash(slot, e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ boot

showTab(location.hash.slice(1) || "photos");
