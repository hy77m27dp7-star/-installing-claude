// One list of sections for every page header. Rebuilds the nav from it and marks the
// current page; "/", "/index.html", "/state" and "/state.html" all resolve. Also mounts
// her face: a face-centred circular CSS crop of a master (object-fit cover plus an
// object-position from the focus table below), never an edited image. Browser only.

export const LINKS = [
  ["/", "Chat"],
  ["/phone", "Phone"],
  ["/album", "Album"],
  ["/memory", "Memory"],
  ["/state", "State"],
  ["/model", "Model"],
  ["/images", "Images"],
  ["/timeline", "Timeline"],
];

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

const here = normalize(location.pathname);
for (const nav of document.querySelectorAll(".nav")) {
  nav.replaceChildren();
  for (const [href, label] of LINKS) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    const active = normalize(href) === here;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const active = nav.querySelector("a.active");
  if (active && typeof active.scrollIntoView === "function") {
    try {
      active.scrollIntoView({ block: "nearest", inline: "center" });
    } catch {
      // Older engines refuse the options object; the row still scrolls by hand.
    }
  }
}

mountAvatar();
