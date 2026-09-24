// Why she said that: one row per assistant message holding the ids the turn was built
// from (prompt version, provider, model, history and fact ids, threads, callbacks,
// unknowns, counts, flags). Ids and counts only: never prompt text, never a secret.

const MAX_JSON = 64 * 1024;

function serialize(messageId: string, ctx: Record<string, unknown>): string {
  if (typeof messageId !== "string" || !messageId) throw new Error("messageId is required");
  const json = JSON.stringify(ctx ?? {});
  if (json.length > MAX_JSON) throw new Error("message context exceeds " + MAX_JSON + " bytes");
  return json;
}

// The insert as a statement, so chat.ts can put it in the turn's own batch. A second
// write for the same message replaces the first (a retried commit, never two contexts).
export function contextStmt(db: D1Database, messageId: string, ctx: Record<string, unknown>): D1PreparedStatement {
  return db
    .prepare("INSERT INTO message_context (message_id, json, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(message_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at")
    .bind(messageId, serialize(messageId, ctx), new Date().toISOString());
}

export async function writeContext(db: D1Database, messageId: string, ctx: Record<string, unknown>): Promise<void> {
  await contextStmt(db, messageId, ctx).run();
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
