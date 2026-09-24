// Nightly backup (SPEC_V2 section N): the full export lands in R2 as
// backups/avelie-<YYYY-MM-DD>.json and the newest 30 are kept. Runs from the 07:00 UTC
// cron in src/index.ts. A second run on the same day overwrites that day's file (one
// object per day, never a pile). Every run leaves one audit row.
import { auditStmt, dayKey } from "./db";
import { exportAll } from "./exportImport";
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
