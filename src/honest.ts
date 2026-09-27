// Honest to the record (SPEC_V5 section 6): what she already sent him, read from her own
// messages (every send is already on her row: song_json, image_id with its asset, audio_key,
// media_id). One per-turn section, WHAT YOU HAVE SENT HIM, and the list the denied_send check
// reads (src/checks.ts). Nothing new is stored: the record is the messages.
//
// Day words are read on the story clock (skeptic 10): each item stands at its STORY instant
// (clock.ts storyInstantOf), so a song sent inside a held scene reads "today" at the held
// clock, never a real time after RIGHT NOW's and never "-1 days ago" across midnight.
import { localDayKeyOf, storyInstantOf } from "./clock";
import type { StoryClock } from "./clock";
import { formatClock, localParts, safeTimezone, WEEKDAYS } from "./life";
import { saidLine } from "./said";
import type { SentKind } from "./types";

export const SENT_KIND_WORDS: Record<SentKind, string> = {
  song: "a song",
  photo: "a photo",
  clip: "a clip",
  voice: "a voice note",
  media: "from your phone",
};

export interface SentItem {
  messageId: string;
  conversationId: string;
  kind: SentKind;
  at: string;
  label: string;
  words: string[];
}

export const SENT_HEADER =
  "WHAT YOU HAVE SENT HIM (true: these went to him, from you; never say you did not send one of these, never send him the same song twice)";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 90;
const PHOTO_LABEL = 100;
const VOICE_LABEL = 60;
const MEDIA_LABEL = 120;
const SONG_LABEL = 200;
const MAX_WORDS = 8;
const SENT_STOP = new Set(["with", "from", "that", "this", "your", "just", "like", "what", "when", "then", "them", "they", "have", "been"]);

// ------------------------------------------------------------------ pure

// Lowercase words of four letters or more, the stop list removed, deduplicated, at most eight.
export function sentWords(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 4 || SENT_STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

function storyInstant(clock: StoryClock | null | undefined, at: string): Date {
  if (clock) {
    try {
      const d = storyInstantOf(clock, at);
      if (d instanceof Date && Number.isFinite(d.getTime())) return d;
    } catch {
      // the stamp itself below
    }
  }
  const t = Date.parse(at);
  return new Date(Number.isFinite(t) ? t : 0);
}

function dayNumber(d: Date, tz: string): number {
  const key = localDayKeyOf(d, tz);
  const t = Date.parse(key + "T00:00:00.000Z");
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : 0;
}

// The words for when an item went to him, from her local day of storyNow: "today {clock}",
// "yesterday", the weekday for 2 to 6 days, else "N days ago". An instant after storyNow (a
// difference below zero, or later the same day) reads "today" with no clock.
function whenWords(instant: Date, storyNow: Date, tz: string): string {
  const diff = dayNumber(storyNow, tz) - dayNumber(instant, tz);
  if (diff < 0) return "today";
  if (diff === 0) {
    if (instant.getTime() > storyNow.getTime()) return "today";
    const p = localParts(instant, tz);
    return `today ${formatClock(p.hour * 60 + p.minute)}`;
  }
  if (diff === 1) return "yesterday";
  if (diff <= 6) return WEEKDAYS[localParts(instant, tz).weekday] ?? `${diff} days ago`;
  return `${diff} days ago`;
}

function itemLine(item: SentItem, when: string): string {
  const label = typeof item.label === "string" ? item.label.trim() : "";
  switch (item.kind) {
    case "song":
      return `- ${when}: a song${label ? ", " + label : ""}`;
    case "photo":
      return `- ${when}: a photo${label ? ` (${label})` : ""}`;
    case "clip":
      return `- ${when}: a clip${label ? ` (${label})` : ""}`;
    case "voice":
      return `- ${when}: a voice note${label ? ` ("${label.replace(/"/g, "'")}")` : ""}`;
    case "media":
      return `- ${when}: ${label || "something"}, from your phone`;
    default:
      return "";
  }
}

export function sentSection(items: SentItem[], storyNow: Date, tz: string, clock: StoryClock | null = null): string {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i.at === "string") : [];
  if (!list.length) return "";
  const zone = safeTimezone(tz);
  const now = storyNow instanceof Date && Number.isFinite(storyNow.getTime()) ? storyNow : new Date();
  const lines = list.map((i) => itemLine(i, whenWords(storyInstant(clock, i.at), now, zone))).filter(Boolean);
  if (!lines.length) return "";
  return [SENT_HEADER, ...lines].join("\n");
}

// What the denied_send check reads: each item's kind, its words, and whether it went to him on
// her local day of storyNow (the same rule as the section's "today").
export function sentForCheck(items: SentItem[], storyNow: Date, tz: string, clock: StoryClock | null = null): Array<{ kind: SentKind; words: string[]; today: boolean }> {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i.at === "string") : [];
  const zone = safeTimezone(tz);
  const now = storyNow instanceof Date && Number.isFinite(storyNow.getTime()) ? storyNow : new Date();
  const today = localDayKeyOf(now, zone);
  return list.map((i) => ({
    kind: i.kind,
    words: Array.isArray(i.words) ? i.words.slice() : [],
    today: localDayKeyOf(storyInstant(clock, i.at), zone) === today,
  }));
}

// ------------------------------------------------------------------ db

interface SentMessageRow {
  id: string;
  conversation_id: string;
  content: string | null;
  created_at: string;
  song_json: string | null;
  image_id: string | null;
  audio_key: string | null;
  media_id: string | null;
}

interface SentAssetRow { id: string; role: string; prompt: string | null; approval_status: string }
interface SentMediaRow { id: string; title: string | null }

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function readByIds<T>(db: D1Database, sqlHead: string, ids: string[]): Promise<T[]> {
  const unique = Array.from(new Set(ids.filter((x) => typeof x === "string" && x)));
  const out: T[] = [];
  for (const part of chunks(unique)) {
    const marks = part.map((_, i) => `?${i + 1}`).join(", ");
    const r = await db.prepare(`${sqlHead} (${marks})`).bind(...part).all<T>();
    out.push(...(r.results ?? []));
  }
  return out;
}

function readSong(json: string | null): { artist: string; title: string } | null {
  if (typeof json !== "string" || !json.trim()) return null;
  try {
    const j = JSON.parse(json) as unknown;
    if (!j || typeof j !== "object") return null;
    const o = j as Record<string, unknown>;
    const artist = typeof o.artist === "string" ? o.artist.replace(/\s+/g, " ").trim() : "";
    const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
    if (!artist && !title) return null;
    return { artist, title };
  } catch {
    return null;
  }
}

function dedupeWords(list: string[]): string[] {
  const out: string[] = [];
  for (const w of list) if (w && !out.includes(w)) out.push(w);
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Every send of hers inside the window, newest first, at most `limit` items (one message may
// give several: a song and a photo). A read that fails answers [].
// `since` (review fix): the window's start on the story clock (context.ts passes the real
// instant `windowDays` of story time reach back to, so a long held scene never empties what
// she sent minutes before it in story time); absent, `windowDays` of real time.
export async function listSent(db: D1Database, args: { now: Date; windowDays: number; limit: number; since?: Date | null }): Promise<SentItem[]> {
  try {
    const now = args?.now instanceof Date && Number.isFinite(args.now.getTime()) ? args.now : new Date();
    const limit = clampInt(args?.limit, 0, 200, 12);
    if (limit === 0) return [];
    const windowDays = clampInt(args?.windowDays, 1, 60, 7);
    const given = args?.since instanceof Date && Number.isFinite(args.since.getTime()) ? args.since.getTime() : NaN;
    const since = new Date(Number.isFinite(given) && given <= now.getTime() ? given : now.getTime() - windowDays * DAY_MS).toISOString();
    const r = await db.prepare(
      "SELECT id, conversation_id, content, created_at, song_json, image_id, audio_key, media_id FROM messages WHERE channel = 'story' AND role = 'assistant' AND created_at >= ?1 AND (deliver_at IS NULL OR deliver_at <= ?2) AND (song_json IS NOT NULL OR image_id IS NOT NULL OR audio_key IS NOT NULL OR media_id IS NOT NULL) ORDER BY created_at DESC LIMIT ?3",
    ).bind(since, now.toISOString(), Math.min(200, limit * 3)).all<SentMessageRow>();
    const rows = r.results ?? [];
    if (!rows.length) return [];
    const imageIds = rows.map((m) => m.image_id).filter((x): x is string => typeof x === "string" && !!x);
    const mediaIds = rows.map((m) => m.media_id).filter((x): x is string => typeof x === "string" && !!x);
    const [assets, media] = await Promise.all([
      imageIds.length ? readByIds<SentAssetRow>(db, "SELECT id, role, prompt, approval_status FROM visual_assets WHERE id IN", imageIds) : Promise.resolve([] as SentAssetRow[]),
      mediaIds.length ? readByIds<SentMediaRow>(db, "SELECT id, title FROM media_library WHERE id IN", mediaIds) : Promise.resolve([] as SentMediaRow[]),
    ]);
    const assetById = new Map(assets.map((a) => [a.id, a] as const));
    const mediaById = new Map(media.map((m) => [m.id, m] as const));
    const out: SentItem[] = [];
    for (const m of rows) {
      const base = { messageId: m.id, conversationId: m.conversation_id, at: m.created_at };
      const song = readSong(m.song_json);
      if (song) {
        const label = saidLine(song.artist && song.title ? `${song.artist} - ${song.title}` : song.artist || song.title, SONG_LABEL);
        const phrase = song.artist.toLowerCase();
        out.push({ ...base, kind: "song", label, words: dedupeWords([phrase, ...sentWords(`${song.artist} ${song.title}`)]) });
      }
      if (typeof m.image_id === "string" && m.image_id) {
        const a = assetById.get(m.image_id);
        if (a && a.approval_status !== "rejected" && a.approval_status !== "failed") {
          const kind: SentKind | null = a.role === "video" ? "clip" : a.role === "candidate" || a.role === "scene" ? "photo" : null;
          if (kind) {
            const prompt = typeof a.prompt === "string" ? a.prompt : "";
            out.push({ ...base, kind, label: saidLine(prompt, PHOTO_LABEL), words: sentWords(prompt) });
          }
        }
      }
      if (typeof m.audio_key === "string" && m.audio_key) {
        const label = saidLine(m.content ?? "", VOICE_LABEL);
        out.push({ ...base, kind: "voice", label, words: sentWords(label) });
      }
      if (typeof m.media_id === "string" && m.media_id) {
        const item = mediaById.get(m.media_id);
        const title = item && typeof item.title === "string" ? saidLine(item.title, MEDIA_LABEL) : "";
        if (title) out.push({ ...base, kind: "media", label: title, words: sentWords(title) });
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  } catch {
    return [];
  }
}
