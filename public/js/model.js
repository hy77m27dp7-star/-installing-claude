// Model: settings form, usage panel, system panel.
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

function fill(s) {
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el) continue;
    if (BOOL.has(k)) el.checked = !!s[k];
    else el.value = s[k] === undefined || s[k] === null ? "" : String(s[k]);
  }
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el) continue;
    if (BOOL.has(k)) out[k] = el.checked;
    else if (NUMERIC.has(k)) out[k] = Number(el.value);
    else out[k] = el.value.trim();
  }
  return out;
}

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
    if (!Number.isFinite(patch[k])) {
      flash($("settings-status"), k, "danger");
      return;
    }
  }
  btn.disabled = true;
  try {
    const s = await api("PUT", "/api/settings", patch);
    fill(s);
    flash($("settings-status"), "saved", "ok");
    loadUsage();
    loadSystem();
  } catch (e2) {
    flash($("settings-status"), e2.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

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
