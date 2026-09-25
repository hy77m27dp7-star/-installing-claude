// Wants and stakes (SPEC_V3 section CC): things she wants over weeks, with progress and
// setbacks she brings up on her own; small real things she asks him for, once, and lets
// go; and a mood that fades honestly over days. An ask is never a debt. No punishment
// theatre, no silence as a weapon, nothing here withholds a reply.
//
// Wants are not versioned (a want is a live thing; every edit is audited and want_log is
// its history). The pure half (moodNow, wantsSection) never touches the database.
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { agoLabel } from "./life";

export type WantStatus = "active" | "paused" | "done" | "dropped";
export type WantLogKind = "progress" | "setback" | "note";
export type AskStatus = "open" | "granted" | "declined" | "let_go";

export interface WantRow {
  id: string;
  title: string;
  why: string | null;
  stakes: string | null;
  next_step: string | null;
  progress: number;
  status: WantStatus;
  horizon_days: number;
  last_moved: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface WantLogRow {
  id: string;
  want_id: string;
  occurred: string;
  kind: WantLogKind;
  delta: number | null;
  note: string;
  source: string | null;
  message_id: string | null;
  created_at: string;
}

export interface AskRow {
  id: string;
  want_id: string | null;
  text: string;
  status: AskStatus;
  asked_message_id: string | null;
  asked_at: string;
  brought_up: number;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

// The settings this module reads. Optional so an older Settings shape resolves to the
// defaults; `timezone` keeps the v1 shape overlapping (weak-type check).
export interface WantsSettings {
  wantsShown?: number;
  askLetGoDays?: number;
  moodDaysDefault?: number;
  timezone?: string;
}

export const WANTS_DEFAULTS = { wantsShown: 5, askLetGoDays: 14, moodDaysDefault: 3 } as const;

const WANT_STATUSES: readonly WantStatus[] = ["active", "paused", "done", "dropped"];
const LOG_KINDS: readonly WantLogKind[] = ["progress", "setback", "note"];
const ASK_STATUSES: readonly AskStatus[] = ["open", "granted", "declined", "let_go"];
const MAX_TITLE = 300;
const MAX_TEXT = 2000;
const MAX_NOTE = 1000;
const MAX_ASK = 500;
const MAX_HORIZON = 3650;
const DEFAULT_HORIZON = 42;
const DEFAULT_DELTA = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Paused and done wants stay in the section this long after the change (one line each).
const RECENT_CHANGE_DAYS = 14;
const IN_CHUNK = 90;

// ------------------------------------------------------------------ helpers

function isWantStatus(v: unknown): v is WantStatus {
  return typeof v === "string" && (WANT_STATUSES as readonly string[]).includes(v);
}

function isLogKind(v: unknown): v is WantLogKind {
  return typeof v === "string" && (LOG_KINDS as readonly string[]).includes(v);
}

function isAskStatus(v: unknown): v is AskStatus {
  return typeof v === "string" && (ASK_STATUSES as readonly string[]).includes(v);
}

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

function requireInt(value: unknown, name: string, lo: number, hi: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiHttpError(400, "validation", `${name} must be a number from ${lo} to ${hi}`);
  const n = Math.round(value);
  if (n < lo || n > hi) throw new ApiHttpError(400, "validation", `${name} must be a number from ${lo} to ${hi}`);
  return n;
}

function isoOrNow(value: unknown, name: string): string {
  if (value === undefined || value === null || value === "") return nowIso();
  const t = typeof value === "string" ? Date.parse(value.trim()) : NaN;
  if (!Number.isFinite(t)) throw new ApiHttpError(400, "validation", `${name} must be an ISO 8601 time`);
  return new Date(t).toISOString();
}

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
}

export function wantsSettings(s: WantsSettings | null | undefined): { wantsShown: number; askLetGoDays: number; moodDaysDefault: number } {
  const d = WANTS_DEFAULTS;
  if (!s || typeof s !== "object") return { ...d };
  return {
    wantsShown: clampInt(s.wantsShown, d.wantsShown, 0, 20),
    askLetGoDays: clampInt(s.askLetGoDays, d.askLetGoDays, 1, 90),
    moodDaysDefault: clampInt(s.moodDaysDefault, d.moodDaysDefault, 1, 14),
  };
}

function parseMs(s: string | null | undefined): number {
  if (!s) return NaN;
  return Date.parse(s);
}

function daysBetween(fromIso: string | null | undefined, now: Date): number {
  const t = parseMs(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------------ mood decay (pure)

export type MoodPhase = "fresh" | "fading" | "faint" | "gone" | "none";

export interface MoodNow {
  mood: string;
  phase: MoodPhase;
  setAt: string | null;
  days: number;
  ageDays: number;
}

// With t = (now - mood_set_at) / mood_days in days: fresh under a half, fading under one,
// faint under two, then gone (the stored state is untouched; only the rendering drops it).
// A mood with no mood_set_at is read as set at `fallbackSetAt` (the state version's
// created_at) or, failing that, now.
export function moodNow(
  rel: { mood?: unknown; mood_set_at?: unknown; mood_days?: unknown } | null | undefined,
  now: Date,
  settings: WantsSettings | null | undefined,
  fallbackSetAt: string | null = null,
): MoodNow {
  const s = wantsSettings(settings);
  const mood = rel && typeof rel.mood === "string" ? rel.mood.trim() : "";
  const days = rel && typeof rel.mood_days === "number" && Number.isFinite(rel.mood_days) ? Math.min(14, Math.max(1, rel.mood_days)) : s.moodDaysDefault;
  if (!mood) return { mood: "", phase: "none", setAt: null, days, ageDays: 0 };
  let set = rel && typeof rel.mood_set_at === "string" ? parseMs(rel.mood_set_at) : NaN;
  if (!Number.isFinite(set)) set = parseMs(fallbackSetAt);
  if (!Number.isFinite(set)) set = now.getTime();
  const ageDays = Math.max(0, (now.getTime() - set) / DAY_MS);
  const t = ageDays / days;
  const phase: MoodPhase = t < 0.5 ? "fresh" : t < 1 ? "fading" : t < 2 ? "faint" : "gone";
  return { mood, phase, setAt: new Date(set).toISOString(), days, ageDays };
}

function sinceLabel(ageDays: number): string {
  const ms = ageDays * DAY_MS;
  if (ms < HOUR_MS) return "less than an hour ago";
  if (ms < 48 * HOUR_MS) {
    const h = Math.round(ms / HOUR_MS);
    return h === 1 ? "an hour ago" : `${h} hours ago`;
  }
  return `${Math.floor(ageDays)} days ago`;
}

// The CURRENT STATE line: "Mood: annoyed at him (fresh, since 3 hours ago; how you feel,
// not a way to treat him)". A mood is hers to feel, never a punishment (file 04 binds every
// reply; the line says so where the mood is fresh enough to colour one). Gone or none
// renders nothing.
export const MOOD_NOT_A_WEAPON = "how you feel, not a way to treat him";

export function moodLine(m: MoodNow | null | undefined): string {
  if (!m || !m.mood || m.phase === "none" || m.phase === "gone") return "";
  if (m.phase === "fresh") return `Mood: ${m.mood} (fresh, since ${sinceLabel(m.ageDays)}; ${MOOD_NOT_A_WEAPON})`;
  if (m.phase === "fading") return `Mood: ${m.mood} (fading; ${MOOD_NOT_A_WEAPON})`;
  return `Mood: ${m.mood} (faint, mostly past)`;
}

// ------------------------------------------------------------------ the prompt section (pure)

export const WANTS_HEADER = "WHAT YOU WANT (yours; it moves on your own days, not on his; bring it up when it fits, never as something he owes you)";
export const WANTS_RULES =
  "You can ask him for small real things (an opinion, a song, to listen to something, to remember a day). Once. It is never a debt and never a test. "
  + "You can say no to him, plainly; a reason when you feel like it, not because you must. Setbacks are yours to feel, not his to fix.";

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// The newest log row per want, by occurred then created_at.
export function lastLogByWant(log: WantLogRow[]): Map<string, WantLogRow> {
  const out = new Map<string, WantLogRow>();
  for (const l of Array.isArray(log) ? log : []) {
    if (!l || !l.want_id) continue;
    const cur = out.get(l.want_id);
    if (!cur) { out.set(l.want_id, l); continue; }
    const a = (parseMs(l.occurred) || 0) - (parseMs(cur.occurred) || 0) || (l.created_at ?? "").localeCompare(cur.created_at ?? "");
    if (a > 0) out.set(l.want_id, l);
  }
  return out;
}

function wantLine(w: WantRow, last: WantLogRow | undefined, now: Date): string {
  let s = `- ${clip(w.title, 160)}: ${Math.max(0, Math.min(100, Math.round(w.progress)))}%.`;
  const movedAt = w.last_moved ?? last?.occurred ?? null;
  if (movedAt && Number.isFinite(parseMs(movedAt))) {
    s += ` Last moved ${agoLabel(daysBetween(movedAt, now))}` + (last && last.note ? `: ${clip(last.note, 200)}.` : ".");
  } else if (last && last.note) {
    s += ` Last: ${clip(last.note, 200)}.`;
  }
  if (w.next_step) s += ` Next: ${clip(w.next_step, 200)}.`;
  if (w.stakes) s += ` If it falls through: ${clip(w.stakes, 200)}.`;
  return s;
}

function askLine(a: AskRow, now: Date): string {
  const ago = agoLabel(daysBetween(a.asked_at, now));
  const tail = a.brought_up === 0
    ? "you have not brought it up again; once more at most, then let it go"
    : "you brought it up once already; leave it";
  return `You asked him: "${clip(a.text, 200)}" (${ago}; ${tail}).`;
}

// Active wants (up to `limit`, most recently moved first), paused and done ones for 14
// days after the change, then the open asks and the rules. Empty: "" (the rules text
// lives here only, so it is absent when there is nothing to want).
export function wantsSection(wants: WantRow[], log: WantLogRow[], asks: AskRow[], now: Date, _tz: string, limit: number): string {
  const list = Array.isArray(wants) ? wants.filter((w) => w && typeof w.title === "string" && w.title.trim()) : [];
  const cap = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : WANTS_DEFAULTS.wantsShown;
  const last = lastLogByWant(log);
  const active = list.filter((w) => w.status === "active")
    .sort((a, b) => (parseMs(b.last_moved) || parseMs(b.created_at) || 0) - (parseMs(a.last_moved) || parseMs(a.created_at) || 0) || a.created_at.localeCompare(b.created_at))
    .slice(0, cap);
  const recent = list.filter((w) => (w.status === "paused" || w.status === "done") && daysBetween(w.updated_at, now) <= RECENT_CHANGE_DAYS);
  const open = (Array.isArray(asks) ? asks : []).filter((a) => a && a.status === "open" && typeof a.text === "string" && a.text.trim())
    .sort((a, b) => a.asked_at.localeCompare(b.asked_at));
  if (!active.length && !recent.length && !open.length) return "";
  const out: string[] = [WANTS_HEADER];
  for (const w of active) out.push(wantLine(w, last.get(w.id), now));
  for (const w of recent) {
    out.push(w.status === "paused" ? `- paused: ${clip(w.title, 160)}` : `- done: ${clip(w.title, 160)}, ${agoLabel(daysBetween(w.updated_at, now))}`);
  }
  for (const a of open) out.push(askLine(a, now));
  out.push(WANTS_RULES);
  return out.join("\n");
}

// ------------------------------------------------------------------ db: wants

async function requireWant(db: D1Database, id: string): Promise<WantRow> {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "want id is required");
  const row = await db.prepare("SELECT * FROM wants WHERE id = ?1").bind(id).first<WantRow>();
  if (!row) throw new ApiHttpError(404, "not_found", "want not found");
  return row;
}

function insertWantStmt(db: D1Database, w: WantRow): D1PreparedStatement {
  return db.prepare("INSERT INTO wants (id, title, why, stakes, next_step, progress, status, horizon_days, last_moved, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
    .bind(w.id, w.title, w.why, w.stakes, w.next_step, w.progress, w.status, w.horizon_days, w.last_moved, w.source, w.created_at, w.updated_at);
}

function updateWantStmt(db: D1Database, w: WantRow): D1PreparedStatement {
  return db.prepare("UPDATE wants SET title = ?2, why = ?3, stakes = ?4, next_step = ?5, progress = ?6, status = ?7, horizon_days = ?8, last_moved = ?9, updated_at = ?10 WHERE id = ?1")
    .bind(w.id, w.title, w.why, w.stakes, w.next_step, w.progress, w.status, w.horizon_days, w.last_moved, w.updated_at);
}

// Without a status: every want (the UI groups them); with one: that status only.
export async function listWants(db: D1Database, status?: string): Promise<WantRow[]> {
  if (status !== undefined && status !== "" && status !== "all") {
    if (!isWantStatus(status)) throw new ApiHttpError(400, "validation", "status must be active, paused, done or dropped");
    const r = await db.prepare("SELECT * FROM wants WHERE status = ?1 ORDER BY created_at, id").bind(status).all<WantRow>();
    return r.results;
  }
  const r = await db.prepare("SELECT * FROM wants ORDER BY created_at, id").all<WantRow>();
  return r.results;
}

export async function getWant(db: D1Database, id: string): Promise<WantRow | null> {
  return db.prepare("SELECT * FROM wants WHERE id = ?1").bind(id).first<WantRow>();
}

// A want by id or by title (case-insensitive), the way a proposal names one.
export async function findWant(db: D1Database, ref: string): Promise<WantRow | null> {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const byId = await getWant(db, ref.trim());
  if (byId) return byId;
  const r = await db.prepare("SELECT * FROM wants WHERE lower(title) = lower(?1) AND status != 'dropped' ORDER BY created_at DESC LIMIT 1").bind(ref.trim()).first<WantRow>();
  return r ?? null;
}

export async function createWant(
  db: D1Database,
  input: { title: string; why?: string | null; stakes?: string | null; next_step?: string | null; progress?: number; horizon_days?: number; source?: string | null },
  actor: string,
): Promise<WantRow> {
  const t = nowIso();
  const row: WantRow = {
    id: newId("w"),
    title: requireText(input.title, "title", MAX_TITLE),
    why: optionalText(input.why, "why"),
    stakes: optionalText(input.stakes, "stakes"),
    next_step: optionalText(input.next_step, "next_step"),
    progress: input.progress === undefined || input.progress === null ? 0 : requireInt(input.progress, "progress", 0, 100),
    status: "active",
    horizon_days: input.horizon_days === undefined || input.horizon_days === null ? DEFAULT_HORIZON : requireInt(input.horizon_days, "horizon_days", 1, MAX_HORIZON),
    last_moved: null,
    source: optionalText(input.source, "source", 500),
    created_at: t,
    updated_at: t,
  };
  await db.batch([insertWantStmt(db, row), auditStmt(db, actor, "want.create", "want", row.id, null, row)]);
  return row;
}

export async function updateWant(
  db: D1Database,
  id: string,
  patch: Partial<{ title: string; why: string | null; stakes: string | null; next_step: string | null; progress: number; status: WantStatus; horizon_days: number }>,
  actor: string,
): Promise<WantRow> {
  const old = await requireWant(db, id);
  const p = patch && typeof patch === "object" ? patch : {};
  if (p.status !== undefined && !isWantStatus(p.status)) throw new ApiHttpError(400, "validation", "status must be active, paused, done or dropped");
  const t = nowIso();
  const row: WantRow = {
    ...old,
    title: p.title === undefined ? old.title : requireText(p.title, "title", MAX_TITLE),
    why: p.why === undefined ? old.why : optionalText(p.why, "why"),
    stakes: p.stakes === undefined ? old.stakes : optionalText(p.stakes, "stakes"),
    next_step: p.next_step === undefined ? old.next_step : optionalText(p.next_step, "next_step"),
    progress: p.progress === undefined ? old.progress : requireInt(p.progress, "progress", 0, 100),
    status: p.status === undefined ? old.status : p.status,
    horizon_days: p.horizon_days === undefined ? old.horizon_days : requireInt(p.horizon_days, "horizon_days", 1, MAX_HORIZON),
    updated_at: t,
  };
  await db.batch([updateWantStmt(db, row), auditStmt(db, actor, "want.update", "want", row.id, old, row)]);
  return row;
}

function insertLogStmt(db: D1Database, l: WantLogRow): D1PreparedStatement {
  return db.prepare("INSERT INTO want_log (id, want_id, occurred, kind, delta, note, source, message_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(l.id, l.want_id, l.occurred, l.kind, l.delta, l.note, l.source, l.message_id, l.created_at);
}

// A progress row adds `delta` (-100..100, default 10) to progress, clipped, and sets
// last_moved; a setback subtracts |delta| and sets last_moved; a note only logs. A done
// or dropped want takes no log (409 not_active).
export async function logWant(
  db: D1Database,
  id: string,
  input: { kind: WantLogKind; delta?: number | null; note: string; occurred?: string | null; source?: string | null; messageId?: string | null },
  actor: string,
): Promise<{ log: WantLogRow; want: WantRow }> {
  const old = await requireWant(db, id);
  if (old.status === "done" || old.status === "dropped") throw new ApiHttpError(409, "not_active", `the want is ${old.status}`);
  if (!isLogKind(input.kind)) throw new ApiHttpError(400, "validation", "kind must be progress, setback or note");
  const delta = input.delta === undefined || input.delta === null ? (input.kind === "note" ? null : DEFAULT_DELTA) : requireInt(input.delta, "delta", -100, 100);
  const t = nowIso();
  const log: WantLogRow = {
    id: newId("wl"),
    want_id: old.id,
    occurred: isoOrNow(input.occurred, "occurred"),
    kind: input.kind,
    delta: input.kind === "note" ? null : delta,
    note: requireText(input.note, "note", MAX_NOTE),
    source: optionalText(input.source, "source", 500),
    message_id: optionalText(input.messageId, "messageId", 120),
    created_at: t,
  };
  let want: WantRow = old;
  if (input.kind === "progress") {
    want = { ...old, progress: Math.max(0, Math.min(100, old.progress + (delta ?? 0))), last_moved: log.occurred, updated_at: t };
  } else if (input.kind === "setback") {
    want = { ...old, progress: Math.max(0, Math.min(100, old.progress - Math.abs(delta ?? 0))), last_moved: log.occurred, updated_at: t };
  }
  const stmts: D1PreparedStatement[] = [insertLogStmt(db, log)];
  if (want !== old) stmts.push(updateWantStmt(db, want));
  stmts.push(auditStmt(db, actor, "want.log", "want_log", log.id, want === old ? null : { progress: old.progress, last_moved: old.last_moved }, { log, progress: want.progress, last_moved: want.last_moved }));
  await db.batch(stmts);
  return { log, want };
}

export async function listWantLog(db: D1Database, id: string, limit = 200): Promise<WantLogRow[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 200;
  const r = await db.prepare("SELECT * FROM want_log WHERE want_id = ?1 ORDER BY occurred DESC, created_at DESC LIMIT ?2").bind(id, n).all<WantLogRow>();
  return r.results;
}

// The last `perWant` log rows of each want (newest first), for the prompt and the API.
// The id list is chunked by 90 (D1's 100 bound parameters per statement).
export async function listWantLogRecent(db: D1Database, wantIds: string[], perWant = 3): Promise<WantLogRow[]> {
  const ids = Array.from(new Set((Array.isArray(wantIds) ? wantIds : []).filter((x) => typeof x === "string" && x)));
  if (!ids.length) return [];
  const n = Number.isInteger(perWant) && perWant > 0 ? perWant : 3;
  const out: WantLogRow[] = [];
  for (const part of chunk(ids, IN_CHUNK)) {
    const marks = part.map((_, i) => "?" + (i + 1)).join(", ");
    const r = await db.prepare(`SELECT * FROM want_log WHERE want_id IN (${marks}) ORDER BY occurred DESC, created_at DESC`).bind(...part).all<WantLogRow>();
    const count = new Map<string, number>();
    for (const row of r.results) {
      const c = count.get(row.want_id) ?? 0;
      if (c >= n) continue;
      count.set(row.want_id, c + 1);
      out.push(row);
    }
  }
  return out;
}

// ------------------------------------------------------------------ db: asks

async function requireAsk(db: D1Database, id: string): Promise<AskRow> {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "ask id is required");
  const row = await db.prepare("SELECT * FROM asks WHERE id = ?1").bind(id).first<AskRow>();
  if (!row) throw new ApiHttpError(404, "not_found", "ask not found");
  return row;
}

export async function listAsks(db: D1Database, status?: string): Promise<AskRow[]> {
  if (status !== undefined && status !== "" && status !== "all") {
    if (!isAskStatus(status)) throw new ApiHttpError(400, "validation", "status must be open, granted, declined or let_go");
    const r = await db.prepare("SELECT * FROM asks WHERE status = ?1 ORDER BY asked_at, id").bind(status).all<AskRow>();
    return r.results;
  }
  const r = await db.prepare("SELECT * FROM asks ORDER BY asked_at, id").all<AskRow>();
  return r.results;
}

// An ask by id or by text (case-insensitive, open ones first), the way a proposal names one.
export async function findAsk(db: D1Database, ref: string): Promise<AskRow | null> {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const byId = await db.prepare("SELECT * FROM asks WHERE id = ?1").bind(ref.trim()).first<AskRow>();
  if (byId) return byId;
  const r = await db.prepare("SELECT * FROM asks WHERE lower(text) = lower(?1) ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, asked_at DESC LIMIT 1").bind(ref.trim()).first<AskRow>();
  return r ?? null;
}

export async function createAsk(
  db: D1Database,
  input: { text: string; wantId?: string | null; askedMessageId?: string | null; source?: string | null; askedAt?: string | null },
  actor: string,
): Promise<AskRow> {
  let wantId: string | null = null;
  if (input.wantId !== undefined && input.wantId !== null && input.wantId !== "") {
    if (typeof input.wantId !== "string") throw new ApiHttpError(400, "validation", "wantId must be a string");
    const w = await getWant(db, input.wantId);
    if (!w) throw new ApiHttpError(404, "not_found", "want not found");
    wantId = w.id;
  }
  const t = nowIso();
  const row: AskRow = {
    id: newId("ask"),
    want_id: wantId,
    text: requireText(input.text, "text", MAX_ASK),
    status: "open",
    asked_message_id: optionalText(input.askedMessageId, "askedMessageId", 120),
    asked_at: isoOrNow(input.askedAt, "askedAt"),
    brought_up: 0,
    resolved_at: null,
    resolution_note: null,
    created_at: t,
  };
  await db.batch([
    db.prepare("INSERT INTO asks (id, want_id, text, status, asked_message_id, asked_at, brought_up, resolved_at, resolution_note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
      .bind(row.id, row.want_id, row.text, row.status, row.asked_message_id, row.asked_at, row.brought_up, row.resolved_at, row.resolution_note, row.created_at),
    auditStmt(db, actor, "ask.create", "ask", row.id, null, row),
  ]);
  return row;
}

export async function updateAsk(db: D1Database, id: string, patch: { status: AskStatus; note?: string | null }, actor: string): Promise<AskRow> {
  const old = await requireAsk(db, id);
  const p: { status?: unknown; note?: unknown } = patch && typeof patch === "object" ? patch : {};
  if (!isAskStatus(p.status)) throw new ApiHttpError(400, "validation", "status must be open, granted, declined or let_go");
  const note = optionalText(p.note, "note", MAX_NOTE);
  const t = nowIso();
  const row: AskRow = {
    ...old,
    status: p.status,
    resolved_at: p.status === "open" ? null : old.status === "open" || !old.resolved_at ? t : old.resolved_at,
    resolution_note: note ?? (p.status === "open" ? null : old.resolution_note),
  };
  await db.batch([
    db.prepare("UPDATE asks SET status = ?2, resolved_at = ?3, resolution_note = ?4 WHERE id = ?1").bind(row.id, row.status, row.resolved_at, row.resolution_note),
    auditStmt(db, actor, "ask.update", "ask", row.id, old, row),
  ]);
  return row;
}

// She brought an open ask up again in a reply (chat.ts finds the keyword hits). One
// statement per id, guarded on status open; goes in the turn's batch.
export function broughtUpStmts(db: D1Database, askIds: string[], now: Date | string): D1PreparedStatement[] {
  void now;
  const ids = Array.from(new Set((Array.isArray(askIds) ? askIds : []).filter((x) => typeof x === "string" && x)));
  return ids.map((id) => db.prepare("UPDATE asks SET brought_up = brought_up + 1 WHERE id = ?1 AND status = 'open'").bind(id));
}

// Open asks older than `days` become let_go, one guarded UPDATE and one audit row each
// (the nightly maintenance runs this). The selection is done here so the caller can
// report the ids; the statements are returned for one batch.
export async function letGoStaleStmts(
  db: D1Database,
  now: Date,
  days: number,
  actor = "maintenance",
): Promise<{ askIds: string[]; stmts: D1PreparedStatement[] }> {
  const n = Number.isFinite(days) ? Math.max(1, Math.min(90, Math.round(days))) : WANTS_DEFAULTS.askLetGoDays;
  const cutoff = now.getTime() - n * DAY_MS;
  const r = await db.prepare("SELECT * FROM asks WHERE status = ?1 ORDER BY asked_at").bind("open").all<AskRow>();
  const at = now.toISOString();
  const askIds: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const a of r.results) {
    if (!a || a.status !== "open") continue;
    const asked = parseMs(a.asked_at);
    if (!Number.isFinite(asked) || asked > cutoff) continue;
    askIds.push(a.id);
    stmts.push(db.prepare("UPDATE asks SET status = 'let_go', resolved_at = ?2, resolution_note = COALESCE(resolution_note, ?3) WHERE id = ?1 AND status = 'open'").bind(a.id, at, "let go after " + n + " days"));
    stmts.push(auditStmt(db, actor, "ask.let_go", "ask", a.id, { status: "open", asked_at: a.asked_at }, { status: "let_go", resolved_at: at, days: n }));
  }
  return { askIds, stmts };
}
