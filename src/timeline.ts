// The timeline (SPEC_V2 section X): one read-only scroll of what happened, merged from
// the tables that record it and sorted oldest first so the newest sits at the bottom.
// Sources: approved history entries, her approved photos, the library items she sent,
// life log notes, every relationship and scene version, and her first texts. Each item
// carries a date, a type, a title, a short text and a link (the chat for a message, the
// State tab for a version or an entry). Nothing here writes.
//
// Every source is read with its own statement (no joins), each capped at the page size
// and cut at `before`, so a page costs a dozen small reads; the merge, the sort and the
// final cut happen in code.
//
// v3 (SPEC_V3 "Export and import"): calls (EE), want log rows and asks (CC), corrections
// (AA) and portrait approvals (DD) join the scroll. A v3 table that does not exist yet
// (a database behind migration 0005) answers nothing, never a failure.
import { listAssets, listHistory } from "./db";
import { listMedia } from "./media";
import type { LifeLog, LifeThread } from "./life";
import type { Env, HistoryRow, MediaRow, MessageRow, StateVersionRow, VisualAssetRow } from "./types";


export type TimelineType = "history" | "photo" | "media" | "life" | "relationship" | "scene" | "first_text"
  | "call" | "want" | "ask" | "correction" | "portrait";

export interface TimelineItem {
  // Unique on the timeline: "<type>:<row id>".
  id: string;
  // ISO instant the item is placed at.
  at: string;
  type: TimelineType;
  title: string;
  text: string | null;
  // Where the item opens: "/" (the chat, with conversationId to reopen) or a State tab.
  link: string | null;
  messageId: string | null;
  conversationId: string | null;
  imageId: string | null;
  mediaId: string | null;
  entity: "relationship" | "scene" | null;
  version: number | null;
  // v4 (SPEC_V4 section 3): a photo item says whether he is in the picture.
  withHim?: boolean;
}

export interface TimelinePage {
  items: TimelineItem[];
  // The oldest date on this page when it was full (pass as ?before= for the page above), else null.
  nextBefore: string | null;
}

export interface TimelineOptions {
  before?: string;
  limit?: number;
}

export const TIMELINE_MAX = 500;
const TEXT_CHARS = 160;
const THREAD_ROWS = 1000;
const TYPE_ORDER: Record<TimelineType, number> = {
  history: 0, relationship: 1, scene: 2, life: 3, photo: 4, media: 5, first_text: 6, call: 7, want: 8, ask: 9, correction: 10, portrait: 11,
};

// ------------------------------------------------------------------ helpers

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return TIMELINE_MAX;
  return Math.min(TIMELINE_MAX, Math.max(1, Math.floor(n)));
}

function parseBefore(v: string | undefined): { iso: string; ms: number } | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const ms = Date.parse(v.trim());
  if (!Number.isFinite(ms)) return null;
  return { iso: new Date(ms).toISOString(), ms };
}

function ms(iso: string | null | undefined): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

// The first `n` chars of a text, on one line, with a marker when it was cut.
function excerpt(s: string | null | undefined, n = TEXT_CHARS): string | null {
  if (typeof s !== "string") return null;
  const one = s.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > n ? one.slice(0, n - 3).trimEnd() + "..." : one;
}

function stateField(json: string, key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object") {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    // an unreadable version still shows, without its summary
  }
  return null;
}

function item(partial: Pick<TimelineItem, "id" | "at" | "type" | "title"> & Partial<TimelineItem>): TimelineItem {
  return {
    text: null,
    link: null,
    messageId: null,
    conversationId: null,
    imageId: null,
    mediaId: null,
    entity: null,
    version: null,
    ...partial,
  };
}

// ------------------------------------------------------------------ sources

async function rows<T>(db: D1Database, sql: string, binds: unknown[]): Promise<T[]> {
  const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  return (await stmt.all<T>()).results;
}

// A v3 table that is not there yet answers [].
async function rowsOrEmpty<T>(db: D1Database, sql: string, binds: unknown[]): Promise<T[]> {
  try {
    return await rows<T>(db, sql, binds);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ v3 sources

interface CallRowLite { id: string; conversation_id: string; status: string; started_at: string; ended_at: string | null; seconds: number; transcript_rows: number; end_reason: string | null }
interface WantLogLite { id: string; want_id: string; occurred: string; kind: string; delta: number | null; note: string; created_at: string }
interface WantLite { id: string; title: string }
interface AskLite { id: string; text: string; status: string; asked_at: string; asked_message_id: string | null; created_at: string }
interface CorrectionLite { id: string; message_id: string; conversation_id: string | null; kind: string; note: string | null; original: string; rewrite: string | null; created_at: string }

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function callItems(calls: CallRowLite[]): TimelineItem[] {
  return calls
    .filter((c) => c.status === "ended")
    .map((c) => item({
      id: "call:" + c.id,
      at: c.ended_at ?? c.started_at,
      type: "call",
      title: "call, " + clock(c.seconds),
      text: c.transcript_rows ? c.transcript_rows + " lines" + (c.end_reason && c.end_reason !== "ended" ? ", " + c.end_reason.replace(/_/g, " ") : "") : "no words",
      link: "/",
      conversationId: c.conversation_id,
    }));
}

function wantItems(log: WantLogLite[], wants: WantLite[]): TimelineItem[] {
  const titles = new Map(wants.map((w) => [w.id, w.title] as const));
  return log.map((l) => {
    const at = Number.isFinite(ms(l.occurred)) ? l.occurred : l.created_at;
    const title = titles.get(l.want_id) ?? "a want";
    const head = l.kind === "progress" ? "moved" : l.kind === "setback" ? "setback" : "note";
    return item({
      id: "want:" + l.id,
      at,
      type: "want",
      title: title + ": " + head + (typeof l.delta === "number" && l.kind !== "note" ? " " + (l.kind === "setback" ? "-" : "+") + Math.abs(l.delta) : ""),
      text: excerpt(l.note),
      link: "/state#wants",
    });
  });
}

function askItems(asks: AskLite[]): TimelineItem[] {
  return asks.map((a) => item({
    id: "ask:" + a.id,
    at: Number.isFinite(ms(a.asked_at)) ? a.asked_at : a.created_at,
    type: "ask",
    title: "she asked" + (a.status !== "open" ? " (" + a.status.replace(/_/g, " ") + ")" : ""),
    text: excerpt(a.text),
    link: a.asked_message_id ? "/" : "/state#wants",
    messageId: a.asked_message_id,
  }));
}

const KIND_WORD: Record<string, string> = {
  ai: "not how she talks", clever: "too clever", not_her: "not her", too_long: "too long", too_nice: "too nice", too_polished: "too polished", other: "note",
};

function correctionItems(list: CorrectionLite[]): TimelineItem[] {
  return list.map((c) => item({
    id: "correction:" + c.id,
    at: c.created_at,
    type: "correction",
    title: "note: " + (KIND_WORD[c.kind] ?? c.kind),
    text: excerpt(c.rewrite ? "his version: " + c.rewrite : c.note ?? c.original),
    link: "/",
    messageId: c.message_id,
    conversationId: c.conversation_id,
  }));
}

function portraitItems(assets: VisualAssetRow[]): TimelineItem[] {
  return assets
    .filter((a) => (a.role as string) === "portrait" && a.approval_status === "approved")
    .map((a) => item({
      id: "portrait:" + a.id,
      at: a.decided_at ?? a.created_at,
      type: "portrait",
      title: "portrait",
      text: excerpt(a.prompt),
      link: "/state#life",
      imageId: a.id,
    }));
}

function historyItems(list: HistoryRow[]): TimelineItem[] {
  return list.map((h) => item({
    id: "history:" + h.id,
    at: h.created_at,
    type: "history",
    title: h.title,
    text: excerpt((h.occurred ? h.occurred + ": " : "") + h.body),
    link: "/state#history",
  }));
}

function photoItems(assets: VisualAssetRow[]): TimelineItem[] {
  return assets
    .filter((a) => a.role === "scene" && a.approval_status === "approved")
    .map((a) => item({
      id: "photo:" + a.id,
      at: a.created_at,
      type: "photo",
      title: "photo",
      text: excerpt(a.prompt),
      link: a.message_id ? "/" : "/images",
      messageId: a.message_id,
      conversationId: a.conversation_id,
      imageId: a.id,
      withHim: Number(a.with_him ?? 0) === 1,
    }));
}

function lifeItems(log: LifeLog[], threads: LifeThread[]): TimelineItem[] {
  const titles = new Map<string, string>();
  for (const t of threads) titles.set(t.id, t.title);
  return log.map((l) => {
    const thread = l.thread_id ? titles.get(l.thread_id) ?? null : null;
    const at = Number.isFinite(ms(l.occurred)) ? l.occurred : l.created_at;
    return item({
      id: "life:" + l.id,
      at,
      type: "life",
      title: thread ?? "her day",
      text: excerpt(l.note),
      link: "/state#life",
    });
  });
}

function stateItems(versions: StateVersionRow[]): TimelineItem[] {
  return versions
    .filter((v) => v.entity === "relationship" || v.entity === "scene")
    .map((v) => {
      const status = stateField(v.state_json, "status");
      const detail = v.note?.trim() || stateField(v.state_json, "summary");
      return item({
        id: v.entity + ":" + v.id,
        at: v.created_at,
        type: v.entity,
        title: `${v.entity} v${v.version}${status ? ": " + status : ""}`,
        text: excerpt(detail),
        link: "/state#now",
        entity: v.entity,
        version: v.version,
      });
    });
}

// Her story messages that stand on their own on the timeline: the ones that sent a
// library item, and the ones she started (no message of his before them).
function messageItems(messages: MessageRow[], media: MediaRow[]): TimelineItem[] {
  const byId = new Map<string, MediaRow>();
  for (const m of media) byId.set(m.id, m);
  const out: TimelineItem[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || m.channel !== "story") continue;
    const mediaId = typeof m.media_id === "string" && m.media_id ? m.media_id : null;
    if (mediaId) {
      const row = byId.get(mediaId);
      out.push(item({
        id: "media:" + m.id,
        at: m.created_at,
        type: "media",
        title: row ? row.title : "sent something from her phone",
        text: excerpt(row?.description ?? m.content),
        link: "/",
        messageId: m.id,
        conversationId: m.conversation_id,
        mediaId,
      }));
    }
    if (m.reply_to_id === null || m.reply_to_id === undefined) {
      out.push(item({
        id: "first_text:" + m.id,
        at: m.created_at,
        type: "first_text",
        title: "she texted first",
        text: excerpt(m.content),
        link: "/",
        messageId: m.id,
        conversationId: m.conversation_id,
      }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ the page

export async function getTimeline(db: D1Database, _env: Env, opts: TimelineOptions = {}): Promise<TimelinePage> {
  const limit = clampLimit(opts.limit);
  const before = parseBefore(opts.before);
  // SQL cut where the column is the placement date; the code cut below covers the rest
  // (life notes are placed at `occurred`, and a stand-in database evaluates no SQL).
  const cut = before ? before.iso : "9999-12-31T23:59:59.999Z";

  const [history, assets, log, threads, versions, messages, media, calls, wantLog, wants, asks, corrections] = await Promise.all([
    listHistory(db, "approved"),
    listAssets(db, "approved"),
    rows<LifeLog>(db, "SELECT * FROM life_log WHERE occurred < ?1 ORDER BY occurred DESC, created_at DESC LIMIT ?2", [cut, limit]),
    rows<LifeThread>(db, "SELECT id, title FROM life_threads ORDER BY created_at DESC LIMIT ?1", [THREAD_ROWS]),
    rows<StateVersionRow>(db, "SELECT * FROM state_versions WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2", [cut, limit]),
    rows<MessageRow>(
      db,
      "SELECT * FROM messages WHERE role = ?1 AND channel = ?2 AND created_at < ?3 AND (media_id IS NOT NULL OR reply_to_id IS NULL) AND call_id IS NULL ORDER BY created_at DESC LIMIT ?4",
      ["assistant", "story", cut, limit * 2],
    ).catch(() => rows<MessageRow>(
      db,
      "SELECT * FROM messages WHERE role = ?1 AND channel = ?2 AND created_at < ?3 AND (media_id IS NOT NULL OR reply_to_id IS NULL) ORDER BY created_at DESC LIMIT ?4",
      ["assistant", "story", cut, limit * 2],
    )),
    listMedia(db, "active"),
    // v3
    rowsOrEmpty<CallRowLite>(db, "SELECT * FROM calls WHERE status = 'ended' AND COALESCE(ended_at, started_at) < ?1 ORDER BY started_at DESC LIMIT ?2", [cut, limit]),
    rowsOrEmpty<WantLogLite>(db, "SELECT * FROM want_log WHERE occurred < ?1 ORDER BY occurred DESC, created_at DESC LIMIT ?2", [cut, limit]),
    rowsOrEmpty<WantLite>(db, "SELECT id, title FROM wants ORDER BY created_at DESC LIMIT ?1", [THREAD_ROWS]),
    rowsOrEmpty<AskLite>(db, "SELECT * FROM asks WHERE asked_at < ?1 ORDER BY asked_at DESC LIMIT ?2", [cut, limit]),
    rowsOrEmpty<CorrectionLite>(db, "SELECT * FROM corrections WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2", [cut, limit]),
  ]);

  const all = [
    ...historyItems(history),
    ...photoItems(assets),
    ...lifeItems(log, threads),
    ...stateItems(versions),
    ...messageItems(messages, media),
    ...callItems(calls),
    ...wantItems(wantLog, wants),
    ...askItems(asks),
    ...correctionItems(corrections),
    ...portraitItems(assets),
  ].filter((i) => {
    const t = ms(i.at);
    if (!Number.isFinite(t)) return false;
    return before ? t < before.ms : true;
  });

  all.sort((a, b) => {
    const d = ms(a.at) - ms(b.at);
    if (d !== 0) return d;
    const k = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return k !== 0 ? k : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const items = all.length > limit ? all.slice(all.length - limit) : all;
  const oldest = items[0];
  const nextBefore = all.length > limit && oldest ? oldest.at : null;
  return { items, nextBefore };
}

// ------------------------------------------------------------------ places (SPEC_V2 section W)

export interface PlaceOption {
  id: string;
  title: string;
  detail: string | null;
}

// The known places for the Together toggle's location picker: active place threads,
// alphabetical by title.
export function placesForPicker(threads: LifeThread[]): PlaceOption[] {
  return threads
    .filter((t) => t.kind === "place" && t.status === "active" && typeof t.title === "string" && t.title.trim())
    .map((t) => ({ id: t.id, title: t.title.trim(), detail: t.detail && t.detail.trim() ? t.detail.trim() : null }))
    .sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
}
