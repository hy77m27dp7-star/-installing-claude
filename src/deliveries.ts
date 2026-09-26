// Delayed replies and their one notification (SPEC_V4 section 6).
//
// In real mode (replyDelayMode "real") a reply exists the moment she wrote it but lands
// at its deliver_at: minutes later when her day says she is busy, 5 to 90 seconds on the
// free branch (src/life.ts computeDeliverAt; src/chat.ts commitReply stamps every
// real-mode reply). The */20 cron calls pushDueReplies before her first texts: it finds
// the replies that landed since the last tick, and when at least one of them was held two
// minutes or more it sends ONE Web Push for the batch (reason her_delayed_reply). The
// service worker then reads GET /api/push/latest and shows her line.
//
// Two floors keep this from becoming the retention hook the rules forbid:
// - DELAY_PUSH_MIN_MS: a reply held under two minutes (the free branch) never pushes. He
//   was in the thread for it; a buzz twenty minutes later would only pull him back.
// - DUE_WINDOW_MS: a reply due before the window is never pushed either; it sits in the
//   thread and he reads it there.
// - Quiet hours (herFirstQuietHours, her time; the cron passes `quiet`): a reply that lands
//   inside them never buzzes his phone. It sits in the thread for the morning.
// Every row the query finds is stamped pushed_at, pushed or skipped, whatever the push
// result (no keys, no subscription, a failed send, quiet hours), so no reply is ever
// considered twice.
// The instant-mode reply (deliver_at null) never enters the query at all.
import { sendPush } from "./push";
import type { PushSendResult } from "./push";
import type { Env } from "./types";

// The cron is every 20 minutes; a reply due since the last tick is inside the window.
export const DUE_WINDOW_MS = 25 * 60 * 1000;
// A reply counts as delayed only when it was held two minutes or more (deliver_at - created_at).
export const DELAY_PUSH_MIN_MS = 120000;
export const PUSH_REASON_DELAYED = "her_delayed_reply";

// D1 binds at most 100 parameters per statement; the id list plus the stamp stays under it.
const IN_CHUNK = 90;
const QUERY_LIMIT = 50;

export interface DueRow {
  id: string;
  created_at: string;
  deliver_at: string | null;
  pushed_at: string | null;
}

export interface DueSplit {
  // Ids to notify about (one push for all of them) and then stamp.
  push: string[];
  // Ids inside the window that fail the two-minute floor: stamped, never pushed.
  skip: string[];
}

function ms(iso: string | null | undefined): number {
  if (typeof iso !== "string" || !iso) return NaN;
  return Date.parse(iso);
}

// Pure. `push` = rows whose deliver_at is at or before `now` and after `now - DUE_WINDOW_MS`,
// held DELAY_PUSH_MIN_MS or more, with pushed_at null. `skip` = rows in the same window
// with pushed_at null that were held less than the floor. A row not yet due, due before
// the window, already pushed or without a readable deliver_at is in neither list.
export function dueReplies(rows: ReadonlyArray<DueRow>, now: Date): DueSplit {
  const nowMs = now.getTime();
  const floor = nowMs - DUE_WINDOW_MS;
  const push: string[] = [];
  const skip: string[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    if (row.pushed_at !== null && row.pushed_at !== undefined) continue;
    const at = ms(row.deliver_at);
    if (!Number.isFinite(at)) continue;
    if (at > nowMs || at <= floor) continue;
    const created = ms(row.created_at);
    const held = Number.isFinite(created) ? at - created : 0;
    if (held >= DELAY_PUSH_MIN_MS) push.push(row.id);
    else skip.push(row.id);
  }
  return { push, skip };
}

function chunk<T>(list: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function stampStatements(db: D1Database, ids: ReadonlyArray<string>, stamp: string): D1PreparedStatement[] {
  return chunk(ids, IN_CHUNK).map((part) => {
    const marks = part.map((_, i) => "?" + (i + 2)).join(", ");
    return db.prepare("UPDATE messages SET pushed_at = ?1 WHERE id IN (" + marks + ")").bind(stamp, ...part);
  });
}

export interface PushDueResult {
  // Replies that qualified for the notification (0 when nothing was pushed).
  due: number;
  // Whether a push was attempted for the batch (the result says how it went).
  pushed: boolean;
  result: PushSendResult | null;
  // Present (true) when the tick fell inside quiet hours: nothing was sent, the rows stamped.
  quiet?: true;
}

// The cron's half. Reads the due rows, splits them, sends ONE push when any qualifies and
// the tick is outside quiet hours, and stamps every row it saw (push and skip together)
// whatever the push result.
export async function pushDueReplies(env: Env, db: D1Database, now: Date = new Date(), opts: { quiet?: boolean } = {}): Promise<PushDueResult> {
  const nowIso = now.toISOString();
  const floorIso = new Date(now.getTime() - DUE_WINDOW_MS).toISOString();
  const r = await db
    .prepare("SELECT id, created_at, deliver_at, pushed_at FROM messages WHERE role = 'assistant' AND channel = 'story' AND deliver_at IS NOT NULL AND pushed_at IS NULL AND deliver_at <= ?1 AND deliver_at > ?2 LIMIT ?3")
    .bind(nowIso, floorIso, QUERY_LIMIT)
    .all<DueRow>();
  const split = dueReplies(r.results ?? [], now);
  let result: PushSendResult | null = null;
  const quiet = opts.quiet === true;
  if (split.push.length && !quiet) {
    // One notification for the batch, never one per message; sendPush never throws.
    result = await sendPush(env, db, PUSH_REASON_DELAYED, now);
  }
  const stamped = [...split.push, ...split.skip];
  if (stamped.length) {
    try {
      await db.batch(stampStatements(db, stamped, nowIso));
    } catch (e) {
      // The stamp is what keeps the log from repeating; say so and let the next tick retry.
      console.error("deliveries: pushed_at not stamped", e instanceof Error ? e.name : "error", stamped.length);
    }
  }
  if (split.push.length) console.log("deliveries", "due", split.push.length, "skipped", split.skip.length, "push", quiet ? "quiet hours" : result ? (result.skipped ?? "sent " + result.sent) : "-");
  if (quiet && split.push.length) return { due: split.push.length, pushed: false, result: null, quiet: true };
  return { due: split.push.length, pushed: split.push.length > 0, result };
}
