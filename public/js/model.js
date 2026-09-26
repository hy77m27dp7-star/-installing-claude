// Model: settings (with the price table), her timing and voice, grounding, calls,
// tastings, the texter meter, notifications, drift reports, voiceprint, usage, system.
import { api, h, chip, clear, downloadUrl, flash, fmtDate, fmtTime, parseJson, registerServiceWorker, today, usd } from "./api.js";

const $ = (id) => document.getElementById(id);
const form = $("settingsForm");

const FIELDS = [
  "provider", "model", "effort", "temperature", "maxTokens", "textureCuesEnabled", "typoCueShare",
  "exemplarsPerTurn", "exemplarCooldownTurns", "correctionsShown", "correctionRewriteToBank",
  "memoryDecayEnabled", "memoryFactsMax", "memoryHalfLifeLowDays", "memoryHalfLifeMidDays", "memoryHalfLifeHighDays", "provisionalRecallEvery",
  "wantsShown", "askLetGoDays", "moodDaysDefault",
  "herCity", "weatherUnits", "weatherProvider", "timezone",
  "replyDelayMode", "realDelayMaxMinutes",
  "herFirstTextsPerDay", "herFirstQuietHours",
  "voiceProvider", "voiceMode", "elevenLabsVoiceId", "transcribeProvider",
  "callProvider", "callModel", "callVoice", "callTranscribeModel", "callSystemMode", "callMaxMinutes", "callPricePerMinute",
  "elevenLabsAgentId", "elevenLabsCallPricePerMinute",
  "proposalsEnabled", "proposalsAutoApprove", "proposalProvider", "proposalModel",
  "tastingEnabled", "tastingProvider", "tastingModel", "tastingDailyCapUsd",
  "finetuneMinExamples", "finetuneSystemMode",
  "imageProvider", "imageModel", "imageQuality", "imageSize", "imageCostUsd", "portraitSize", "portraitCostUsd",
  "videoProvider", "videoModel", "videoSeconds", "videoRatio", "videoCostUsd",
  "hisFaceInTogether", "hisFaceApartEvery", "hisFaceMax",
  "dailyCapUsd", "monthlyCapUsd", "driftCheckEnabled",
  // v4 (SPEC_V4): the call face, him in a picture, the listening line and the place
  // pictures, her playlist and the player, her ElevenLabs voice, clips from the chat.
  "callFaceProvider", "callFaceSourceAssetId", "hisFaceInPhotos", "listeningLineEnabled", "placeCostUsd",
  "spotifyEnabled", "spotifyPlaylistName", "spotifyPlaylistId", "spotifyPlayer",
  "elevenLabsModel", "elevenLabsTtsPricePer1kChars", "videoMarkerEnabled",
];
const NUMERIC = new Set([
  "temperature", "maxTokens", "typoCueShare", "imageCostUsd", "dailyCapUsd", "monthlyCapUsd", "realDelayMaxMinutes", "herFirstTextsPerDay",
  "exemplarsPerTurn", "exemplarCooldownTurns", "correctionsShown",
  "memoryFactsMax", "memoryHalfLifeLowDays", "memoryHalfLifeMidDays", "memoryHalfLifeHighDays", "provisionalRecallEvery",
  "wantsShown", "askLetGoDays", "moodDaysDefault",
  "callMaxMinutes", "callPricePerMinute", "elevenLabsCallPricePerMinute",
  "tastingDailyCapUsd", "finetuneMinExamples", "portraitCostUsd", "videoSeconds", "videoCostUsd",
  "hisFaceApartEvery", "hisFaceMax",
  "placeCostUsd", "elevenLabsTtsPricePer1kChars",
]);
const BOOL = new Set([
  "proposalsEnabled", "proposalsAutoApprove", "driftCheckEnabled", "textureCuesEnabled", "correctionRewriteToBank", "memoryDecayEnabled", "tastingEnabled", "hisFaceInTogether",
  "hisFaceInPhotos", "listeningLineEnabled", "spotifyEnabled", "videoMarkerEnabled",
]);
// Her first texts as the one button turns them on (SPEC_V4 section 6): two a day, quiet
// from 23:30 to 08:30 in her timezone. The switches ship off; the button is the opt-in.
const HER_TEXTS_PER_DAY = 2;
const HER_TEXTS_QUIET_HOURS = "23:30-08:30";
// The four call prices live in one settings object; the form shows them as four fields.
const CALL_PRICE_KEYS = ["audioInPerMTok", "audioOutPerMTok", "textInPerMTok", "textOutPerMTok"];
// Rough tokens per training example, for the two estimates the Texter card shows.
const EST_COMPACT = 3000;
const EST_FULL = 12000;

// Only keys the server returned go back in a save: a field the runtime does not know yet
// stays visible but disabled instead of failing the whole form.
let known = null;

// The settings as the server last served them. A save sends only what differs from this,
// so a cap change never re-asserts the model line (the server checks a model only when
// the patch names it or the prices), and the audit row lists just what changed.
let loaded = null;
let loadedPrices = "";

function fill(s) {
  loaded = s;
  known = new Set(Object.keys(s || {}));
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el) continue;
    const has = known.has(k);
    // v4 (Amendment A2): the two ElevenLabs call fields are live; the v3 data-reserved
    // rule that kept them disabled is gone, so the markup's attribute no longer matters.
    el.disabled = !has;
    if (!has) continue;
    if (BOOL.has(k)) el.checked = !!s[k];
    else el.value = s[k] === undefined || s[k] === null ? "" : String(s[k]);
  }
  const cp = s && s.callPrices && typeof s.callPrices === "object" ? s.callPrices : null;
  for (const key of CALL_PRICE_KEYS) {
    const el = form.elements["callPrices." + key];
    if (!el) continue;
    el.disabled = !known.has("callPrices");
    el.value = cp && cp[key] !== undefined && cp[key] !== null ? String(cp[key]) : "";
  }
  fillPrices(s.prices);
  renderTexterLive();
  renderHerTexts([]);
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (!el || (known && !known.has(k))) continue;
    let v;
    if (BOOL.has(k)) v = el.checked;
    else if (NUMERIC.has(k)) v = Number(el.value);
    else v = el.value.trim();
    if (loaded && loaded[k] === v) continue;
    out[k] = v;
  }
  // A city typed without a Find pick has no coordinates of its own: the old ones would
  // give the new name the old weather. Null clears them; the weather line goes quiet
  // until he picks a match (the pick writes city, lat, lon and timezone together).
  if ("herCity" in out && known && known.has("herLat") && known.has("herLon")) {
    out.herLat = null;
    out.herLon = null;
  }
  if (known && known.has("callPrices")) {
    const cp = {};
    let any = false;
    for (const key of CALL_PRICE_KEYS) {
      const el = form.elements["callPrices." + key];
      if (!el) continue;
      const n = Number(el.value);
      if (!el.value.trim() || !Number.isFinite(n)) throw new Error("callPrices: " + key + " needs a number of 0 or more");
      cp[key] = n;
      if (!loaded || !loaded.callPrices || loaded.callPrices[key] !== n) any = true;
    }
    if (any) out.callPrices = cp;
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
  let patch;
  try {
    patch = collect();
  } catch (e0) {
    fail($("settings-status"), e0);
    return;
  }
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
    loadGrounding();
    loadTexter();
    loadTastings();
    loadSpotify();
  } catch (e2) {
    fail($("settings-status"), e2);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ grounding (SPEC_V3 DD)

function cityLabel(r) {
  return [r.name, r.admin1, r.country].filter((x) => typeof x === "string" && x).join(", ").slice(0, 80);
}

$("geoFind").addEventListener("click", async () => {
  const name = form.elements.herCity.value.trim();
  const box = $("geoResults");
  const slot = $("geo-status");
  clear(box);
  if (!name) { flash(slot, "city", "danger"); return; }
  const btn = $("geoFind");
  btn.disabled = true;
  try {
    const r = await api("POST", "/api/grounding/geocode", { name });
    const results = r && Array.isArray(r.results) ? r.results : [];
    if (!results.length) { flash(slot, "No match", "danger"); return; }
    for (const c of results.slice(0, 5)) {
      const pickBtn = h("button", { type: "button", class: "btn small" },
        h("span", { text: cityLabel(c) }),
        c.timezone ? chip(String(c.timezone)) : null);
      pickBtn.addEventListener("click", async () => {
        pickBtn.disabled = true;
        try {
          const patch = { herCity: cityLabel(c), herLat: Number(c.latitude), herLon: Number(c.longitude) };
          if (typeof c.timezone === "string" && c.timezone) patch.timezone = c.timezone;
          fill(await api("PUT", "/api/settings", patch));
          clear(box);
          flash(slot, "set", "ok");
          loadGrounding();
        } catch (e) {
          pickBtn.disabled = false;
          fail(slot, e);
        }
      });
      box.append(pickBtn);
    }
  } catch (e) {
    fail(slot, e);
  } finally {
    btn.disabled = false;
  }
});

// The read-only Now line: time of day, the weather words, what she is wearing.
async function loadGrounding() {
  const line = $("groundingNow");
  clear(line);
  let g;
  try {
    g = await api("GET", "/api/grounding");
  } catch {
    return;
  }
  if (!g || typeof g !== "object") return;
  const parts = [];
  if (g.timeOfDay) parts.push(["now", String(g.timeOfDay)]);
  const w = g.weather && typeof g.weather === "object" ? g.weather : null;
  if (w) {
    const temp = w.temp !== undefined && w.temp !== null ? Math.round(Number(w.temp)) + (w.units === "celsius" ? "C" : "F") : "";
    const feels = w.feels !== undefined && w.feels !== null && Math.round(Number(w.feels)) !== Math.round(Number(w.temp)) ? ", feels " + Math.round(Number(w.feels)) : "";
    parts.push([g.city ? String(g.city) : "weather", [temp, w.words].filter(Boolean).join(", ") + feels]);
  } else if (g.city) {
    parts.push(["city", String(g.city)]);
  }
  const outfit = g.outfit && typeof g.outfit === "object" ? g.outfit.text : g.outfit;
  if (outfit) parts.push(["wearing", String(outfit)]);
  if (!parts.length) { line.append(chip("nothing yet")); return; }
  for (const [k, v] of parts) line.append(h("span", null, h("span", { class: "k", text: k }), v), " ");
}

// ------------------------------------------------------------ texter (SPEC_V3 II)

let texterStatus = null;

function renderTexterLive() {
  const box = $("texterLive");
  clear(box);
  const live = texterStatus && texterStatus.live && typeof texterStatus.live === "object" ? texterStatus.live : loaded ? { provider: loaded.provider, model: loaded.model } : null;
  if (live) box.append(chip("live: " + String(live.provider || "") + " " + String(live.model || ""), "accent"));
  const tm = (texterStatus && texterStatus.texterModel) || (loaded && loaded.texterModel);
  if (tm && live && live.model === tm) box.append(chip("texter", "ok"));
  const prev = texterStatus && texterStatus.previous && typeof texterStatus.previous === "object" ? texterStatus.previous : loaded && loaded.texterPrevious;
  if (prev && typeof prev === "object" && prev.model) box.append(chip("back: " + String(prev.provider || "") + " " + String(prev.model || "")));
}

async function loadTexter() {
  const box = $("texterBox");
  let s;
  try {
    s = await api("GET", "/api/finetune/status");
  } catch (e) {
    box.classList.toggle("hidden", e.status === 404);
    flash($("texter-status"), e.code, "danger");
    return;
  }
  box.classList.remove("hidden");
  texterStatus = s && typeof s === "object" ? s : null;
  const approved = Number(s && s.approved) || 0;
  const minimum = Number(s && s.minimum) || 0;
  const count = $("texterCount");
  clear(count);
  count.append(String(approved), h("span", { text: " of " + minimum }));
  const pct = minimum > 0 ? Math.min(100, Math.round((approved / minimum) * 100)) : 0;
  const meter = $("texterMeter");
  meter.setAttribute("aria-valuenow", String(pct));
  meter.querySelector("span").style.width = pct + "%";
  const chips = $("texterChips");
  clear(chips);
  const b = s && s.breakdown && typeof s.breakdown === "object" ? s.breakdown : {};
  for (const [k, label] of [["keeps", "keeps"], ["rewrites", "rewrites"], ["picks", "picks"]]) {
    if (b[k] !== undefined) chips.append(chip(label + " " + b[k]));
  }
  chips.append(chip(s && s.ready ? "ready" : "not yet", s && s.ready ? "ok" : "amber"));
  chips.append(chip("compact ~" + Math.round((approved * EST_COMPACT) / 1000) + "k tokens"));
  chips.append(chip("full ~" + Math.round((approved * EST_FULL) / 1000) + "k tokens"));
  if (s && typeof s.texterModel === "string" && s.texterModel && !$("texterModel").value) $("texterModel").value = s.texterModel;
  renderTexterLive();
}

function stripHimQuery() {
  return "?stripHim=" + ($("stripHim").checked ? "1" : "0");
}

async function exportTexter(btn, path, name) {
  const slot = $("export-status");
  btn.disabled = true;
  try {
    await downloadUrl(path + stripHimQuery(), name);
    flash(slot, "exported", "ok");
  } catch (e) {
    fail(slot, e);
  } finally {
    btn.disabled = false;
  }
}

$("exportTrain").addEventListener("click", () => exportTexter($("exportTrain"), "/api/finetune/export.jsonl", "avelie-train-" + today() + ".jsonl"));
$("exportRecord").addEventListener("click", () => exportTexter($("exportRecord"), "/api/finetune/export.json", "avelie-train-" + today() + ".json"));

$("texterUse").addEventListener("click", async () => {
  const slot = $("texter-status");
  const model = $("texterModel").value.trim();
  if (!model) { flash(slot, "model id", "danger"); return; }
  const body = { model };
  const inRaw = $("texterIn").value.trim();
  const outRaw = $("texterOut").value.trim();
  if (inRaw || outRaw) {
    const i = Number(inRaw);
    const o = Number(outRaw);
    if (!inRaw || !outRaw || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) { flash(slot, "both prices", "danger"); return; }
    body.inputPerMTok = i;
    body.outputPerMTok = o;
  }
  const btn = $("texterUse");
  btn.disabled = true;
  try {
    fill(await api("POST", "/api/finetune/use", body));
    flash(slot, "in use", "ok");
    loadTexter();
    loadSystem();
  } catch (e) {
    fail(slot, e);
  } finally {
    btn.disabled = false;
  }
});

$("texterRevert").addEventListener("click", async () => {
  const slot = $("texter-status");
  const btn = $("texterRevert");
  btn.disabled = true;
  try {
    fill(await api("POST", "/api/finetune/revert", {}));
    flash(slot, "reverted", "ok");
    loadTexter();
    loadSystem();
  } catch (e) {
    fail(slot, e);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ tastings (SPEC_V3 HH)

function performerKey(p) {
  return String(p && p.provider || "") + " " + String(p && p.model || "");
}

async function loadTastings() {
  const box = $("tastingsBox");
  const tbody = $("ledgerRows");
  const recent = $("tastingsRecent");
  let r;
  try {
    r = await api("GET", "/api/tastings/ledger");
  } catch (e) {
    box.classList.toggle("hidden", e.status === 404);
    flash($("tastings-status"), e.code, "danger");
    return;
  }
  box.classList.remove("hidden");
  clear(tbody);
  clear(recent);
  const performers = r && Array.isArray(r.performers) ? r.performers : [];
  const live = loaded ? performerKey(loaded) : "";
  if (!performers.length) tbody.append(h("tr", null, h("td", { colspan: "7" }, chip("none"))));
  for (const p of performers) {
    const key = performerKey(p);
    const slot = h("span", { class: "chips" });
    const promote = h("button", {
      type: "button", class: "btn small", text: "Promote", disabled: key === live,
      onclick: async () => {
        if (!window.confirm("Promote " + key + "?")) return;
        promote.disabled = true;
        try {
          fill(await api("POST", "/api/tastings/promote", { provider: p.provider, model: p.model }));
          flash($("tastings-status"), "promoted", "ok");
          loadTastings();
          loadSystem();
        } catch (e) {
          promote.disabled = false;
          fail(slot, e);
        }
      },
    });
    const rate = Number(p.rate);
    tbody.append(h("tr", null,
      h("td", { class: "mono", text: key }),
      h("td", { class: "num", text: String(Number(p.wins) || 0) }),
      h("td", { class: "num", text: String(Number(p.losses) || 0) }),
      h("td", { class: "num", text: String(Number(p.draws) || 0) }),
      h("td", { class: "num", text: Number.isFinite(rate) ? Math.round((rate <= 1 ? rate * 100 : rate)) + "%" : "" }),
      h("td", { text: p.lastPickedAt || p.last_picked_at ? fmtTime(p.lastPickedAt || p.last_picked_at) : "" }),
      h("td", null, h("span", { class: "row" }, key === live ? chip("live", "accent") : promote, slot))));
  }
  const rows = r && Array.isArray(r.recent) ? r.recent : [];
  if (!rows.length) recent.append(h("div", { class: "chips" }, chip("none")));
  for (const t of rows.slice(0, 20)) {
    const winner = t.winner && typeof t.winner === "object" ? performerKey(t.winner) : t.winner ? String(t.winner) : "";
    const loser = t.loser && typeof t.loser === "object" ? performerKey(t.loser) : t.loser ? String(t.loser) : "";
    const st = String(t.status || t.pick || "");
    recent.append(h("div", { class: "recent-row" },
      h("span", { class: "when", text: fmtTime(t.decided_at || t.decidedAt || t.created_at) }),
      h("span", { class: "chips" },
        st ? chip(st, st === "picked" ? "ok" : st === "void" ? "amber" : "") : null,
        winner ? chip("won: " + winner, "accent") : null,
        loser ? chip("lost: " + loser) : null),
      h("span", { class: "muted small mono", text: String(t.id || "").slice(0, 8) })));
  }
}

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

// ------------------------------------------------------------ her texts on this phone (SPEC_V4 section 6)

function herTextsOn() {
  return !!(loaded && Number(loaded.herFirstTextsPerDay) > 0);
}

function renderHerTexts(notes) {
  const btn = $("herTextsBtn");
  const slot = $("herTextsStatus");
  if (!btn) return;
  const on = herTextsOn();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  if (!slot) return;
  clear(slot);
  slot.append(chip(on ? "on" : "off", on ? "ok" : ""));
  for (const n of notes || []) slot.append(chip(n, n === "denied" ? "danger" : "amber"));
}

// One press: subscribe this phone (skipped with a note when the Worker has no VAPID key;
// "denied" when the permission was refused), then her first texts on at two a day within
// the quiet hours. A second press with the texts on turns them off and unsubscribes.
async function pressHerTexts() {
  const btn = $("herTextsBtn");
  const slot = $("herTextsStatus");
  btn.disabled = true;
  const notes = [];
  try {
    if (herTextsOn()) {
      let sub = null;
      try { sub = await currentSubscription(); } catch { sub = null; }
      if (sub) await unsubscribePush();
      fill(await api("PUT", "/api/settings", { herFirstTextsPerDay: 0 }));
      renderHerTexts([]);
      return;
    }
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    let keyed = false;
    try {
      const r = await api("GET", "/api/push/public-key");
      keyed = !!(r && r.configured !== false && (r.publicKey || r.key || r.vapidPublicKey));
    } catch {
      keyed = false;
    }
    if (!supported) notes.push("no push here");
    else if (!keyed) notes.push("no push key");
    else {
      try {
        await subscribePush();
      } catch (e) {
        notes.push(e && e.code === "denied" ? "denied" : "no push");
      }
    }
    fill(await api("PUT", "/api/settings", { herFirstTextsPerDay: HER_TEXTS_PER_DAY, herFirstQuietHours: HER_TEXTS_QUIET_HOURS }));
    renderHerTexts(notes);
    const toggle = $("pushToggle");
    if (toggle) { try { toggle.checked = !!(await currentSubscription()); } catch { /* unchanged */ } }
  } catch (e) {
    fail(slot, e);
  } finally {
    btn.disabled = false;
  }
}

function initHerTexts() {
  const btn = $("herTextsBtn");
  if (!btn) return;
  btn.addEventListener("click", pressHerTexts);
  renderHerTexts([]);
}

// ------------------------------------------------------------ Spotify (SPEC_V4 section 4, A1)

function spotifyChips(s) {
  const out = [];
  if (s.connected) out.push(chip("connected" + (s.displayName ? ": " + String(s.displayName) : ""), "ok"));
  else if (s.configured === false) out.push(chip("not configured", "amber"));
  else out.push(chip("not connected"));
  if (s.connected) out.push(chip(loaded && loaded.spotifyEnabled ? "adding" : "paused"));
  return out;
}

async function loadSpotify() {
  const card = $("spotifyCard");
  if (!card) return;
  const status = $("spotifyStatus");
  const playlist = $("spotifyPlaylist");
  const connect = $("spotifyConnect");
  const disconnect = $("spotifyDisconnect");
  let s;
  try {
    s = await api("GET", "/api/spotify");
  } catch (e) {
    card.classList.toggle("hidden", e.status === 404);
    if (status) { clear(status); status.append(chip(e.code, "danger")); }
    return;
  }
  card.classList.remove("hidden");
  if (!s || typeof s !== "object") return;
  if (status) { clear(status); status.append(spotifyChips(s)); }
  if (playlist) {
    clear(playlist);
    const name = s.playlist && s.playlist.name ? String(s.playlist.name) : s.playlistName ? String(s.playlistName) : "";
    if (name) playlist.append(chip(name, "accent"));
    if (s.connected) playlist.append(chip(s.playlist && s.playlist.ok ? "ok" : "missing", s.playlist && s.playlist.ok ? "ok" : "amber"));
    if (s.playlistId) playlist.append(chip(String(s.playlistId).slice(0, 22), "mono"));
  }
  if (connect) {
    connect.setAttribute("href", "/api/spotify/connect");
    connect.classList.toggle("hidden", !!s.connected || s.configured === false);
    connect.textContent = s.connected ? "Reconnect" : "Connect";
  }
  if (disconnect) disconnect.classList.toggle("hidden", !s.connected);
}

function initSpotify() {
  const card = $("spotifyCard");
  if (!card) return;
  const disconnect = $("spotifyDisconnect");
  if (disconnect) {
    disconnect.addEventListener("click", async () => {
      if (!window.confirm("Disconnect Spotify? The playlist stays on your account.")) return;
      disconnect.disabled = true;
      try {
        await api("POST", "/api/spotify/disconnect", {});
        flash($("spotify-status"), "disconnected", "ok");
        await loadSettings();
        loadSpotify();
      } catch (e) {
        fail($("spotify-status") || $("spotifyStatus"), e);
      } finally {
        disconnect.disabled = false;
      }
    });
  }
  // The callback lands on /model#spotify: bring the card into view once.
  if (location.hash === "#spotify") {
    try { card.scrollIntoView({ block: "start" }); } catch { /* fine */ }
  }
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
    tbody.append(h("tr", null, h("td", { colspan: "10" }, chip("none"))));
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
      h("td", { class: "num", text: num(pick(j, ["avgBubbles", "bubblesPerReply", "bubbles", "bubble_count"]), 1) }),
      h("td", { class: "num", text: pct(pick(j, ["oneWordShare", "one_word_share"])) }),
      h("td", { class: "num", text: pct(pick(j, ["lowercaseShare", "lowercase_share"])) }),
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

// ------------------------------------------------------------ usage and system

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
    const keys = s.providerKeys && typeof s.providerKeys === "object" ? s.providerKeys : {};
    const kbox = $("sysKeys");
    clear(kbox);
    const names = ["anthropic", "openai", ...Object.keys(keys).filter((k) => k !== "anthropic" && k !== "openai")];
    for (const k of names) {
      const dot = h("span", { class: "dot" + (keys[k] ? " on" : ""), role: "img", "aria-label": keys[k] ? "set" : "missing" });
      kbox.append(h("span", { class: "k", text: k }), h("span", { class: "v" }, dot));
    }
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
  await loadSettings();
  loadUsage();
  loadSystem();
  loadGrounding();
  loadTexter();
  loadTastings();
  loadDrift();
  loadVoiceprint();
  initPush();
  initHerTexts();
  initSpotify();
  loadSpotify();
}

init();
