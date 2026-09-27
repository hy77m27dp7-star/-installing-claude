// The words of her camera roll and of the Us page (DESIGN_EXPERIENCE 5.4 and 6.4). Pure:
// no DOM, no fetch, so the unit suite imports it straight. Every date is read in the
// browser's local time, and the month and day names are fixed English words (never the
// locale), so "September" and "Sep 26" read the same on every device.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function readTime(iso) {
  if (iso === null || iso === undefined || iso === "") return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

// "2026-09" for a time in September 2026 (local); "" for an unreadable time.
export function monthKey(iso) {
  const d = readTime(iso);
  return d ? d.getFullYear() + "-" + pad(d.getMonth() + 1) : "";
}

// "September" in the year of nowIso, "September 2025" in any other; "" for a bad key.
export function monthLabel(key, nowIso) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ""));
  if (!m) return "";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return "";
  const now = readTime(nowIso) || new Date();
  const name = MONTHS[month - 1];
  return Number(m[1]) === now.getFullYear() ? name : name + " " + m[1];
}

// Newest month first; inside a month the items keep the order they came in. An item
// whose time cannot be read lands in one group of its own, last, under the key "".
export function groupByMonth(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const key = monthKey(item.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries())
    .sort((a, b) => (a[0] === b[0] ? 0 : a[0] === "" ? 1 : b[0] === "" ? -1 : a[0] < b[0] ? 1 : -1))
    .map(([key, list]) => ({ key, items: list }));
}

// "Sep 26"; "" for an unreadable time.
export function capDate(iso) {
  const d = readTime(iso);
  return d ? MONTHS[d.getMonth()].slice(0, 3) + " " + d.getDate() : "";
}

// "Saturday, September 26", with ", 2025" when it is not the year of nowIso; "" when unreadable.
export function dayWords(iso, nowIso) {
  const d = readTime(iso);
  if (!d) return "";
  const now = readTime(nowIso) || new Date();
  const base = DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
  return d.getFullYear() === now.getFullYear() ? base : base + ", " + d.getFullYear();
}

// The spoken name of a tile: "Saturday, September 26, the record store"; the date alone
// without a place; "Picture" when there is neither.
export function tileLabel(item, nowIso) {
  const when = dayWords(item && item.at, nowIso);
  const place = item && typeof item.place === "string" ? item.place.trim() : "";
  const words = [when, place].filter(Boolean).join(", ");
  return words || "Picture";
}

// "24 pictures", "24+ pictures" when more are waiting, "1 picture"; "" for none.
export function countLabel(n, more) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (!v) return "";
  return v + (more ? "+" : "") + (v === 1 && !more ? " picture" : " pictures");
}

// "Sep 24 -- Sep 25", or one date when both fall on the same local day; "" when neither reads.
export function spanWords(fromIso, toIso) {
  const a = capDate(fromIso);
  const b = capDate(toIso);
  if (!a) return b;
  if (!b) return a;
  const da = readTime(fromIso);
  const db = readTime(toIso);
  const sameDay = da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  return sameDay ? a : a + " -- " + b;
}

// "Seeing each other, early" from "seeing each other, early": the first letter raised.
export function sentenceCase(s) {
  const t = String(s ?? "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}
