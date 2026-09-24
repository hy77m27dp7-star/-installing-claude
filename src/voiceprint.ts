// Her voiceprint (SPEC_V2 section Y): one set of numbers per week over her story-channel
// messages, so a drift in how she writes shows up as a number before anyone notices it
// in a reply. computeVoiceprint is pure over rows; runVoiceprint reads the week ending
// now, stores one row in voiceprints, and listVoiceprints reads them back newest first.
// Nothing here changes a message.
import { auditStmt, getCurrentState, newId, nowIso } from "./db";
import type { Flag, MessageRow, RelationshipState } from "./types";

export interface VoiceprintStats {
  since: string;
  until: string;
  // Her story messages inside the window.
  count: number;
  meanLength: number;
  medianLength: number;
  // Share of replies ending with "?".
  questionShare: number;
  // Share of replies carrying "lol" (or its cousins) or an emoji. Should be zero.
  lolEmojiShare: number;
  // Share of replies that name him.
  nameShare: number;
  hisName: string | null;
  topWords: Array<{ word: string; n: number }>;
  bubbles: number;
  bubblesPerReply: number;
  // Replies with no message of his before them.
  firstTexts: number;
  flagsPerCode: Record<string, number>;
  flagsTotal: number;
}

export interface VoiceprintRow {
  id: string;
  week: string;
  json: string;
  created_at: string;
}

export interface VoiceprintRun {
  id: string;
  week: string;
  created_at: string;
  stats: VoiceprintStats;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const TOP_WORDS = 25;
const MAX_ROWS = 5000;
const LIST_MAX = 104;

// The scope name of the facts about him (types.ts FactScope "justin") doubles as the
// name to look for when the record has not written his name down yet.
const DEFAULT_HIS_NAME = "Justin";

// Common words that say nothing about her voice.
const STOP_WORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because", "been", "before",
  "being", "but", "by", "can", "could", "did", "do", "does", "doing", "don", "dont", "for", "from", "get", "go", "going", "got",
  "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "im", "in", "into", "is", "it",
  "its", "just", "know", "like", "me", "more", "most", "my", "no", "not", "now", "of", "off", "on", "once", "one", "only", "or",
  "other", "our", "out", "over", "own", "really", "same", "she", "should", "so", "some", "such", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "thing", "this", "those", "though", "through", "to", "too", "under",
  "up", "us", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would",
  "yeah", "yes", "you", "your", "yours", "ok", "okay",
]);

const LOL = /\b(?:lol|lmao|lmfao|rofl|haha+|hehe+)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

// ------------------------------------------------------------------ helpers

function round(n: number, places: number): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  const hi = sorted[mid] ?? 0;
  if (n % 2 === 1) return hi;
  const lo = sorted[mid - 1] ?? 0;
  return (lo + hi) / 2;
}

function bubbleCount(text: string): number {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

function parseFlags(json: string | null | undefined): Flag[] {
  if (typeof json !== "string" || !json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is Flag => Boolean(f) && typeof f === "object" && typeof (f as Flag).code === "string");
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameMatcher(name: string | null): RegExp | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  return new RegExp("(?:^|[^\\p{L}\\p{N}])" + escapeRegExp(n.toLowerCase()) + "(?![\\p{L}\\p{N}])", "iu");
}

function inWindow(row: MessageRow, sinceMs: number, untilMs: number): boolean {
  const t = Date.parse(row.created_at);
  if (!Number.isFinite(t)) return false;
  if (Number.isFinite(sinceMs) && t < sinceMs) return false;
  if (Number.isFinite(untilMs) && t >= untilMs) return false;
  return true;
}

// ISO week key ("2026-W39") of the day the window ended in, UTC.
export function weekKey(untilIso: string): string {
  const end = new Date(Date.parse(untilIso) - 1);
  const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ the numbers (pure)

export function computeVoiceprint(rows: MessageRow[], since: string, until: string, opts: { hisName?: string | null } = {}): VoiceprintStats {
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const hisName = opts.hisName === undefined ? DEFAULT_HIS_NAME : (opts.hisName ?? null);
  const nameRe = nameMatcher(hisName);

  const hers = rows.filter((r) => r.role === "assistant" && r.channel === "story" && typeof r.content === "string" && inWindow(r, sinceMs, untilMs));
  const count = hers.length;

  const lengths: number[] = [];
  let questions = 0;
  let lolOrEmoji = 0;
  let named = 0;
  let bubbles = 0;
  let firstTexts = 0;
  const words = new Map<string, number>();
  const flagsPerCode: Record<string, number> = {};
  let flagsTotal = 0;

  for (const m of hers) {
    const text = m.content.trim();
    lengths.push(text.length);
    if (text.endsWith("?")) questions += 1;
    if (LOL.test(text) || EMOJI.test(text)) lolOrEmoji += 1;
    if (nameRe && nameRe.test(text)) named += 1;
    bubbles += bubbleCount(text);
    if (m.reply_to_id === null || m.reply_to_id === undefined) firstTexts += 1;
    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
      const w = raw.replace(/^'+|'+$/g, "");
      if (w.length < 2 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
      if (hisName && w === hisName.toLowerCase()) continue;
      words.set(w, (words.get(w) ?? 0) + 1);
    }
    for (const f of parseFlags(m.flags_json)) {
      flagsPerCode[f.code] = (flagsPerCode[f.code] ?? 0) + 1;
      flagsTotal += 1;
    }
  }

  const sorted = lengths.slice().sort((a, b) => a - b);
  const total = lengths.reduce((a, b) => a + b, 0);
  const share = (n: number): number => (count ? round(n / count, 3) : 0);
  const topWords = [...words.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_WORDS)
    .map(([word, n]) => ({ word, n }));

  return {
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : since,
    until: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : until,
    count,
    meanLength: count ? round(total / count, 1) : 0,
    medianLength: round(median(sorted), 1),
    questionShare: share(questions),
    lolEmojiShare: share(lolOrEmoji),
    nameShare: share(named),
    hisName,
    topWords,
    bubbles,
    bubblesPerReply: count ? round(bubbles / count, 2) : 0,
    firstTexts,
    flagsPerCode,
    flagsTotal,
  };
}

// ------------------------------------------------------------------ the weekly run

export async function runVoiceprint(db: D1Database, now: Date = new Date()): Promise<VoiceprintRun> {
  const until = now.toISOString();
  const since = new Date(now.getTime() - WEEK_MS).toISOString();

  let hisName: string | null | undefined;
  try {
    const rel = await getCurrentState<RelationshipState>(db, "relationship");
    hisName = typeof rel.state.his_name === "string" && rel.state.his_name.trim() ? rel.state.his_name.trim() : undefined;
  } catch {
    hisName = undefined;
  }

  const r = await db
    .prepare("SELECT * FROM messages WHERE role = ?1 AND channel = ?2 AND created_at >= ?3 AND created_at < ?4 ORDER BY created_at LIMIT ?5")
    .bind("assistant", "story", since, until, MAX_ROWS)
    .all<MessageRow>();
  const stats = computeVoiceprint(r.results, since, until, hisName === undefined ? {} : { hisName });

  const row: VoiceprintRow = { id: newId("vp"), week: weekKey(until), json: JSON.stringify(stats), created_at: nowIso() };
  await db.batch([
    db.prepare("INSERT INTO voiceprints (id, week, json, created_at) VALUES (?1, ?2, ?3, ?4)").bind(row.id, row.week, row.json, row.created_at),
    auditStmt(db, "system", "voiceprint.run", "voiceprint", row.id, null, { week: row.week, count: stats.count, flagsTotal: stats.flagsTotal }),
  ]);
  return { id: row.id, week: row.week, created_at: row.created_at, stats };
}

export async function listVoiceprints(db: D1Database, limit = 8): Promise<VoiceprintRow[]> {
  const n = Number.isFinite(limit) ? Math.min(LIST_MAX, Math.max(1, Math.floor(limit))) : 8;
  const r = await db.prepare("SELECT * FROM voiceprints ORDER BY created_at DESC LIMIT ?1").bind(n).all<VoiceprintRow>();
  return r.results;
}
