// The song loop (SPEC_V5 section 9): the artists he already knows or did not like, one row per
// artist (the newest press wins), written by the two buttons on a song card, by the owner, or
// by a promoted known_artist proposal (his own words). A per-turn section, SONGS AND HIM, so
// what she sends him is new to him and hers; a one-time notice for a pick of hers that could
// not be found (v4's spotify_status not_found), stamped on the message when it rode.
//
// Her taste, not his: the list only tells her what he knows; nothing here reads his Spotify.
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";

export type KnownKind = "known" | "disliked";
export type KnownSource = "button" | "proposal" | "owner";

export interface KnownArtistRow {
  id: string;
  artist: string;
  artist_norm: string;
  kind: KnownKind;
  source: KnownSource;
  message_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export const SONGS_HEADER = "SONGS AND HIM (so what you send him is new to him and yours)";

const MAX_ARTIST = 200;
const MAX_NOTE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const MISSING_WINDOW_DAYS = 3;
const DEFAULT_LIMIT = 40;

// ------------------------------------------------------------------ pure

// Lowercased, a leading "the " removed, "&" to "and", everything but letters and digits to one
// space, trimmed: "The National" and "national" are one artist.
export function artistNorm(a: string): string {
  const lower = String(a ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const stripped = lower.replace(/^the\s+/, "");
  const norm = stripped.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (norm) return norm;
  return lower.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function isListedArtist(song: { artist: string } | null, listed: ReadonlySet<string>): boolean {
  if (!song || typeof song.artist !== "string" || !listed || typeof listed.has !== "function") return false;
  const n = artistNorm(song.artist);
  return !!n && listed.has(n);
}

function cleanNames(list: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(list) ? list : []) {
    if (typeof a !== "string") continue;
    const name = a.replace(/\s+/g, " ").trim();
    const n = artistNorm(name);
    if (!name || !n || seen.has(n)) continue;
    seen.add(n);
    out.push(name);
  }
  return out;
}

// The two lists newest first, together at most `limit` artists: each list gets up to half
// (rounded up) and whatever the other leaves goes to the longer one.
function splitLimit(known: string[], disliked: string[], limit: number): { known: string[]; disliked: string[] } {
  if (limit <= 0) return { known: [], disliked: [] };
  const half = Math.ceil(limit / 2);
  let k = Math.min(known.length, half);
  let d = Math.min(disliked.length, half);
  let left = limit - k - d;
  if (left > 0 && known.length > k) { const add = Math.min(left, known.length - k); k += add; left -= add; }
  if (left > 0 && disliked.length > d) { const add = Math.min(left, disliked.length - d); d += add; left -= add; }
  if (k + d > limit) {
    // limit odd and both lists full: the known list gives one back.
    k = limit - d;
  }
  return { known: known.slice(0, k), disliked: disliked.slice(0, d) };
}

export function songsSection(args: { known: string[]; disliked: string[]; missing: { artist: string; title: string } | null; limit: number }): string {
  const limit = typeof args?.limit === "number" && Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : DEFAULT_LIMIT;
  const lists = splitLimit(cleanNames(args?.known), cleanNames(args?.disliked), limit);
  const m = args?.missing;
  const artist = m && typeof m.artist === "string" ? m.artist.replace(/\s+/g, " ").trim() : "";
  const title = m && typeof m.title === "string" ? m.title.replace(/\s+/g, " ").trim() : "";
  const missingLabel = artist && title ? `${artist} - ${title}` : artist || title;
  const lines: string[] = [];
  if (lists.known.length) lines.push(`He already knows: ${lists.known.join(", ")}. Send him something he does not know.`);
  if (lists.disliked.length) lines.push(`He did not like: ${lists.disliked.join(", ")}. Not his; do not send them again.`);
  if (missingLabel) {
    lines.push(`The last song you sent him, ${missingLabel}, is not anywhere you can find it now. If it comes up, you could not find it again; say so once, in your own words, and move on.`);
  }
  if (!lines.length) return "";
  return [SONGS_HEADER, ...lines].join("\n");
}

// ------------------------------------------------------------------ db

function isKind(v: unknown): v is KnownKind {
  return v === "known" || v === "disliked";
}

function isSource(v: unknown): v is KnownSource {
  return v === "button" || v === "proposal" || v === "owner";
}

async function byNorm(db: D1Database, norm: string): Promise<KnownArtistRow | null> {
  return db.prepare("SELECT * FROM known_artists WHERE artist_norm = ?1").bind(norm).first<KnownArtistRow>();
}

export async function setKnownArtist(
  db: D1Database,
  input: { artist: string; kind: KnownKind; source: "button" | "proposal" | "owner"; messageId?: string | null; note?: string | null },
  actor: string,
): Promise<KnownArtistRow> {
  if (!input || typeof input !== "object") throw new ApiHttpError(400, "validation", "body must be an object");
  const artist = typeof input.artist === "string" ? input.artist.replace(/\s+/g, " ").trim() : "";
  if (!artist) throw new ApiHttpError(400, "validation", "artist is required");
  if (artist.length > MAX_ARTIST) throw new ApiHttpError(400, "validation", `artist exceeds ${MAX_ARTIST} characters`);
  if (!isKind(input.kind)) throw new ApiHttpError(400, "validation", "kind must be known or disliked");
  if (!isSource(input.source)) throw new ApiHttpError(400, "validation", "source must be button, proposal or owner");
  const norm = artistNorm(artist);
  if (!norm) throw new ApiHttpError(400, "validation", "artist needs a letter or a digit");
  let messageId: string | null = null;
  if (input.messageId !== undefined && input.messageId !== null) {
    if (typeof input.messageId !== "string") throw new ApiHttpError(400, "validation", "messageId must be a string");
    messageId = input.messageId.trim() || null;
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string") throw new ApiHttpError(400, "validation", "note must be a string");
    note = input.note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE) || null;
  }
  const before = await byNorm(db, norm);
  const t = nowIso();
  const after: KnownArtistRow = before
    ? { ...before, kind: input.kind, source: input.source, message_id: messageId, note, updated_at: t }
    : { id: newId("ka"), artist, artist_norm: norm, kind: input.kind, source: input.source, message_id: messageId, note, created_at: t, updated_at: t };
  await db.batch([
    db.prepare(
      "INSERT INTO known_artists (id, artist, artist_norm, kind, source, message_id, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) ON CONFLICT(artist_norm) DO UPDATE SET kind = excluded.kind, source = excluded.source, message_id = excluded.message_id, note = excluded.note, updated_at = excluded.updated_at",
    ).bind(after.id, artist, norm, input.kind, input.source, messageId, note, t),
    auditStmt(db, actor, "artist.set", "known_artist", after.id, before, after),
  ]);
  // A press racing another on the same artist: the row that stands is the truth.
  const stored = await byNorm(db, norm).catch(() => null);
  return stored ?? after;
}

function readSongArtist(json: unknown): { artist: string; title: string } | null {
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

// A press of "know it" or "not for me" on a song card: the artist of that message's song.
export async function songFeedback(db: D1Database, messageId: string, kind: KnownKind, actor: string): Promise<KnownArtistRow> {
  if (typeof messageId !== "string" || !messageId.trim()) throw new ApiHttpError(400, "validation", "message id is required");
  if (!isKind(kind)) throw new ApiHttpError(400, "validation", "kind must be known or disliked");
  const row = await db.prepare("SELECT id, song_json FROM messages WHERE id = ?1").bind(messageId.trim()).first<{ id: string; song_json: string | null }>();
  if (!row) throw new ApiHttpError(404, "not_found", "message not found");
  const song = readSongArtist(row.song_json);
  if (!song || !song.artist) throw new ApiHttpError(400, "validation", "no song on this message");
  return setKnownArtist(db, { artist: song.artist, kind, source: "button", messageId: row.id }, actor);
}

export async function listKnownArtists(db: D1Database, kind?: KnownKind, limit = 200): Promise<KnownArtistRow[]> {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(1000, Math.floor(limit)) : 200;
  if (kind !== undefined) {
    if (!isKind(kind)) throw new ApiHttpError(400, "validation", "kind must be known or disliked");
    const r = await db.prepare("SELECT * FROM known_artists WHERE kind = ?1 ORDER BY updated_at DESC, created_at DESC, id LIMIT ?2").bind(kind, n).all<KnownArtistRow>();
    return r.results ?? [];
  }
  const r = await db.prepare("SELECT * FROM known_artists ORDER BY updated_at DESC, created_at DESC, id LIMIT ?1").bind(n).all<KnownArtistRow>();
  return r.results ?? [];
}

// His list, his to prune: the row is deleted, and the audit keeps it.
export async function removeKnownArtist(db: D1Database, id: string, actor: string): Promise<void> {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "artist id is required");
  const row = await db.prepare("SELECT * FROM known_artists WHERE id = ?1").bind(id.trim()).first<KnownArtistRow>();
  if (!row) throw new ApiHttpError(404, "not_found", "artist not found");
  await db.batch([
    db.prepare("DELETE FROM known_artists WHERE id = ?1").bind(row.id),
    auditStmt(db, actor, "artist.remove", "known_artist", row.id, row, null),
  ]);
}

// The newest pick of hers that could not be found (spotify_status not_found), not yet told,
// within the last three days. A read that fails (a database behind 0009) answers null.
export async function missingSongNotice(db: D1Database, now: Date): Promise<{ messageId: string; artist: string; title: string } | null> {
  try {
    const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    const since = new Date(at.getTime() - MISSING_WINDOW_DAYS * DAY_MS).toISOString();
    const r = await db.prepare(
      "SELECT id, song_json FROM messages WHERE role = 'assistant' AND channel = 'story' AND spotify_status = 'not_found' AND song_told_at IS NULL AND created_at >= ?1 AND (deliver_at IS NULL OR deliver_at <= ?2) ORDER BY created_at DESC LIMIT 5",
    ).bind(since, at.toISOString()).all<{ id: string; song_json: string | null }>();
    for (const row of r.results ?? []) {
      const song = readSongArtist(row.song_json);
      if (song) return { messageId: row.id, artist: song.artist, title: song.title };
    }
    return null;
  } catch {
    return null;
  }
}

export function songToldStmt(db: D1Database, messageId: string, at: string): D1PreparedStatement {
  return db.prepare("UPDATE messages SET song_told_at = ?2 WHERE id = ?1 AND song_told_at IS NULL").bind(messageId, at);
}
