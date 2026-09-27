// Us (the experience pass, DESIGN_EXPERIENCE section 8.7): the story of the two of them.
// Where they stand and since when, the chapters, the moments that mattered, the places they
// have been together, the lines of hers he kept, and her names for each other.
//
// Not in the view, on purpose: facts about him, guesses, her reads of him, her untold facts
// or their subjects (Studio > Memory lists them). No weights, no phases, no numbers but the
// count of visits. Read-only; every sub-read that throws on an older shape answers empty.
import type { SceneVersionLike } from "./album";
import { conversationData, isFillerPlace, placeTitle, visitedVersions } from "./chapters";
import { loadStoryClock } from "./clock";
import { getCurrentState, listConversations, listHistory } from "./db";
import { listPlaces, placeTitleNorm } from "./places";
import type { PlaceRow } from "./places";
import { displayStatus } from "./standing";
import type { ConversationRow, HistoryRow, RelationshipState, Settings } from "./types";
import { safeTimezone } from "./life";

export interface UsView {
  since: string | null;
  standing: string | null;
  nicknames: string[];
  chapters: Array<{ id: string; title: string; from: string; to: string }>;
  moments: Array<{ id: string; title: string; at: string | null }>;
  places: Array<{ title: string; first: string; times: number; placeId: string | null; picture: boolean }>;
  kept: Array<{ id: string; text: string; at: string; conversationId: string }>;
}

export const QUOTE_MAX = 240;
export const KEPT_MAX = 12;
const CHUNK = 90;

// ------------------------------------------------------------------ pure

function ms(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

function oneLine(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function sceneOf(v: SceneVersionLike): { together: boolean; location: string | null } {
  try {
    const parsed: unknown = JSON.parse(v.state_json);
    if (!parsed || typeof parsed !== "object") return { together: false, location: null };
    const o = parsed as { status?: unknown; location?: unknown };
    const together = typeof o.status === "string" && o.status.trim().toLowerCase() === "together";
    const location = typeof o.location === "string" && oneLine(o.location) ? oneLine(o.location) : null;
    return { together, location };
  } catch {
    return { together: false, location: null };
  }
}

// The places they have been together: a visit starts at a VISITED together version with a
// location whose place (placeTitle: "the record store on Congress Street, at the used bins"
// is "The record store on Congress Street") differs from the previous visited version's
// together place (or the previous visited version was not together). A filler location
// ("same scene", "k") names no place: the visit before it carries on. Oldest first by the
// first visit.
export function togetherPlaces(versions: SceneVersionLike[], storyTimes: readonly string[]): Array<{ title: string; norm: string; first: string; times: number }> {
  const visited = visitedVersions(versions, storyTimes);
  const byNorm = new Map<string, { title: string; norm: string; first: string; times: number }>();
  let prev: string | null = null;
  for (const v of visited) {
    const s = sceneOf(v);
    if (!s.together) {
      prev = null;
      continue;
    }
    if (!s.location || isFillerPlace(s.location)) continue;
    const title = placeTitle(s.location);
    const norm = title ? placeTitleNorm(title) : "";
    if (!title || !norm) {
      prev = null;
      continue;
    }
    if (norm !== prev) {
      const cur = byNorm.get(norm);
      if (cur) cur.times += 1;
      else byNorm.set(norm, { title, norm, first: v.created_at, times: 1 });
    }
    prev = norm;
  }
  return Array.from(byNorm.values()).sort((a, b) => (ms(a.first) || 0) - (ms(b.first) || 0));
}

// A kept line of hers as a pull quote: every *action* removed, one line, cut at the last
// space before 240 characters with "..." appended when longer; null when nothing is left.
export function quoteText(content: string | null | undefined): string | null {
  if (typeof content !== "string") return null;
  const s = oneLine(content.replace(/\*[^*\n]*\*/g, " ").replace(/\*/g, " "));
  if (!s) return null;
  if (s.length <= QUOTE_MAX) return s;
  const head = s.slice(0, QUOTE_MAX);
  const sp = head.lastIndexOf(" ");
  return (sp > 0 ? head.slice(0, sp) : head).replace(/[\s,;:]+$/, "") + "...";
}

// Her names for each other: every "(...)" aside taken out first ("Starbrite (his, for her;
// she says the ruling is pending)" is "Starbrite"), then split on commas, semicolons, " / "
// and newlines, trimmed, the empty ones and "none" or "none established" dropped, repeats
// (any case) kept once.
export function splitNicknames(s: string | null | undefined): string[] {
  if (typeof s !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.replace(/\([^)]*\)?/g, " ").split(/[,;\n]|\s\/\s/)) {
    const n = oneLine(raw);
    if (!n || /^none(?:\s+(?:established|yet))?$/i.test(n)) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

// ------------------------------------------------------------------ D1

function quiet<T>(name: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e: unknown): T => {
    console.warn("us: " + name + " skipped", e instanceof Error ? e.name : "error");
    return fallback;
  });
}

interface MarkLite { message_id: string; mark: string }
interface KeptMsg { id: string; conversation_id: string; role: string; channel: string; content: string | null; created_at: string; deliver_at?: string | null }

async function keptLines(db: D1Database, listed: Set<string>, now: Date): Promise<UsView["kept"]> {
  const nowIso = now.toISOString();
  const marks = await db.prepare("SELECT message_id, mark FROM message_marks WHERE mark = ?1").bind("keep").all<MarkLite>();
  const ids = Array.from(new Set((marks.results ?? []).filter((m) => m && m.mark === "keep" && typeof m.message_id === "string").map((m) => m.message_id)));
  const rows: KeptMsg[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const q = part.map((_, k) => "?" + (k + 1)).join(", ");
    const r = await db.prepare(`SELECT id, conversation_id, role, channel, content, created_at, deliver_at FROM messages WHERE id IN (${q})`).bind(...part).all<KeptMsg>();
    for (const m of r.results ?? []) if (m && part.includes(m.id)) rows.push(m);
  }
  return rows
    .filter((m) => m.role === "assistant" && m.channel === "story" && listed.has(m.conversation_id))
    .filter((m) => m.deliver_at === null || m.deliver_at === undefined || m.deliver_at <= nowIso)
    .sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0) || (a.id < b.id ? 1 : -1))
    .map((m) => ({ id: m.id, text: quoteText(m.content), at: m.created_at, conversationId: m.conversation_id }))
    .filter((k): k is UsView["kept"][number] => typeof k.text === "string" && k.text.length > 0)
    .slice(0, KEPT_MAX);
}

function momentsOf(rows: HistoryRow[]): UsView["moments"] {
  return rows
    .filter((h) => h && h.status === "approved" && oneLine(h.title))
    .slice()
    .sort((a, b) => {
      const ao = typeof a.occurred === "string" && a.occurred.trim() ? a.occurred.trim() : null;
      const bo = typeof b.occurred === "string" && b.occurred.trim() ? b.occurred.trim() : null;
      if (ao !== bo) {
        if (ao === null) return 1;
        if (bo === null) return -1;
        return ao < bo ? -1 : 1;
      }
      return (Number(a.seq) || 0) - (Number(b.seq) || 0);
    })
    .map((h) => ({ id: h.id, title: oneLine(h.title), at: typeof h.occurred === "string" && h.occurred.trim() ? h.occurred.trim() : null }));
}

async function relationship(db: D1Database): Promise<RelationshipState | null> {
  const cur = await getCurrentState<RelationshipState>(db, "relationship");
  return cur && cur.state && typeof cur.state === "object" ? cur.state : null;
}

export async function usView(db: D1Database, settings: Settings, now: Date): Promise<UsView> {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const tz = safeTimezone(typeof settings.timezone === "string" && settings.timezone.trim() ? settings.timezone.trim() : "America/New_York");
  const convs = (await quiet("conversations", listConversations(db), [] as ConversationRow[])).filter((c) => c && c.status !== "drift" && c.status !== "deleted");
  const listed = new Set(convs.map((c) => c.id));

  const [data, history, places, kept, rel, clock] = await Promise.all([
    quiet("chapters", conversationData(db, convs, tz, at), { views: [], times: new Map<string, string[]>(), versions: [] as SceneVersionLike[] }),
    quiet("history", listHistory(db, "approved"), [] as HistoryRow[]),
    quiet("places", listPlaces(db), [] as PlaceRow[]),
    quiet("kept", keptLines(db, listed, at), [] as UsView["kept"]),
    quiet("relationship", relationship(db), null),
    loadStoryClock(db, settings, at),
  ]);

  const chapters = data.views
    .filter((v) => typeof v.firstAt === "string" && v.firstAt)
    .sort((a, b) => (ms(a.firstAt) || 0) - (ms(b.firstAt) || 0))
    .map((v) => ({ id: v.id, title: v.displayTitle, from: v.firstAt as string, to: (v.lastAt ?? v.firstAt) as string }));

  const storyTimes: string[] = [];
  for (const [id, list] of data.times) if (listed.has(id)) storyTimes.push(...list);
  // A place row is found by its own title or by the place its title names ("Rosie's, on
  // Exchange Street" is also "rosie's"), the same cut the visits are keyed by.
  const byNorm = new Map<string, PlaceRow>();
  for (const p of places) {
    if (!p || typeof p.title_norm !== "string") continue;
    const cut = placeTitle(typeof p.title === "string" ? p.title : "");
    for (const key of [p.title_norm, cut ? placeTitleNorm(cut) : ""]) if (key && !byNorm.has(key)) byNorm.set(key, p);
  }
  const placeList = togetherPlaces(data.versions, storyTimes).map((p) => {
    const row = byNorm.get(p.norm) ?? null;
    return {
      title: p.title,
      first: p.first,
      times: p.times,
      placeId: row ? row.id : null,
      picture: !!(row && typeof row.picture_key === "string" && row.picture_key.length > 0),
    };
  });

  let standing: string | null = null;
  if (rel) {
    let shown = "";
    try {
      shown = displayStatus(rel, at, clock);
    } catch {
      shown = "";
    }
    const text = oneLine(shown) || oneLine(rel.status);
    standing = text || null;
  }

  return {
    since: chapters[0]?.from ?? null,
    standing,
    nicknames: rel ? splitNicknames(typeof rel.nicknames === "string" ? rel.nicknames : null) : [],
    chapters,
    moments: momentsOf(history),
    places: placeList,
    kept,
  };
}
