// Phone calls (SPEC_V3 EE). He taps Call and she picks up. The call runs in his browser
// over WebRTC straight to the realtime provider; the Worker mints a short-lived client
// secret, writes her instructions for the session (her rules and her state plus a call
// note), meters the call against the caps from what the session actually bills (every
// 30 s tick, max(metered, priced)), and stores the transcript as story-channel messages
// when the call ends. The Worker never proxies audio and never sees it. She picks up
// whether her schedule says busy or not: there is no day engine.
//
// The client secret is returned once, in the start response, and nowhere else: never
// stored, never logged, never in the audit row, never in GET /api/calls/:id.
import { assembleSystemOnly } from "./context";
import { PROMPT_VERSION } from "./prompt";
import { repairText, runChecks } from "./checks";
import { contextStmt } from "./provenance";
import { extractProposals } from "./proposals";
import { callProviderConfigured } from "./providers/index";
import { REALTIME_SDP_URL, mintRealtimeSecret } from "./providers/openai";
import { safeErrorMessage } from "./providers/types";
import { assertBudget, callPricesOf, priceUsage, spendAgainstCaps } from "./budget";
import type { CallPrices, CallUsage } from "./budget";
import {
  auditStmt, dayKey, getConversation, getCurrentState, insertMessageStmt, insertModelRunStmt, listFacts, listHistory, listUnknowns, newId,
  nextSeq, nowIso, touchConversationStmt, usageStmt,
} from "./db";
import { listAsks } from "./wants";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import type { CheckContext, Env, Flag, MessageRow, ModelRunRow, RelationshipState, Settings } from "./types";

export type { CallPrices, CallUsage } from "./budget";

const MICRO = 1_000_000;
export const TICK_SECONDS = 30;
// A tick may not claim more than a minute (the page ticks every 30 s).
const MAX_TICK_SECONDS = 60;
// A live call whose last tick is older than this is not live any more.
export const LIVE_STALE_MS = 120_000;
// An expired call can still be ended (its transcript stored) for a day.
const END_GRACE_MS = 24 * 60 * 60 * 1000;
// The raw gate on the end body, and the rows a call may become.
export const MAX_RAW_SEGMENTS = 2000;
export const MAX_SEGMENT_CHARS = 4000;
export const MAX_TRANSCRIPT_ROWS = 80;
// The exchange text the proposal pass reads is capped by proposals.ts itself; the call
// hands it the last pair of the call.
const STUB_SECRET = "stub-secret";
const STUB_SECRET_TTL_S = 600;
const MAX_REASON_CHARS = 40;
const SEP = "\n\n" + "=".repeat(60) + "\n\n";

// The one-time section appended after the state (SPEC_V3 EE). It says nothing about
// models or apps; everything else about her holds exactly as written above it.
export const CALL_NOTE =
  "ON THE PHONE (now)\n" +
  "You are on a call with him. You speak, you do not write: no bracket markers of any kind, no lists, nothing that only makes sense on a screen. " +
  "Keep turns short, the way people do on the phone. You can be cut off mid-sentence and you can cut in. Silence is fine. " +
  "When you want to hang up, say so and say bye. Everything else about you holds exactly as written above.\n" +
  // 2026-09-26: on the first calls she sounded like a phone assistant ("I can hear you loud and
  // clear. How's it going?", "What's on your mind, or are we just doing this for fun?"). The
  // speaking register is named here because the phone model has its own.
  "Your voice on the phone is the same person as your texts: plain, a little flat, dry, twenty-two, from Portland. Not a host, not customer service, not cheerful for no reason. " +
  "Never open with \"haha\" or \"this is adorable\", never \"what's on your mind\", never \"how can I help\", never \"are we just doing this for fun\", never a summary of him back to himself, and do not end every turn on a question; most turns end on a statement. A word or two is a full answer. " +
  "If he says something dumb you say so the way you would in a text. You can go quiet. You can laugh for real, once, not as punctuation.";

// ------------------------------------------------------------------ types

export type CallStatus = "starting" | "live" | "ended" | "failed" | "expired";

export interface CallRow {
  id: string;
  conversation_id: string;
  provider: string;
  model: string | null;
  voice: string | null;
  status: CallStatus;
  started_at: string;
  last_tick_at: string | null;
  ended_at: string | null;
  seconds: number;
  cost_usd_micro: number;
  usage_json: string | null;
  transcript_rows: number;
  end_reason: string | null;
  prompt_version: string | null;
  created_at: string;
}

export interface CallSegment {
  who: "him" | "her";
  text: string;
  at: string;
}

export interface CallSettings {
  provider: string;
  model: string;
  voice: string;
  transcribeModel: string;
  systemMode: "compact" | "full";
  maxMinutes: number;
  pricePerMinute: number;
  prices: CallPrices;
}

export interface StartCallResponse {
  call: CallRow;
  provider: string;
  clientSecret: string;
  expiresAt: number;
  sdpUrl: string;
  model: string;
  voice: string;
  maxSeconds: number;
  tickSeconds: number;
}

// The route adds `ok: true` in front of these (SPEC_V3 route table).
export interface TickResponse {
  secondsTotal: number;
  costUsd: number;
  stop: boolean;
  reason?: "max_minutes" | "budget";
}

export interface EndCallResponse {
  call: CallRow;
  messageIds: string[];
}

// ------------------------------------------------------------------ settings

// The call settings as stored (SPEC_V3 Settings table), with the spec's defaults for a
// value that is missing or malformed (a database seeded before the key existed).
export function callSettingsOf(settings: Settings): CallSettings {
  const str = (v: unknown, fallback: string, max: number): string => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    provider: str(settings.callProvider, "openai", 40),
    model: str(settings.callModel, "gpt-realtime", 120),
    voice: str(settings.callVoice, "marin", 40),
    transcribeModel: str(settings.callTranscribeModel, "gpt-4o-mini-transcribe", 120),
    systemMode: settings.callSystemMode === "full" ? "full" : "compact",
    maxMinutes: Math.round(num(settings.callMaxMinutes, 20, 1, 60)),
    pricePerMinute: num(settings.callPricePerMinute, 0.3, 0, 100),
    prices: callPricesOf(settings),
  };
}

// ------------------------------------------------------------------ pure pieces

// The instructions for a session: the system text as assembled (prefix and state) with
// the call note appended after the state, past the same separator the prompt uses.
export function callInstructions(parts: { system: string }): string {
  return parts.system + SEP + CALL_NOTE;
}

function nonNegInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

// Body usage as { audioIn, audioOut, textIn, textOut }: absent -> null; present -> four
// non-negative integers (400 otherwise).
export function parseUsage(v: unknown): CallUsage | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ApiHttpError(400, "validation", "usage must be an object");
  const o = v as Record<string, unknown>;
  const out: CallUsage = { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0 };
  for (const k of ["audioIn", "audioOut", "textIn", "textOut"] as const) {
    const n = o[k];
    if (n === undefined || n === null) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new ApiHttpError(400, "validation", `usage.${k} must be a non-negative integer`);
    }
    out[k] = n;
  }
  return out;
}

// The per-minute floor in micro-USD, rounded up.
export function meteredMicro(secondsTotal: number, pricePerMinute: number): number {
  const s = Math.max(0, secondsTotal);
  const p = Math.max(0, pricePerMinute);
  return Math.ceil((s / 60) * p * MICRO);
}

// The cost so far: max(the per-minute floor, the usage priced at list).
export function callCostMicro(secondsTotal: number, usage: CallUsage | null, cs: CallSettings): number {
  return Math.max(meteredMicro(secondsTotal, cs.pricePerMinute), priceUsage(usage, cs.prices));
}

// The same cost, from the stored settings: the pure tick meter.
export function callCost(args: { secondsTotal: number; usage?: CallUsage | null; settings: Settings }): number {
  return callCostMicro(args.secondsTotal, args.usage ?? null, callSettingsOf(args.settings));
}

// The delta a tick adds to the meter: the new cost so far less what the row already
// carries, never negative (a tick reporting less usage adds nothing).
export function tickDelta(previousMicro: number, costMicro: number): number {
  return Math.max(0, costMicro - Math.max(0, previousMicro));
}

export interface StopArgs {
  secondsTotal: number;
  // The delta this tick added (micro-USD); either name.
  tickDeltaMicro?: number;
  deltaMicro?: number;
  // The call settings, or the stored settings they come from.
  cs?: CallSettings;
  settings?: Settings;
  todayMicro: number;
  monthMicro: number;
  // The caps in micro-USD; read from `settings` when absent.
  dailyMicro?: number;
  monthlyMicro?: number;
}

export interface StopResult {
  stop: boolean;
  reason?: "max_minutes" | "budget";
}

// The stop test after a tick (SPEC_V3 EE): max minutes first, then the caps with one more
// tick's worth (the larger of half a minute's floor and the delta this tick added).
export function stopReason(args: StopArgs): StopResult {
  const cs = args.cs ?? callSettingsOf(args.settings ?? ({} as Settings));
  const capMicro = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v * MICRO)) : fallback);
  const dailyMicro = args.dailyMicro ?? capMicro(args.settings?.dailyCapUsd, 3 * MICRO);
  const monthlyMicro = args.monthlyMicro ?? capMicro(args.settings?.monthlyCapUsd, 30 * MICRO);
  const delta = Math.max(0, args.tickDeltaMicro ?? args.deltaMicro ?? 0);
  if (args.secondsTotal > cs.maxMinutes * 60) return { stop: true, reason: "max_minutes" };
  const oneMore = Math.max(Math.ceil((cs.pricePerMinute / 2) * MICRO), delta);
  if (args.todayMicro + oneMore > dailyMicro) return { stop: true, reason: "budget" };
  if (args.monthMicro + oneMore > monthlyMicro) return { stop: true, reason: "budget" };
  return { stop: false };
}

function cleanSegmentText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Consecutive same-speaker segments become one; empty ones are dropped; a merged text
// never grows past MAX_SEGMENT_CHARS (a new row starts instead). The page (public/js/call.js
// addSegment) runs exactly this rule before sending, so the server run is idempotent on
// already-merged input and the two agree on any array.
export function mergeSegments(segments: CallSegment[]): CallSegment[] {
  const out: CallSegment[] = [];
  for (const s of segments) {
    const text = cleanSegmentText(s.text);
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.who === s.who && last.text.length + 1 + text.length <= MAX_SEGMENT_CHARS) {
      last.text = last.text + " " + text;
      continue;
    }
    out.push({ who: s.who, text: text.slice(0, MAX_SEGMENT_CHARS), at: s.at });
  }
  return out;
}

// At most `max` rows: the newest max - 2 stay as they are and everything earlier folds
// into one row per speaker (in order of first appearance), so the record keeps every
// word and the thread stays readable.
export function capSegments(segments: CallSegment[], max = MAX_TRANSCRIPT_ROWS): CallSegment[] {
  if (segments.length <= max) return segments;
  const keep = Math.max(0, max - 2);
  const head = segments.slice(0, segments.length - keep);
  const tail = segments.slice(segments.length - keep);
  const folded: CallSegment[] = [];
  for (const s of head) {
    const f = folded.find((x) => x.who === s.who);
    if (f) f.text = f.text + " " + s.text;
    else folded.push({ who: s.who, text: s.text, at: s.at });
  }
  return [...folded, ...tail];
}

// The flag-only run of the checks on her spoken turn: every code is stored for the record,
// retry-severity ones included (no retry is possible on speech), and the mechanical
// repair (dashes, emoji, markdown) is the only change ever made to her words.
export function flagOnlyChecks(text: string, ctx: CheckContext): { text: string; flags: Flag[] } {
  const r = runChecks(text, ctx);
  let out = text;
  if (r.action === "repair" || r.repaired !== undefined) {
    const repaired = r.repaired !== undefined ? r.repaired : repairText(text);
    if (repaired.trim()) out = repaired;
  }
  return { text: out, flags: r.flags };
}

// ------------------------------------------------------------------ rows

function callRowStmt(db: D1Database, c: CallRow): D1PreparedStatement {
  return db.prepare("INSERT INTO calls (id, conversation_id, provider, model, voice, status, started_at, last_tick_at, ended_at, seconds, cost_usd_micro, usage_json, transcript_rows, end_reason, prompt_version, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)")
    .bind(c.id, c.conversation_id, c.provider, c.model, c.voice, c.status, c.started_at, c.last_tick_at, c.ended_at, c.seconds, c.cost_usd_micro, c.usage_json, c.transcript_rows, c.end_reason, c.prompt_version, c.created_at);
}

export async function getCall(db: D1Database, id: string): Promise<CallRow | null> {
  if (typeof id !== "string" || !id || id.length > 120) return null;
  return db.prepare("SELECT * FROM calls WHERE id = ?1").bind(id).first<CallRow>();
}

export async function listCalls(db: D1Database, conversationId?: string | null, limit = 50): Promise<CallRow[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 50;
  const r = conversationId
    ? await db.prepare("SELECT * FROM calls WHERE conversation_id = ?1 ORDER BY started_at DESC LIMIT ?2").bind(conversationId, n).all<CallRow>()
    : await db.prepare("SELECT * FROM calls ORDER BY started_at DESC LIMIT ?1").bind(n).all<CallRow>();
  return r.results;
}

// The transcript rows of a call, in seq order.
export async function listCallMessages(db: D1Database, callId: string): Promise<MessageRow[]> {
  const r = await db.prepare("SELECT * FROM messages WHERE call_id = ?1 ORDER BY seq ASC").bind(callId).all<MessageRow>();
  return r.results;
}

// A call whose page is gone: live or starting with no tick (or start) in the last two
// minutes. Marked expired before anything else is decided (startCall, and the nightly
// maintenance through the same statement).
export function expireStaleCallsStmt(db: D1Database, now: Date): D1PreparedStatement {
  const cutoff = new Date(now.getTime() - LIVE_STALE_MS).toISOString();
  return db.prepare("UPDATE calls SET status = 'expired', ended_at = ?2, end_reason = COALESCE(end_reason, 'expired') WHERE status IN ('starting', 'live') AND COALESCE(last_tick_at, started_at) < ?1")
    .bind(cutoff, now.toISOString());
}

function parseUsageJson(json: string | null): CallUsage | null {
  if (!json) return null;
  try {
    return parseUsage(JSON.parse(json));
  } catch {
    return null;
  }
}

// The usage is cumulative for the session, so the stored figure never goes down: a tick
// that reports less than an earlier one (a zero after a lost response.done) keeps the
// per-field maximum.
export function mergeUsage(reported: CallUsage | null, stored: CallUsage | null): CallUsage | null {
  if (!reported) return stored;
  if (!stored) return reported;
  return {
    audioIn: Math.max(reported.audioIn, stored.audioIn),
    audioOut: Math.max(reported.audioOut, stored.audioOut),
    textIn: Math.max(reported.textIn, stored.textIn),
    textOut: Math.max(reported.textOut, stored.textOut),
  };
}

function errorClass(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof Error) return e.name || "Error";
  return "error";
}

function providerToApi(e: unknown): ApiHttpError {
  if (e instanceof ApiHttpError) return e;
  if (e instanceof ProviderError) {
    const message = safeErrorMessage(e);
    if (e.kind === "config") return new ApiHttpError(503, "provider_not_configured", message, false, e.provider);
    return new ApiHttpError(502, "provider_failed", message, e.retryable, e.kind);
  }
  return new ApiHttpError(502, "provider_failed", safeErrorMessage(e), true);
}

// ------------------------------------------------------------------ start

export async function startCall(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { conversationId: string; actor: string },
  _ctx?: ExecutionContext,
): Promise<StartCallResponse> {
  const cs = callSettingsOf(settings);
  if (typeof args.conversationId !== "string" || !args.conversationId) throw new ApiHttpError(400, "validation", "conversationId is required");
  const conv = await getConversation(db, args.conversationId);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  if (conv.status !== "active") throw new ApiHttpError(400, "validation", "conversation is not active");

  if (cs.provider === "off") throw new ApiHttpError(503, "provider_not_configured", "calls are off", false, "off");
  if (cs.provider === "elevenlabs") throw new ApiHttpError(503, "provider_not_configured", "the ElevenLabs call path is reserved for v3.1", false, "reserved_v3_1");
  if (!callProviderConfigured(env, cs.provider)) {
    throw new ApiHttpError(503, "provider_not_configured", `${cs.provider} is not configured for calls`, false, cs.provider);
  }

  // One call at a time, in any conversation. A dead page's call is expired first.
  const now = new Date();
  await expireStaleCallsStmt(db, now).run();
  const live = await db.prepare("SELECT id FROM calls WHERE status IN ('starting', 'live') LIMIT 1").first<{ id: string }>();
  if (live) throw new ApiHttpError(409, "call_in_progress", "a call is already live", false, live.id);

  // The same law as every other paid path: a paid call provider at a per-minute price of
  // 0 would meter at $0 whenever the page reports no usage, and no cap could trip.
  if (cs.provider !== "stub" && !(cs.pricePerMinute > 0)) {
    throw new ApiHttpError(402, "price_unknown", "callPricePerMinute is 0; set the price per minute in the Calls section of the Model page before a call", false, cs.provider);
  }
  await assertBudget(db, settings, 2 * cs.pricePerMinute);

  // Her instructions for the session, compact by default (SPEC_V3 EE, costs).
  const buildInstructions = async (mode: "compact" | "full"): Promise<string> => {
    const parts = await assembleSystemOnly(db, args.conversationId, settings, now, mode, { env });
    return callInstructions(parts);
  };
  let mode = cs.systemMode;
  let instructions = await buildInstructions(mode);

  let clientSecret: string;
  let expiresAt: number;
  let sdpUrl: string;
  let model = cs.model;
  if (cs.provider === "stub") {
    clientSecret = STUB_SECRET;
    expiresAt = Math.floor(now.getTime() / 1000) + STUB_SECRET_TTL_S;
    sdpUrl = "";
  } else {
    const mint = async (): Promise<{ value: string; expiresAt: number; model: string }> =>
      mintRealtimeSecret(env, { model: cs.model, voice: cs.voice, instructions, transcribeModel: cs.transcribeModel });
    let minted: { value: string; expiresAt: number; model: string };
    try {
      minted = await mint();
    } catch (e) {
      // A session that refuses the instructions for size (400) gets the compact form once.
      const sizeRefusal = e instanceof ProviderError && e.kind === "bad_request" && mode === "full";
      if (!sizeRefusal) throw providerToApi(e);
      console.warn("call instructions refused on full; retrying compact", errorClass(e));
      mode = "compact";
      instructions = await buildInstructions(mode);
      try {
        minted = await mint();
      } catch (e2) {
        throw providerToApi(e2);
      }
    }
    clientSecret = minted.value;
    expiresAt = minted.expiresAt;
    model = minted.model;
    sdpUrl = REALTIME_SDP_URL;
  }

  const t = nowIso();
  const call: CallRow = {
    id: newId("call"),
    conversation_id: args.conversationId,
    provider: cs.provider,
    model,
    voice: cs.voice,
    status: "starting",
    started_at: t,
    last_tick_at: null,
    ended_at: null,
    seconds: 0,
    cost_usd_micro: 0,
    usage_json: null,
    transcript_rows: 0,
    end_reason: null,
    prompt_version: PROMPT_VERSION,
    created_at: t,
  };
  // The audit row carries the call row only: no secret, no instructions.
  await db.batch([
    callRowStmt(db, call),
    auditStmt(db, args.actor, "call.start", "call", call.id, null, { ...call, instructionsMode: mode }),
  ]);

  return {
    call,
    provider: cs.provider,
    clientSecret,
    expiresAt,
    sdpUrl,
    model,
    voice: cs.voice,
    maxSeconds: cs.maxMinutes * 60,
    tickSeconds: TICK_SECONDS,
  };
}

// ------------------------------------------------------------------ tick

export async function tickCall(
  db: D1Database,
  settings: Settings,
  id: string,
  body: { seconds: unknown; usage?: unknown },
): Promise<TickResponse> {
  const cs = callSettingsOf(settings);
  const row = await getCall(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "call not found");
  if (row.status !== "starting" && row.status !== "live") throw new ApiHttpError(409, "call_over", "the call is " + row.status, false);
  const secondsRaw = body.seconds;
  if (typeof secondsRaw !== "number" || !Number.isFinite(secondsRaw) || secondsRaw < 0) throw new ApiHttpError(400, "validation", "seconds must be a non-negative number");
  const seconds = Math.min(MAX_TICK_SECONDS, Math.floor(secondsRaw));
  const usage = mergeUsage(parseUsage(body.usage), parseUsageJson(row.usage_json));

  const secondsTotal = row.seconds + seconds;
  const cost = callCostMicro(secondsTotal, usage, cs);
  const delta = tickDelta(row.cost_usd_micro, cost);
  const total = Math.max(row.cost_usd_micro, cost);
  const t = nowIso();
  const model = row.model ?? cs.model;
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE calls SET status = 'live', last_tick_at = ?2, seconds = ?3, cost_usd_micro = ?4, usage_json = ?5 WHERE id = ?1 AND status IN ('starting', 'live')")
      .bind(id, t, secondsTotal, total, usage ? JSON.stringify(usage) : row.usage_json),
  ];
  // The call is one request in the usage table: counted by its first tick (the row is
  // still "starting"), never again by the later ticks or the end.
  if (delta > 0) stmts.push(usageStmt(db, dayKey(), row.provider, model, 0, 0, delta, row.status === "starting" ? 1 : 0));
  await db.batch(stmts);

  // The tick that crosses is recorded; the stop test then reads the spend with it in.
  const spend = await spendAgainstCaps(db, settings);
  const verdict = stopReason({ secondsTotal, deltaMicro: delta, cs, ...spend });
  const out: TickResponse = { secondsTotal, costUsd: total / MICRO, stop: verdict.stop };
  if (verdict.reason) out.reason = verdict.reason;
  return out;
}

// ------------------------------------------------------------------ end

function parseSegments(v: unknown): CallSegment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ApiHttpError(400, "validation", "segments must be an array");
  if (v.length > MAX_RAW_SEGMENTS) throw new ApiHttpError(400, "validation", `segments exceeds ${MAX_RAW_SEGMENTS}`);
  const out: CallSegment[] = [];
  v.forEach((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ApiHttpError(400, "validation", `segments[${i}] must be an object`);
    const o = item as Record<string, unknown>;
    if (o.who !== "him" && o.who !== "her") throw new ApiHttpError(400, "validation", `segments[${i}].who must be him or her`);
    if (typeof o.text !== "string") throw new ApiHttpError(400, "validation", `segments[${i}].text must be a string`);
    if (o.text.length > MAX_SEGMENT_CHARS) throw new ApiHttpError(400, "validation", `segments[${i}].text exceeds ${MAX_SEGMENT_CHARS} characters`);
    let at = nowIso();
    if (o.at !== undefined && o.at !== null) {
      if (typeof o.at !== "string") throw new ApiHttpError(400, "validation", `segments[${i}].at must be an ISO time`);
      const ms = Date.parse(o.at);
      if (!Number.isFinite(ms)) throw new ApiHttpError(400, "validation", `segments[${i}].at must be an ISO time`);
      at = new Date(ms).toISOString();
    }
    out.push({ who: o.who, text: o.text, at });
  });
  return out;
}

// The checks' view of the world for a spoken turn: shared history, his name, the open
// unknowns, the open asks (ask_nag reads the transcript too). Read once per call end.
async function checkContextFor(db: D1Database): Promise<Omit<CheckContext, "recentAssistantTexts">> {
  const [facts, history, unknowns, rel, asks] = await Promise.all([
    listFacts(db, "justin"),
    listHistory(db),
    listUnknowns(db, "open"),
    getCurrentState<RelationshipState>(db, "relationship"),
    listAsks(db, "open").catch((): Awaited<ReturnType<typeof listAsks>> => []),
  ]);
  const his = rel.state.his_name;
  return {
    hasSharedHistory: history.length > 0 || facts.length > 0,
    knownName: typeof his === "string" && his.trim() ? his.trim() : null,
    openUnknownTopics: unknowns.map((u) => u.topic),
    channel: "story",
    openAsks: asks.filter((a) => a && a.status === "open").map((a) => ({ text: a.text, broughtUp: a.brought_up })),
  };
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

// The seconds the page counted since the call went live (the end body's `seconds`): the
// per-minute floor sees the time since the last tick, up to one tick's worth, and a call
// that ends before its first tick is not free. Never below what the ticks recorded.
function secondsAtEnd(row: CallRow, reported: unknown): number {
  const n = typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? Math.floor(reported) : row.seconds;
  return Math.min(row.seconds + MAX_TICK_SECONDS, Math.max(row.seconds, n));
}

export async function endCall(
  env: Env,
  db: D1Database,
  settings: Settings,
  id: string,
  body: { reason?: unknown; segments?: unknown; usage?: unknown; seconds?: unknown },
  actor: string,
  ctx?: ExecutionContext,
): Promise<EndCallResponse> {
  const cs = callSettingsOf(settings);
  const row = await getCall(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "call not found");
  const now = new Date();
  if (row.status === "ended" || row.status === "failed") throw new ApiHttpError(409, "call_over", "the call is " + row.status, false);
  if (row.status === "expired") {
    const lastMs = Date.parse(row.last_tick_at ?? row.started_at);
    if (!Number.isFinite(lastMs) || now.getTime() - lastMs > END_GRACE_MS) throw new ApiHttpError(409, "call_over", "the call expired more than a day ago", false);
  }
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_CHARS) : "";
  const reason = reasonRaw || "ended";
  const usage = mergeUsage(parseUsage(body.usage), parseUsageJson(row.usage_json));
  const segments = capSegments(mergeSegments(parseSegments(body.segments)));

  // The final reconciliation, the same rule as the ticks, over the seconds the page
  // counted (bounded by the ticks plus one tick's worth).
  const seconds = secondsAtEnd(row, body.seconds);
  const cost = callCostMicro(seconds, usage, cs);
  const delta = tickDelta(row.cost_usd_micro, cost);
  const total = Math.max(row.cost_usd_micro, cost);
  const model = row.model ?? cs.model;
  const promptVersion = row.prompt_version ?? PROMPT_VERSION;

  const base = await checkContextFor(db);
  const runId = newId("r");
  const run: ModelRunRow = {
    id: runId,
    conversation_id: row.conversation_id,
    // ModelRunRow.kind gains "call" in v3 (../types, pipeline lane); the column has no CHECK.
    kind: "call",
    provider: row.provider,
    model,
    prompt_version: promptVersion,
    input_tokens: usage ? usage.audioIn + usage.textIn : 0,
    output_tokens: usage ? usage.audioOut + usage.textOut : 0,
    cost_usd_micro: total,
    latency_ms: seconds * 1000,
    status: "ok",
    error: null,
    flags_json: null,
    created_at: nowIso(),
  };

  // Her spoken turns get the flag-only run of the checks, in order, each seeing the ones
  // before it as its recent replies and what he said just before it as his text.
  const prepared: Array<{ who: "him" | "her"; text: string; at: string; flags: Flag[] }> = [];
  const herSoFar: string[] = [];
  let hisLast = "";
  for (const s of segments) {
    if (s.who === "her") {
      const r = flagOnlyChecks(s.text, { ...base, recentAssistantTexts: herSoFar.slice(-5), hisText: hisLast });
      herSoFar.push(r.text);
      prepared.push({ who: "her", text: r.text, at: s.at, flags: r.flags });
    } else {
      hisLast = s.text;
      prepared.push({ who: "him", text: s.text, at: s.at, flags: [] });
    }
  }

  const ids: string[] = prepared.map(() => newId("m"));
  const build = async (): Promise<D1PreparedStatement[]> => {
    const t = nowIso();
    const stmts: D1PreparedStatement[] = [];
    let seq = await nextSeq(db, row.conversation_id);
    let lastHis: string | null = null;
    prepared.forEach((p, i) => {
      const mid = ids[i]!;
      const m: MessageRow = {
        id: mid,
        conversation_id: row.conversation_id,
        channel: "story",
        role: p.who === "him" ? "user" : "assistant",
        content: p.text,
        created_at: p.at,
        seq: seq++,
        idempotency_key: null,
        reply_to_id: p.who === "her" ? lastHis : null,
        model_run_id: p.who === "her" ? runId : null,
        flags_json: p.who === "her" ? JSON.stringify(p.flags) : null,
        image_id: null,
        image_status: null,
        deliver_at: null,
        song_json: null,
        audio_key: null,
        images_json: null,
        media_id: null,
        call_id: row.id,
      };
      if (p.who === "him") lastHis = mid;
      stmts.push(insertMessageStmt(db, m));
      if (p.who === "her") stmts.push(contextStmt(db, mid, { callId: row.id, promptVersion }));
    });
    stmts.push(insertModelRunStmt(db, run));
    stmts.push(db.prepare("UPDATE calls SET status = 'ended', ended_at = ?2, end_reason = ?3, usage_json = ?4, transcript_rows = ?5, cost_usd_micro = ?6, seconds = ?7 WHERE id = ?1")
      .bind(row.id, t, reason, usage ? JSON.stringify(usage) : row.usage_json, prepared.length, total, seconds));
    // A call that never ticked is counted as its one request here; otherwise the first
    // tick counted it and the end adds only the last delta.
    const requests = row.status === "starting" ? 1 : 0;
    if (delta > 0 || requests > 0) stmts.push(usageStmt(db, dayKey(), row.provider, model, 0, 0, delta, requests));
    if (prepared.length) stmts.push(touchConversationStmt(db, row.conversation_id, t));
    stmts.push(auditStmt(db, actor, "call.end", "call", row.id, { status: row.status, seconds: row.seconds, cost_usd_micro: row.cost_usd_micro }, {
      status: "ended", reason, seconds, cost_usd_micro: total, transcript_rows: prepared.length,
    }));
    return stmts;
  };

  // A first-text cron tick can land during a call and take a seq: recompute once.
  try {
    await db.batch(await build());
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await db.batch(await build());
  }

  const ended: CallRow = {
    ...row, status: "ended", ended_at: nowIso(), end_reason: reason, usage_json: usage ? JSON.stringify(usage) : row.usage_json,
    transcript_rows: prepared.length, cost_usd_micro: total, seconds,
  };

  // The proposal pass over the call's last exchange (its rows are the newest story
  // messages, so the pass reads the call). Best effort, in the background window.
  const lastHerIndex = prepared.map((p) => p.who).lastIndexOf("her");
  if (ctx && settings.proposalsEnabled && lastHerIndex >= 0) {
    const assistant: MessageRow = {
      id: ids[lastHerIndex]!, conversation_id: row.conversation_id, channel: "story", role: "assistant", content: prepared[lastHerIndex]!.text,
      created_at: prepared[lastHerIndex]!.at, seq: 0, idempotency_key: null, reply_to_id: null, model_run_id: runId,
      flags_json: null, image_id: null, image_status: null,
    };
    const lastHisIndex = prepared.slice(0, lastHerIndex).map((p) => p.who).lastIndexOf("him");
    const user: MessageRow | null = lastHisIndex >= 0
      ? { ...assistant, id: ids[lastHisIndex]!, role: "user", content: prepared[lastHisIndex]!.text, created_at: prepared[lastHisIndex]!.at, model_run_id: null }
      : null;
    ctx.waitUntil(
      extractProposals(env, db, settings, row.conversation_id, user, assistant)
        .catch((e: unknown) => console.warn("call proposal extraction failed", errorClass(e))),
    );
  }

  return { call: ended, messageIds: ids };
}
