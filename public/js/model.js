// Model: settings form (with the price table), usage panel, system panel.
import { api, h, chip, clear, flash, usd } from "./api.js";

const $ = (id) => document.getElementById(id);
const form = $("settingsForm");

const FIELDS = [
  "provider", "model", "effort", "temperature", "maxTokens",
  "proposalsEnabled", "proposalProvider", "proposalModel",
  "imageProvider", "imageModel", "imageQuality", "imageSize", "imageCostUsd",
  "dailyCapUsd", "monthlyCapUsd",
];
const NUMERIC = new Set(["temperature", "maxTokens", "imageCostUsd", "dailyCapUsd", "monthlyCapUsd"]);
const BOOL = new Set(["proposalsEnabled"]);

// The settings as the server last served them. A save sends only what differs from this,
// so a cap change never re-asserts the model line (the server checks a model only when
// the patch names it or the prices), and the audit row lists just what changed.
let loaded = null;
let loadedPrices = "";

function fill(s) {
  loaded = s;
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el) continue;
    if (BOOL.has(k)) el.checked = !!s[k];
    else el.value = s[k] === undefined || s[k] === null ? "" : String(s[k]);
  }
  fillPrices(s.prices);
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el) continue;
    let v;
    if (BOOL.has(k)) v = el.checked;
    else if (NUMERIC.has(k)) v = Number(el.value);
    else v = el.value.trim();
    if (loaded && loaded[k] === v) continue;
    out[k] = v;
  }
  return out;
}

// The page shows a full-sentence error for a save: the server's message names the field
// and what to do (the code alone, "validation", says nothing useful).
function fail(slot, e) {
  flash(slot, e && e.message ? e.message : (e && e.code) || "error", "danger wrap");
}

// ------------------------------------------------------------------ prices

const priceRows = $("priceRows");

function priceRow(model, p) {
  const tr = h("tr", null,
    h("td", null, h("input", { type: "text", class: "price-model", value: model, maxlength: "200", placeholder: "model id", "aria-label": "Model id", autocomplete: "off" })),
    h("td", { class: "num" }, h("input", { type: "number", class: "price-in", value: p.inputPerMTok, min: "0", step: "any", inputmode: "decimal", "aria-label": "Input price per million tokens" })),
    h("td", { class: "num" }, h("input", { type: "number", class: "price-out", value: p.outputPerMTok, min: "0", step: "any", inputmode: "decimal", "aria-label": "Output price per million tokens" })),
    h("td", null, h("button", { type: "button", class: "btn small ghost", text: "Remove", onclick: () => tr.remove() })));
  return tr;
}

function normalizePrices(prices) {
  const out = {};
  const src = prices && typeof prices === "object" ? prices : {};
  for (const model of Object.keys(src).sort()) {
    const p = src[model];
    if (!p || typeof p.inputPerMTok !== "number" || typeof p.outputPerMTok !== "number") continue;
    out[model] = { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok };
  }
  return out;
}

function fillPrices(prices) {
  const table = normalizePrices(prices);
  loadedPrices = JSON.stringify(table);
  clear(priceRows);
  for (const [model, p] of Object.entries(table)) priceRows.append(priceRow(model, p));
}

// The table as typed. Throws a plain message for a row that cannot be sent; an entirely
// empty row is skipped.
function collectPrices() {
  const out = {};
  for (const tr of priceRows.querySelectorAll("tr")) {
    const model = tr.querySelector(".price-model").value.trim();
    const inRaw = tr.querySelector(".price-in").value.trim();
    const outRaw = tr.querySelector(".price-out").value.trim();
    if (!model && !inRaw && !outRaw) continue;
    if (!model) throw new Error("prices: a row has no model id");
    const inputPerMTok = Number(inRaw);
    const outputPerMTok = Number(outRaw);
    if (!inRaw || !outRaw || !Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok) || inputPerMTok < 0 || outputPerMTok < 0) {
      throw new Error("prices: " + model + " needs an input and an output price of 0 or more");
    }
    if (out[model]) throw new Error("prices: " + model + " is listed twice");
    out[model] = { inputPerMTok, outputPerMTok };
  }
  return out;
}

$("addPriceBtn").addEventListener("click", () => {
  const tr = priceRow("", { inputPerMTok: "", outputPerMTok: "" });
  priceRows.append(tr);
  tr.querySelector(".price-model").focus();
});

// ------------------------------------------------------------------ settings

async function loadSettings() {
  try {
    fill(await api("GET", "/api/settings"));
  } catch (e) {
    flash($("settings-status"), e.code, "danger");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("saveBtn");
  const patch = collect();
  for (const k of NUMERIC) {
    if (k in patch && !Number.isFinite(patch[k])) {
      flash($("settings-status"), k, "danger");
      return;
    }
  }
  let prices;
  try {
    prices = collectPrices();
  } catch (e1) {
    fail($("settings-status"), e1);
    return;
  }
  if (JSON.stringify(normalizePrices(prices)) !== loadedPrices) patch.prices = prices;
  btn.disabled = true;
  try {
    const s = await api("PUT", "/api/settings", patch);
    fill(s);
    flash($("settings-status"), Object.keys(patch).length ? "saved" : "nothing to save", "ok");
    loadUsage();
    loadSystem();
  } catch (e2) {
    fail($("settings-status"), e2);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ usage and system

async function loadUsage() {
  try {
    const u = await api("GET", "/api/usage");
    $("usageToday").textContent = usd(u.todayUsd);
    $("usageTodayCap").textContent = "cap " + usd(u.dailyCapUsd);
    $("usageMonth").textContent = usd(u.monthUsd);
    $("usageMonthCap").textContent = "cap " + usd(u.monthlyCapUsd);
    const tbody = $("usageRows");
    clear(tbody);
    const rows = Array.isArray(u.byDay) ? u.byDay : [];
    if (!rows.length) tbody.append(h("tr", null, h("td", { colspan: "7" }, chip("none"))));
    for (const r of rows) {
      tbody.append(h("tr", null,
        h("td", { class: "mono", text: r.day }),
        h("td", { text: r.provider }),
        h("td", { class: "mono", text: r.model }),
        h("td", { class: "num", text: r.requests }),
        h("td", { class: "num", text: r.inputTokens }),
        h("td", { class: "num", text: r.outputTokens }),
        h("td", { class: "num", text: usd(r.costUsd) })));
    }
  } catch (e) {
    flash($("usage-status"), e.code, "danger");
  }
}

async function loadSystem() {
  try {
    const s = await api("GET", "/api/system");
    $("sysConstitution").textContent = s.constitutionVersion || "";
    $("sysPrompt").textContent = s.promptVersion || "";
    const keys = s.providerKeys || {};
    $("keyAnthropic").classList.toggle("on", !!keys.anthropic);
    $("keyOpenai").classList.toggle("on", !!keys.openai);
    const counts = $("sysCounts");
    clear(counts);
    for (const [k, v] of Object.entries(s.counts || {})) {
      counts.append(h("span", { class: "k", text: k }), h("span", { class: "v", text: String(v) }));
    }
  } catch (e) {
    flash($("system-status"), e.code, "danger");
  }
}

loadSettings();
loadUsage();
loadSystem();
