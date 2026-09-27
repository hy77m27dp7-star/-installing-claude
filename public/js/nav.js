// The shell of every page (DESIGN_EXPERIENCE section 2.8). Two halves: HER (Chat, Phone,
// Album, Us) in the header, or the bottom tab bar at phone width, and STUDIO (Record,
// Settings, Pictures, Timeline, Memory) behind one quiet door at the far end of the header
// and its own row under it on a Studio page. "/", "/index.html", "/state" and "/state.html"
// all resolve. Also mounts her face (a face-centred circular CSS crop of a master: object-fit
// cover plus an object-position from the focus table below, never an edited image) and her
// photograph behind the page (#backdrop, from GET /api/wallpaper). Browser only.

export const LINKS = [["/", "Chat"], ["/phone", "Phone"], ["/album", "Album"], ["/us", "Us"]];

export const STUDIO_LINKS = [["/state", "Record"], ["/model", "Settings"], ["/images", "Pictures"], ["/timeline", "Timeline"], ["/memory", "Memory"]];

export const STUDIO_HOME = "/state";

// Line icons (24 viewBox, stroked in currentColor by app.css): path data only.
export const NAV_ICONS = {
  "/": "M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.2A7.5 7.5 0 1 1 20 11.5z",
  "/phone": "M8.5 2.5h7a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2zM10.5 18.5h3",
  "/album": "M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4zM4 15.5l4.5-4.5 4 4 2.5-2.5 5 5M15.5 8.5h.01",
  "/us": "M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z",
  studio: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
};

// Percent of width, percent of height: the eyes and mouth inside the circle. Read off the
// masters on 2026-09-26. src/api.ts carries the same table (nav_v4 compares the two).
export const AVATAR_FOCUS = {
  "master-00": [50, 40],
  "master-01": [48, 28],
  "master-02": [58, 24],
  "master-03": [50, 32],
  "master-04": [44, 27],
  "master-05": [50, 24],
};

const DEFAULT_FOCUS = [50, 30];
const STORE_KEY = "avelie.avatar";
const DEFAULT_AVATAR = { assetId: "master-05", file: "images/masters/05_MASTER_GAVINS_BLACK_DRESS_APPROVED.png" };

export function avatarFocus(assetId) {
  const f = AVATAR_FOCUS[String(assetId || "")];
  return f ? [f[0], f[1]] : [DEFAULT_FOCUS[0], DEFAULT_FOCUS[1]];
}

// What every avatar on the page shows right now.
let current = { assetId: DEFAULT_AVATAR.assetId, file: DEFAULT_AVATAR.file, focus: avatarFocus(DEFAULT_AVATAR.assetId) };

function normalize(p) {
  const s = String(p || "").replace(/\/+$/, "").replace(/\.html$/, "").replace(/\/index$/, "");
  return s || "/";
}

export function isStudioPath(pathname) {
  const here = normalize(pathname);
  return STUDIO_LINKS.some(([href]) => normalize(href) === here);
}

function srcFor(file) {
  const f = String(file || "").replace(/^\/+/, "");
  return f ? "/" + f : "";
}

function apply(img, info) {
  if (!img) return;
  const src = srcFor(info.file);
  if (src && img.getAttribute("src") !== src) img.src = src;
  // The crop goes through the CSSOM: the CSP has no unsafe-inline, so a style attribute
  // in markup would be dropped.
  img.style.objectPosition = info.focus[0] + "% " + info.focus[1] + "%";
  img.dataset.asset = info.assetId;
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || typeof v.assetId !== "string" || typeof v.file !== "string") return null;
    return { assetId: v.assetId, file: v.file };
  } catch {
    return null;
  }
}

function writeStore(info) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ assetId: info.assetId, file: info.file }));
  } catch {
    // A private window or blocked storage: the next load asks the route again.
  }
}

function setCurrent(assetId, file, focus) {
  current = { assetId, file, focus: Array.isArray(focus) && focus.length === 2 ? [Number(focus[0]), Number(focus[1])] : avatarFocus(assetId) };
  for (const img of document.querySelectorAll("img.avatar[data-avatar]")) apply(img, current);
}

// Sets the header avatar (or the given element) at once from localStorage and the focus
// table, then asks GET /api/avatar, updates when it differs, and stores the answer.
export function mountAvatar(el) {
  const img = el || document.getElementById("avatar");
  if (!img) return;
  img.dataset.avatar = "her";
  const stored = readStore();
  if (stored) setCurrent(stored.assetId, stored.file, avatarFocus(stored.assetId));
  else setCurrent(current.assetId, current.file, current.focus);
  fetch("/api/avatar", { headers: { accept: "application/json" }, credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((a) => {
      if (!a || typeof a !== "object" || typeof a.assetId !== "string" || typeof a.file !== "string") return;
      const focus = Array.isArray(a.focus) && a.focus.length === 2 ? a.focus : avatarFocus(a.assetId);
      const same = a.assetId === current.assetId && a.file === current.file
        && Number(focus[0]) === current.focus[0] && Number(focus[1]) === current.focus[1];
      if (!same) setCurrent(a.assetId, a.file, focus);
      writeStore(current);
    })
    .catch(() => {});
}

// A new <img class="avatar"> with the same source and crop as the header's, at `size` px.
export function avatarImg(size) {
  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = "";
  img.decoding = "async";
  const px = Math.max(16, Math.round(Number(size) || 36));
  img.width = px;
  img.height = px;
  img.style.setProperty("--avatar-size", px + "px");
  img.dataset.avatar = "her";
  apply(img, current);
  return img;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "nav-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function link(href, label, d, active) {
  const a = document.createElement("a");
  a.href = href;
  const text = document.createElement("span");
  text.className = "nav-label";
  text.textContent = label;
  if (d) a.append(icon(d));
  a.append(text);
  a.classList.toggle("active", active);
  if (active) a.setAttribute("aria-current", "page");
  return a;
}

// Her photograph behind the page (section 2.4): the image of the day from GET /api/wallpaper,
// its crop through the CSSOM, .ready once it has loaded, nothing at all on any failure. A
// page that fills it itself (the chat: a place picture when they are together there)
// carries data-manual; an element passed in is always filled.
export function mountBackdrop(img) {
  const el = img || document.getElementById("backdrop");
  if (!el) return;
  if (!img && el.hasAttribute("data-manual")) return;
  const ready = () => {
    if (el.naturalWidth > 0) el.classList.add("ready");
  };
  el.addEventListener("load", ready);
  el.addEventListener("error", () => {
    el.classList.remove("ready");
    el.removeAttribute("src");
  });
  fetch("/api/wallpaper", { headers: { accept: "application/json" }, credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((w) => {
      if (!w || typeof w !== "object" || typeof w.url !== "string" || !w.url) return;
      const f = Array.isArray(w.focus) && w.focus.length === 2 ? w.focus : null;
      el.style.objectPosition = f ? Number(f[0]) + "% " + Number(f[1]) + "%" : "50% 30%";
      if (el.getAttribute("src") !== w.url) el.src = w.url;
      if (el.complete) ready();
    })
    .catch(() => {});
}

const here = normalize(location.pathname);
const studio = isStudioPath(location.pathname);
for (const nav of document.querySelectorAll(".nav")) {
  nav.replaceChildren();
  for (const [href, label] of LINKS) nav.append(link(href, label, NAV_ICONS[href], normalize(href) === here));
}

// The one door to the writer's room, at the far end of the header.
const header = document.querySelector("header.top");
if (header && !header.querySelector("a.studio-link")) {
  const door = link(STUDIO_HOME, "Studio", NAV_ICONS.studio, studio);
  door.className = "studio-link" + (studio ? " active" : "");
  door.setAttribute("aria-label", "Studio");
  header.append(door);
}

// A Studio page: its own row of five under the header.
if (studio && document.body) {
  document.body.classList.add("studio");
  if (header && !document.querySelector("nav.studio-nav")) {
    const row = document.createElement("nav");
    row.className = "studio-nav";
    row.setAttribute("aria-label", "Studio");
    for (const [href, label] of STUDIO_LINKS) row.append(link(href, label, null, normalize(href) === here));
    header.after(row);
    const active = row.querySelector("a.active");
    if (active && typeof active.scrollIntoView === "function") {
      try {
        active.scrollIntoView({ block: "nearest", inline: "center" });
      } catch {
        // Older engines refuse the options object; the row still scrolls by hand.
      }
    }
  }
}

const brandAvatar = document.getElementById("avatar");
if (brandAvatar) brandAvatar.classList.add("ring");

mountBackdrop();
mountAvatar();
