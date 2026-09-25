// She texts first (SPEC_V2 section R): opt-in, capped, and never a hook.
//
// A 20-minute cron (and POST /api/herfirst/run by hand) asks maybeTextFirst whether this is
// a moment she would text him on her own. The answer is a table of reasons not to (off,
// quiet hours, her day has her busy, the day's cap, a message in the last 45 minutes, two
// of hers already unanswered, his last message unanswered) and then one chance: a per-tick
// probability tuned so the expected count over her remaining waking ticks today equals what
// is left of the cap, decided by a seed so a tick answers the same way twice. When it says
// send, one opener turn runs through the normal pipeline with a one-time note; a first text
// whose checks raise dependency_hook is deleted, logged and not retried in that tick.
//
// None of this is a retention hook: there is no "miss you", no streak, nothing sadder for
// the app being closed. The note forbids exactly those lines; the checks catch the rest.
import { runTurn } from "./chat";
import { auditStmt, createConversation, listConversations } from "./db";
import { ApiHttpError } from "./errors";
import { listThreads, localParts, safeTimezone, seededUnit, whereSheIs } from "./life";
import { providerConfigured } from "./providers/index";
import { sendPush } from "./push";
import type { PushSendResult } from "./push";
import type { Env, MessageRow, Settings, TurnResponse } from "./types";

export interface FirstTextArgs {
  enabled: boolean;
  cap: number;
  countToday: number;
  now: Date;
  tz: string;
  // "HH:MM-HH:MM" in her timezone; may wrap midnight ("23:30-08:30").
  quietHours: string;
  busy: boolean;
  lastMessageAt: Date | null;
  lastTwoAreHers: boolean;
  seed: string;
}

export interface FirstTextDecision {
  send: boolean;
  reason: string;
}

export interface FirstTextRun {
  sent: boolean;
  reason: string;
  day: string;
  countToday: number;
  conversationId: string | null;
  message?: MessageRow;
  // The id of a first text that was dropped for a dependency_hook flag.
  droppedMessageId?: string;
  push?: PushSendResult;
}

const TICK_MINUTES = 20;
const MINUTES_PER_DAY = 24 * 60;
const RECENT_MINUTES = 45;
const CAP_MAX = 10;
const DEFAULT_QUIET = "23:30-08:30";
const QUIET_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;
const ACTOR = "herfirst";
const PUSH_REASON = "her_first_text";
// A first text that still carries one of these after the retry is not hers to send: a
// dependency line ("miss you", "waiting for you", ...) or an open ask leading the text
// (SPEC_V3 section CC: a push-notified first text never opens with what he did not answer).
export const HARD_REJECT_CODES: ReadonlySet<string> = new Set(["dependency_hook", "ask_nag"]);

// The one-time note for a first text (SPEC_V2 section R). He never sees it.
export const FIRST_TEXT_NOTE =
  "Send him something from your own day or something you remember, the way a person texts first. One or two bubbles. "
  + "Never mention how long it has been, never say you missed him or waited, never ask him to reply, never make it about him being gone.";

// ------------------------------------------------------------------ quiet hours (pure)

interface QuietWindow {
  start: number;
  end: number;
}

function hhmm(h: string, m: string): number | null {
  const hour = Number(h);
  const minute = Number(m);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

// "HH:MM-HH:MM" as minutes of the day; a malformed setting falls back to the default window.
// A start equal to its end is no window at all.
export function parseQuietHours(s: string): QuietWindow | null {
  const m = QUIET_RE.exec(typeof s === "string" ? s.trim() : "");
  const parsed = m ? { start: hhmm(m[1] ?? "", m[2] ?? ""), end: hhmm(m[3] ?? "", m[4] ?? "") } : null;
  if (!parsed || parsed.start === null || parsed.end === null) {
    return s === DEFAULT_QUIET ? null : parseQuietHours(DEFAULT_QUIET);
  }
  if (parsed.start === parsed.end) return null;
  return { start: parsed.start, end: parsed.end };
}

export function inQuietHours(minuteOfDay: number, q: QuietWindow | null): boolean {
  if (!q) return false;
  const t = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (q.start < q.end) return t >= q.start && t < q.end;
  // Wraps midnight: quiet from start until the end of the day, and from midnight until end.
  return t >= q.start || t < q.end;
}

// The 20-minute ticks from this minute to the end of her local day that fall outside the
// quiet window; this tick counts when it is awake. At least 1 so a division never blows up.
export function wakingTicksLeft(minuteOfDay: number, q: QuietWindow | null): number {
  let n = 0;
  for (let t = minuteOfDay; t < MINUTES_PER_DAY; t += TICK_MINUTES) if (!inQuietHours(t, q)) n++;
  return Math.max(1, n);
}

function clampCap(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
  return Math.min(CAP_MAX, Math.max(0, n));
}

function countOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

// ------------------------------------------------------------------ the decision (pure)

// The reasons not to, in order; null when every gate is open and only the window is left.
export function gateReason(args: FirstTextArgs): string | null {
  const cap = clampCap(args.cap);
  if (!args.enabled || cap <= 0) return "off: her first texts are disabled (cap 0)";

  const tz = safeTimezone(args.tz);
  const p = localParts(args.now, tz);
  const minute = p.hour * 60 + p.minute;
  if (inQuietHours(minute, parseQuietHours(args.quietHours))) return `quiet hours (${args.quietHours || DEFAULT_QUIET}, her time)`;

  if (args.busy) return "busy: her day has her somewhere else right now";

  const count = countOf(args.countToday);
  if (count >= cap) return `cap reached: ${count} of ${cap} today`;

  if (args.lastMessageAt instanceof Date && Number.isFinite(args.lastMessageAt.getTime())) {
    const ageMin = (args.now.getTime() - args.lastMessageAt.getTime()) / 60000;
    if (ageMin < RECENT_MINUTES) return `recent: the last message is ${Math.max(0, Math.floor(ageMin))} minutes old`;
  }

  if (args.lastTwoAreHers) return "two of hers are already unanswered; she never stacks a third";
  return null;
}

// The gates, then the window: probability = what is left of the cap over the waking ticks
// left today (1 when the ticks cannot carry the count), rolled with the seed.
export function decideFirstText(args: FirstTextArgs): FirstTextDecision {
  const gate = gateReason(args);
  if (gate !== null) return { send: false, reason: gate };

  const cap = clampCap(args.cap);
  const remaining = cap - countOf(args.countToday);
  const p = localParts(args.now, safeTimezone(args.tz));
  const ticks = wakingTicksLeft(p.hour * 60 + p.minute, parseQuietHours(args.quietHours));
  const probability = Math.min(1, remaining / ticks);
  const roll = seededUnit(typeof args.seed === "string" ? args.seed : "");
  const detail = `${remaining} to go, ${ticks} waking tick${ticks === 1 ? "" : "s"} left today, p=${probability.toFixed(2)}`;
  if (roll < probability) return { send: true, reason: `send: ${detail}` };
  return { send: false, reason: `not this tick: ${detail}` };
}

// ------------------------------------------------------------------ the runner

interface LastMessages {
  lastMessageAt: Date | null;
  lastTwoAreHers: boolean;
  hisTurn: boolean;
}

// Her local calendar day, the key of first_texts_daily.
export function localDayKey(now: Date, tz: string): string {
  const p = localParts(now, safeTimezone(tz));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

async function countFor(db: D1Database, day: string): Promise<number> {
  const r = await db.prepare("SELECT count FROM first_texts_daily WHERE day = ?1").bind(day).first<{ count: number }>();
  return r && typeof r.count === "number" ? r.count : 0;
}

async function lastMessages(db: D1Database, conversationId: string): Promise<LastMessages> {
  const r = await db
    .prepare("SELECT role, created_at FROM messages WHERE conversation_id = ?1 AND channel = 'story' ORDER BY seq DESC LIMIT 2")
    .bind(conversationId)
    .all<{ role: string; created_at: string }>();
  const rows = r.results;
  const newest = rows[0];
  const at = newest ? Date.parse(newest.created_at) : NaN;
  return {
    lastMessageAt: Number.isFinite(at) ? new Date(at) : null,
    lastTwoAreHers: rows.length >= 2 && rows.every((m) => m.role === "assistant"),
    hisTurn: newest !== undefined && newest.role === "user",
  };
}

// The newest active conversation, or a fresh one named after her local day.
async function pickConversation(db: D1Database, day: string): Promise<{ id: string; created: boolean }> {
  const active = (await listConversations(db)).filter((c) => c.status === "active");
  const first = active[0];
  if (first) return { id: first.id, created: false };
  const row = await createConversation(db, day);
  await auditStmt(db, ACTOR, "conversation.create", "conversation", row.id, null, row).run();
  return { id: row.id, created: true };
}

// runTurn wants an ExecutionContext for its after-response work (the proposal pass, a voice
// note). Neither caller has one to give, so the work is collected and awaited here.
function collectingContext(): { ctx: ExecutionContext; settle: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>): void { tasks.push(p); },
    passThroughOnException(): void { /* nothing to pass through */ },
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: async () => { await Promise.allSettled(tasks); } };
}

function errorClass(e: unknown): string {
  if (e instanceof Error) return e.name || "Error";
  return "error";
}

// A first text that the checks caught with a dependency line is not hers to send: the row
// and its provenance go, the spend stays recorded, the audit says why.
async function dropFirstText(db: D1Database, message: MessageRow, flags: string[]): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM message_context WHERE message_id = ?1").bind(message.id),
    db.prepare("DELETE FROM messages WHERE id = ?1").bind(message.id),
    auditStmt(db, ACTOR, "herfirst.dropped", "message", message.id, { conversationId: message.conversation_id, flags }, null),
  ]);
}

// One tick. Reads her settings, her day and the newest conversation, decides, and when the
// decision is send runs the opener turn, counts it, audits it and pushes. Returns what
// happened and why in plain words (the Model page shows the reason).
export async function maybeTextFirst(env: Env, db: D1Database, settings: Settings, now: Date = new Date()): Promise<FirstTextRun> {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const tz = safeTimezone(settings.timezone);
  const day = localDayKey(at, tz);
  const cap = clampCap(settings.herFirstTextsPerDay);
  const base: FirstTextRun = { sent: false, reason: "", day, countToday: 0, conversationId: null };

  // The gates that need nothing but the settings and the day's count come first, so an
  // off, quiet or capped tick reads one row and never opens a conversation.
  const neutral: FirstTextArgs = {
    enabled: cap > 0, cap, countToday: 0, now: at, tz, quietHours: settings.herFirstQuietHours,
    busy: false, lastMessageAt: null, lastTwoAreHers: false, seed: "",
  };
  const off = gateReason(neutral);
  if (off !== null) return { ...base, reason: off };

  const countToday = await countFor(db, day);
  base.countToday = countToday;
  const capped = gateReason({ ...neutral, countToday });
  if (capped !== null) return { ...base, reason: capped };

  if (!providerConfigured(env, settings.provider)) return { ...base, reason: `provider not configured: ${settings.provider}` };

  const threads = await listThreads(db, "active");
  const where = whereSheIs(threads, at, tz);

  const conv = await pickConversation(db, day);
  base.conversationId = conv.id;
  const last = conv.created ? { lastMessageAt: null, lastTwoAreHers: false, hisTurn: false } : await lastMessages(db, conv.id);
  if (last.hisTurn) return { ...base, reason: "his last message has no reply yet; that is a reply, not a first text" };

  const seed = `${at.toISOString().slice(0, 16)}:${conv.id}`;
  const decision = decideFirstText({
    enabled: true,
    cap,
    countToday,
    now: at,
    tz,
    quietHours: settings.herFirstQuietHours,
    busy: where.busy,
    lastMessageAt: last.lastMessageAt,
    lastTwoAreHers: last.lastTwoAreHers,
    seed,
  });
  if (!decision.send) return { ...base, reason: decision.reason };

  // The opener turn: the normal pipeline, no message of his, the one-time note.
  const { ctx, settle } = collectingContext();
  let turn: TurnResponse;
  try {
    turn = await runTurn(env, ctx, db, settings, conv.id, "", "", ACTOR, { openerNote: FIRST_TEXT_NOTE });
  } catch (e) {
    if (e instanceof ApiHttpError) {
      console.warn("herfirst: turn failed", e.code, e.detail ?? "");
      return { ...base, reason: `turn failed: ${e.code}` };
    }
    throw e;
  }
  const message = turn.assistantMessage;
  const flags = turn.flags.map((f) => f.code);

  const rejected = flags.find((code) => HARD_REJECT_CODES.has(code));
  if (rejected) {
    try {
      await dropFirstText(db, message, flags);
    } catch (e) {
      console.error("herfirst: dropped first text not removed", errorClass(e));
    }
    await settle();
    console.warn("herfirst: first text dropped", rejected, message.id);
    return { ...base, reason: `dropped: the checks raised ${rejected}; not retried this tick`, droppedMessageId: message.id };
  }

  const countAfter = countToday + 1;
  try {
    await db.batch([
      db.prepare("INSERT INTO first_texts_daily (day, count) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1").bind(day),
      auditStmt(db, ACTOR, "herfirst.sent", "message", message.id, null, {
        conversationId: conv.id, day, countToday: countAfter, flags, seed, reason: decision.reason,
      }),
    ]);
  } catch (e) {
    // The message stands; the count is the thing that slipped. Say so in the log.
    console.error("herfirst: count not recorded", errorClass(e));
  }

  const push = await sendPush(env, db, PUSH_REASON, at);
  await settle();
  return { ...base, sent: true, reason: decision.reason, countToday: countAfter, message, push };
}
