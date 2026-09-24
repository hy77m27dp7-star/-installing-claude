// Fetch wrapper plus the small DOM helpers every page shares.

export async function api(method, path, body) {
  const init = { method, credentials: "same-origin", headers: { accept: "application/json, text/plain" } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
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
const flashTimers = new WeakMap();
export function flash(slot, text, kind) {
  if (!slot) return;
  clear(slot);
  slot.append(chip(text || "error", kind || ""));
  const prev = flashTimers.get(slot);
  if (prev) clearTimeout(prev);
  if (kind !== "danger") {
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
