// Why she said that: one row per assistant message holding the ids the turn was built
// from (prompt version, provider, model, history and fact ids, threads, callbacks,
// unknowns, counts, flags). Ids and counts only in the JSON: never prompt text, never a
// secret.
//
// v3 (SPEC_V3 section II): the same row may carry `state_text`, the per-turn state
// sections exactly as they were sent (never the prefix, never a secret), so an approved
// exchange can be exported with the memory that shaped it. Capped at 24,000 characters,
// cut at a section boundary. The column exists from migration 0005; the v2 statement
// shape is kept whenever no state text is given.

const MAX_JSON = 64 * 1024;
export const MAX_STATE_TEXT = 24_000;
// The line stateSections puts between sections (prompt.ts); a cut lands on one of these.
const SECTION_BREAK = "\n\n" + "-".repeat(60) + "\n\n";

function serialize(messageId: string, ctx: Record<string, unknown>): string {
  if (typeof messageId !== "string" || !messageId) throw new Error("messageId is required");
  const json = JSON.stringify(ctx ?? {});
  if (json.length > MAX_JSON) throw new Error("message context exceeds " + MAX_JSON + " bytes");
  return json;
}

// The state text as stored: whole sections only, up to the cap. A text under the cap is
// kept as it is; a longer one is cut at the last section break before the cap (or hard at
// the cap when a single section is longer than that).
export function clipStateText(text: string, max = MAX_STATE_TEXT): string {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(SECTION_BREAK, max);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, max);
}

// The insert as a statement, so chat.ts can put it in the turn's own batch. A second
// write for the same message replaces the first (a retried commit, never two contexts).
// With a state text (v3) the row's state_text is written too.
export function contextStmt(db: D1Database, messageId: string, ctx: Record<string, unknown>, stateText: string | null = null): D1PreparedStatement {
  const json = serialize(messageId, ctx);
  const at = new Date().toISOString();
  if (typeof stateText === "string") {
    return db
      .prepare("INSERT INTO message_context (message_id, json, created_at, state_text) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(message_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at, state_text = excluded.state_text")
      .bind(messageId, json, at, clipStateText(stateText));
  }
  return db
    .prepare("INSERT INTO message_context (message_id, json, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(message_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at")
    .bind(messageId, json, at);
}

export async function writeContext(db: D1Database, messageId: string, ctx: Record<string, unknown>, stateText: string | null = null): Promise<void> {
  await contextStmt(db, messageId, ctx, stateText).run();
}

// The stored state text of a reply (v3), or null when the row predates v3 or is missing.
export async function readStateText(db: D1Database, messageId: string): Promise<string | null> {
  if (typeof messageId !== "string" || !messageId) return null;
  const row = await db.prepare("SELECT state_text FROM message_context WHERE message_id = ?1").bind(messageId).first<{ state_text: string | null }>();
  return row && typeof row.state_text === "string" && row.state_text ? row.state_text : null;
}

export async function readContext(db: D1Database, messageId: string): Promise<Record<string, unknown> | null> {
  if (typeof messageId !== "string" || !messageId) return null;
  const row = await db.prepare("SELECT json FROM message_context WHERE message_id = ?1").bind(messageId).first<{ json: string }>();
  if (!row) return null;
  try {
    const v: unknown = JSON.parse(row.json);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
