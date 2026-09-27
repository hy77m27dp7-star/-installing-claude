// Chapters (the experience pass, DESIGN_EXPERIENCE sections 8.2 and 8.3): a conversation
// read as a chapter of the two of them. Its title is computed on every read and never
// stored (only his rename writes conversations.title): his own title, else the place they
// were together when it began (or the first place they went inside it), else the day.
//
// Every time here comes from the VISIBLE story rows (channel story, deliver_at unset or
// passed): a held reply, an operator note or a call row never opens or closes a chapter.
// A scene version nobody talked in (a photo re-shoot setup, a test fast-forward, a scene set
// and changed again before a word) never names a chapter.
import { ApiHttpError } from "./errors";
import { sceneAt } from "./album";
import type { SceneVersionLike } from "./album";
import { auditStmt, getConversation } from "./db";
import { safeTimezone } from "./life";
import type { ConversationRow } from "./types";

export type TitleFrom = "his" | "place" | "day";

export interface ConversationView extends ConversationRow {
  displayTitle: string;
  titleFrom: TitleFrom;
  firstAt: string | null; // first visible story message
  lastAt: string | null; // last visible story message
  preview: { role: "user" | "assistant"; text: string; at: string } | null;
}

export const TITLE_MAX = 80;
export const PREVIEW_MAX = 90;
const PLACE_TITLE_MAX = 40;
const CHUNK = 90;
const DASHES = /\s*[\u2013\u2014]\s*/g;
const ELLIPSIS = /\u2026/g;

// ------------------------------------------------------------------ pure

function ms(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

function oneLine(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

// One line cut at the last space before `max` characters, "..." appended when cut.
export function cutLine(s: unknown, max: number): string | null {
  const line = oneLine(s);
  if (!line) return null;
  if (line.length <= max) return line;
  const head = line.slice(0, max);
  const sp = head.lastIndexOf(" ");
  const base = (sp > 0 ? head.slice(0, sp) : head).replace(/[\s,;:]+$/, "");
  return (base || head) + "...";
}

// One leading "at ", "in " or "on " dropped (any case).
export function dropLead(s: string, words: readonly string[] = ["at", "in", "on"]): string {
  const re = new RegExp("^(?:" + words.join("|") + ")(?:\\s+|$)", "i");
  return s.replace(re, "");
}

// The words a place gives a chapter: "at the record store on Congress Street, late" -> "The
// record store on Congress Street". Null when nothing is left.
export function placeTitle(location: string | null | undefined): string | null {
  let s = oneLine(location);
  if (!s) return null;
  s = dropLead(s);
  const cuts = [",", ";", "(", " -- "].map((m) => s.indexOf(m)).filter((i) => i >= 0);
  if (cuts.length) s = s.slice(0, Math.min(...cuts));
  s = s.trim();
  if (s.length > PLACE_TITLE_MAX) {
    const head = s.slice(0, PLACE_TITLE_MAX + 1);
    const sp = head.lastIndexOf(" ");
    s = sp > 0 ? head.slice(0, sp) : s.slice(0, PLACE_TITLE_MAX);
  }
  s = s.replace(/[\s.,;:!?'"\-]+$/, "").trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function partOfDay(hour: number): string {
  if (hour >= 5 && hour <= 11) return "morning";
  if (hour >= 12 && hour <= 16) return "afternoon";
  if (hour >= 17 && hour <= 20) return "evening";
  return "night";
}

// "Thursday night": the weekday in her timezone and the part of the day by her local hour.
export function dayTitle(iso: string, tz: string): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const zone = safeTimezone(tz);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(t));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return (weekday + " " + partOfDay(hour)).trim();
}

interface SceneRead { status: string; location: string | null }

function readScene(v: SceneVersionLike): SceneRead | null {
  try {
    const parsed: unknown = JSON.parse(v.state_json);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as { status?: unknown; location?: unknown };
    const status = typeof o.status === "string" ? o.status.trim().toLowerCase() : "";
    const location = typeof o.location === "string" && o.location.trim() ? o.location.trim() : null;
    return { status, location };
  } catch {
    return null;
  }
}

function byCreated(a: SceneVersionLike, b: SceneVersionLike): number {
  const d = (ms(a.created_at) || 0) - (ms(b.created_at) || 0);
  return d !== 0 ? d : a.version - b.version;
}

// The versions with at least one visible story message in [created_at, next version's
// created_at), oldest first (by created_at, then version).
export function visitedVersions(versions: SceneVersionLike[], storyTimes: readonly string[]): SceneVersionLike[] {
  const list = (Array.isArray(versions) ? versions : []).filter((v) => v && Number.isFinite(ms(v.created_at))).slice().sort(byCreated);
  const times = (Array.isArray(storyTimes) ? storyTimes : []).map(ms).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (!list.length || !times.length) return [];
  const out: SceneVersionLike[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i] as SceneVersionLike;
    const start = ms(v.created_at);
    const nextV = list[i + 1];
    const end = nextV ? ms(nextV.created_at) : Infinity;
    if (!(end > start)) continue; // a version replaced at the same instant held no words
    // the first time at or after `start`
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((times[mid] as number) < start) lo = mid + 1;
      else hi = mid;
    }
    if (lo < times.length && (times[lo] as number) < end) out.push(v);
  }
  return out;
}

// his > the place in force at firstAt > the first VISITED together version inside the span
// > the day. `versions` are every scene version when `span.times` carries the chapter's
// visible story times (they are narrowed to the visited ones here), else they are taken as
// already visited.
export function chapterTitle(
  conv: { title: string | null; created_at: string },
  span: { firstAt: string | null; lastAt: string | null; times?: readonly string[] },
  versions: SceneVersionLike[],
  tz: string,
): { displayTitle: string; titleFrom: TitleFrom } {
  const his = oneLine(conv && conv.title);
  if (his) return { displayTitle: his, titleFrom: "his" };
  const firstAt = span && typeof span.firstAt === "string" && span.firstAt ? span.firstAt : null;
  const lastAt = span && typeof span.lastAt === "string" && span.lastAt ? span.lastAt : firstAt;
  if (firstAt) {
    const visited = span.times ? visitedVersions(versions, span.times) : (Array.isArray(versions) ? versions.slice().sort(byCreated) : []);
    const inForce = sceneAt(visited, firstAt);
    if ((inForce.status ?? "").toLowerCase() === "together" && inForce.location) {
      const words = placeTitle(inForce.location);
      if (words) return { displayTitle: words, titleFrom: "place" };
    }
    const from = ms(firstAt);
    const to = ms(lastAt);
    for (const v of visited) {
      const t = ms(v.created_at);
      if (!(t > from && t <= to)) continue;
      const s = readScene(v);
      if (!s || s.status !== "together" || !s.location) continue;
      const words = placeTitle(s.location);
      if (words) return { displayTitle: words, titleFrom: "place" };
    }
  }
  return { displayTitle: dayTitle(firstAt ?? conv.created_at, tz), titleFrom: "day" };
}

function validation(message: string): ApiHttpError {
  return new ApiHttpError(400, "validation", message);
}

// His rename: null or blank -> null (back to the automatic title); otherwise one line, the
// smart punctuation of his phone repaired (an em or en dash with its spaces -> " -- ", the
// ellipsis character -> "..."), at most 80 characters after that. Anything else is a 400.
export function cleanTitle(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw validation("title must be a string or null");
  let s = oneLine(raw);
  if (!s) return null;
  s = s.replace(DASHES, " -- ").replace(ELLIPSIS, "...").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > TITLE_MAX) throw validation("title is too long");
  return s;
}

// The last line of a chapter as the list shows it: one line, cut at the last space before
// 90 characters with "..." appended when longer; null when there is no text.
export function previewText(content: string | null | undefined): string | null {
  return cutLine(content, PREVIEW_MAX);
}

// ------------------------------------------------------------------ D1

interface TimeRow { conversation_id: string; created_at: string; channel?: string; deliver_at?: string | null }
interface LastRow { conversation_id: string; role: string; content: string | null; created_at: string; seq: number; channel?: string; deliver_at?: string | null }

function visibleStory(r: { channel?: string; deliver_at?: string | null }, nowIso: string): boolean {
  if (r.channel !== undefined && r.channel !== "story") return false;
  const d = r.deliver_at;
  return d === null || d === undefined || d <= nowIso;
}

function chunked(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

// The visible story message times of each conversation, oldest first.
export async function readStoryTimes(db: D1Database, ids: string[], now: Date): Promise<Map<string, string[]>> {
  const nowIso = now.toISOString();
  const wanted = new Set(ids);
  const out = new Map<string, string[]>();
  for (const part of chunked(Array.from(wanted))) {
    const marks = part.map((_, k) => "?" + (k + 2)).join(", ");
    const r = await db
      .prepare(`SELECT conversation_id, created_at, channel, deliver_at FROM messages WHERE channel = 'story' AND (deliver_at IS NULL OR deliver_at <= ?1) AND conversation_id IN (${marks}) ORDER BY created_at`)
      .bind(nowIso, ...part)
      .all<TimeRow>();
    for (const row of r.results ?? []) {
      if (!row || !wanted.has(row.conversation_id) || !Number.isFinite(ms(row.created_at)) || !visibleStory(row, nowIso)) continue;
      const list = out.get(row.conversation_id) ?? [];
      list.push(row.created_at);
      out.set(row.conversation_id, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => ms(a) - ms(b));
  return out;
}

// The last visible story row of each conversation (the highest seq among them).
async function readLastRows(db: D1Database, ids: string[], now: Date): Promise<Map<string, LastRow>> {
  const nowIso = now.toISOString();
  const wanted = new Set(ids);
  const out = new Map<string, LastRow>();
  for (const part of chunked(Array.from(wanted))) {
    const marks = part.map((_, k) => "?" + (k + 2)).join(", ");
    const r = await db
      .prepare(
        "SELECT m.conversation_id AS conversation_id, m.role AS role, m.content AS content, m.created_at AS created_at, m.seq AS seq, m.channel AS channel, m.deliver_at AS deliver_at FROM messages m "
        + "JOIN (SELECT conversation_id AS cid, MAX(seq) AS top FROM messages WHERE channel = 'story' AND (deliver_at IS NULL OR deliver_at <= ?1) "
        + `AND conversation_id IN (${marks}) GROUP BY conversation_id) x ON x.cid = m.conversation_id AND x.top = m.seq`,
      )
      .bind(nowIso, ...part)
      .all<LastRow>();
    for (const row of r.results ?? []) {
      if (!row || !wanted.has(row.conversation_id) || !visibleStory(row, nowIso)) continue;
      const cur = out.get(row.conversation_id);
      if (!cur || Number(row.seq) > Number(cur.seq)) out.set(row.conversation_id, row);
    }
  }
  return out;
}

export async function readSceneVersions(db: D1Database): Promise<SceneVersionLike[]> {
  try {
    const r = await db.prepare("SELECT version, state_json, created_at FROM state_versions WHERE entity = ?1 ORDER BY version").bind("scene").all<SceneVersionLike>();
    return (r.results ?? []).filter((v) => v && typeof v.state_json === "string");
  } catch {
    return [];
  }
}

function previewOf(row: LastRow | undefined): ConversationView["preview"] {
  if (!row) return null;
  const text = previewText(row.content);
  if (!text) return null;
  return { role: row.role === "user" ? "user" : "assistant", text, at: row.created_at };
}

// The views and what they were computed from (us.ts reuses the times and the versions).
export async function conversationData(
  db: D1Database,
  rows: ConversationRow[],
  tz: string,
  now: Date = new Date(),
): Promise<{ views: ConversationView[]; times: Map<string, string[]>; versions: SceneVersionLike[] }> {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === "string") : [];
  const ids = list.map((r) => r.id);
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  let times = new Map<string, string[]>();
  let last = new Map<string, LastRow>();
  let versions: SceneVersionLike[] = [];
  if (ids.length) {
    [times, last, versions] = await Promise.all([
      readStoryTimes(db, ids, at).catch(() => new Map<string, string[]>()),
      readLastRows(db, ids, at).catch(() => new Map<string, LastRow>()),
      readSceneVersions(db),
    ]);
  }
  const views = list.map((row) => {
    const own = times.get(row.id) ?? [];
    const firstAt = own[0] ?? null;
    const lastAt = own[own.length - 1] ?? null;
    const title = chapterTitle(row, { firstAt, lastAt, times: own }, versions, tz);
    return { ...row, displayTitle: title.displayTitle, titleFrom: title.titleFrom, firstAt, lastAt, preview: previewOf(last.get(row.id)) };
  });
  return { views, times, versions };
}

export async function conversationViews(db: D1Database, rows: ConversationRow[], tz: string, now: Date = new Date()): Promise<ConversationView[]> {
  return (await conversationData(db, rows, tz, now)).views;
}

// His rename (PUT /api/conversations/:id): one batch, the UPDATE and its audit row.
export async function renameConversation(db: D1Database, id: string, title: string | null, actor: string, tz: string): Promise<ConversationView> {
  const clean = cleanTitle(title);
  const conv = await getConversation(db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const after: ConversationRow = { ...conv, title: clean };
  await db.batch([
    db.prepare("UPDATE conversations SET title = ?1 WHERE id = ?2").bind(clean, id),
    auditStmt(db, actor, "conversation.rename", "conversation", id, conv, after),
  ]);
  const views = await conversationViews(db, [after], tz);
  const view = views[0];
  if (!view) throw new ApiHttpError(404, "not_found", "conversation not found");
  return view;
}
