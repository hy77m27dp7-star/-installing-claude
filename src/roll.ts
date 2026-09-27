// Her camera roll (the experience pass, DESIGN_EXPERIENCE section 8.1): every picture and
// clip of hers that is APPROVED, bound to a message or not. The album (src/album.ts) keeps
// its own shape and rule (message-bound rows only, candidates too); the roll is what the Her
// pages show: the Album's months, the phone's Photos app and its lock-screen strip.
//
// Read-only. Never a master, him, portrait, call-face, archive, blacklisted or missing row;
// never a candidate, rejected, pending, generating or failed one; never the R2 key.
import { ApiHttpError } from "./errors";
import { sceneAt } from "./album";
import type { SceneVersionLike } from "./album";

export interface RollItem {
  id: string;
  kind: "photo" | "clip";
  url: string;
  poster: string | null;
  at: string;
  place: string | null;
  us: boolean;
  conversationId: string | null;
  messageId: string | null;
}

export interface RollPage {
  items: RollItem[];
  nextBefore: string | null;
}

export const ROLL_ROLES: readonly string[] = ["scene", "candidate", "video"];
export const ROLL_LIMIT_DEFAULT = 60;
export const ROLL_LIMIT_MAX = 200;
// D1 binds at most 100 parameters per statement; every IN list rides in chunks of 90.
const CHUNK = 90;
const SOURCE_PREFIX = "source:";

interface RollAssetRow {
  id: string;
  role: string;
  approval_status: string;
  conversation_id: string | null;
  message_id: string | null;
  notes: string | null;
  created_at: string;
  with_him?: number | null;
}

interface MessageStamp {
  id: string;
  conversation_id: string | null;
  created_at: string;
}

// ------------------------------------------------------------------ pure

export function rollEligible(row: { role: string; approval_status: string }): boolean {
  return !!row && ROLL_ROLES.includes(row.role) && row.approval_status === "approved";
}

// The picture a clip was made from, as chat.js clipSourceOf reads it: the part of `notes`
// before the first "|", when it starts with "source:", trimmed after the prefix.
export function clipSourceOf(notes: string | null): string | null {
  if (typeof notes !== "string" || !notes.startsWith(SOURCE_PREFIX)) return null;
  const head = notes.split("|")[0] ?? "";
  const id = head.slice(SOURCE_PREFIX.length).trim();
  return id ? id : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function normLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return ROLL_LIMIT_DEFAULT;
  return Math.min(ROLL_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

// Any time Date.parse reads, normalised to the ISO form created_at is stored in.
function normBefore(before: string | undefined): string | null {
  if (before === undefined || before === null || before === "") return null;
  const t = typeof before === "string" ? parseTime(before) : null;
  if (t === null) throw new ApiHttpError(400, "validation", "before must be an ISO time");
  return new Date(t).toISOString();
}

function byNewest(a: RollAssetRow, b: RollAssetRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function media(id: string): string {
  return "/media/" + encodeURIComponent(id);
}

// ------------------------------------------------------------------ D1

// The SQL filter and, again in memory, the same rule (the unit suite's stand-in evaluates
// only "column = ?N" binds). `at`: only the rows created at exactly that time.
async function readRows(db: D1Database, before: string | null, limit: number, at?: string): Promise<RollAssetRow[]> {
  const where: string[] = ["role IN ('scene', 'candidate', 'video')", "approval_status = ?1"];
  const binds: Array<string | number> = ["approved"];
  if (before !== null) {
    binds.push(before);
    where.push("created_at < ?" + binds.length);
  }
  if (at !== undefined) {
    binds.push(at);
    where.push("created_at = ?" + binds.length);
  }
  binds.push(limit);
  const sql = "SELECT * FROM visual_assets WHERE " + where.join(" AND ") + " ORDER BY created_at DESC, id DESC LIMIT ?" + binds.length;
  const r = await db.prepare(sql).bind(...binds).all<RollAssetRow>();
  return (r.results ?? [])
    .filter((row) => row && typeof row.id === "string" && typeof row.created_at === "string")
    .filter((row) => rollEligible(row))
    .filter((row) => before === null || row.created_at < before)
    .filter((row) => at === undefined || row.created_at === at)
    .sort(byNewest)
    .slice(0, limit);
}

async function stampsFor(db: D1Database, ids: string[]): Promise<Map<string, MessageStamp>> {
  const out = new Map<string, MessageStamp>();
  const unique = Array.from(new Set(ids.filter((x) => typeof x === "string" && x)));
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const marks = part.map((_, k) => "?" + (k + 1)).join(", ");
    const r = await db.prepare(`SELECT id, conversation_id, created_at FROM messages WHERE id IN (${marks})`).bind(...part).all<MessageStamp>();
    for (const m of r.results ?? []) if (m && typeof m.id === "string" && part.includes(m.id)) out.set(m.id, m);
  }
  return out;
}

async function sceneVersions(db: D1Database): Promise<SceneVersionLike[]> {
  try {
    const r = await db.prepare("SELECT version, state_json, created_at FROM state_versions WHERE entity = ?1 ORDER BY version").bind("scene").all<SceneVersionLike>();
    return r.results ?? [];
  } catch {
    return [];
  }
}

// One page of her roll, newest first by created_at, id. `before` cuts on the asset's
// created_at; a tie at the page edge joins the page (listAlbum's rule), and `nextBefore` is
// the oldest row's created_at on a full page, else null.
export async function listRoll(db: D1Database, opts: { limit?: number; before?: string } = {}): Promise<RollPage> {
  const limit = normLimit(opts.limit);
  const before = normBefore(opts.before);

  const ahead = await readRows(db, before, limit + 1);
  let rows = ahead.slice(0, limit);
  const edge = rows[rows.length - 1];
  const past = ahead[limit];
  const more = ahead.length > limit;
  if (more && edge && past && past.created_at === edge.created_at) {
    const tie = await readRows(db, before, ROLL_LIMIT_MAX, edge.created_at);
    rows = rows.filter((r) => r.created_at !== edge.created_at).concat(tie).sort(byNewest);
  }
  if (!rows.length) return { items: [], nextBefore: null };

  const bound = rows.map((r) => r.message_id).filter((id): id is string => typeof id === "string" && id.length > 0);
  let stamps = new Map<string, MessageStamp>();
  try {
    stamps = await stampsFor(db, bound);
  } catch {
    stamps = new Map();
  }
  const versions = bound.length ? await sceneVersions(db) : [];

  const items: RollItem[] = rows.map((row) => {
    const messageId = typeof row.message_id === "string" && row.message_id ? row.message_id : null;
    const stamp = messageId ? stamps.get(messageId) ?? null : null;
    const at = stamp && typeof stamp.created_at === "string" && stamp.created_at ? stamp.created_at : row.created_at;
    const clip = row.role === "video";
    const source = clip ? clipSourceOf(row.notes ?? null) : null;
    return {
      id: row.id,
      kind: clip ? "clip" : "photo",
      url: media(row.id),
      poster: source ? media(source) : null,
      at,
      place: messageId ? sceneAt(versions, at).location : null,
      us: Number(row.with_him ?? 0) === 1,
      conversationId: (stamp && stamp.conversation_id) || row.conversation_id || null,
      messageId,
    };
  });

  const last = rows[rows.length - 1];
  return { items, nextBefore: more && last ? last.created_at : null };
}
