// Model: settings, her timing and voice, notifications, drift reports, voiceprint, usage, system.
import { api, h, chip, clear, flash, fmtDate, fmtTime, parseJson, registerServiceWorker, usd } from "./api.js";

const $ = (id) => document.getElementById(id);
const form = $("settingsForm");

const FIELDS = [
  "provider", "model", "effort", "temperature", "maxTokens",
  "replyDelayMode", "realDelayMaxMinutes", "timezone",
  "herFirstTextsPerDay", "herFirstQuietHours",
  "voiceProvider", "voiceMode", "elevenLabsVoiceId", "transcribeProvider",
  "proposalsEnabled", "proposalProvider", "proposalModel",
  "imageProvider", "imageModel", "imageQuality", "imageSize", "imageCostUsd",
  "dailyCapUsd", "monthlyCapUsd", "driftCheckEnabled",
];
const NUMERIC = new Set(["temperature", "maxTokens", "imageCostUsd", "dailyCapUsd", "monthlyCapUsd", "realDelayMaxMinutes", "herFirstTextsPerDay"]);
const BOOL = new Set(["proposalsEnabled", "driftCheckEnabled"]);

// Only keys the server returned go back in a save: a field the runtime does not know yet
// stays visible but disabled instead of failing the whole form.
let known = null;

function fill(s) {
  known = new Set(Object.keys(s || {}));
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el) continue;
    const has = known.has(k);
    el.disabled = !has;
    if (!has) continue;
    if (BOOL.has(k)) el.checked = !!s[k];
    else el.value = s[k] === undefined || s[k] === null ? "" : String(s[k]);
  }
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el || (known && !known.has(k))) continue;
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
    if (k in patch && !Number.isFinite(patch[k])) {
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

// ------------------------------------------------------------ her first texts

$("herFirstRun").addEventListener("click", async () => {
  const btn = $("herFirstRun");
  const slot = $("herfirst-status");
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/herfirst/run", {});
    const sent = r && (r.sent === true || r.ok === true && r.sent !== false);
    const reason = r && (r.reason || r.skipped || r.status);
    flash(slot, sent ? "sent" : reason ? String(reason) : "ok", sent ? "ok" : "");
  } catch (e) {
    flash(slot, e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ notifications

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

async function subscribePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw Object.assign(new Error("denied"), { code: "denied" });
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const r = await api("GET", "/api/push/public-key");
  const key = typeof r === "string" ? r : r && (r.publicKey || r.key || r.vapidPublicKey);
  if (!key) throw Object.assign(new Error("no key"), { code: "no_key" });
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(String(key)) });
  await api("POST", "/api/push/subscribe", sub.toJSON());
}

async function unsubscribePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  try { await api("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint }); } catch { /* server side is best effort */ }
  await sub.unsubscribe();
}

async function initPush() {
  const box = $("pushBox");
  const toggle = $("pushToggle");
  const slot = $("push-status");
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) {
    box.classList.add("hidden");
    return;
  }
  try {
    toggle.checked = !!(await currentSubscription());
  } catch {
    toggle.checked = false;
  }
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    const want = toggle.checked;
    try {
      if (want) await subscribePush();
      else await unsubscribePush();
      flash(slot, want ? "on" : "off", "ok");
    } catch (e) {
      toggle.checked = !want;
      flash(slot, e.code || "error", "danger");
    } finally {
      toggle.disabled = false;
    }
  });
}

// ------------------------------------------------------------ drift

function flagCount(s) {
  if (!s || typeof s !== "object") return 0;
  if (typeof s.flagCount === "number") return s.flagCount;
  if (typeof s.totalFlags === "number") return s.totalFlags;
  if (typeof s.flags === "number") return s.flags;
  if (Array.isArray(s.flags)) return s.flags.length;
  if (s.flags && typeof s.flags === "object") return Object.values(s.flags).reduce((a, b) => a + (Number(b) || 0), 0);
  return 0;
}

function scenarioChips(summary) {
  const list = Array.isArray(summary) ? summary
    : summary && Array.isArray(summary.scenarios) ? summary.scenarios
      : summary && Array.isArray(summary.results) ? summary.results : null;
  if (list) {
    return list.map((s) => {
      const n = flagCount(s);
      const name = (s && (s.name || s.id || s.scenario || s.title)) || "scenario";
      return chip(name + " " + n, n ? "amber" : "ok");
    });
  }
  if (summary && typeof summary === "object") {
    const nested = Object.entries(summary).filter(([, v]) => v && typeof v === "object");
    if (nested.length) return nested.map(([k, v]) => { const n = flagCount(v); return chip(k + " " + n, n ? "amber" : "ok"); });
    return Object.entries(summary).map(([k, v]) => chip(k + " " + String(v).slice(0, 40)));
  }
  return [chip("none")];
}

function driftRow(row) {
  const summary = parseJson(row.json, null) ?? row.summary ?? null;
  return h("div", { class: "report-row" },
    h("div", { class: "row" },
      h("span", { class: "small", text: fmtTime(row.ran_at || row.ranAt || row.created_at) }),
      row.provider ? chip(row.provider) : null,
      row.model ? chip(row.model) : null,
      row.prompt_version ? chip(row.prompt_version) : null),
    h("div", { class: "chips" }, scenarioChips(summary)));
}

async function loadDrift() {
  const box = $("driftList");
  clear(box);
  try {
    const r = await api("GET", "/api/drift");
    const rows = Array.isArray(r) ? r : (r && (r.reports || r.rows)) || [];
    if (!rows.length) box.append(h("div", { class: "chips" }, chip("none")));
    for (const row of rows.slice(0, 4)) box.append(driftRow(row));
  } catch (e) {
    box.append(h("div", { class: "chips" }, chip(e.code, "danger")));
    if (e.status === 404) $("driftRun").disabled = true;
  }
}

$("driftRun").addEventListener("click", async () => {
  const btn = $("driftRun");
  btn.disabled = true;
  try {
    await api("POST", "/api/drift/run", {});
    flash($("drift-status"), "ran", "ok");
    loadDrift();
  } catch (e) {
    flash($("drift-status"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ voiceprint

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return null;
}

function num(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return digits === undefined ? String(n) : n.toFixed(digits);
}

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return (n <= 1 ? n * 100 : n).toFixed(0) + "%";
}

// A small inline line: no chart library, just a path across the last weeks.
function sparkline(values, label) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 120 28");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (nums.length >= 2) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const step = 112 / (nums.length - 1);
    const d = nums.map((v, i) => (i ? "L" : "M") + (4 + i * step).toFixed(1) + " " + (24 - ((v - min) / span) * 20).toFixed(1)).join(" ");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return h("span", { class: "row" }, svg, h("span", { class: "small muted", text: label }));
}

async function loadVoiceprint() {
  const box = $("voiceprintBox");
  const tbody = $("voiceprintRows");
  const sparks = $("voiceprintSparks");
  let rows;
  try {
    const r = await api("GET", "/api/voiceprint");
    rows = Array.isArray(r) ? r : (r && (r.voiceprints || r.rows)) || [];
  } catch {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  clear(tbody);
  clear(sparks);
  const list = rows.slice(0, 8).map((row) => ({ row, j: parseJson(row.json, null) || row.stats || row }));
  if (!list.length) {
    tbody.append(h("tr", null, h("td", { colspan: "8" }, chip("none"))));
    return;
  }
  for (const { row, j } of list) {
    const flags = pick(j, ["flagsTotal", "flagCount", "totalFlags"]);
    const perCode = pick(j, ["flagsPerCode", "flags"]);
    const flagText = flags !== null ? num(flags) : perCode && typeof perCode === "object" ? num(Object.values(perCode).reduce((a, b) => a + (Number(b) || 0), 0)) : "";
    tbody.append(h("tr", null,
      h("td", { class: "mono", text: row.week || fmtDate(row.created_at) }),
      h("td", { class: "num", text: num(pick(j, ["count", "messages", "n"])) }),
      h("td", { class: "num", text: num(pick(j, ["meanLength", "mean", "mean_length"]), 0) }),
      h("td", { class: "num", text: num(pick(j, ["medianLength", "median", "median_length"]), 0) }),
      h("td", { class: "num", text: pct(pick(j, ["questionShare", "question_share", "questions"])) }),
      h("td", { class: "num", text: num(pick(j, ["bubblesPerReply", "bubbles", "bubble_count"]), 1) }),
      h("td", { class: "num", text: num(pick(j, ["firstTexts", "first_texts", "firstTextCount"])) }),
      h("td", { class: "num", text: flagText })));
  }
  const chrono = list.slice().reverse();
  sparks.append(sparkline(chrono.map(({ j }) => pick(j, ["meanLength", "mean", "mean_length"])), "length"));
  sparks.append(sparkline(chrono.map(({ j }) => pick(j, ["questionShare", "question_share", "questions"])), "questions"));
}

$("voiceprintRun").addEventListener("click", async () => {
  const btn = $("voiceprintRun");
  btn.disabled = true;
  try {
    await api("POST", "/api/voiceprint/run", {});
    flash($("voiceprint-status"), "ran", "ok");
    loadVoiceprint();
  } catch (e) {
    flash($("voiceprint-status"), e.code, "danger");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ usage, system

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

async function init() {
  try {
    await api("GET", "/api/me");
    registerServiceWorker();
  } catch {
    /* gated before this page loads */
  }
  loadSettings();
  loadUsage();
  loadSystem();
  loadDrift();
  loadVoiceprint();
  initPush();
}

init();
