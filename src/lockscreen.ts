// Her lock screen (the experience pass, DESIGN_EXPERIENCE sections 8.4 and 8.5): the daily
// wallpaper, and one read for the lock: her story time and date, her weather, a few real
// notifications, the strip of her last pictures and the things she wants with their next
// step.
//
// fix0927 lane B: the wallpaper pool is her masters 01 to 05 and the solo photos she SENT
// (approved, a message behind it); a picture the owner fired (message_id null) never dresses
// her phone. The lock's roll is the pictures she sent, then her masters.
//
// Every text here is a line of the record as stored (cut to length) or a fixed label; nothing
// is generated, narrated or rewritten, and nothing calls a provider. The read writes no story
// row: the only writes it can cause are the story clock's idempotent sync inside
// loadStoryClock and the weather cache inside getWeather, as GET /api/clock and GET
// /api/phone already do. It never calls syncPeople or syncPlaces.
import { masterUrl, readHerMasters } from "./album";
import type { HerMaster } from "./album";
import { listBeatViews } from "./arcs";
import type { BeatView } from "./arcs";
import { loadStoryClock, localDayKeyOf, storyNow } from "./clock";
import type { StoryClock } from "./clock";
import { getCurrentState } from "./db";
import { safeTimezone } from "./life";
import { localDayKey, weatherFor } from "./phone";
import { listRoll, rollWithMasters } from "./roll";
import type { RollItem } from "./roll";
import type { Env, RelationshipState, Settings } from "./types";
import { listWants } from "./wants";

// ------------------------------------------------------------------ the wallpaper

export interface Wallpaper { kind: "photo" | "master"; id: string; url: string; focus: [number, number] | null; day: string }

export const WALLPAPER_POOL = 30;

// fix0927 lane B: the face-centred crop of each master as [x%, y%], the same table as
// src/api.ts AVATAR_FOCUS (fix0927_b_masters keeps the two equal; this file cannot import
// api.ts, which imports it). A master missing from it sits at 50% 30%.
export const MASTER_FOCUS: Readonly<Record<string, [number, number]>> = {
  "master-00": [50, 40],
  "master-01": [48, 28],
  "master-02": [58, 24],
  "master-03": [50, 32],
  "master-04": [44, 27],
  "master-05": [50, 24],
};
const MASTER_FOCUS_DEFAULT: [number, number] = [50, 30];

// A wallpaper candidate: a photo she sent (id, created_at), or one of her masters (with its
// `file`, and a `focus` when known).
export interface WallCandidate { id: string; created_at: string; file?: string; focus?: [number, number] | null }

function masterFocus(id: string, given: [number, number] | null | undefined): [number, number] {
  const f = Array.isArray(given) && given.length === 2 ? given : MASTER_FOCUS[id] ?? MASTER_FOCUS_DEFAULT;
  return [f[0], f[1]];
}

// 32-bit FNV-1a over the UTF-8 bytes of `s`.
export function fnv1a32(s: string): number {
  const bytes = new TextEncoder().encode(typeof s === "string" ? s : "");
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function byNewest(a: { id: string; created_at: string }, b: { id: string; created_at: string }): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// One wallpaper per day of hers: the candidate at fnv1a32(day) % n of the newest-first list
// (a photo she sent, or one of her masters when it carries its `file`), or the fallback
// master (with its focus) when the pool is empty.
export function pickWallpaper(day: string, photos: WallCandidate[], fallback: { id: string; file: string; focus: [number, number] }): Wallpaper {
  const list = (Array.isArray(photos) ? photos : []).filter((p) => p && typeof p.id === "string" && p.id).slice().sort(byNewest);
  if (!list.length) {
    const file = String(fallback.file ?? "").replace(/^\/+/, "");
    return { kind: "master", id: fallback.id, url: "/" + file, focus: [fallback.focus[0], fallback.focus[1]], day };
  }
  const pick = list[fnv1a32(day) % list.length] as WallCandidate;
  const url = typeof pick.file === "string" ? masterUrl(pick.file) : null;
  if (url) return { kind: "master", id: pick.id, url, focus: masterFocus(pick.id, pick.focus), day };
  return { kind: "photo", id: pick.id, url: "/media/" + encodeURIComponent(pick.id), focus: null, day };
}

// Her masters as wallpaper candidates.
export function masterCandidates(masters: HerMaster[]): WallCandidate[] {
  return (Array.isArray(masters) ? masters : [])
    .filter((m) => m && typeof m.id === "string" && typeof m.file === "string")
    .map((m) => ({ id: m.id, created_at: m.created_at, file: m.file, focus: masterFocus(m.id, null) }));
}

interface WallRow { id: string; created_at: string; role?: string; approval_status?: string; with_him?: number | null; bytes?: number | null; message_id?: string | null }

function tzOf(settings: Partial<Settings> | null | undefined): string {
  const tz = settings && typeof settings.timezone === "string" && settings.timezone.trim() ? settings.timezone.trim() : "America/New_York";
  return safeTimezone(tz);
}

// Her approved solo photos with bytes that she SENT (a message behind each), newest 30. A read
// that fails answers none (her masters, then the fallback master).
async function wallpaperPhotos(db: D1Database): Promise<WallRow[]> {
  try {
    const r = await db
      .prepare(
        "SELECT id, created_at, role, approval_status, with_him, bytes, message_id FROM visual_assets WHERE role IN ('scene', 'candidate') AND approval_status = ?1 AND message_id IS NOT NULL AND COALESCE(with_him, 0) = 0 AND bytes IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?2",
      )
      .bind("approved", WALLPAPER_POOL)
      .all<WallRow>();
    return (r.results ?? [])
      .filter((row) => row && typeof row.id === "string" && typeof row.created_at === "string")
      .filter((row) => (row.role === undefined || row.role === "scene" || row.role === "candidate") && (row.approval_status === undefined || row.approval_status === "approved"))
      .filter((row) => typeof row.message_id === "string" && row.message_id.trim().length > 0)
      .filter((row) => Number(row.with_him ?? 0) === 0 && (row.bytes === undefined || (row.bytes !== null && Number.isFinite(Number(row.bytes)))))
      .sort(byNewest)
      .slice(0, WALLPAPER_POOL);
  } catch {
    return [];
  }
}

// The day is her local calendar day on the REAL clock (the phone panel stays on it). The pool:
// the solo photos she sent and her masters 01 to 05.
export async function wallpaperNow(db: D1Database, settings: Settings, now: Date, fallback: { id: string; file: string; focus: [number, number] }): Promise<Wallpaper> {
  const day = localDayKey(now, tzOf(settings));
  const [photos, masters] = await Promise.all([wallpaperPhotos(db), readHerMasters(db)]);
  const pool: WallCandidate[] = [...photos.map((p) => ({ id: p.id, created_at: p.created_at })), ...masterCandidates(masters)];
  return pickWallpaper(day, pool, fallback);
}

// ------------------------------------------------------------------ the lock

export type LockApp = "messages" | "music" | "calendar";
export interface LockNote { id: string; app: LockApp; title: string; text: string; at: string }
export interface LockScreen {
  now: string;
  frozen: boolean;
  tz: string;
  time: string;
  dateLine: string;
  weather: { temp: number; units: "fahrenheit" | "celsius"; words: string } | null;
  wallpaper: Wallpaper;
  notes: LockNote[];
  roll: RollItem[];
  wants: Array<{ id: string; title: string; next: { title: string; dueOn: string; day: string } | null }>;
}
export interface LockBeat { id: string; wantId: string; title: string; dueOn: string; dueAt: string }
export interface LockInput {
  now: Date;
  tz: string;
  his: { id: string; text: string; at: string } | null;
  hisName: string | null;
  song: { messageId: string; artist: string; title: string; at: string } | null;
  beats: LockBeat[];
}

export const LOCK_TEXT_MAX = 160;
export const LOCK_NOTES_MAX = 4;
export const LOCK_CALENDAR_MAX = 2;
export const LOCK_CALENDAR_DAYS = 2; // today and the next two days
export const LOCK_MESSAGE_HOURS = 48;
export const LOCK_SONG_HOURS = 72;
export const LOCK_ROLL_READ = 12;
export const LOCK_ROLL_SHOWN = 6;
// fix0927 review: this many of her masters keep a place on the lock strip however many
// pictures she has sent (public/js/phone.js STRIP_MASTERS is the same).
export const LOCK_ROLL_MASTERS = 2;
export const LOCK_WANTS_MAX = 8;
const HOUR_MS = 60 * 60 * 1000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ms(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

// One line of the record, at most `max` characters, cut at a word with "...".
function lineOf(s: unknown, max = LOCK_TEXT_MAX): string {
  const line = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (line.length <= max) return line;
  const head = line.slice(0, max - 3);
  const sp = head.lastIndexOf(" ");
  return (sp > 0 ? head.slice(0, sp) : head).replace(/[\s,;:]+$/, "") + "...";
}

function dayNumber(day: string): number | null {
  const m = typeof day === "string" ? DAY_RE.exec(day.trim()) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? Math.round(t / (24 * HOUR_MS)) : null;
}

function dayKeyOfNumber(n: number): string {
  const d = new Date(n * 24 * HOUR_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Same day "Today", next day "Tomorrow", 2 to 6 days ahead the long weekday ("Thursday"),
// anything else "Oct 3".
export function dayWord(dueOn: string, todayKey: string): string {
  const due = dayNumber(dueOn);
  const today = dayNumber(todayKey);
  if (due === null) return "";
  const diff = today === null ? NaN : due - today;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const d = new Date(due * 24 * HOUR_MS);
  if (diff >= 2 && diff <= 6) return WEEKDAYS_LONG[d.getUTCDay()] ?? "";
  return (MONTHS_SHORT[d.getUTCMonth()] ?? "") + " " + d.getUTCDate();
}

// Her dated steps still ahead of her run: the views whose run is pending (or absent), due at
// the run's due_at (which already carries any shift the story clock added), soonest first.
export function upcomingBeats(views: BeatView[], tz: string): LockBeat[] {
  const zone = safeTimezone(tz);
  const out: LockBeat[] = [];
  for (const v of Array.isArray(views) ? views : []) {
    if (!v || !v.beat || v.beat.status !== "active") continue;
    if (v.run && v.run.status !== "pending") continue;
    const dueAt = v.run ? v.run.due_at : v.beat.due_at;
    const t = ms(dueAt);
    if (!Number.isFinite(t)) continue;
    out.push({ id: v.beat.id, wantId: v.beat.want_id, title: v.beat.title, dueOn: localDayKeyOf(new Date(t), zone), dueAt });
  }
  return out.sort((a, b) => ms(a.dueAt) - ms(b.dueAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The notifications: calendar first (soonest first, at most two, today or the next two days,
// not already past), then his last text (48 h) and the song she last sent (72 h), newest
// first; at most four in all. Nothing is invented: no input, no entry.
export function lockNotes(input: LockInput): LockNote[] {
  const now = input && input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const nowMs = now.getTime();
  const tz = safeTimezone(input && typeof input.tz === "string" ? input.tz : "UTC");
  const todayKey = localDayKeyOf(now, tz);
  const today = dayNumber(todayKey);
  const days = new Set<string>();
  if (today !== null) for (let i = 0; i <= LOCK_CALENDAR_DAYS; i++) days.add(dayKeyOfNumber(today + i));

  const calendar: LockNote[] = (Array.isArray(input.beats) ? input.beats : [])
    .filter((b) => b && days.has(b.dueOn) && Number.isFinite(ms(b.dueAt)) && ms(b.dueAt) >= nowMs)
    .slice()
    .sort((a, b) => ms(a.dueAt) - ms(b.dueAt))
    .slice(0, LOCK_CALENDAR_MAX)
    .map((b) => ({ id: "beat:" + b.id, app: "calendar" as const, title: dayWord(b.dueOn, todayKey), text: lineOf(b.title), at: b.dueAt }))
    .filter((n) => n.text);

  const rest: LockNote[] = [];
  const his = input.his;
  if (his && Number.isFinite(ms(his.at)) && nowMs - ms(his.at) <= LOCK_MESSAGE_HOURS * HOUR_MS) {
    const text = lineOf(his.text);
    const name = typeof input.hisName === "string" ? input.hisName.trim() : "";
    if (text) rest.push({ id: "msg:" + his.id, app: "messages", title: name, text, at: his.at });
  }
  const song = input.song;
  if (song && Number.isFinite(ms(song.at)) && nowMs - ms(song.at) <= LOCK_SONG_HOURS * HOUR_MS) {
    const title = lineOf(song.title);
    if (title) rest.push({ id: "song:" + song.messageId, app: "music", title, text: lineOf(song.artist), at: song.at });
  }
  rest.sort((a, b) => ms(b.at) - ms(a.at));
  return [...calendar, ...rest].slice(0, LOCK_NOTES_MAX);
}

function timeParts(now: Date, tz: string): { time: string; dateLine: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, weekday: "long", month: "long", day: "numeric",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { time: get("hour") + ":" + get("minute"), dateLine: `${get("weekday")}, ${get("month")} ${get("day")}` };
}

// The pure core: every read already made. The held clock decides `now` and `frozen`.
export function lockScreenFrom(parts: {
  clock: StoryClock;
  tz: string;
  weather: { temp: number; units: string; words: string } | null;
  wallpaper: Wallpaper;
  his: LockInput["his"];
  hisName: string | null;
  song: LockInput["song"];
  beats: LockBeat[];
  roll: RollItem[];
  wants: Array<{ id: string; title: string }>;
}): LockScreen {
  const tz = safeTimezone(parts.tz);
  const now = storyNow(parts.clock);
  const at = Number.isFinite(now.getTime()) ? now : new Date(Date.parse(parts.clock.real));
  const frozen = !!(parts.clock.enabled && parts.clock.open);
  const todayKey = localDayKeyOf(at, tz);
  const { time, dateLine } = timeParts(at, tz);
  const beats = Array.isArray(parts.beats) ? parts.beats : [];
  const w = parts.weather;
  const weather = w && Number.isFinite(Number(w.temp)) && typeof w.words === "string"
    ? { temp: Math.round(Number(w.temp)), units: w.units === "celsius" ? "celsius" as const : "fahrenheit" as const, words: w.words }
    : null;
  const roll = rollWithMasters(
    (Array.isArray(parts.roll) ? parts.roll : []).filter((i) => i && !i.us && !(i.kind === "clip" && !i.poster)),
    LOCK_ROLL_SHOWN,
    LOCK_ROLL_MASTERS,
  );
  const wants = (Array.isArray(parts.wants) ? parts.wants : []).slice(0, LOCK_WANTS_MAX).map((wt) => {
    const next = beats.find((b) => b.wantId === wt.id) ?? null;
    return { id: wt.id, title: wt.title, next: next ? { title: next.title, dueOn: next.dueOn, day: dayWord(next.dueOn, todayKey) } : null };
  });
  return {
    now: at.toISOString(),
    frozen,
    tz,
    time,
    dateLine,
    weather,
    wallpaper: parts.wallpaper,
    notes: lockNotes({ now: at, tz, his: parts.his, hisName: parts.hisName, song: parts.song, beats }),
    roll,
    wants,
  };
}

function quiet<T>(name: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e: unknown): T => {
    console.warn("lock: " + name + " skipped", e instanceof Error ? e.name : "error");
    return fallback;
  });
}

interface MsgRow { id: string; content: string | null; created_at: string; role?: string; channel?: string; deliver_at?: string | null; song_json?: string | null }

function visibleStory(r: MsgRow, role: string, realIso: string): boolean {
  if (r.role !== undefined && r.role !== role) return false;
  if (r.channel !== undefined && r.channel !== "story") return false;
  return r.deliver_at === null || r.deliver_at === undefined || r.deliver_at <= realIso;
}

// His newest visible story message with text, over the conversations the list shows.
async function hisLast(db: D1Database, real: Date): Promise<LockInput["his"]> {
  const realIso = real.toISOString();
  const r = await db
    .prepare(
      "SELECT m.id AS id, m.content AS content, m.created_at AS created_at, m.role AS role, m.channel AS channel, m.deliver_at AS deliver_at FROM messages m JOIN conversations c ON c.id = m.conversation_id "
      + "WHERE m.role = ?1 AND m.channel = ?2 AND (m.deliver_at IS NULL OR m.deliver_at <= ?3) AND trim(COALESCE(m.content, '')) <> '' AND c.status NOT IN ('deleted', 'drift') ORDER BY m.created_at DESC LIMIT 1",
    )
    .bind("user", "story", realIso)
    .all<MsgRow>();
  const row = (r.results ?? [])
    .filter((m) => m && typeof m.id === "string" && visibleStory(m, "user", realIso) && typeof m.content === "string" && m.content.trim())
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
  return row ? { id: row.id, text: row.content as string, at: row.created_at } : null;
}

function readSong(json: unknown): { artist: string; title: string } | null {
  if (typeof json !== "string" || !json.trim()) return null;
  try {
    const o = JSON.parse(json) as unknown;
    if (!o || typeof o !== "object") return null;
    const s = o as Record<string, unknown>;
    const artist = typeof s.artist === "string" ? s.artist.trim() : "";
    const title = typeof s.title === "string" ? s.title.trim() : "";
    return artist && title ? { artist, title } : null;
  } catch {
    return null;
  }
}

// Her newest visible story row that carries a song.
async function herSong(db: D1Database, real: Date): Promise<LockInput["song"]> {
  const realIso = real.toISOString();
  const r = await db
    .prepare(
      "SELECT m.id AS id, m.content AS content, m.created_at AS created_at, m.role AS role, m.channel AS channel, m.deliver_at AS deliver_at, m.song_json AS song_json FROM messages m JOIN conversations c ON c.id = m.conversation_id "
      + "WHERE m.role = ?1 AND m.channel = ?2 AND (m.deliver_at IS NULL OR m.deliver_at <= ?3) AND m.song_json IS NOT NULL AND c.status NOT IN ('deleted', 'drift') ORDER BY m.created_at DESC LIMIT 1",
    )
    .bind("assistant", "story", realIso)
    .all<MsgRow>();
  const rows = (r.results ?? [])
    .filter((m) => m && typeof m.id === "string" && visibleStory(m, "assistant", realIso))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at));
  for (const row of rows) {
    const song = readSong(row.song_json);
    if (song) return { messageId: row.id, artist: song.artist, title: song.title, at: row.created_at };
  }
  return null;
}

async function hisNameOf(db: D1Database): Promise<string | null> {
  const cur = await getCurrentState<RelationshipState>(db, "relationship");
  const name = cur && cur.state && typeof cur.state.his_name === "string" ? cur.state.his_name.trim() : "";
  return name || null;
}

// One read for the lock. `realNow` is the wall clock (visibility, weather, the clock's own
// sync); the lock's time, date and day words follow her story clock.
export async function lockScreen(env: Env, db: D1Database, settings: Settings, realNow: Date, wallpaper: Wallpaper): Promise<LockScreen> {
  const real = realNow instanceof Date && Number.isFinite(realNow.getTime()) ? realNow : new Date();
  const tz = tzOf(settings);
  const clock = await loadStoryClock(db, settings, real);
  const [weather, his, hisName, song, views, wants, roll] = await Promise.all([
    quiet("weather", weatherFor(env, db, settings, real), null),
    quiet("his last text", hisLast(db, real), null),
    quiet("his name", hisNameOf(db), null),
    quiet("her song", herSong(db, real), null),
    quiet("beats", listBeatViews(db, { status: "active" }), [] as BeatView[]),
    quiet("wants", listWants(db, "active"), [] as Awaited<ReturnType<typeof listWants>>),
    quiet("roll", listRoll(db, { limit: LOCK_ROLL_READ }).then((p) => [...p.items, ...(Array.isArray(p.masters) ? p.masters : [])]), [] as RollItem[]),
  ]);
  let beats: LockBeat[] = [];
  try {
    beats = upcomingBeats(views, tz);
  } catch {
    beats = [];
  }
  return lockScreenFrom({
    clock,
    tz,
    weather: weather ? { temp: weather.temp, units: weather.units, words: weather.words } : null,
    wallpaper,
    his,
    hisName,
    song,
    beats,
    roll,
    wants: wants.map((w) => ({ id: w.id, title: w.title })),
  });
}
