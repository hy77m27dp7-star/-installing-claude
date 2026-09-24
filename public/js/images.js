// Images: masters with hashes and Verify, the candidate queue, approved scenes, the rejected list.
import { api, h, chip, clear, flash, bytesLabel, fmtTime } from "./api.js";

const $ = (id) => document.getElementById(id);

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

// ------------------------------------------------------------ masters

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

// ------------------------------------------------------------ candidates and scenes

function decideButtons(id, slot) {
  const approve = h("button", { type: "button", class: "btn small", text: "Approve" });
  const reject = h("button", { type: "button", class: "btn small danger", text: "Reject" });
  const act = async (decision) => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      await api("POST", "/api/images/" + encode(id) + "/decide", { decision });
      load();
    } catch (e) {
      approve.disabled = false;
      reject.disabled = false;
      flash(slot, e.code, "danger");
    }
  };
  approve.addEventListener("click", () => act("approve"));
  reject.addEventListener("click", () => act("reject"));
  return [approve, reject];
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

// ------------------------------------------------------------ rejected

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

load();
