// Grounding (SPEC_V3 section DD): she lives somewhere real. The RIGHT NOW section tells
// her the day and the hour, the weather outside, what she is wearing today (carried from
// her last approved photo or her own note) and what she has done so far today. None of
// it is ever a reason not to answer; it is what a person just knows.
//
// The pure half (timeOfDay, weatherLine, outfitNow, groundingSection) runs under Node
// for the unit suite; the db half reads and writes grounding_log, audited.
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { WEEKDAYS, formatClock, localParts, safeTimezone } from "./life";
import type { VisualAssetRow } from "./types";
import type { WeatherNow } from "./weather";

export type GroundingKind = "meal" | "outfit" | "errand" | "misc";

export interface GroundingRow {
  id: string;
  kind: GroundingKind;
  note: string;
  occurred: string;
  source: string | null;
  message_id: string | null;
  created_at: string;
}

export type TimeOfDay = "early morning" | "morning" | "midday" | "afternoon" | "evening" | "night" | "late night";

export interface Outfit {
  text: string;
  from: "photo" | "log";
  // The instant it was recorded (the photo's decided_at, the note's occurred).
  at: string;
  assetId?: string;
  rowId?: string;
}

export const GROUNDING_KINDS: readonly GroundingKind[] = ["meal", "outfit", "errand", "misc"];
export const GROUNDING_HEADER = "RIGHT NOW (true today; you know it the way a person knows the weather, without announcing it)";
const MAX_NOTE = 500;
const MAX_SOURCE = 200;
const MAX_MESSAGE_ID = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDY_MPH = 20;

// ------------------------------------------------------------------ pure

export function isGroundingKind(v: unknown): v is GroundingKind {
  return typeof v === "string" && (GROUNDING_KINDS as readonly string[]).includes(v);
}

// early morning 5..8, morning 8..11, midday 11..14, afternoon 14..17, evening 17..21,
// night 21..24, late night 0..5.
export function timeOfDay(localHour: number): TimeOfDay {
  const h = Number.isFinite(localHour) ? ((Math.floor(localHour) % 24) + 24) % 24 : 12;
  if (h < 5) return "late night";
  if (h < 8) return "early morning";
  if (h < 11) return "morning";
  if (h < 14) return "midday";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

// The local calendar day (as a number of days) of an instant in her timezone.
function localDayOf(d: Date, tz: string): number {
  const p = localParts(d, tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

export function isSameLocalDay(iso: string | null | undefined, now: Date, tz: string): boolean {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const zone = safeTimezone(tz);
  return localDayOf(new Date(t), zone) === localDayOf(now, zone);
}

// The start (inclusive) and end (exclusive) instants of her current local day.
export function localDayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const zone = safeTimezone(tz);
  const p = localParts(now, zone);
  const startUtc = Date.UTC(p.year, p.month - 1, p.day) - p.offsetMinutes * 60000;
  return { start: new Date(startUtc), end: new Date(startUtc + DAY_MS) };
}

// "3:10pm" for an instant in her timezone.
export function clockOf(iso: string, tz: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const p = localParts(new Date(t), safeTimezone(tz));
  return formatClock(p.hour * 60 + p.minute);
}

// "7:02pm" from an Open-Meteo local wall-clock string ("2026-09-24T19:02"); "" otherwise.
function wallClock(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  const m = /T(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return "";
  return formatClock(h * 60 + min);
}

// "Portland, Maine: 71F, clear, feels like 73, sun sets at 7:02pm." Empty with no weather
// (never a made-up line). Without a city name the place reads "Outside".
export function weatherLine(w: WeatherNow | null | undefined, city: string, _now: Date, _tz: string): string {
  if (!w || typeof w.temp !== "number" || !Number.isFinite(w.temp)) return "";
  const unit = w.units === "celsius" ? "C" : "F";
  const parts: string[] = [`${Math.round(w.temp)}${unit}`];
  if (w.words) parts.push(w.words);
  if (typeof w.feels === "number" && Number.isFinite(w.feels) && Math.round(w.feels) !== Math.round(w.temp)) parts.push(`feels like ${Math.round(w.feels)}`);
  if (typeof w.windMph === "number" && w.windMph >= WINDY_MPH) parts.push("windy");
  if (w.isDay) {
    const set = wallClock(w.sunset);
    if (set) parts.push(`sun sets at ${set}`);
  } else {
    const rise = wallClock(w.sunrise);
    if (rise) parts.push(`sun comes up at ${rise}`);
  }
  const place = typeof city === "string" && city.trim() ? city.trim() : "Outside";
  return `${place}: ${parts.join(", ")}.`;
}

// What she is wearing today: the newest of an approved photo decided today (its own
// description says what she wore) and an outfit note from today. Never from an older day.
export function outfitNow(assets: VisualAssetRow[], rows: GroundingRow[], now: Date, tz: string): Outfit | null {
  let best: Outfit | null = null;
  const consider = (o: Outfit): void => {
    if (!best || Date.parse(o.at) > Date.parse(best.at)) best = o;
  };
  for (const a of Array.isArray(assets) ? assets : []) {
    if (!a || a.role !== "scene" || a.approval_status !== "approved") continue;
    if (!a.decided_at || !isSameLocalDay(a.decided_at, now, tz)) continue;
    const text = typeof a.prompt === "string" ? a.prompt.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    consider({ text, from: "photo", at: a.decided_at, assetId: a.id });
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.kind !== "outfit" || typeof r.note !== "string" || !r.note.trim()) continue;
    if (!isSameLocalDay(r.occurred, now, tz)) continue;
    consider({ text: r.note.replace(/\s+/g, " ").trim(), from: "log", at: r.occurred, rowId: r.id });
  }
  return best;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// The section. Lines with no data are omitted; with no data at all (no weather, no
// outfit, nothing done today) the section is omitted: the day and hour alone are
// already in YOUR LIFE.
export function groundingSection(args: {
  now: Date;
  tz: string;
  city: string;
  weather: WeatherNow | null;
  outfit: Outfit | null;
  today: GroundingRow[];
}): string {
  const tz = safeTimezone(args.tz);
  const now = args.now instanceof Date ? args.now : new Date();
  const weather = weatherLine(args.weather, args.city, now, tz);
  const outfit = args.outfit && args.outfit.text ? args.outfit : null;
  const today = (Array.isArray(args.today) ? args.today : [])
    .filter((r) => r && isGroundingKind(r.kind) && typeof r.note === "string" && r.note.trim() && r.kind !== "outfit")
    .sort((a, b) => a.occurred.localeCompare(b.occurred));
  if (!weather && !outfit && !today.length) return "";
  const p = localParts(now, tz);
  const out: string[] = [GROUNDING_HEADER];
  out.push(`It is ${WEEKDAYS[p.weekday] ?? ""} ${formatClock(p.hour * 60 + p.minute)}, ${timeOfDay(p.hour)}.` + (weather ? " " + weather : ""));
  if (outfit) {
    const when = clockOf(outfit.at, tz);
    const from = outfit.from === "photo" ? `your photo${when ? " at " + when : ""}` : `you noted it${when ? " at " + when : ""}`;
    out.push(`You are wearing: ${clip(outfit.text, 240)} (${from}).`);
  }
  if (today.length) {
    out.push("Today so far: " + today.map((r) => {
      const when = clockOf(r.occurred, tz);
      return `${r.kind}: ${clip(r.note, 160)}${when ? " (" + when + ")" : ""}`;
    }).join("; ") + ".");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ db

// Today's rows in her timezone, oldest first. Older rows stay for the timeline and the export.
export async function todayRows(db: D1Database, now: Date, tz: string): Promise<GroundingRow[]> {
  const { start, end } = localDayBounds(now, tz);
  const r = await db.prepare("SELECT * FROM grounding_log WHERE occurred >= ?1 AND occurred < ?2 ORDER BY occurred, created_at").bind(start.toISOString(), end.toISOString()).all<GroundingRow>();
  return r.results;
}

export async function listGroundingRows(db: D1Database, limit = 200): Promise<GroundingRow[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 200;
  const r = await db.prepare("SELECT * FROM grounding_log ORDER BY occurred DESC, created_at DESC LIMIT ?1").bind(n).all<GroundingRow>();
  return r.results;
}

export async function createGroundingRow(
  db: D1Database,
  input: { kind: GroundingKind; note: string; occurred?: string | null; source?: string | null; messageId?: string | null },
  actor: string,
): Promise<GroundingRow> {
  if (!isGroundingKind(input.kind)) throw new ApiHttpError(400, "validation", "kind must be meal, outfit, errand or misc");
  if (typeof input.note !== "string" || !input.note.trim()) throw new ApiHttpError(400, "validation", "note is required");
  const note = input.note.trim();
  if (note.length > MAX_NOTE) throw new ApiHttpError(400, "validation", `note exceeds ${MAX_NOTE} characters`);
  let occurred = nowIso();
  if (input.occurred !== undefined && input.occurred !== null && input.occurred !== "") {
    const t = typeof input.occurred === "string" ? Date.parse(input.occurred.trim()) : NaN;
    if (!Number.isFinite(t)) throw new ApiHttpError(400, "validation", "occurred must be an ISO 8601 time");
    occurred = new Date(t).toISOString();
  }
  const text = (v: unknown, name: string, max: number): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new ApiHttpError(400, "validation", `${name} must be a string`);
    const s = v.trim();
    if (s.length > max) throw new ApiHttpError(400, "validation", `${name} exceeds ${max} characters`);
    return s || null;
  };
  const row: GroundingRow = {
    id: newId("gr"),
    kind: input.kind,
    note,
    occurred,
    source: text(input.source, "source", MAX_SOURCE),
    message_id: text(input.messageId, "messageId", MAX_MESSAGE_ID),
    created_at: nowIso(),
  };
  await db.batch([
    db.prepare("INSERT INTO grounding_log (id, kind, note, occurred, source, message_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(row.id, row.kind, row.note, row.occurred, row.source, row.message_id, row.created_at),
    auditStmt(db, actor, "grounding.create", "grounding_log", row.id, null, row),
  ]);
  return row;
}

export async function deleteGroundingRow(db: D1Database, id: string, actor: string): Promise<void> {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "id is required");
  const row = await db.prepare("SELECT * FROM grounding_log WHERE id = ?1").bind(id).first<GroundingRow>();
  if (!row) throw new ApiHttpError(404, "not_found", "grounding row not found");
  await db.batch([
    db.prepare("DELETE FROM grounding_log WHERE id = ?1").bind(id),
    auditStmt(db, actor, "grounding.delete", "grounding_log", id, row, null),
  ]);
}
