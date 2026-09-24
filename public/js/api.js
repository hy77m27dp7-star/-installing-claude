// Fetch wrapper plus the small DOM helpers every page shares.

export async function api(method, path, body) {
  const init = { method, credentials: "same-origin", headers: { accept: "application/json, text/plain" } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return request(path, init);
}

// Multipart: the browser sets the boundary itself, so no content-type header here.
export async function apiForm(method, path, formData) {
  return request(path, { method, credentials: "same-origin", headers: { accept: "application/json, text/plain" }, body: formData });
}

async function request(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw makeError("network", 0, "network");
  }
  const raw = await res.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!res.ok) {
    const obj = data && typeof data === "object" ? data : {};
    const err = makeError(obj.code || String(res.status), res.status, obj.error || res.statusText || "error");
    if (obj.retryable !== undefined) err.retryable = obj.retryable;
    if (obj.detail !== undefined) err.detail = obj.detail;
    throw err;
  }
  return data;
}

function makeError(code, status, message) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

// h("div", { class: "x", onclick: fn, text: "label" }, child, [more, children])
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  appendChildren(el, children);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "readOnly") el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) { appendChildren(el, c); continue; }
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  if (el) el.replaceChildren();
}

export function chip(text, kind) {
  return h("span", { class: "chip" + (kind ? " " + kind : ""), text });
}

// Replaces whatever is in a status slot with one chip; non-error chips fade after a moment.
// kind is a class list ("danger", "ok", "danger wrap" for a full sentence that may wrap).
const flashTimers = new WeakMap();
export function flash(slot, text, kind) {
  if (!slot) return;
  clear(slot);
  slot.append(chip(text || "error", kind || ""));
  const prev = flashTimers.get(slot);
  if (prev) clearTimeout(prev);
  if (!/\bdanger\b/.test(kind || "")) {
    flashTimers.set(slot, setTimeout(() => clear(slot), 2500));
  }
}

export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : fmtDate(iso) + " " + t;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// ISO -> the value a datetime-local input takes (local wall time), and back.
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function usd(n) {
  const v = Number(n) || 0;
  return "$" + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2));
}

export function bytesLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + " KB";
  return (v / (1024 * 1024)).toFixed(2) + " MB";
}

// Flags arrive as a JSON string on a message row or as Flag objects on a turn response.
export function flagCodes(value) {
  let list = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  return list.map((f) => (typeof f === "string" ? f : f && f.code)).filter(Boolean);
}

// A column that may hold JSON text, an object already, or nothing.
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function storeSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* storage unavailable */ }
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The shell registers only once the owner is known (a successful GET /api/me).
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !local) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* offline shell is optional */ });
}

// Inline stroke icons (24 box). Built with the SVG namespace so no markup is parsed.
const ICONS = {
  paperclip: ["M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"],
  mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z", "M19 11v1a7 7 0 0 1-14 0v-1", "M12 19v3", "M8 22h8"],
  send: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"],
  note: ["M9 18V6l12-2v12", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  play: ["M6 4l14 8-14 8z"],
};

export function svgIcon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
