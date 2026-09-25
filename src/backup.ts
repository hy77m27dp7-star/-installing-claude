// Nightly backup (SPEC_V2 section N): the full export lands in R2 as
// backups/avelie-<YYYY-MM-DD>.json and the newest 30 are kept. Runs from the 07:00 UTC
// cron in src/index.ts. A second run on the same day overwrites that day's file (one
// object per day, never a pile). Every run leaves one audit row.
import { auditStmt, dayKey } from "./db";
import { exportAll, importAll } from "./exportImport";
import { ApiHttpError } from "./errors";
import type { Env } from "./types";

export const BACKUP_PREFIX = "backups/";
export const BACKUP_KEEP = 30;
const LIST_PAGE = 1000;
const ACTOR = "cron";

export function backupKey(now: Date = new Date()): string {
  return BACKUP_PREFIX + "avelie-" + dayKey(now) + ".json";
}

async function listBackupKeys(env: Env): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.MEDIA.list({ prefix: BACKUP_PREFIX, limit: LIST_PAGE, cursor });
    for (const o of page.objects) keys.push(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  // Date-named keys sort chronologically as text.
  return keys.sort();
}

export async function runBackup(env: Env, db: D1Database): Promise<{ key: string; bytes: number; kept: number }> {
  const data = await exportAll(db, env);
  const body = new TextEncoder().encode(JSON.stringify(data));
  const key = backupKey();
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: "application/json" } });

  const keys = await listBackupKeys(env);
  const excess = keys.length > BACKUP_KEEP ? keys.slice(0, keys.length - BACKUP_KEEP) : [];
  if (excess.length) await env.MEDIA.delete(excess);
  const kept = keys.length - excess.length;

  await auditStmt(db, ACTOR, "backup.run", "r2", key, null, { key, bytes: body.byteLength, kept, deleted: excess.length }).run();
  return { key, bytes: body.byteLength, kept };
}

// ------------------------------------------------------------------ named snapshots (v3.2)
// A snapshot is the same export as the nightly backup, taken on demand under its own prefix
// (so the 30-file pruning of backups/ never touches it) and restorable through the same
// import the /api/import route trusts: the story tables are replaced, settings and visual
// assets merge. Made for "try something in another chat, then put her memory back".
export const SNAPSHOT_PREFIX = "snapshots/";

export function snapshotKey(label: string, now: Date = new Date()): string {
  const slug = String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "snapshot";
  const hhmm = now.toISOString().slice(11, 16).replace(":", "");
  return SNAPSHOT_PREFIX + "avelie-" + dayKey(now) + "-" + hhmm + "-" + slug + ".json";
}

export async function runSnapshot(env: Env, db: D1Database, label: string, actor: string): Promise<{ key: string; bytes: number }> {
  const data = await exportAll(db, env);
  const body = new TextEncoder().encode(JSON.stringify(data));
  const key = snapshotKey(label);
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: "application/json" } });
  await auditStmt(db, actor, "snapshot.take", "r2", key, null, { key, bytes: body.byteLength, label }).run();
  return { key, bytes: body.byteLength };
}

export async function listSnapshots(env: Env): Promise<Array<{ key: string; bytes: number; uploaded: string }>> {
  const out: Array<{ key: string; bytes: number; uploaded: string }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.MEDIA.list({ prefix: SNAPSHOT_PREFIX, limit: LIST_PAGE, cursor });
    for (const o of page.objects) out.push({ key: o.key, bytes: o.size, uploaded: o.uploaded.toISOString() });
    if (!page.truncated) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Restore a snapshot or a nightly backup by key. The key must sit under one of the two
// prefixes; anything else is refused before R2 is read.
export async function restoreSnapshot(env: Env, db: D1Database, key: string, actor: string): Promise<Record<string, unknown>> {
  if (typeof key !== "string" || !(key.startsWith(SNAPSHOT_PREFIX) || key.startsWith(BACKUP_PREFIX)) || key.includes("..")) {
    throw new ApiHttpError(400, "validation", "key must name a snapshot or a backup");
  }
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new ApiHttpError(404, "not_found", "no such snapshot");
  let payload: unknown;
  try { payload = JSON.parse(await obj.text()); } catch { throw new ApiHttpError(422, "unreadable", "the snapshot is not valid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiHttpError(422, "unreadable", "the snapshot is not an export");
  const result = await importAll(db, payload as Record<string, unknown>, actor);
  await auditStmt(db, actor, "snapshot.restore", "r2", key, null, { key, bytes: obj.size }).run();
  return result as unknown as Record<string, unknown>;
}
