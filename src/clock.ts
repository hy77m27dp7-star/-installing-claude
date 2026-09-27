// Her clock (SPEC_V5 section 1), with Justin's rule: "time can pass on texting mode but not
// together mode... i might quit in the middle of a scene".
//
// Story time runs only while the scene is APART (or there is none). Every run of consecutive
// scene versions whose status is together is one HELD span: it opens at the created_at of
// the run's first version and closes at the created_at of the first later version that is
// not together. Inside a held span the story clock stands still at the moment the scene
// began; outside one it is the real now, so her calendar is Portland's. Absence is measured
// in story time: real elapsed time minus its overlap with every held span.
//
// The spans live in one small table (story_clock) that every reader syncs lazily against
// state_versions (syncStoryClock), so every path that moves the scene (the Apart switch, a
// promoted proposal, a restore, an import) is caught without a hook in any of them.
//
// Import rule (the module graph keeps no cycle through here): this file imports life.ts,
// grounding.ts, weather.ts, db.ts and errors.ts, and NEVER prompt.ts, wants.ts, arcs.ts,
// callbacks.ts or memory.ts (each of those imports this file, or is imported by life.ts).
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { outfitNow, todayRows } from "./grounding";
import type { GroundingRow, Outfit } from "./grounding";
import { WEEKDAYS, formatClock, localParts, safeTimezone } from "./life";
import type { SceneMode, Settings, TimeSince, VisualAssetRow } from "./types";
import { CACHE_FRESH_MS, cacheKey, herCoordinates, weatherProviderOf, weatherUnitsOf } from "./weather";
import type { WeatherNow } from "./weather";

export const CLOCK_ACTOR = "clock";
export const CLOCK_HORIZON_DAYS = 120; // spans older than this (by resumed_at) are not loaded
export const HER_DAY_MIN_APART_MS = 6 * 60 * 60 * 1000;
export const SNAPSHOT_WEATHER_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export interface ClockSpan {
  id: string;
  opened_version: number;
  frozen_at: string;
  closed_version: number | null;
  resumed_at: string | null;
  location: string | null;
  weather_json: string | null;
  outfit_json: string | null;
  today_json: string | null;
  prior_time: string | null;
  beats_shifted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoryClock {
  enabled: boolean; // settings.storyClockEnabled (a missing key reads true)
  real: string; // ISO of the real instant the clock was read at
  frozen: boolean; // enabled and a span is open (the scene is together)
  open: ClockSpan | null;
  spans: ClockSpan[]; // open spans and spans resumed within CLOCK_HORIZON_DAYS, oldest first
}

export interface ClockView {
  enabled: boolean;
  frozen: boolean;
  real: string;
  storyNow: string;
  open: { id: string; frozenAt: string; location: string | null } | null;
  recent: Array<{ id: string; frozenAt: string; resumedAt: string | null; location: string | null; minutes: number }>;
}

export interface LastExchange { hisAt: string | null; herAt: string | null; lastAt: string | null }

export interface HeldGrounding { weather: WeatherNow | null; outfit: Outfit | null; today: GroundingRow[] }

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_WORDS_MAX = 60;
const SNAPSHOT_TODAY_MAX = 30;
const RECENT_SPANS = 10;
const SPANS_LIMIT = 500;
const SHIFT_LIMIT = 200;
// Review fixes: the closed spans whose beats were never moved (a failed shift, a Worker that
// died between the close and the claim, a run written by the backfill) retried per sync; the
// scene versions one backfill reads.
const RETRY_SHIFT_LIMIT = 3;
const BACKFILL_VERSIONS_LIMIT = 2000;
const BACKFILL_BATCH = 50;
const TIME_SINCE_FLOOR_MINUTES = 15;

export const TIME_SINCE_HEADER =
  "TIME SINCE (true, from the clock; use it or ignore it; never a complaint, never who wrote last, never where he was, never how long you waited)";

// ------------------------------------------------------------------ pure

// The same rule as prompt.ts sceneMode: a string that trims and lowercases to "together".
export function isTogether(status: unknown): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "together";
}

export function disabledClock(real: Date): StoryClock {
  const t = real instanceof Date && Number.isFinite(real.getTime()) ? real : new Date();
  return { enabled: false, real: t.toISOString(), frozen: false, open: null, spans: [] };
}

export function storyNow(clock: StoryClock): Date {
  if (clock.enabled && clock.open) return new Date(Date.parse(clock.open.frozen_at));
  return new Date(Date.parse(clock.real));
}

function spanStart(s: ClockSpan): number {
  return typeof s.frozen_at === "string" ? Date.parse(s.frozen_at) : NaN;
}

function spanEnd(s: ClockSpan, realMs: number): number {
  return s.resumed_at ? Date.parse(s.resumed_at) : realMs;
}

// The held time inside [fromMs, toMs]: the sum of every span's overlap with the interval.
// Spans never overlap each other (the record is one sequence of versions).
export function frozenOverlapMs(spans: readonly ClockSpan[], fromMs: number, toMs: number, realMs: number): number {
  let sum = 0;
  for (const s of Array.isArray(spans) ? spans : []) {
    if (!s) continue;
    const start = spanStart(s);
    const end = spanEnd(s, realMs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    sum += Math.max(0, Math.min(toMs, end) - Math.max(fromMs, start));
  }
  return sum;
}

export function storyElapsedMs(clock: StoryClock, fromIso: string | null | undefined, toIso?: string | null): number {
  const from = typeof fromIso === "string" ? Date.parse(fromIso) : NaN;
  const real = Date.parse(clock.real);
  const to = typeof toIso === "string" && toIso ? Date.parse(toIso) : real;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  if (!clock.enabled) return to - from;
  return Math.max(0, to - from - frozenOverlapMs(clock.spans, from, to, real));
}

export function storyAgeDays(clock: StoryClock, fromIso: string | null | undefined): number {
  return storyElapsedMs(clock, fromIso) / DAY_MS;
}

// The instant a real stamp stands for in the story: inside a span, the moment the scene froze.
export function storyInstantOf(clock: StoryClock, iso: string): Date {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return new Date(Date.parse(clock.real));
  if (clock.enabled) {
    const realMs = Date.parse(clock.real);
    for (const s of clock.spans) {
      if (!s) continue;
      const start = spanStart(s);
      const end = spanEnd(s, realMs);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start <= t && t < end) return new Date(start);
    }
  }
  return new Date(t);
}

// A dated thing of hers that fell inside a CLOSED held span stands the same distance after
// the span as it was after the moment the scene froze, to the millisecond. Inside the open
// span, before or after every span, with no clock or an unreadable stamp: unchanged.
export function deferredInstant(clock: StoryClock | null | undefined, iso: string): string {
  if (!clock || !clock.enabled) return iso;
  const t0 = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t0)) return iso;
  // Review fix: the closed spans oldest first, the shifted instant carried through each one,
  // so a thing pushed out of one held span that lands inside the next is pushed past it too.
  const closed = (Array.isArray(clock.spans) ? clock.spans : [])
    .filter((s): s is ClockSpan => !!s && typeof s.resumed_at === "string" && !!s.resumed_at)
    .map((s) => ({ start: spanStart(s), end: Date.parse(s.resumed_at as string) }))
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end))
    .sort((a, b) => a.start - b.start);
  let t = t0;
  for (const x of closed) {
    if (x.start < t && t <= x.end) t = x.end + (t - x.start);
  }
  return t === t0 ? iso : new Date(t).toISOString();
}

// The real instant a story-time window of `windowMs` reaching back from the clock's real now
// starts at: held spans inside it do not count, so a week of story time after a three-day
// held scene reaches ten real days back. No clock or a disabled one: plain real time.
export function storyWindowStart(clock: StoryClock | null | undefined, windowMs: number): Date {
  const realMs = clock ? Date.parse(clock.real) : Date.now();
  const base = Number.isFinite(realMs) ? realMs : Date.now();
  const want = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0;
  if (!clock || !clock.enabled) return new Date(base - want);
  const spans = (Array.isArray(clock.spans) ? clock.spans : [])
    .filter((s): s is ClockSpan => !!s)
    .map((s) => ({ start: spanStart(s), end: spanEnd(s, base) }))
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => b.start - a.start);
  let cursor = base;
  let remaining = want;
  for (const x of spans) {
    if (x.start >= cursor) continue;
    const end = Math.min(x.end, cursor);
    const apart = cursor - end;
    if (apart >= remaining) return new Date(cursor - remaining);
    remaining -= apart;
    cursor = x.start;
  }
  return new Date(cursor - remaining);
}

// The reference the sync is tested against: every maximal run of together versions is a span.
export function spansFromVersions(
  versions: ReadonlyArray<{ version: number; status: string; created_at: string; location?: string | null }>,
): Array<{ openedVersion: number; frozenAt: string; closedVersion: number | null; resumedAt: string | null; location: string | null }> {
  const sorted = (Array.isArray(versions) ? [...versions] : []).filter((v) => v && Number.isFinite(v.version)).sort((a, b) => a.version - b.version);
  const out: Array<{ openedVersion: number; frozenAt: string; closedVersion: number | null; resumedAt: string | null; location: string | null }> = [];
  let open: { openedVersion: number; frozenAt: string; closedVersion: number | null; resumedAt: string | null; location: string | null } | null = null;
  for (const v of sorted) {
    if (isTogether(v.status)) {
      if (!open) open = { openedVersion: v.version, frozenAt: v.created_at, closedVersion: null, resumedAt: null, location: v.location ?? null };
    } else if (open) {
      open.closedVersion = v.version;
      open.resumedAt = v.created_at;
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDayKeyOf(d: Date, tz: string): string {
  const p = localParts(d, safeTimezone(tz));
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function parseDay(day: string): { y: number; m: number; d: number } | null {
  const m = typeof day === "string" ? DAY_RE.exec(day.trim()) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

// The ISO instant of a wall-clock time on a local calendar day, DST-safe (two passes of the
// zone's offset). A malformed day or time is a 400.
export function localInstant(day: string, hhmm: string, tz: string): string {
  const dp = parseDay(day);
  if (!dp) throw new ApiHttpError(400, "validation", "day must be a real date as YYYY-MM-DD");
  const tm = typeof hhmm === "string" ? HHMM_RE.exec(hhmm.trim()) : null;
  if (!tm) throw new ApiHttpError(400, "validation", "time must be HH:MM (00:00 to 23:59)");
  const zone = safeTimezone(tz);
  const guess = Date.UTC(dp.y, dp.m - 1, dp.d, Number(tm[1]), Number(tm[2]));
  const o1 = localParts(new Date(guess), zone).offsetMinutes;
  const t1 = guess - o1 * MINUTE_MS;
  const o2 = localParts(new Date(t1), zone).offsetMinutes;
  return new Date(guess - o2 * MINUTE_MS).toISOString();
}

export function dayBounds(day: string, tz: string): { start: string; end: string } {
  const dp = parseDay(day);
  if (!dp) throw new ApiHttpError(400, "validation", "day must be a real date as YYYY-MM-DD");
  const next = new Date(Date.UTC(dp.y, dp.m - 1, dp.d + 1));
  const nextDay = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
  return { start: localInstant(day, "00:00", tz), end: localInstant(nextDay, "00:00", tz) };
}

// The last local day that has ENDED by `now`: always the calendar day before today, her time.
// No run of any kind writes or marks a day that is not over.
export function herDayKey(now: Date, tz: string): string {
  const today = localDayKeyOf(now, tz);
  return localDayKeyOf(new Date(Date.parse(dayBounds(today, tz).start) - 1), tz);
}

export function gapWords(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v < 60 * MINUTE_MS) return "less than an hour";
  if (v < 90 * MINUTE_MS) return "about an hour";
  if (v < 20 * HOUR_MS) return `about ${Math.round(v / HOUR_MS)} hours`;
  if (v < 36 * HOUR_MS) return "about a day";
  const days = v / DAY_MS;
  if (days < 13.5) return `${Math.round(days)} days`;
  if (days < 60) {
    const w = Math.round(days / 7);
    return w === 1 ? "about a week" : `${w} weeks`;
  }
  const months = Math.round(days / 30);
  return months === 1 ? "about a month" : `${months} months`;
}

// No role: who wrote last never reaches her (SPEC_V5 skeptic 6).
export function timeSince(clock: StoryClock, last: LastExchange, tz: string): TimeSince {
  const hisAgoMs = last && last.hisAt ? storyElapsedMs(clock, last.hisAt) : null;
  const lastAgoMs = last && last.lastAt ? storyElapsedMs(clock, last.lastAt) : null;
  // Review fix: the day of the last exchange is read back from the story time since it, so a
  // scene held from Tuesday night to Friday morning is not "a new day" three hours later.
  const nowStory = storyNow(clock);
  const newDay = last && last.lastAt && typeof lastAgoMs === "number"
    ? localDayKeyOf(new Date(nowStory.getTime() - lastAgoMs), tz) !== localDayKeyOf(nowStory, tz)
    : false;
  return { hisAgoMs, lastAgoMs, newDay };
}

export function timeSinceSection(t: TimeSince | null | undefined, args: { mode: SceneMode; opener: boolean; minMinutes: number }): string {
  if (!t || !args || args.mode === "together" || args.opener) return "";
  const ago = t.lastAgoMs;
  if (typeof ago !== "number" || !Number.isFinite(ago)) return "";
  const floor = Math.max(TIME_SINCE_FLOOR_MINUTES, Number.isFinite(args.minMinutes) ? args.minMinutes : TIME_SINCE_FLOOR_MINUTES);
  if (ago < floor * MINUTE_MS) return "";
  const out = [TIME_SINCE_HEADER, `You last talked ${gapWords(ago)} ago.`];
  if (t.newDay) out.push("It is a new day since you last talked.");
  return out.join("\n");
}

// The scene's own time words while the scene is held; never words carried over from the
// scene before (the open span's prior_time).
export function clockWordsFor(scene: { status?: unknown; time?: unknown }, clock: StoryClock): string | null {
  if (!clock || !clock.enabled || !clock.frozen || !clock.open) return null;
  if (!scene || !isTogether(scene.status)) return null;
  if (typeof scene.time !== "string") return null;
  const words = scene.time.replace(/\s+/g, " ").trim();
  if (!words || words.length > TIME_WORDS_MAX) return null;
  const prior = typeof clock.open.prior_time === "string" ? clock.open.prior_time.replace(/\s+/g, " ").trim().toLowerCase() : "";
  if (prior && prior === words.toLowerCase()) return null;
  return words;
}

function parseJson<T>(json: string | null | undefined): T | null {
  if (typeof json !== "string" || !json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function readHeldWeather(json: string | null): WeatherNow | null {
  const w = parseJson<WeatherNow>(json);
  if (!w || typeof w !== "object" || typeof w.temp !== "number" || !Number.isFinite(w.temp)) return null;
  return w;
}

function readHeldOutfit(json: string | null): Outfit | null {
  const o = parseJson<Outfit>(json);
  if (!o || typeof o !== "object" || typeof o.text !== "string" || !o.text.trim() || typeof o.at !== "string") return null;
  return o;
}

// The grounding of a held scene: everything inside the span is stamped frozen_at, so no line
// shows a real time that happened while the scene was held.
export function heldGrounding(span: ClockSpan, live: { assets: VisualAssetRow[]; rows: GroundingRow[] }, clock: StoryClock): HeldGrounding {
  const frozenAt = span.frozen_at;
  const start = Date.parse(frozenAt);
  const realMs = Date.parse(clock.real);
  const inSpan = (iso: string | null | undefined): boolean => {
    if (typeof iso !== "string") return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && Number.isFinite(start) && t >= start && (!Number.isFinite(realMs) || t <= realMs);
  };

  const weather = readHeldWeather(span.weather_json);

  const today: GroundingRow[] = [];
  const seen = new Set<string>();
  const snap = parseJson<unknown>(span.today_json);
  for (const r of Array.isArray(snap) ? (snap as GroundingRow[]) : []) {
    if (!r || typeof r !== "object" || typeof r.note !== "string" || r.kind === "outfit") continue;
    if (typeof r.id === "string") seen.add(r.id);
    today.push(r);
  }
  const liveRows = Array.isArray(live && live.rows) ? live.rows : [];
  for (const r of liveRows) {
    if (!r || r.kind === "outfit" || typeof r.note !== "string") continue;
    if (!inSpan(r.created_at)) continue;
    if (typeof r.id === "string" && seen.has(r.id)) continue;
    if (typeof r.id === "string") seen.add(r.id);
    today.push({ ...r, occurred: frozenAt });
  }

  // The outfit: the newest of the snapshot, a photo she sent inside the scene, and an outfit
  // note written inside it (ranked by when each really happened, then stamped frozen_at).
  let best: Outfit | null = readHeldOutfit(span.outfit_json);
  let bestMs = best ? Date.parse(best.at) : -Infinity;
  if (!Number.isFinite(bestMs)) bestMs = -Infinity;
  const consider = (o: Outfit, realAt: number): void => {
    if (!Number.isFinite(realAt)) return;
    if (!best || realAt > bestMs) {
      best = o;
      bestMs = realAt;
    }
  };
  for (const a of Array.isArray(live && live.assets) ? live.assets : []) {
    if (!a || a.role !== "scene" || a.approval_status !== "approved") continue;
    if (typeof a.message_id !== "string" || !a.message_id.trim()) continue;
    if (!inSpan(a.decided_at)) continue;
    const text = typeof a.prompt === "string" ? a.prompt.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    consider({ text, from: "photo", at: frozenAt, assetId: a.id }, Date.parse(a.decided_at as string));
  }
  for (const r of liveRows) {
    if (!r || r.kind !== "outfit" || typeof r.note !== "string" || !r.note.trim()) continue;
    if (!inSpan(r.created_at)) continue;
    consider({ text: r.note.replace(/\s+/g, " ").trim(), from: "log", at: frozenAt, rowId: r.id }, Date.parse(r.created_at));
  }

  return { weather, outfit: best, today };
}

export function clockView(clock: StoryClock): ClockView {
  const realMs = Date.parse(clock.real);
  const recent = [...(Array.isArray(clock.spans) ? clock.spans : [])].reverse().slice(0, RECENT_SPANS).map((s) => {
    const start = spanStart(s);
    const end = spanEnd(s, realMs);
    const minutes = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / MINUTE_MS)) : 0;
    return { id: s.id, frozenAt: s.frozen_at, resumedAt: s.resumed_at, location: s.location, minutes };
  });
  const open = clock.enabled && clock.open ? { id: clock.open.id, frozenAt: clock.open.frozen_at, location: clock.open.location } : null;
  return { enabled: clock.enabled, frozen: clock.frozen, real: clock.real, storyNow: storyNow(clock).toISOString(), open, recent };
}

// ------------------------------------------------------------------ database

interface SceneHead { version: number; created_at: string; status: string; location: string | null }

const STATUS_EXPR = "COALESCE(lower(trim(json_extract(state_json, '$.status'))), '')";

function changed(r: D1Result | undefined | null): number {
  return r && r.meta && typeof r.meta.changes === "number" ? r.meta.changes : 0;
}

function tzOf(settings: Partial<Settings> | null | undefined): string {
  return safeTimezone(settings && typeof settings.timezone === "string" ? settings.timezone : "");
}

function errorClass(e: unknown): string {
  return e instanceof Error ? e.name || "Error" : "error";
}

async function snapshotFor(
  db: D1Database,
  settings: Partial<Settings> | null | undefined,
  frozenAt: string,
  tz: string,
): Promise<{ weather: string | null; outfit: string | null; today: string | null }> {
  const t = Date.parse(frozenAt);
  const out: { weather: string | null; outfit: string | null; today: string | null } = { weather: null, outfit: null, today: null };
  if (!Number.isFinite(t)) return out;
  const frozen = new Date(t);

  // The weather of that moment, from the cache only (never fetched long after it).
  try {
    const coords = herCoordinates(settings ?? null);
    if (coords && weatherProviderOf(settings ?? null) !== "off") {
      const key = cacheKey(coords.lat, coords.lon, weatherUnitsOf(settings ?? null));
      const row = await db
        .prepare("SELECT json, fetched_at FROM weather_cache WHERE k = ?1 AND fetched_at >= ?2 AND fetched_at <= ?3 ORDER BY fetched_at DESC LIMIT 1")
        .bind(key, new Date(t - SNAPSHOT_WEATHER_MAX_AGE_MS).toISOString(), new Date(t + CACHE_FRESH_MS).toISOString())
        .first<{ json: string; fetched_at: string }>();
      if (row && typeof row.json === "string") out.weather = row.json;
    }
  } catch (e) {
    console.warn("clock: snapshot weather skipped", errorClass(e));
  }

  let rows: GroundingRow[] = [];
  try {
    rows = (await todayRows(db, frozen, tz)).filter((r) => r && typeof r.occurred === "string" && Date.parse(r.occurred) <= t);
    if (rows.length > SNAPSHOT_TODAY_MAX) rows = rows.slice(rows.length - SNAPSHOT_TODAY_MAX);
    out.today = JSON.stringify(rows);
  } catch (e) {
    console.warn("clock: snapshot rows skipped", errorClass(e));
  }

  try {
    const assets = await db
      .prepare("SELECT * FROM visual_assets WHERE role = 'scene' AND approval_status = 'approved' AND decided_at IS NOT NULL AND decided_at <= ?1 ORDER BY decided_at DESC LIMIT 50")
      .bind(frozenAt)
      .all<VisualAssetRow>();
    const outfit = outfitNow(assets.results ?? [], rows, frozen, tz);
    out.outfit = outfit ? JSON.stringify(outfit) : null;
  } catch (e) {
    console.warn("clock: snapshot outfit skipped", errorClass(e));
  }
  return out;
}

// Claims a closed span's one-time beat move and runs it. A failed read of the beats or a
// failed batch releases the claim (review fix, L1 deviation 7), so the next sync retries
// it; the batch is atomic, so a retry never moves a beat twice.
async function shiftClosedSpan(
  db: D1Database,
  span: ClockSpan,
  resumedAt: string,
  tz: string,
  t: string,
  action: "clock.resume" | "clock.shift",
  after: Record<string, unknown>,
): Promise<number> {
  const claim = await db
    .prepare("UPDATE story_clock SET beats_shifted_at = ?2 WHERE id = ?1 AND beats_shifted_at IS NULL")
    .bind(span.id, t)
    .run();
  if (changed(claim) === 0) return 0;
  const release = async (): Promise<void> => {
    try {
      await db.prepare("UPDATE story_clock SET beats_shifted_at = NULL WHERE id = ?1 AND beats_shifted_at = ?2").bind(span.id, t).run();
    } catch (e) {
      console.error("clock: claim not released", errorClass(e));
    }
  };
  const stmts = await shiftStmtsOrNull(db, { frozenAt: span.frozen_at, resumedAt }, tz);
  if (stmts === null) {
    await release();
    return 0;
  }
  const moved = Math.floor(stmts.length / 2);
  try {
    await db.batch([...stmts, auditStmt(db, CLOCK_ACTOR, action, "story_clock", span.id, span, { ...after, beats_shifted_at: t, beatsMoved: moved })]);
  } catch (e) {
    console.error("clock: beats not moved", errorClass(e), moved);
    await release();
    return 0;
  }
  return moved;
}

async function closeSpan(
  db: D1Database,
  span: ClockSpan,
  closer: { version: number; created_at: string },
  tz: string,
  t: string,
): Promise<{ closed: string | null; shifted: number }> {
  const r = await db
    .prepare("UPDATE story_clock SET closed_version = ?2, resumed_at = ?3, updated_at = ?4 WHERE id = ?1 AND resumed_at IS NULL")
    .bind(span.id, closer.version, closer.created_at, t)
    .run();
  if (changed(r) === 0) return { closed: null, shifted: 0 };
  const after = { ...span, closed_version: closer.version, resumed_at: closer.created_at, updated_at: t };
  const moved = await shiftClosedSpan(db, span, closer.created_at, tz, t, "clock.resume", after);
  return { closed: span.id, shifted: moved };
}

// The closed spans whose beats were never moved, retried a few per sync (review fix).
async function retryShifts(db: D1Database, tz: string, t: string): Promise<number> {
  const r = await db
    .prepare("SELECT * FROM story_clock WHERE resumed_at IS NOT NULL AND beats_shifted_at IS NULL ORDER BY frozen_at ASC LIMIT ?1")
    .bind(RETRY_SHIFT_LIMIT)
    .all<ClockSpan>();
  let moved = 0;
  for (const span of r.results ?? []) {
    if (!span || typeof span.id !== "string" || typeof span.resumed_at !== "string" || !span.resumed_at) continue;
    moved += await shiftClosedSpan(db, span, span.resumed_at, tz, t, "clock.shift", { ...span });
  }
  return moved;
}

// Every together run that CLOSED among the scene versions in (after, upTo] written as a
// closed span (review fix): the runs a single read missed (the record went together, apart,
// together, apart between two reads), and after an import that carried no clock, every held
// run of the restored record. `shiftedAt` null leaves the beat move to the retry; a stamp
// marks it done (an import's beats were never inside these spans on this database).
export async function backfillClosedSpans(
  db: D1Database,
  opts: { after: number; upTo: number | null; shiftedAt: string | null; now: string },
): Promise<number> {
  const after = Number.isFinite(opts.after) ? Math.max(0, Math.trunc(opts.after)) : 0;
  const r = opts.upTo === null
    ? await db
      .prepare(`SELECT version, created_at, ${STATUS_EXPR} AS status, json_extract(state_json, '$.location') AS location FROM state_versions WHERE entity = 'scene' AND version > ?1 ORDER BY version ASC LIMIT ?2`)
      .bind(after, BACKFILL_VERSIONS_LIMIT)
      .all<{ version: number; created_at: string; status: string; location: unknown }>()
    : await db
      .prepare(`SELECT version, created_at, ${STATUS_EXPR} AS status, json_extract(state_json, '$.location') AS location FROM state_versions WHERE entity = 'scene' AND version > ?1 AND version <= ?2 ORDER BY version ASC LIMIT ?3`)
      .bind(after, opts.upTo, BACKFILL_VERSIONS_LIMIT)
      .all<{ version: number; created_at: string; status: string; location: unknown }>();
  const versions = (r.results ?? [])
    .filter((v) => v && typeof v.version === "number" && typeof v.created_at === "string")
    .map((v) => ({
      version: v.version,
      status: typeof v.status === "string" ? v.status : "",
      created_at: v.created_at,
      location: typeof v.location === "string" && v.location.trim() ? v.location.trim() : null,
    }));
  const runs = spansFromVersions(versions).filter((x) => x.closedVersion !== null && typeof x.resumedAt === "string");
  if (!runs.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const x of runs) {
    stmts.push(
      db.prepare("DELETE FROM story_clock WHERE opened_version = ?1 AND frozen_at != ?2").bind(x.openedVersion, x.frozenAt),
      db.prepare("INSERT OR IGNORE INTO story_clock (id, opened_version, frozen_at, closed_version, resumed_at, location, weather_json, outfit_json, today_json, prior_time, beats_shifted_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, NULL, ?7, ?8, ?8)")
        .bind("sc_v" + x.openedVersion, x.openedVersion, x.frozenAt, x.closedVersion, x.resumedAt, x.location, opts.shiftedAt, opts.now),
    );
  }
  let written = 0;
  for (let i = 0; i < stmts.length; i += BACKFILL_BATCH * 2) {
    const res = await db.batch(stmts.slice(i, i + BACKFILL_BATCH * 2));
    for (let j = 1; j < res.length; j += 2) written += changed(res[j]);
  }
  if (written) await auditStmt(db, CLOCK_ACTOR, "clock.backfill", "story_clock", null, null, { after, upTo: opts.upTo, spans: written }).run();
  return written;
}

async function openSpan(
  db: D1Database,
  settings: Partial<Settings> | null | undefined,
  cur: SceneHead,
  tz: string,
  t: string,
): Promise<string | null> {
  const prev = await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM state_versions WHERE entity = 'scene' AND version <= ?1 AND ${STATUS_EXPR} != 'together'`)
    .bind(cur.version)
    .first<{ v: number }>();
  const v = prev && typeof prev.v === "number" ? prev.v : 0;
  const start = await db
    .prepare("SELECT version, created_at, json_extract(state_json, '$.location') AS location FROM state_versions WHERE entity = 'scene' AND version > ?1 ORDER BY version ASC LIMIT 1")
    .bind(v)
    .first<{ version: number; created_at: string; location: unknown }>();
  if (!start) return null;
  let priorTime: string | null = null;
  if (v > 0) {
    const pt = await db
      .prepare("SELECT json_extract(state_json, '$.time') AS time FROM state_versions WHERE entity = 'scene' AND version = ?1")
      .bind(v)
      .first<{ time: unknown }>();
    priorTime = pt && typeof pt.time === "string" && pt.time.trim() ? pt.time.trim() : null;
  }
  const location = typeof start.location === "string" && start.location.trim() ? start.location.trim() : null;
  const snap = await snapshotFor(db, settings, start.created_at, tz);
  const id = "sc_v" + start.version;
  const span: ClockSpan = {
    id,
    opened_version: start.version,
    frozen_at: start.created_at,
    closed_version: null,
    resumed_at: null,
    location,
    weather_json: snap.weather,
    outfit_json: snap.outfit,
    today_json: snap.today,
    prior_time: priorTime,
    beats_shifted_at: null,
    created_at: t,
    updated_at: t,
  };
  const res = await db.batch([
    // A stale row holding this version number after a restore rewrote the versions; a live
    // row for the same run has the same frozen_at and stays.
    db.prepare("DELETE FROM story_clock WHERE opened_version = ?1 AND frozen_at != ?2").bind(span.opened_version, span.frozen_at),
    db.prepare("INSERT OR IGNORE INTO story_clock (id, opened_version, frozen_at, closed_version, resumed_at, location, weather_json, outfit_json, today_json, prior_time, beats_shifted_at, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10)")
      .bind(id, span.opened_version, span.frozen_at, span.location, span.weather_json, span.outfit_json, span.today_json, span.prior_time, t, t),
  ]);
  if (changed(res[1]) === 0) return null;
  await auditStmt(db, CLOCK_ACTOR, "clock.freeze", "story_clock", id, null, span).run();
  return id;
}

// Compares story_clock with the scene versions and opens or closes a span when the record
// moved. A failed read throws to the caller (who treats it as a disabled clock).
export async function syncStoryClock(
  db: D1Database,
  settings: Partial<Settings> | null | undefined,
  now: Date,
): Promise<{ opened: string | null; closed: string | null; shifted: number }> {
  const tz = tzOf(settings);
  const t = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : nowIso();
  const result: { opened: string | null; closed: string | null; shifted: number } = { opened: null, closed: null, shifted: 0 };

  const cur = await db
    .prepare(`SELECT version, created_at, ${STATUS_EXPR} AS status, json_extract(state_json, '$.location') AS location FROM state_versions WHERE entity = 'scene' ORDER BY version DESC LIMIT 1`)
    .first<SceneHead>();
  let open = await db.prepare("SELECT * FROM story_clock WHERE resumed_at IS NULL ORDER BY opened_version DESC LIMIT 1").first<ClockSpan>();

  // The stale guard: a span left behind by a restore or an import that rewrote the versions.
  if (open) {
    const own = await db
      .prepare(`SELECT created_at, ${STATUS_EXPR} AS status FROM state_versions WHERE entity = 'scene' AND version = ?1`)
      .bind(open.opened_version)
      .first<{ created_at: string; status: string }>();
    if (!own || own.status !== "together" || own.created_at !== open.frozen_at) {
      await db.batch([
        db.prepare("DELETE FROM story_clock WHERE id = ?1 AND resumed_at IS NULL").bind(open.id),
        auditStmt(db, CLOCK_ACTOR, "clock.stale", "story_clock", open.id, null, open),
      ]);
      open = null;
    }
  }

  if (!cur) return result;
  const together = cur.status === "together";

  const firstBreakAfter = async (version: number): Promise<{ version: number; created_at: string } | null> =>
    db
      .prepare(`SELECT version, created_at FROM state_versions WHERE entity = 'scene' AND version > ?1 AND ${STATUS_EXPR} != 'together' ORDER BY version ASC LIMIT 1`)
      .bind(version)
      .first<{ version: number; created_at: string }>();

  if (together && open) {
    // (A) Still together. When the record left together and came back, close the old span at
    // the break and open one for the current run; every run that opened and closed between
    // the two reads is written too (review fix).
    const brk = await firstBreakAfter(open.opened_version);
    if (brk) {
      const c = await closeSpan(db, open, brk, tz, t);
      result.closed = c.closed;
      result.shifted = c.shifted;
      await backfillClosedSpans(db, { after: brk.version, upTo: cur.version, shiftedAt: null, now: t });
      result.opened = await openSpan(db, settings, cur, tz, t);
    }
  } else if (together && !open) {
    // (B) Together and nothing held yet.
    result.opened = await openSpan(db, settings, cur, tz, t);
  } else if (!together && open) {
    // (C) The record left together: close the span at the first version after it that is not,
    // and write every run that opened and closed after it (review fix).
    const brk = (await firstBreakAfter(open.opened_version)) ?? { version: cur.version, created_at: cur.created_at };
    const c = await closeSpan(db, open, brk, tz, t);
    result.closed = c.closed;
    result.shifted = c.shifted;
    if (brk.version < cur.version) await backfillClosedSpans(db, { after: brk.version, upTo: cur.version, shiftedAt: null, now: t });
  }
  // (D) Apart and nothing held: nothing. In every case, a closed span whose beats were never
  // moved is retried (review fix).
  result.shifted += await retryShifts(db, tz, t);
  return result;
}

// The clock for one reader. Never throws: a database behind 0009, or any failed read, is a
// disabled clock (v4's real-time behaviour).
export async function loadStoryClock(db: D1Database, settings: Partial<Settings> | null | undefined, now: Date = new Date()): Promise<StoryClock> {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  if (settings && settings.storyClockEnabled === false) return disabledClock(at);
  try {
    await syncStoryClock(db, settings, at);
  } catch (e) {
    console.warn("clock: sync skipped", errorClass(e));
  }
  try {
    const since = new Date(at.getTime() - CLOCK_HORIZON_DAYS * DAY_MS).toISOString();
    // Review fix: the NEWEST spans within the horizon (past 500, the oldest are the ones cut,
    // never the open span), then oldest first.
    const r = await db
      .prepare("SELECT * FROM story_clock WHERE resumed_at IS NULL OR resumed_at >= ?1 ORDER BY frozen_at DESC LIMIT ?2")
      .bind(since, SPANS_LIMIT)
      .all<ClockSpan>();
    const spans = (r.results ?? [])
      .filter((s) => s && typeof s.id === "string" && typeof s.frozen_at === "string")
      .sort((a, b) => (Date.parse(a.frozen_at) || 0) - (Date.parse(b.frozen_at) || 0) || a.opened_version - b.opened_version);
    let open: ClockSpan | null = null;
    for (const s of spans) if (s.resumed_at === null || s.resumed_at === undefined) open = s;
    return { enabled: true, real: at.toISOString(), frozen: open !== null, open, spans };
  } catch (e) {
    console.warn("clock: read skipped", errorClass(e));
    return disabledClock(at);
  }
}

// The last story exchange across every conversation (she is one person).
export async function lastExchange(db: D1Database, excludeMessageId: string | null, now: Date): Promise<LastExchange> {
  const r = await db
    .prepare("SELECT id, role, created_at FROM messages WHERE channel = 'story' AND (deliver_at IS NULL OR deliver_at <= ?1) AND id != ?2 ORDER BY created_at DESC LIMIT 20")
    .bind(now.toISOString(), excludeMessageId ?? "")
    .all<{ id: string; role: string; created_at: string }>();
  const rows = r.results ?? [];
  const first = rows[0];
  const his = rows.find((m) => m && m.role === "user");
  const her = rows.find((m) => m && m.role === "assistant");
  return { hisAt: his ? his.created_at : null, herAt: her ? her.created_at : null, lastAt: first ? first.created_at : null };
}

export function holdWeatherStmt(db: D1Database, spanId: string, weather: WeatherNow): D1PreparedStatement {
  return db
    .prepare("UPDATE story_clock SET weather_json = ?2, updated_at = ?3 WHERE id = ?1 AND weather_json IS NULL")
    .bind(spanId, JSON.stringify(weather), nowIso());
}

// The move of pending beats when a held span closes (the rule is SPEC_V5 section 2; it lives
// here beside the sync so this file never imports arcs.ts). Only runs that fell due INSIDE
// the span move, to the same distance after it, to the millisecond; a run due after the span
// keeps its day. Each move leaves a note on its want. [] on nothing or a pre-0009 database.
export async function shiftBeatsForSpan(db: D1Database, span: { frozenAt: string; resumedAt: string }, tz: string): Promise<D1PreparedStatement[]> {
  return (await shiftStmtsOrNull(db, span, tz)) ?? [];
}

// The same statements, or null when the beats could not be read (so the caller can release
// its claim and retry instead of marking the move done).
async function shiftStmtsOrNull(db: D1Database, span: { frozenAt: string; resumedAt: string }, tz: string): Promise<D1PreparedStatement[] | null> {
  const frozen = Date.parse(span.frozenAt);
  const resumed = Date.parse(span.resumedAt);
  if (!Number.isFinite(frozen) || !Number.isFinite(resumed) || resumed <= frozen) return [];
  let rows: Array<{ id: string; due_at: string; title: string; want_id: string }>;
  try {
    const r = await db
      .prepare("SELECT r.id, r.due_at, b.title, b.want_id FROM beat_runs r JOIN arc_beats b ON b.id = r.beat_id WHERE r.status IN ('pending','proposed') AND b.status = 'active' AND r.due_at > ?1 AND r.due_at <= ?2 ORDER BY r.due_at LIMIT ?3")
      .bind(span.frozenAt, span.resumedAt, SHIFT_LIMIT)
      .all<{ id: string; due_at: string; title: string; want_id: string }>();
    rows = r.results ?? [];
  } catch (e) {
    console.warn("clock: beats not read", errorClass(e));
    return null;
  }
  const zone = safeTimezone(tz);
  const heldMs = resumed - frozen;
  const t = nowIso();
  const out: D1PreparedStatement[] = [];
  for (const run of rows) {
    const due = run && typeof run.due_at === "string" ? Date.parse(run.due_at) : NaN;
    if (!Number.isFinite(due)) continue;
    const moved = new Date(resumed + (due - frozen));
    const p = localParts(moved, zone);
    const note = `${run.title}: moved to ${WEEKDAYS[p.weekday] ?? ""} ${formatClock(p.hour * 60 + p.minute)}`;
    out.push(
      db.prepare("UPDATE beat_runs SET due_at = ?2, shifted_ms = shifted_ms + ?3, updated_at = ?4 WHERE id = ?1 AND status IN ('pending','proposed')")
        .bind(run.id, moved.toISOString(), heldMs, t),
      db.prepare("INSERT INTO want_log (id, want_id, occurred, kind, delta, note, source, message_id, created_at) VALUES (?1, ?2, ?3, 'note', NULL, ?4, 'clock', NULL, ?5)")
        .bind(newId("wl"), run.want_id, span.resumedAt, note, t),
    );
  }
  return out;
}
