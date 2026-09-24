// Media she can send that the owner approved (SPEC_V2 section V): the library the owner
// uploads (a clip, a video, an image, up to 25 MB, with a title and a one-line
// description), the prompt section that lists it, and the [media: <title>] marker that
// sends one. The runtime resolves the title case-insensitively; an unknown title strips
// the marker and flags media_unknown. Nothing is ever sent on a schedule.
import { auditStmt, newId, nowIso, sha256Hex } from "./db";
import { ApiHttpError } from "./errors";
import type { Env, MediaRow } from "./types";

export type { MediaRow } from "./types";

export const MEDIA_KINDS = ["clip", "video", "image", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 2000;
export const LIBRARY_PREFIX = "library/";
export const MAX_LIBRARY_ROWS = 500;
export const MEDIA_SECTION_TITLE = "THINGS ON YOUR PHONE YOU COULD SEND";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/flac": "flac",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

// ------------------------------------------------------------------ the marker (pure)

const MEDIA_RE = /\[media:\s*([^\]\n]*)\]/gi;
// What a line may be left with once its marker is gone and still count as empty.
const LEFTOVER_RE = /^[\s.,;:!?)]*$/;

// "[media: title]" anywhere in the text (case-insensitive). Every marker is removed; the
// last one carrying a title wins; an empty title is no title. A line that held only a
// marker (plus stray punctuation) disappears; a line that also carried prose keeps the
// prose. Same shape as the photo and song parsers in markers.ts.
export function parseMediaMarker(text: string): { clean: string; title: string | null } {
  let title: string | null = null;
  const kept: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    let had = false;
    const stripped = line.replace(MEDIA_RE, (_m, inner: string) => {
      had = true;
      const t = inner.trim().slice(0, MAX_TITLE_CHARS);
      if (t) title = t;
      return "";
    });
    if (!had) {
      kept.push(line);
      continue;
    }
    if (LEFTOVER_RE.test(stripped)) continue;
    kept.push(stripped.replace(/[ \t]{2,}/g, " ").trimEnd());
  }
  return { clean: kept.join("\n").trimEnd(), title };
}

// The form two titles are compared in: case folded, quotes and outer punctuation off,
// whitespace collapsed. "Fire Escape, take 2" and "fire escape take 2" are the same item.
export function normalizeTitle(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
}

// ------------------------------------------------------------------ helpers

export function mediaKindOf(mime: string): MediaKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("audio/")) return "clip";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/")) return "image";
  return "other";
}

export function extForMime(mime: string): string {
  return EXT_BY_MIME[(mime || "").split(";")[0]?.trim().toLowerCase() ?? ""] ?? "bin";
}

function isMediaKind(v: unknown): v is MediaKind {
  return typeof v === "string" && (MEDIA_KINDS as readonly string[]).includes(v);
}

function cleanMime(mime: string): string {
  const m = (mime || "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (m.startsWith("audio/") || m.startsWith("video/") || m.startsWith("image/")) return m;
  throw new ApiHttpError(415, "unsupported_media_type", "file must be audio, video or an image");
}

// ------------------------------------------------------------------ rows

export async function listMedia(db: D1Database, status: MediaRow["status"] | "all" = "active", limit = MAX_LIBRARY_ROWS): Promise<MediaRow[]> {
  const n = Math.max(1, Math.min(MAX_LIBRARY_ROWS, Math.trunc(limit) || MAX_LIBRARY_ROWS));
  const r = status === "all"
    ? await db.prepare("SELECT * FROM media_library ORDER BY created_at DESC LIMIT ?1").bind(n).all<MediaRow>()
    : await db.prepare("SELECT * FROM media_library WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2").bind(status, n).all<MediaRow>();
  return r.results;
}

export async function getMedia(db: D1Database, id: string): Promise<MediaRow | null> {
  if (!id || id.length > 80) return null;
  return db.prepare("SELECT * FROM media_library WHERE id = ?1").bind(id).first<MediaRow>();
}

export interface MediaUpload {
  bytes: ArrayBuffer;
  mime: string;
  title: string;
  description?: string | null;
  kind?: MediaKind | null;
}

// Stores the bytes at library/<id>.<ext> and the row in one go; the object is removed
// again when the row cannot be written. The title is what she will call it.
export async function uploadMedia(env: Env, db: D1Database, input: MediaUpload, actor: string): Promise<MediaRow> {
  const title = (input.title ?? "").trim();
  if (!title) throw new ApiHttpError(400, "validation", "title is required");
  if (title.length > MAX_TITLE_CHARS) throw new ApiHttpError(400, "validation", `title exceeds ${MAX_TITLE_CHARS} characters`);
  const description = (input.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION_CHARS) throw new ApiHttpError(400, "validation", `description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  if (input.kind !== undefined && input.kind !== null && !isMediaKind(input.kind)) {
    throw new ApiHttpError(400, "validation", "kind must be one of " + MEDIA_KINDS.join(", "));
  }
  const mime = cleanMime(input.mime);
  const bytes = input.bytes;
  if (!bytes || !bytes.byteLength) throw new ApiHttpError(400, "validation", "file is empty");
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new ApiHttpError(413, "too_large", "file exceeds " + MAX_MEDIA_BYTES + " bytes");

  const id = newId("md");
  const key = LIBRARY_PREFIX + id + "." + extForMime(mime);
  const row: MediaRow = {
    id,
    kind: input.kind ?? mediaKindOf(mime),
    title,
    description: description || null,
    key,
    mime,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    status: "active",
    created_at: nowIso(),
  };
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  try {
    await db.batch([
      db.prepare("INSERT INTO media_library (id, kind, title, description, key, mime, bytes, sha256, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
        .bind(row.id, row.kind, row.title, row.description, row.key, row.mime, row.bytes, row.sha256, row.status, row.created_at),
      auditStmt(db, actor, "media.upload", "media_library", id, null, row),
    ]);
  } catch (e) {
    try {
      await env.MEDIA.delete(key);
    } catch {
      /* the object is orphaned at worst */
    }
    throw e;
  }
  return row;
}

// The bytes go; the row stays (status deleted) so a message that sent it still knows
// what it was. A second delete, or an unknown id, is 404.
export async function deleteMedia(env: Env, db: D1Database, id: string, actor: string): Promise<void> {
  const row = await getMedia(db, id);
  if (!row || row.status === "deleted") throw new ApiHttpError(404, "not_found", "media not found");
  try {
    await env.MEDIA.delete(row.key);
  } catch (e) {
    console.warn("media delete failed", e instanceof Error ? e.name : "error");
  }
  await db.batch([
    db.prepare("UPDATE media_library SET status = 'deleted' WHERE id = ?1").bind(id),
    auditStmt(db, actor, "media.delete", "media_library", id, row, { ...row, status: "deleted" }),
  ]);
}

// Streams one library object (Range honoured) after the owner gate. The streaming code
// lives in images.ts with the other private media; loaded on first use so this module
// stays free of the provider chain for the pure parsers' sake.
export async function serveLibrary(env: Env, db: D1Database, id: string, range: string | null = null): Promise<Response> {
  const images = await import("./images");
  return images.serveLibrary(env, db, id, range);
}

// The item a [media: title] line names: an active row whose title matches after
// normalization (case, quotes, punctuation, whitespace). The newest wins a tie. Null
// when nothing matches; the caller strips the marker and flags media_unknown.
export async function resolveMediaTitle(db: D1Database, title: string): Promise<MediaRow | null> {
  const want = normalizeTitle(title);
  if (!want) return null;
  const rows = await listMedia(db, "active");
  for (const r of rows) if (normalizeTitle(r.title) === want) return r;
  return null;
}

// ------------------------------------------------------------------ the prompt section

// One line per item: the exact title she must use, its kind, and the one-line
// description. Empty library = no section at all (nothing to tempt a filler).
export function mediaSection(rows: MediaRow[]): string {
  const live = (rows ?? []).filter((r) => r && r.status === "active" && typeof r.title === "string" && r.title.trim());
  if (!live.length) return "";
  const lines = live.slice(0, 60).map((r) => {
    const desc = (r.description ?? "").replace(/\s+/g, " ").trim();
    return `- "${r.title.trim()}" (${r.kind})${desc ? ": " + desc.slice(0, 160) : ""}`;
  });
  return (
    MEDIA_SECTION_TITLE + "\n" +
    "Saved on your phone. Send one only when it actually fits the moment, never on a schedule, never to fill silence, by ending your message with one line exactly in this form: [media: the exact title]. At most one per message.\n" +
    lines.join("\n")
  );
}
