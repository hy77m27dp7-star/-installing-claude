// Her life: threads (routines, events, people, places, arcs) and a log of what happened.
// Nothing is seeded; it fills through the owner and through approved proposals. Threads
// are versioned like facts (an edit is a new row, the old one superseded), and every
// write is audited in the same batch.
//
// The pure half (whereSheIs, lifeSection, computeDeliverAt) never touches the database
// and does its timezone math with Intl alone, so the unit suite can run it under Node.
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { carryStmt } from "./memory";

export type ThreadKind = "routine" | "event" | "person" | "place" | "arc";
export type ThreadStatus = "active" | "done" | "dropped" | "superseded";

export interface LifeThread {
  id: string;
  kind: ThreadKind;
  title: string;
  detail: string | null;
  schedule_json: string | null;
  status: ThreadStatus;
  relation: string | null;
  source: string | null;
  version: number;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  // v3 (SPEC_V3 section DD, migration 0005): the approved portrait of a person, set by the
  // image decision route and carried along the version chain. Optional in the type so v2
  // fixtures and writers keep compiling; a row read from D1 carries it, null when unset.
  portrait_asset_id?: string | null;
}

export interface LifeLog {
  id: string;
  thread_id: string | null;
  occurred: string;
  note: string;
  source: string | null;
  created_at: string;
}

// schedule_json shapes. A routine: { tz?, blocks: [{ days: [1..5], start: "09:00", end: "17:30", label? }] }.
// An event: { at: ISO, minutes?, label? }. Any kind may carry either; whereSheIs reads both.
export interface RoutineBlock {
  days: number[];
  start: string;
  end: string;
  label?: string;
}

export interface Schedule {
  tz?: string;
  blocks?: RoutineBlock[];
  at?: string;
  minutes?: number;
  label?: string;
}

export interface Whereabouts {
  busy: boolean;
  label: string | null;
  until: Date | null;
}

const KINDS: ThreadKind[] = ["routine", "event", "person", "place", "arc"];
const STATUSES: ThreadStatus[] = ["active", "done", "dropped", "superseded"];
const MAX_TEXT = 4000;
const MAX_TITLE = 300;
const MAX_SCHEDULE = 4000;
const MAX_BLOCKS = 21;
const DEFAULT_EVENT_MINUTES = 120;
const MAX_EVENT_MINUTES = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// v3: how many of a person's last notes the YOUR LIFE people list carries (section DD).
const PERSON_NOTES = 2;
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

export const EMPTY_LIFE_LINE =
  "Nothing about your days has been written down yet. You still have days. Mention ordinary things when they fit; they become real once they are written down.";

// ------------------------------------------------------------------ small pure helpers

function isKind(v: unknown): v is ThreadKind {
  return typeof v === "string" && (KINDS as string[]).includes(v);
}

function isStatus(v: unknown): v is ThreadStatus {
  return typeof v === "string" && (STATUSES as string[]).includes(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// FNV-1a over the string, folded to a unit float. Deterministic across runtimes.
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

function parseHHMM(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = HHMM_RE.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Only what parses cleanly; a malformed schedule is treated as none (never an error in
// the prompt path).
export function parseSchedule(json: string | null): Schedule | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(v)) return null;
  const out: Schedule = {};
  if (typeof v.tz === "string" && v.tz.trim()) out.tz = v.tz.trim();
  if (typeof v.label === "string" && v.label.trim()) out.label = v.label.trim();
  if (typeof v.at === "string" && Number.isFinite(Date.parse(v.at))) out.at = v.at;
  if (typeof v.minutes === "number" && Number.isFinite(v.minutes) && v.minutes > 0) out.minutes = Math.min(MAX_EVENT_MINUTES, v.minutes);
  if (Array.isArray(v.blocks)) {
    const blocks: RoutineBlock[] = [];
    for (const b of v.blocks) {
      if (!isPlainObject(b) || !Array.isArray(b.days)) continue;
      const days = b.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
      if (!days.length || parseHHMM(b.start) === null || parseHHMM(b.end) === null) continue;
      const block: RoutineBlock = { days: Array.from(new Set(days)).sort((a, b2) => a - b2), start: String(b.start).trim(), end: String(b.end).trim() };
      if (typeof b.label === "string" && b.label.trim()) block.label = b.label.trim();
      blocks.push(block);
    }
    if (blocks.length) out.blocks = blocks;
  }
  return out.blocks || out.at ? out : null;
}

// ------------------------------------------------------------------ timezone math (Intl only)

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  // Minutes to add to UTC to get this wall clock (New York in September: -240).
  offsetMinutes: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function safeTimezone(tz: string): string {
  const t = typeof tz === "string" ? tz.trim() : "";
  if (!t) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: t });
    return t;
  } catch {
    return "UTC";
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  const key = safeTimezone(tz);
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: key, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatterCache.set(key, f);
  }
  return f;
}

export function localParts(now: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(now);
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = num("year");
  const month = num("month");
  const day = num("day");
  const hour = num("hour") % 24;
  const minute = num("minute");
  const second = num("second");
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((asUtc - (now.getTime() - now.getUTCMilliseconds())) / 60000);
  return { year, month, day, hour, minute, weekday: new Date(asUtc).getUTCDay(), offsetMinutes };
}

// A wall-clock time on a local calendar day, as an instant. dayShift moves the day.
function localToInstant(p: LocalParts, minutesOfDay: number, dayShift = 0): Date {
  return new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift, 0, minutesOfDay) - p.offsetMinutes * 60000);
}

function localDayNumber(p: LocalParts): number {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

export function formatClock(minutesOfDay: number): string {
  const h24 = Math.floor(minutesOfDay / 60) % 24;
  const m = minutesOfDay % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${h24 < 12 ? "am" : "pm"}`;
}

function formatDayTime(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${WEEKDAYS[p.weekday] ?? ""} ${formatClock(p.hour * 60 + p.minute)}`;
}

function dayRange(days: number[]): string {
  const sorted = Array.from(new Set(days)).filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!sorted.length) return "";
  if (sorted.length === 7) return "every day";
  const names = sorted.map((d) => WEEKDAYS_SHORT[d] ?? "");
  const consecutive = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] ?? -9) + 1);
  if (consecutive && sorted.length >= 3) return `${names[0]} to ${names[names.length - 1]}`;
  return names.join(", ");
}

export function agoLabel(ageDays: number): string {
  const n = Math.max(0, Math.floor(ageDays));
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return `${n} days ago`;
  if (n < 60) {
    const w = Math.round(n / 7);
    return w <= 1 ? "a week ago" : `${w} weeks ago`;
  }
  const mo = Math.round(n / 30);
  return mo <= 1 ? "about a month ago" : `${mo} months ago`;
}

function ageDays(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

function firstLine(s: string | null, max = 200): string {
  if (!s) return "";
  const t = s.trim().split(/\r?\n/)[0] ?? "";
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// ------------------------------------------------------------------ where she is (pure)

function blockHit(thread: LifeThread, sched: Schedule, now: Date, tz: string): Whereabouts | null {
  if (!sched.blocks) return null;
  const p = localParts(now, sched.tz ?? tz);
  const nowMin = p.hour * 60 + p.minute;
  const yesterday = (p.weekday + 6) % 7;
  let best: Whereabouts | null = null;
  for (const b of sched.blocks) {
    const start = parseHHMM(b.start);
    const end = parseHHMM(b.end);
    if (start === null || end === null || start === end) continue;
    let until: Date | null = null;
    if (start < end) {
      if (b.days.includes(p.weekday) && nowMin >= start && nowMin < end) until = localToInstant(p, end);
    } else {
      // Overnight block: started today and runs past midnight, or started yesterday.
      if (b.days.includes(p.weekday) && nowMin >= start) until = localToInstant(p, end, 1);
      else if (b.days.includes(yesterday) && nowMin < end) until = localToInstant(p, end);
    }
    if (until && (!best || !best.until || until.getTime() > best.until.getTime())) {
      best = { busy: true, label: b.label ?? sched.label ?? thread.title, until };
    }
  }
  return best;
}

function eventHit(thread: LifeThread, sched: Schedule, now: Date): Whereabouts | null {
  if (!sched.at) return null;
  const at = Date.parse(sched.at);
  if (!Number.isFinite(at)) return null;
  const end = at + (sched.minutes ?? DEFAULT_EVENT_MINUTES) * 60000;
  const t = now.getTime();
  if (t < at || t >= end) return null;
  return { busy: true, label: sched.label ?? "at " + thread.title, until: new Date(end) };
}

// Resolves active routines and events against her timezone. When several overlap she is
// busy until the last of them ends.
export function whereSheIs(threads: LifeThread[], now: Date, tz: string): Whereabouts {
  let best: Whereabouts | null = null;
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || t.status !== "active") continue;
    const sched = parseSchedule(t.schedule_json);
    if (!sched) continue;
    for (const hit of [blockHit(t, sched, now, tz), eventHit(t, sched, now)]) {
      if (hit && hit.until && (!best || !best.until || hit.until.getTime() > best.until.getTime())) best = hit;
    }
  }
  return best ?? { busy: false, label: null, until: null };
}

// ------------------------------------------------------------------ the prompt section (pure)

function nextEvent(threads: LifeThread[], now: Date): { thread: LifeThread; at: Date; sched: Schedule } | null {
  let best: { thread: LifeThread; at: Date; sched: Schedule } | null = null;
  const horizon = now.getTime() + 7 * DAY_MS;
  for (const t of threads) {
    if (t.status !== "active") continue;
    const sched = parseSchedule(t.schedule_json);
    if (!sched || !sched.at) continue;
    const at = Date.parse(sched.at);
    if (!Number.isFinite(at) || at <= now.getTime() || at > horizon) continue;
    if (!best || at < best.at.getTime()) best = { thread: t, at: new Date(at), sched };
  }
  return best;
}

function routineLine(t: LifeThread): string {
  const sched = parseSchedule(t.schedule_json);
  const blocks = sched?.blocks ?? [];
  const spans = blocks.map((b) => {
    const s = parseHHMM(b.start);
    const e = parseHHMM(b.end);
    const when = s === null || e === null ? "" : `${dayRange(b.days)} ${formatClock(s)} to ${formatClock(e)}`;
    return b.label && b.label !== t.title ? `${when} (${b.label})` : when;
  }).filter(Boolean);
  const tail = spans.length ? spans.join("; ") : firstLine(t.detail);
  return `- ${t.title}${tail ? ": " + tail : ""}`;
}

export function lifeSection(threads: LifeThread[], log: LifeLog[], now: Date, tz: string): string {
  const zone = safeTimezone(tz);
  const all = Array.isArray(threads) ? threads.filter((t) => t && t.status === "active") : [];
  const notes = (Array.isArray(log) ? log.slice() : [])
    .filter((l) => l && typeof l.note === "string" && l.note.trim())
    .sort((a, b) => (Date.parse(b.occurred) || 0) - (Date.parse(a.occurred) || 0) || b.created_at.localeCompare(a.created_at));
  const titles = new Map<string, string>();
  for (const t of all) titles.set(t.id, t.title);

  const out: string[] = [
    "YOUR LIFE RIGHT NOW (yours; mention it when it fits, never to fill silence, never as something he owes you)",
  ];

  if (!all.length && !notes.length) {
    out.push(EMPTY_LIFE_LINE);
    return out.join("\n");
  }

  const p = localParts(now, zone);
  const where = whereSheIs(all, now, zone);
  let line = `It is ${WEEKDAYS[p.weekday] ?? ""} ${formatClock(p.hour * 60 + p.minute)}.`;
  if (where.busy && where.label) {
    const untilText = where.until ? " until " + formatClock((() => { const u = localParts(where.until, zone); return u.hour * 60 + u.minute; })()) : "";
    line += ` You are ${where.label}${untilText}.`;
  } else {
    line += " Nothing on your schedule right now.";
  }
  out.push(line);

  const next = nextEvent(all, now);
  if (next) {
    const gap = localDayNumber(localParts(next.at, zone)) - localDayNumber(p);
    const inWords = gap <= 0 ? "today" : gap === 1 ? "tomorrow" : `in ${gap} days`;
    out.push(`Next up: ${formatDayTime(next.at, zone)}, ${next.sched.label ?? next.thread.title} (${inWords}).`);
  }

  const routines = all.filter((t) => t.kind === "routine");
  if (routines.length) out.push("Your week:\n" + routines.map(routineLine).join("\n"));

  const people = all.filter((t) => t.kind === "person");
  if (people.length) {
    out.push("People in your life:\n" + people.map((t) => {
      const rel = t.relation ? ` (${t.relation})` : "";
      const d = firstLine(t.detail);
      // v3 (section DD): the person's last two notes with their ages, so the arc moves.
      const arc = notes.filter((l) => l.thread_id === t.id).slice(0, PERSON_NOTES)
        .map((l) => `${agoLabel(ageDays(new Date(l.occurred), now))}: ${firstLine(l.note, 160)}`);
      return `- ${t.title}${rel}${d ? ": " + d : ""}${arc.length ? "; " + arc.join("; ") : ""}`;
    }).join("\n"));
  }

  const places = all.filter((t) => t.kind === "place");
  if (places.length) {
    out.push("Places:\n" + places.map((t) => {
      const d = firstLine(t.detail);
      const last = notes.find((l) => l.thread_id === t.id);
      const lastText = last ? `; last time: ${firstLine(last.note)} (${agoLabel(ageDays(new Date(last.occurred), now))})` : "";
      return `- ${t.title}${d ? ": " + d : ""}${lastText}`;
    }).join("\n"));
  }

  const arcs = all.filter((t) => t.kind === "arc");
  if (arcs.length) {
    out.push("Where things stand:\n" + arcs.map((t) => `- ${t.title}: ${firstLine(t.detail) || "no note yet"}`).join("\n"));
  }

  if (notes.length) {
    out.push("Lately (your own notes, newest first):\n" + notes.slice(0, 5).map((l) => {
      const who = l.thread_id ? titles.get(l.thread_id) : undefined;
      return `- ${agoLabel(ageDays(new Date(l.occurred), now))}${who ? " (" + who + ")" : ""}: ${firstLine(l.note, 300)}`;
    }).join("\n"));
  }

  return out.join("\n");
}

// ------------------------------------------------------------------ real-mode delay (pure)

// Busy: min(cap, minutes until the block ends) with 20% jitter, never above the cap.
// Free: 5 to 90 seconds. The jitter is deterministic from the seed (message id), so a
// retried commit lands on the same instant. A cap of 0 means now.
export function computeDeliverAt(threads: LifeThread[], now: Date, tz: string, maxMinutes: number, seed: string): Date {
  const cap = Number.isFinite(maxMinutes) ? Math.max(0, maxMinutes) : 0;
  if (cap <= 0) return new Date(now.getTime());
  const u = seededUnit(String(seed));
  const capMs = cap * 60000;
  const where = whereSheIs(threads, now, tz);
  let delayMs: number;
  if (where.busy && where.until && where.until.getTime() > now.getTime()) {
    const untilMs = where.until.getTime() - now.getTime();
    const base = Math.min(capMs, untilMs);
    delayMs = Math.min(capMs, Math.max(5000, base * (0.8 + 0.4 * u)));
  } else {
    delayMs = Math.min(capMs, (5 + 85 * u) * 1000);
  }
  return new Date(now.getTime() + Math.round(delayMs));
}

// ------------------------------------------------------------------ validation (db half)

function requireText(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiHttpError(400, "validation", `${name} is required`);
  const t = value.trim();
  if (t.length > max) throw new ApiHttpError(400, "validation", `${name} exceeds ${max} characters`);
  return t;
}

function optionalText(value: unknown, name: string, max = MAX_TEXT): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiHttpError(400, "validation", `${name} must be a string`);
  const t = value.trim();
  if (t.length > max) throw new ApiHttpError(400, "validation", `${name} exceeds ${max} characters`);
  return t.length ? t : null;
}

// A schedule must be a JSON object; blocks and `at` must be well formed when present.
// Stored re-serialized so the prompt path always reads what was validated.
function validateSchedule(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiHttpError(400, "validation", "schedule_json must be a JSON string");
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > MAX_SCHEDULE) throw new ApiHttpError(400, "validation", `schedule_json exceeds ${MAX_SCHEDULE} characters`);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ApiHttpError(400, "validation", "schedule_json is not valid JSON");
  }
  if (!isPlainObject(v)) throw new ApiHttpError(400, "validation", "schedule_json must be an object");
  if (v.tz !== undefined && (typeof v.tz !== "string" || safeTimezone(v.tz) !== v.tz.trim())) {
    throw new ApiHttpError(400, "validation", "schedule_json.tz is not a known timezone");
  }
  if (v.label !== undefined && (typeof v.label !== "string" || v.label.length > MAX_TITLE)) {
    throw new ApiHttpError(400, "validation", "schedule_json.label must be a short string");
  }
  if (v.at !== undefined && (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at)))) {
    throw new ApiHttpError(400, "validation", "schedule_json.at must be an ISO date");
  }
  if (v.minutes !== undefined && (typeof v.minutes !== "number" || !Number.isFinite(v.minutes) || v.minutes <= 0 || v.minutes > MAX_EVENT_MINUTES)) {
    throw new ApiHttpError(400, "validation", `schedule_json.minutes must be 1 to ${MAX_EVENT_MINUTES}`);
  }
  if (v.blocks !== undefined) {
    if (!Array.isArray(v.blocks) || v.blocks.length > MAX_BLOCKS) throw new ApiHttpError(400, "validation", `schedule_json.blocks must be an array of at most ${MAX_BLOCKS}`);
    for (const b of v.blocks) {
      if (!isPlainObject(b)) throw new ApiHttpError(400, "validation", "schedule_json.blocks entries must be objects");
      if (!Array.isArray(b.days) || !b.days.length || !b.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
        throw new ApiHttpError(400, "validation", "schedule_json.blocks[].days must list weekdays 0 to 6");
      }
      if (parseHHMM(b.start) === null || parseHHMM(b.end) === null) throw new ApiHttpError(400, "validation", "schedule_json.blocks[].start and end must be HH:MM");
      if (b.label !== undefined && (typeof b.label !== "string" || b.label.length > MAX_TITLE)) {
        throw new ApiHttpError(400, "validation", "schedule_json.blocks[].label must be a short string");
      }
    }
  }
  return JSON.stringify(v);
}

// ------------------------------------------------------------------ threads (db)

function insertThreadStmt(db: D1Database, t: LifeThread): D1PreparedStatement {
  return db.prepare("INSERT INTO life_threads (id, kind, title, detail, schedule_json, status, relation, source, version, supersedes_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
    .bind(t.id, t.kind, t.title, t.detail, t.schedule_json, t.status, t.relation, t.source, t.version, t.supersedes_id, t.created_at, t.updated_at);
}

function supersedeStmt(db: D1Database, id: string, fromStatus: string, at: string): D1PreparedStatement {
  return db.prepare("UPDATE life_threads SET status = 'superseded', updated_at = ?3 WHERE id = ?1 AND status = ?2").bind(id, fromStatus, at);
}

// v3: the approved portrait follows the head. Written as its own statement, only when
// there is one, so the twelve-column insert above stays what it was.
function portraitCarryStmt(db: D1Database, id: string, portraitAssetId: string): D1PreparedStatement {
  return db.prepare("UPDATE life_threads SET portrait_asset_id = ?2 WHERE id = ?1").bind(id, portraitAssetId);
}

// v3: a portrait still being made or waiting for a decision names its person by the head id
// it was made for (visual_assets.notes "person:<threadId>", portraits.ts); a new head takes
// those rows with it, so an edit never orphans a candidate the pages key by the current head.
function portraitNotesCarryStmt(db: D1Database, fromId: string, toId: string): D1PreparedStatement {
  return db.prepare("UPDATE visual_assets SET notes = replace(notes, 'person:' || ?1, 'person:' || ?2) WHERE role = 'portrait' AND approval_status IN ('generating', 'candidate') AND notes LIKE 'person:' || ?1 || '%'")
    .bind(fromId, toId);
}

// v3: the statements that make a new head inherit its portrait, its pending portrait
// candidates and its memory weight (SPEC_V3 sections BB and DD). `fromIds` are the rows the
// weight may live on, first wins.
function headCarryStmts(db: D1Database, row: LifeThread, fromIds: string[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  if (typeof row.portrait_asset_id === "string" && row.portrait_asset_id) out.push(portraitCarryStmt(db, row.id, row.portrait_asset_id));
  for (const from of fromIds) {
    if (!from || from === row.id) continue;
    out.push(carryStmt(db, "thread", from, row.id));
    out.push(portraitNotesCarryStmt(db, from, row.id));
  }
  return out;
}

async function requireThread(db: D1Database, id: string): Promise<LifeThread> {
  if (typeof id !== "string" || !id) throw new ApiHttpError(400, "validation", "thread id is required");
  const row = await db.prepare("SELECT * FROM life_threads WHERE id = ?1").bind(id).first<LifeThread>();
  if (!row) throw new ApiHttpError(404, "not_found", "life thread not found");
  return row;
}

// The whole version chain a row belongs to, oldest first (the same walk state.ts does).
async function chainRows(db: D1Database, id: string): Promise<LifeThread[]> {
  const root = await db.prepare(
    `WITH RECURSIVE up(id, sup, depth) AS (
       SELECT id, supersedes_id, 0 FROM life_threads WHERE id = ?1
       UNION ALL
       SELECT t.id, t.supersedes_id, up.depth + 1 FROM life_threads t JOIN up ON t.id = up.sup WHERE up.depth < 500
     ) SELECT id FROM up WHERE sup IS NULL LIMIT 1`,
  ).bind(id).first<{ id: string }>();
  const rootId = root?.id ?? id;
  const r = await db.prepare(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT ?1, 0
       UNION ALL
       SELECT t.id, down.depth + 1 FROM life_threads t JOIN down ON t.supersedes_id = down.id WHERE down.depth < 500
     ) SELECT t.* FROM life_threads t JOIN down ON t.id = down.id ORDER BY t.version ASC, t.created_at ASC`,
  ).bind(rootId).all<LifeThread>();
  return r.results;
}

// Without a status: every current row (active, done, dropped), never old versions.
export async function listThreads(db: D1Database, status?: string): Promise<LifeThread[]> {
  if (status !== undefined && status !== "") {
    if (!isStatus(status)) throw new ApiHttpError(400, "validation", "status must be active, done, dropped or superseded");
    const r = await db.prepare("SELECT * FROM life_threads WHERE status = ?1 ORDER BY kind, created_at, id").bind(status).all<LifeThread>();
    return r.results;
  }
  const r = await db.prepare("SELECT * FROM life_threads WHERE status != 'superseded' ORDER BY kind, created_at, id").all<LifeThread>();
  return r.results;
}

export async function createThread(
  db: D1Database,
  input: { kind: LifeThread["kind"]; title: string; detail?: string | null; schedule_json?: string | null; relation?: string | null; source?: string | null },
  actor: string,
): Promise<LifeThread> {
  if (!isKind(input.kind)) throw new ApiHttpError(400, "validation", "kind must be routine, event, person, place or arc");
  const t = nowIso();
  const row: LifeThread = {
    id: newId("lt"),
    kind: input.kind,
    title: requireText(input.title, "title", MAX_TITLE),
    detail: optionalText(input.detail, "detail"),
    schedule_json: validateSchedule(input.schedule_json),
    status: "active",
    relation: optionalText(input.relation, "relation", 200),
    source: optionalText(input.source, "source", 500),
    version: 1,
    supersedes_id: null,
    created_at: t,
    updated_at: t,
  };
  await db.batch([insertThreadStmt(db, row), auditStmt(db, actor, "life.thread.create", "life_thread", row.id, null, row)]);
  return row;
}

export async function updateThread(
  db: D1Database,
  id: string,
  patch: Partial<{ title: string; detail: string | null; schedule_json: string | null; relation: string | null; status: "active" | "done" }>,
  actor: string,
): Promise<LifeThread> {
  const old = await requireThread(db, id);
  if (old.status === "superseded") throw new ApiHttpError(409, "not_current", "only the current version of a thread can be edited");
  if (old.status === "dropped") throw new ApiHttpError(409, "dropped", "restore the thread before editing it");
  if (patch.status !== undefined && patch.status !== "active" && patch.status !== "done") {
    throw new ApiHttpError(400, "validation", "status must be active or done");
  }
  const t = nowIso();
  const row: LifeThread = {
    ...old,
    id: newId("lt"),
    title: patch.title === undefined ? old.title : requireText(patch.title, "title", MAX_TITLE),
    detail: patch.detail === undefined ? old.detail : optionalText(patch.detail, "detail"),
    schedule_json: patch.schedule_json === undefined ? old.schedule_json : validateSchedule(patch.schedule_json),
    relation: patch.relation === undefined ? old.relation : optionalText(patch.relation, "relation", 200),
    status: patch.status ?? old.status,
    version: old.version + 1,
    supersedes_id: old.id,
    updated_at: t,
  };
  await db.batch([
    supersedeStmt(db, old.id, old.status, t),
    insertThreadStmt(db, row),
    ...headCarryStmts(db, row, [old.id]),
    auditStmt(db, actor, "life.thread.update", "life_thread", row.id, old, row),
  ]);
  return row;
}

// Dropping is a new head with status dropped: the chain stays intact and restorable.
export async function dropThread(db: D1Database, id: string, actor: string): Promise<void> {
  const old = await requireThread(db, id);
  if (old.status === "superseded") throw new ApiHttpError(409, "not_current", "only the current version of a thread can be dropped");
  if (old.status === "dropped") throw new ApiHttpError(409, "already_dropped", "thread is already dropped");
  const t = nowIso();
  const row: LifeThread = { ...old, id: newId("lt"), status: "dropped", version: old.version + 1, supersedes_id: old.id, updated_at: t };
  await db.batch([
    supersedeStmt(db, old.id, old.status, t),
    insertThreadStmt(db, row),
    ...headCarryStmts(db, row, [old.id]),
    auditStmt(db, actor, "life.thread.drop", "life_thread", row.id, old, row),
  ]);
}

// Restores any version as a new active head (a dropped head, or an older edit).
export async function restoreThread(db: D1Database, id: string, actor: string): Promise<LifeThread> {
  const target = await requireThread(db, id);
  const chain = await chainRows(db, target.id);
  const latest = chain[chain.length - 1] ?? target;
  if (target.status === "active" && latest.id === target.id) return target;
  const maxVersion = chain.reduce((m, r) => Math.max(m, r.version), target.version);
  const t = nowIso();
  // The portrait and the memory weight live on the latest head; an older version restored
  // as the new head inherits them from there (then from itself, if it ever had them).
  const portrait = latest.portrait_asset_id ?? target.portrait_asset_id ?? null;
  const row: LifeThread = { ...target, id: newId("lt"), status: "active", version: maxVersion + 1, supersedes_id: latest.id, updated_at: t, portrait_asset_id: portrait };
  const stmts: D1PreparedStatement[] = chain.filter((r) => r.status !== "superseded").map((r) => supersedeStmt(db, r.id, r.status, t));
  stmts.push(insertThreadStmt(db, row));
  stmts.push(...headCarryStmts(db, row, [latest.id, target.id]));
  stmts.push(auditStmt(db, actor, "life.thread.restore", "life_thread", row.id, { restoredFrom: target.id, latest: latest.id }, row));
  await db.batch(stmts);
  return row;
}

// ------------------------------------------------------------------ log (db)

export async function listLog(db: D1Database, limit = 50): Promise<LifeLog[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 50;
  const r = await db.prepare("SELECT * FROM life_log ORDER BY occurred DESC, created_at DESC LIMIT ?1").bind(n).all<LifeLog>();
  return r.results;
}

export async function logLife(
  db: D1Database,
  threadId: string | null,
  occurred: string,
  note: string,
  source: string | null,
  actor: string,
): Promise<LifeLog> {
  const when = typeof occurred === "string" ? Date.parse(occurred.trim()) : NaN;
  if (!Number.isFinite(when)) throw new ApiHttpError(400, "validation", "occurred must be an ISO date");
  let thread: string | null = null;
  if (threadId !== null && threadId !== undefined && threadId !== "") {
    if (typeof threadId !== "string") throw new ApiHttpError(400, "validation", "threadId must be a string");
    const exists = await db.prepare("SELECT id FROM life_threads WHERE id = ?1").bind(threadId).first<{ id: string }>();
    if (!exists) throw new ApiHttpError(404, "not_found", "life thread not found");
    thread = threadId;
  }
  const row: LifeLog = {
    id: newId("ll"),
    thread_id: thread,
    occurred: new Date(when).toISOString(),
    note: requireText(note, "note"),
    source: optionalText(source, "source", 500),
    created_at: nowIso(),
  };
  await db.batch([
    db.prepare("INSERT INTO life_log (id, thread_id, occurred, note, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(row.id, row.thread_id, row.occurred, row.note, row.source, row.created_at),
    auditStmt(db, actor, "life.log.create", "life_log", row.id, null, row),
  ]);
  return row;
}
