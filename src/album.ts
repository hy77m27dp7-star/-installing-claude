// The album, her camera roll (SPEC_V4 section 5, plus A3: clips beside photos).
//
// Every picture she sent in a conversation (visual_assets rows with message_id set: roles
// candidate and scene for photos, role video for the clips the chat marker makes),
// statuses candidate and approved, newest first, with the date she sent it, the place
// from the scene record in force at that moment, and the two-of-you pictures grouped.
// Read-only: nothing here approves, rejects or generates. Never a role him row, never a
// portrait, never a call-face clip, never an owner-fired picture (message_id null), never
// the R2 key.
//
// The place: the provenance row (message_context) holds no location, only the mode, so
// the record is the newest scene version whose created_at is not after the message. Its
// location counts when its status is together; apart or none gives null.
import type { VisualAssetRow } from "./types";
import { ApiHttpError } from "./errors";

export interface AlbumItem {
  id: string;
  messageId: string;
  conversationId: string | null;
  at: string;
  status: "approved" | "candidate";
  withHim: boolean;
  description: string | null;
  place: string | null;
  sceneStatus: string | null;
  bytes: number | null;
  provider: string | null;
  // A3: a clip (role video bound to a message) sits beside the photos.
  kind: "photo" | "clip";
}

export type AlbumGroup = "all" | "approved" | "candidates" | "us";

export interface AlbumOpts {
  limit?: number;
  before?: string;
  group?: AlbumGroup;
}

export interface AlbumPage {
  items: AlbumItem[];
  nextBefore: string | null;
}

export interface SceneVersionLike {
  version: number;
  state_json: string;
  created_at: string;
}

export const ALBUM_GROUPS: readonly AlbumGroup[] = ["all", "approved", "candidates", "us"];
// Photos (candidate before approval, scene after) and, since A3, clips bound to a message.
export const ALBUM_ROLES: readonly string[] = ["candidate", "scene", "video"];
export const ALBUM_STATUSES: readonly string[] = ["candidate", "approved"];
export const ALBUM_LIMIT_DEFAULT = 100;
export const ALBUM_LIMIT_MAX = 200;
export const ALBUM_DESCRIPTION_MAX = 160;
// D1 binds at most 100 parameters per statement; every IN list rides in chunks of 90.
const CHUNK = 90;

// The row shape this module reads. with_him arrives with migration 0008 (L8 adds it to
// VisualAssetRow); optional here so the module compiles and runs on a row without it.
type AlbumAssetRow = Pick<VisualAssetRow, "id" | "role" | "approval_status" | "conversation_id" | "message_id" | "prompt" | "provider" | "bytes" | "created_at"> & {
  with_him?: number | null;
};

interface MessageStamp {
  id: string;
  conversation_id: string | null;
  created_at: string;
}

// ------------------------------------------------------------------ pure

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// The scene in force at `at`: the newest version (by created_at, then version) whose
// created_at is not after `at`. Its location when the status is together, else null. An
// unparsable state_json is skipped and the next newest counts; nothing eligible, or an
// unreadable `at`, gives nulls.
export function sceneAt(versions: SceneVersionLike[], at: string): { status: string | null; location: string | null } {
  const atMs = parseTime(at);
  if (atMs === null) return { status: null, location: null };
  const eligible = versions
    .map((v) => ({ v, t: parseTime(v.created_at) }))
    .filter((x): x is { v: SceneVersionLike; t: number } => x.t !== null && x.t <= atMs)
    .sort((a, b) => (b.t - a.t) || (b.v.version - a.v.version));
  for (const { v } of eligible) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v.state_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const s = parsed as { status?: unknown; location?: unknown };
    const status = typeof s.status === "string" && s.status.trim() ? s.status.trim() : null;
    const location = status === "together" && typeof s.location === "string" && s.location.trim() ? s.location.trim() : null;
    return { status, location };
  }
  return { status: null, location: null };
}

export function albumDescription(prompt: string | null | undefined): string | null {
  const text = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length > ALBUM_DESCRIPTION_MAX ? text.slice(0, ALBUM_DESCRIPTION_MAX).trimEnd() : text;
}

function normLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return ALBUM_LIMIT_DEFAULT;
  return Math.min(ALBUM_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function normGroup(group: string | undefined): AlbumGroup {
  if (group === undefined || group === null || group === "") return "all";
  if (!ALBUM_GROUPS.includes(group as AlbumGroup)) throw new ApiHttpError(400, "validation", "group must be one of " + ALBUM_GROUPS.join(", "));
  return group as AlbumGroup;
}

function normBefore(before: string | undefined): string | null {
  if (before === undefined || before === null || before === "") return null;
  if (typeof before !== "string" || parseTime(before) === null) throw new ApiHttpError(400, "validation", "before must be an ISO time");
  return before;
}

function inGroup(row: AlbumAssetRow, group: AlbumGroup): boolean {
  if (group === "approved") return row.approval_status === "approved";
  if (group === "candidates") return row.approval_status === "candidate";
  if (group === "us") return Number(row.with_him ?? 0) === 1;
  return true;
}

// The SQL filter and, again in memory, the same rule: a D1 row already matches; the unit
// suite's stand-in evaluates only "column = ?N" binds, never IN lists, ORDER BY or LIMIT,
// so the rule is applied to whatever comes back before it is paged.
function eligibleRow(row: AlbumAssetRow, group: AlbumGroup, before: string | null): boolean {
  if (!ALBUM_ROLES.includes(row.role)) return false;
  if (!ALBUM_STATUSES.includes(row.approval_status)) return false;
  if (!row.message_id) return false;
  if (!inGroup(row, group)) return false;
  if (before !== null && !(row.created_at < before)) return false;
  return true;
}

function byNewest(a: AlbumAssetRow, b: AlbumAssetRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ------------------------------------------------------------------ D1

async function rowsIn<T>(db: D1Database, sql: (marks: string) => string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map((_, k) => "?" + (k + 1)).join(", ");
    const r = await db.prepare(sql(marks)).bind(...part).all<T>();
    out.push(...r.results);
  }
  return out;
}

async function readAssets(db: D1Database, group: AlbumGroup, before: string | null, limit: number): Promise<AlbumAssetRow[]> {
  const where: string[] = [
    "role IN ('candidate', 'scene', 'video')",
    "approval_status IN ('candidate', 'approved')",
    "message_id IS NOT NULL",
  ];
  const binds: Array<string | number> = [];
  if (group === "approved" || group === "candidates") {
    binds.push(group === "approved" ? "approved" : "candidate");
    where.push("approval_status = ?" + binds.length);
  } else if (group === "us") {
    binds.push(1);
    where.push("with_him = ?" + binds.length);
  }
  if (before !== null) {
    binds.push(before);
    where.push("created_at < ?" + binds.length);
  }
  binds.push(limit);
  const sql = "SELECT * FROM visual_assets WHERE " + where.join(" AND ") + " ORDER BY created_at DESC, id DESC LIMIT ?" + binds.length;
  const r = await db.prepare(sql).bind(...binds).all<AlbumAssetRow>();
  return r.results.filter((row) => eligibleRow(row, group, before)).sort(byNewest).slice(0, limit);
}

async function readSceneVersions(db: D1Database): Promise<SceneVersionLike[]> {
  // Bound, not a literal, so the same statement narrows on the unit suite's stand-in.
  const r = await db.prepare("SELECT version, state_json, created_at FROM state_versions WHERE entity = ?1 ORDER BY version").bind("scene").all<SceneVersionLike>();
  return r.results;
}

// One page of the album, newest first. `before` cuts on the asset's created_at (the
// order column) and `nextBefore` is the oldest one on a full page, so the next call
// continues where this one stopped. The messages' created_at and conversation_id are
// read by id in chunks of 90; every scene version is read once.
export async function listAlbum(db: D1Database, opts: AlbumOpts = {}): Promise<AlbumPage> {
  const limit = normLimit(opts.limit);
  const group = normGroup(opts.group);
  const before = normBefore(opts.before);

  const rows = await readAssets(db, group, before, limit);
  if (!rows.length) return { items: [], nextBefore: null };

  const messageIds = Array.from(new Set(rows.map((r) => r.message_id).filter((id): id is string => typeof id === "string" && id.length > 0)));
  const [messages, versions] = await Promise.all([
    rowsIn<MessageStamp>(db, (marks) => `SELECT id, conversation_id, created_at FROM messages WHERE id IN (${marks})`, messageIds),
    readSceneVersions(db),
  ]);
  const stamps = new Map<string, MessageStamp>();
  for (const m of messages) if (m && typeof m.id === "string") stamps.set(m.id, m);

  const items: AlbumItem[] = rows.map((row) => {
    const messageId = row.message_id as string;
    const stamp = stamps.get(messageId) ?? null;
    const at = stamp && typeof stamp.created_at === "string" && stamp.created_at ? stamp.created_at : row.created_at;
    const scene = sceneAt(versions, at);
    return {
      id: row.id,
      messageId,
      conversationId: (stamp && stamp.conversation_id) || row.conversation_id || null,
      at,
      status: row.approval_status === "approved" ? "approved" : "candidate",
      withHim: Number(row.with_him ?? 0) === 1,
      description: albumDescription(row.prompt),
      place: scene.location,
      sceneStatus: scene.status,
      bytes: typeof row.bytes === "number" ? row.bytes : null,
      provider: row.provider ?? null,
      kind: row.role === "video" ? "clip" : "photo",
    };
  });

  const last = rows[rows.length - 1];
  const nextBefore = rows.length >= limit && last ? last.created_at : null;
  return { items, nextBefore };
}
