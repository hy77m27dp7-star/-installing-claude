// Images: masters with hashes and Verify, the candidate queue, approved scenes, the rejected
// list, the library of media she may send; v3 adds Clips (short videos of her, owner-made)
// and Portraits (the faces of the people in her life, by person).
import { api, apiForm, h, chip, clear, flash, bytesLabel, fmtTime } from "./api.js";

const $ = (id) => document.getElementById(id);
const TABS = ["photos", "clips", "portraits", "library"];
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
// A pending clip is polled every 5 s for up to 10 minutes (SPEC_V3 FF).
const CLIP_POLL_MS = 5000;
const CLIP_POLL_MAX = 120;

let verifyResults = null;
let clipSource = null;
const clipPollers = new Map();
const clipPending = new Map();

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

// Every row /api/assets carries, once, whatever list it sits in (the v3 roles portrait and
// video may arrive in their own lists or inside the v1 ones).
function allAssets(assets) {
  const out = [];
  const seen = new Set();
  if (!assets || typeof assets !== "object") return out;
  for (const list of Object.values(assets)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || !a.id || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
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
  else if (name === "clips") loadClips();
  else if (name === "portraits") loadPortraits();
  else loadLibrary();
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------ photos

async function load() {
  try {
    const a = await api("GET", "/api/assets");
    renderMasters(a.masters || []);
    renderCandidates((a.candidates || []).filter((x) => x.role !== "video" && x.role !== "portrait"));
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

function decideButtons(id, slot, reload, withRegenerate) {
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const regen = withRegenerate ? h("button", { type: "button", class: "btn small quiet", text: "Regenerate" }) : null;
  const all = [approve, reject, regen].filter(Boolean);
  const lock = (on) => { for (const b of all) b.disabled = on; };
  const act = async (decision) => {
    lock(true);
    try {
      await api("POST", "/api/images/" + encode(id) + "/decide", { decision });
      reload();
    } catch (e) {
      lock(false);
      flash(slot, e.code, "danger");
    }
  };
  approve.addEventListener("click", () => act("approve"));
  reject.addEventListener("click", () => act("reject"));
  // Reject and ask again with the same description; the page holds the request open.
  if (regen) {
    regen.addEventListener("click", async () => {
      lock(true);
      try {
        await api("POST", "/api/images/" + encode(id) + "/regenerate", {});
        reload();
      } catch (e) {
        lock(false);
        flash(slot, e.code, "danger");
      }
    });
  }
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
      withButtons ? h("div", { class: "row" }, decideButtons(a.id, slot, load, true), slot) : null));
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

// ------------------------------------------------------------ clips (SPEC_V3 FF)

async function loadClips() {
  let assets;
  let settings = null;
  let system = null;
  try {
    [assets, settings, system] = await Promise.all([
      api("GET", "/api/assets"),
      api("GET", "/api/settings").catch(() => null),
      api("GET", "/api/system").catch(() => null),
    ]);
  } catch (e) {
    flash($("clips-status"), e.code, "danger");
    return;
  }
  // Every video control is hidden when clips are off or the provider has no key.
  const provider = settings && typeof settings.videoProvider === "string" ? settings.videoProvider : null;
  const keys = system && system.providerKeys && typeof system.providerKeys === "object" ? system.providerKeys : {};
  const configured = provider && provider !== "off" && !(provider === "runway" && keys.runway === false);
  $("clipMake").classList.toggle("hidden", !configured);
  const slot = $("clips-status");
  clear(slot);
  if (!provider || provider === "off") slot.append(chip("clips off"));
  else if (!configured) slot.append(chip("no key"));
  const rows = allAssets(assets);
  const sources = [...(assets.masters || []), ...(assets.scenes || [])];
  renderClipSources(sources);
  const videos = rows.filter((a) => a.role === "video");
  const candidates = videos.filter((a) => a.approval_status === "candidate");
  const pending = videos.filter((a) => a.approval_status === "generating" || a.approval_status === "pending");
  const approved = videos.filter((a) => a.approval_status === "approved");
  for (const a of pending) if (!clipPending.has(a.id)) clipPending.set(a.id, a);
  renderClipCandidates(candidates);
  renderClipApproved(approved);
  for (const id of clipPending.keys()) startClipPoll(id);
}

function renderClipSources(rows) {
  const box = $("clipSources");
  clear(box);
  if (!rows.length) { box.append(chip("none")); return; }
  if (clipSource && !rows.some((a) => a.id === clipSource)) clipSource = null;
  for (const a of rows) {
    const src = a.role === "master" ? "/images/masters/" + encodeURIComponent(basename(a.file)) : "/media/" + encode(a.id);
    const btn = h("button", { type: "button", "aria-pressed": String(clipSource === a.id), "aria-label": a.role === "master" ? basename(a.file) : "photo " + fmtTime(a.created_at), title: a.prompt || basename(a.file) || "" },
      h("img", { src, alt: "", loading: "lazy" }));
    btn.addEventListener("click", () => {
      clipSource = a.id;
      for (const b of box.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
    });
    box.append(btn);
  }
}

function clipCard(a, withButtons) {
  const slot = h("span", { class: "chips" });
  const pending = clipPending.has(a.id) || a.approval_status === "generating" || a.approval_status === "pending";
  const media = pending
    ? h("div", { class: "clip-pending", "aria-label": "Clip pending" })
    : h("video", { controls: true, playsinline: true, preload: "metadata", src: "/media/" + encode(a.id) });
  return h("div", { class: "img-card clip-card", "data-id": a.id },
    media,
    h("div", { class: "body" },
      a.prompt ? h("div", { class: "prompt", text: a.prompt }) : null,
      h("div", { class: "chips" },
        pending ? chip(a.approval_status || "generating", "amber") : null,
        a.provider ? chip(a.provider) : null,
        a.model ? chip(a.model) : null,
        a.sha256 ? h("span", { class: "mono muted", title: a.sha256, text: hashPrefix(a.sha256) }) : null),
      h("div", { class: "muted small", text: fmtTime(a.decided_at || a.created_at) }),
      withButtons && !pending ? h("div", { class: "row" }, decideButtons(a.id, slot, loadClips, false), slot) : slot));
}

function renderClipCandidates(rows) {
  const box = $("clipCandidates");
  clear(box);
  const pending = [...clipPending.values()].filter((p) => !rows.some((r) => r.id === p.id));
  if (!rows.length && !pending.length) box.append(chip("none"));
  for (const a of pending) box.append(clipCard(a, false));
  for (const a of rows) box.append(clipCard(a, true));
}

function renderClipApproved(rows) {
  const box = $("clipApproved");
  clear(box);
  if (!rows.length) box.append(chip("none"));
  for (const a of rows) box.append(clipCard(a, false));
}

$("clipGenerate").addEventListener("click", async () => {
  const slot = $("clip-status");
  const description = $("clipMotion").value.trim();
  if (!clipSource) { flash(slot, "source", "danger"); return; }
  if (!description) { flash(slot, "motion", "danger"); return; }
  const btn = $("clipGenerate");
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/video/generate", { sourceAssetId: clipSource, description });
    const asset = r && r.asset && typeof r.asset === "object" ? r.asset : null;
    if (asset && asset.id) {
      clipPending.set(asset.id, asset);
      startClipPoll(asset.id);
    }
    $("clipMotion").value = "";
    flash(slot, "started", "ok");
    loadClips();
  } catch (e) {
    flash(slot, e.code + (e.detail && typeof e.detail === "string" ? " " + e.detail : ""), "danger wrap");
  } finally {
    btn.disabled = false;
  }
});

function startClipPoll(id) {
  if (clipPollers.has(id)) return;
  let count = 0;
  const timer = setInterval(async () => {
    count++;
    let r = null;
    try {
      r = await api("POST", "/api/video/" + encode(id) + "/poll", {});
    } catch (e) {
      if (e.status === 404 || e.status === 422) {
        stopClipPoll(id);
        clipPending.delete(id);
        flash($("clips-status"), e.code, "danger");
        loadClips();
      }
      return;
    }
    const status = r && r.status;
    if (status === "candidate" || status === "failed") {
      stopClipPoll(id);
      clipPending.delete(id);
      if (status === "failed") flash($("clips-status"), "clip failed", "danger");
      loadClips();
      return;
    }
    if (count >= CLIP_POLL_MAX) {
      stopClipPoll(id);
      clipPending.delete(id);
      flash($("clips-status"), "timeout", "danger");
      loadClips();
    }
  }, CLIP_POLL_MS);
  clipPollers.set(id, timer);
}

function stopClipPoll(id) {
  const t = clipPollers.get(id);
  if (t) clearInterval(t);
  clipPollers.delete(id);
}

// ------------------------------------------------------------ portraits (SPEC_V3 DD)

async function loadPortraits() {
  const box = $("portraitPeople");
  clear(box);
  let assets;
  let life;
  try {
    [assets, life] = await Promise.all([api("GET", "/api/assets"), api("GET", "/api/life?status=active")]);
  } catch (e) {
    flash($("portraits-status"), e.code, "danger");
    return;
  }
  const people = (life && Array.isArray(life.threads) ? life.threads : []).filter((t) => t.kind === "person");
  const byPerson = new Map();
  for (const a of allAssets(assets)) {
    const m = /^person:([^|\s]+)/.exec(String(a.notes || ""));
    if (a.role !== "portrait" && !m) continue;
    const key = m ? m[1] : "";
    const list = byPerson.get(key) || [];
    list.push(a);
    byPerson.set(key, list);
  }
  if (!people.length) { box.append(h("div", { class: "chips" }, chip("none"))); return; }
  for (const t of people) {
    const rows = byPerson.get(String(t.id)) || [];
    const approvedId = t.portrait_asset_id ? String(t.portrait_asset_id) : "";
    const candidates = rows.filter((a) => a.approval_status === "candidate");
    const approved = rows.filter((a) => a.approval_status === "approved" || a.id === approvedId);
    const grid = h("div", { class: "grid-imgs square" });
    if (approvedId && !approved.some((a) => a.id === approvedId)) approved.push({ id: approvedId, approval_status: "approved", created_at: t.updated_at || t.created_at });
    for (const a of candidates) grid.append(portraitCard(a, true));
    for (const a of approved) grid.append(portraitCard(a, false));
    if (!grid.childElementCount) grid.append(chip("no face yet"));
    box.append(h("div", { class: "card person-block" },
      h("div", { class: "row" }, h("span", { class: "person-name", text: t.title }), t.relation ? chip(t.relation, "accent") : null, approvedId ? chip("portrait", "ok") : null, candidates.length ? chip(candidates.length + " to decide", "amber") : null),
      grid));
  }
}

function portraitCard(a, withButtons) {
  const slot = h("span", { class: "chips" });
  return h("div", { class: "img-card", "data-id": a.id },
    h("img", { src: "/media/" + encode(a.id), alt: "", loading: "lazy" }),
    h("div", { class: "body" },
      a.prompt ? h("div", { class: "prompt", text: a.prompt }) : null,
      h("div", { class: "chips" },
        chip(a.approval_status || "approved", a.approval_status === "candidate" ? "amber" : "ok"),
        a.model ? chip(a.model) : null),
      h("div", { class: "muted small", text: fmtTime(a.decided_at || a.created_at) }),
      withButtons ? h("div", { class: "row" }, decideButtons(a.id, slot, loadPortraits, false), slot) : null));
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
