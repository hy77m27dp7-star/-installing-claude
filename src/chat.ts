// The turn pipeline. One user message in, one of her messages out, or nothing at all:
// a failed or refused model call writes no reply and leaves the scene exactly where it was.
// Everything that lands does so in one batch.
//
// v2: markers (photo, song, voice, media) come off the text before checks; in real mode
// the reply carries a deliver_at (her timing, from her life); every reply writes its
// provenance (the ids the turn was built from) in the same batch; the owner can let her
// open a conversation herself (opts.openerNote), in which case nothing of his is stored;
// his photos ride in on opts.images; a [media: title] line resolves to a library row
// (media_id) or the flag media_unknown; a [voice] line (or voice mode "all") makes the
// audio after the response, best effort.
//
// v3 (SPEC_V3 section HH): the pipeline is three exported pieces so a tasting can run the
// same turn on two performers without a second pipeline. prepareTurn (validation, the
// idempotency lookup, the pending-tasting gate, the provider check, the context with its
// systemParts, the budget estimate, the request and the check context); generateDraft
// (the call, the evaluation, the one retry, the run rows priced by the performer named);
// commitReply (the batch: the user row when new, the run rows, her row, the photo request,
// the provenance with its state text, the exemplar uses, the memory touches, the recall
// row, the asks she brought up again, the conversation touch). runTurn is prepare,
// generate, commit, then the after-response work (her voice note, the proposal pass).
import { assembleContext, keywords } from "./context";
import { SYSTEM_SEPARATOR, moodPhase } from "./prompt";
import { getTextProvider, providerConfigured } from "./providers/index";
import { repairText, runChecks } from "./checks";
import { photoRequestRow } from "./images";
import { stripAllMarkers } from "./markers";
import { computeDeliverAt } from "./life";
import { contextStmt } from "./provenance";
import { resolveMediaTitle } from "./media";
import { attachVoiceNote, voiceWanted } from "./voice";
import type { ImageRef } from "./vision";
import { extractProposals } from "./proposals";
import { assertBudget, costMicro, estimateUsd } from "./budget";
import { useStmts } from "./voicebank";
import { findTouchHits, recallStmt, touchStmts } from "./memory";
import type { TouchCandidate } from "./memory";
import { broughtUpStmts } from "./wants";
import { signature } from "./imperfection";
import {
  dayKey, findByIdempotencyKey, getConversation, insertAssetStmt, insertMessageStmt, insertModelRunStmt, newId, nextSeq, nowIso,
  touchConversationStmt, usageStmt,
} from "./db";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import { safeErrorMessage } from "./providers/types";
import type { SongRef } from "./markers";
import type {
  AssembledContext, ChatMessage, CheckContext, CheckResult, Env, Flag, GenerateRequest, GenerateResult, MessageRow, ModelRunRow,
  PromptCallback, PromptState, ProviderName, RecallPick, Settings, TextProvider, TurnResponse, VisualAssetRow, VoiceLine,
} from "./types";

const MICRO = 1_000_000;
const MAX_CONTENT = 4000;
const KEY_MIN = 8;
const KEY_MAX = 80;
const MAX_OPENER_NOTE = 2000;
const DELAY_MAX_MINUTES = 120;
const DELAY_DEFAULT_MINUTES = 6;
// A pending tasting older than this is abandoned (SPEC_V3 section HH): it never blocks a
// conversation for longer, and the gate expires it lazily.
export const TASTING_TTL_MS = 30 * 60 * 1000;
// At most this many memory rows are touched per turn (SPEC_V3 section BB).
const MAX_TOUCHES = 10;

// The one user turn an opener call sends: a cue for the operator note, never his words.
// Plain letters only, so the stub provider's echo of it trips no check.
export const OPENER_CUE = "[opener]";

// A fact he told her that carries his name ("His name is Justin.").
const NAME_FACT_RE = /\b(?:his (?:first )?name is|he is called|he goes by)\s+([A-Za-z][A-Za-z'-]*)/i;

// One plain sentence per retry code, so the model can actually rewrite the draft.
export const RETRY_RULES: Record<string, string> = {
  question_chain: "do not end this reply with a question; react, decide or disclose instead",
  name_overuse: "use his name once at most, or not at all",
  braking_repeat: "do not repeat the braking line from your recent replies (slow down, stay with me, don't rush, not so fast)",
  therapy_cadence: "drop the therapist phrasing (that sounds really hard, i hear you, thank you for sharing) and say the actual thought the way you text",
  menu_offer: "do not offer a menu of options (do you want me to, i can either); pick one and say it",
  tech_leak: "you are a person; nothing about prompts, models, apps, tokens, AI or how this conversation is produced can appear",
  dependency_hook: "no lines that bind him to you (don't leave me, i've been waiting for you, you're all i have); you are fine on your own",
  first_meeting_replay: "you two already know each other; do not introduce yourself or say nice to meet you",
  // v3
  exemplar_verbatim: "do not reuse the example lines; say your own thing in your own words",
  ask_nag: "you already asked; do not bring it up again, let it go",
  third_person_action: "in your asterisk actions he is \"you\" (*looks at you*), never him, he or his; you are talking to him",
};

export interface TurnOptions {
  // Present when the owner lets her start (SPEC_V2 section Q): the one-time operator note
  // appended to the system prompt. No user message is stored; userMessage is null.
  openerNote?: string;
  // The photos he attached to this message (SPEC_V2 section T), already in R2. The API
  // route writes images_json on his row once the turn is committed.
  images?: ImageRef[];
  // v3 (SPEC_V3 section HH): this request is a tasting turn. A pending tasting with the
  // same key is then handed back for replay instead of answering 409 tasting_pending.
  tasting?: boolean;
  // The tasting being picked (tastings.ts rebuilds the turn to commit the winner): nothing
  // is generated, so the budget gate and the provider check are skipped, and a pending
  // row with this id never blocks.
  tastingPickId?: string;
}

// Who generates: the live performer by default, the tasting performer for side B.
export interface Performer {
  provider: ProviderName;
  model: string;
}

// ------------------------------------------------------------------ small helpers

function parseFlags(json: string | null): Flag[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((f): f is Flag => typeof f === "object" && f !== null && typeof (f as Flag).code === "string");
  } catch {
    return [];
  }
}

// The class of an error, never its message: messages can echo request bodies.
function errorClass(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof Error) return e.name || "Error";
  return "error";
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

function isMissingTable(e: unknown): boolean {
  return e instanceof Error && /no such table/i.test(e.message);
}

// The relationship state names him once the owner records it; before that, a fact he
// told her may carry the name. Nothing else does.
function knownNameFrom(state: PromptState): string | null {
  const his = state.relationship.his_name;
  if (typeof his === "string" && his.trim()) return his.trim();
  for (const f of state.justinFacts) {
    const m = NAME_FACT_RE.exec(f.fact);
    if (m && m[1]) return m[1];
  }
  return null;
}

function clampDelayMinutes(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : DELAY_DEFAULT_MINUTES;
  return Math.min(DELAY_MAX_MINUTES, Math.max(0, n));
}

// The one-time note for an opener turn, appended after the state sections so the cached
// prefix is untouched. The cue turn is explained so no model reads it as his text.
function openerBlock(note: string): string {
  return "ONE-TIME OPERATOR NOTE (not part of the story; he did not write this and never sees it)\n"
    + note
    + `\nThe final user turn reads only "${OPENER_CUE}": it is the cue for this note, not something he wrote. Output only your message.`;
}

// She named the song in prose as well as in the marker (SPEC_V2 section I).
function songNamedTwice(text: string, song: SongRef | null): boolean {
  if (!song) return false;
  const title = song.title.trim().toLowerCase();
  return title.length >= 3 && text.toLowerCase().includes(title);
}

// A line of the record is "referenced" by a text when at least two of its keywords (or
// all, for a very short one) appear in it. Callbacks (SPEC_V2 section K), asks (SPEC_V3
// section CC) and memory touches (section BB) all read this.
function referenced(text: string, line: string, have: Set<string> = keywords(text)): boolean {
  const want = keywords(line);
  if (!want.size) return false;
  let hits = 0;
  for (const k of want) if (have.has(k)) hits++;
  return hits >= Math.min(2, want.size);
}

function callbackReferenced(text: string, cb: PromptCallback): boolean {
  return referenced(text, cb.text);
}

export type CallOk = { ok: true; result: GenerateResult; latencyMs: number };
export type CallFailed = {
  ok: false;
  status: "failed" | "refused";
  errorClass: string;
  retryable: boolean;
  result: GenerateResult | null;
  latencyMs: number;
};
type Call = CallOk | CallFailed;

async function callModel(provider: TextProvider, env: Env, req: GenerateRequest): Promise<Call> {
  const started = Date.now();
  try {
    const result = await provider.generate(env, req);
    const latencyMs = Date.now() - started;
    if (result.stopReason === "refusal") {
      return { ok: false, status: "refused", errorClass: "refusal", retryable: false, result, latencyMs };
    }
    if (!result.text || !result.text.trim()) {
      return { ok: false, status: "failed", errorClass: "empty_reply", retryable: true, result, latencyMs };
    }
    return { ok: true, result, latencyMs };
  } catch (e) {
    const retryable = e instanceof ProviderError ? e.retryable : true;
    // Class plus the provider's redacted words, so a failed call can be diagnosed from the logs.
    console.warn("provider call failed", req.model, errorClass(e), safeErrorMessage(e, 200));
    return { ok: false, status: "failed", errorClass: errorClass(e), retryable, result: null, latencyMs: Date.now() - started };
  }
}

// One model_runs row and what it costs; usage is true when tokens were spent (a row for
// usage_daily goes with it).
export interface BuiltRun {
  run: ModelRunRow;
  micro: number;
  inputTokens: number;
  outputTokens: number;
  usage: boolean;
}

function buildRun(
  kind: ModelRunRow["kind"],
  conversationId: string,
  settings: Settings,
  performer: Performer,
  promptVersion: string,
  call: Call,
  flags: Flag[],
): BuiltRun {
  const res = call.result;
  const inputTokens = res ? Math.max(0, res.inputTokens) : 0;
  const outputTokens = res ? Math.max(0, res.outputTokens) : 0;
  const cost = res ? costMicro(settings, performer.model, inputTokens, outputTokens) : { micro: 0, priceKnown: true };
  const runFlags: Flag[] = [...flags];
  if (!cost.priceKnown) runFlags.push({ code: "price_unknown", severity: "flag", detail: "no price for model " + performer.model });
  const run: ModelRunRow = {
    id: newId("r"),
    conversation_id: conversationId,
    kind,
    provider: performer.provider,
    model: performer.model,
    prompt_version: promptVersion,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd_micro: cost.micro,
    latency_ms: call.latencyMs,
    status: call.ok ? "ok" : call.status,
    error: call.ok ? null : call.errorClass,
    flags_json: runFlags.length ? JSON.stringify(runFlags) : null,
    created_at: nowIso(),
  };
  return { run, micro: cost.micro, inputTokens, outputTokens, usage: res !== null };
}

// The run rows and their usage as statements for a batch.
export function runStatements(db: D1Database, runs: BuiltRun[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const b of runs) {
    out.push(insertModelRunStmt(db, b.run));
    if (b.usage) out.push(usageStmt(db, dayKey(), b.run.provider, b.run.model, b.inputTokens, b.outputTokens, b.micro));
  }
  return out;
}

// A call that produced nothing usable: its failed run row (with its usage when tokens
// were spent), no messages, and the scene stays where it was. Best effort.
export async function recordRuns(db: D1Database, runs: BuiltRun[]): Promise<void> {
  const stmts = runStatements(db, runs);
  if (!stmts.length) return;
  try {
    await db.batch(stmts);
  } catch (e) {
    console.error("model run not recorded", errorClass(e));
  }
}

// A reply as evaluated: the call it came from, the text to store (markers off, mechanical
// repairs applied), what the markers asked for, the checks. `checks.flags` is the one flag
// list (a flag pushed there is stored); `flags` is the same array for readers of the plain
// shape. v3 adds the library row a [media: title] line resolved to and the run row that
// produced the draft (both set by generateDraft; a draft rebuilt from a stored candidate
// leaves them out).
export interface Draft {
  call: CallOk;
  text: string;
  photo: string | null;
  song: SongRef | null;
  voice: boolean;
  mediaTitle: string | null;
  checks: CheckResult;
  retryFlags: number;
  flags?: Flag[];
  raw?: string;
  mediaId?: string | null;
  runId?: string | null;
}

// Markers off, checks on, mechanical repair applied when the checks asked for one. The
// two v2 flags (song named twice, both callbacks forced in) never change the action.
function evaluate(call: CallOk, checkCtx: CheckContext, callbacks: PromptCallback[]): Draft {
  const { clean, photo, song, voice, media } = stripAllMarkers(call.result.text);
  const checks = runChecks(clean, checkCtx);
  if (call.result.stopReason === "max_tokens") {
    checks.flags.push({ code: "truncated", severity: "flag", detail: "reply stopped at max_tokens" });
  }
  if (songNamedTwice(clean, song)) {
    checks.flags.push({ code: "song_marker_dup", severity: "flag", detail: "the prose names the song the marker sends" });
  }
  if (callbacks.length >= 2 && callbacks.slice(0, 2).every((cb) => callbackReferenced(clean, cb))) {
    checks.flags.push({ code: "callback_forced", severity: "flag", detail: "both offered callbacks landed in one reply" });
  }
  let text = clean;
  const needsRepair = checks.action === "repair" || checks.repaired !== undefined;
  if (needsRepair) {
    const repaired = checks.repaired !== undefined ? checks.repaired : repairText(clean);
    if (repaired.trim()) text = repaired;
  }
  return {
    call,
    text,
    photo,
    song,
    voice,
    mediaTitle: media,
    checks,
    retryFlags: checks.flags.filter((f) => f.severity === "retry").length,
    flags: checks.flags,
    raw: call.result.text,
    mediaId: null,
    runId: null,
  };
}

// The retry keeps the system prompt byte-identical (the cache stays warm) and instead
// shows the model its own draft plus one plain rule per rejected code.
function retryMessages(messages: ChatMessage[], draft: string, flags: Flag[]): ChatMessage[] {
  const codes = Array.from(new Set(flags.filter((f) => f.severity === "retry").map((f) => f.code)));
  const rules = codes.map((c) => "- " + (RETRY_RULES[c] ?? c));
  const note =
    "OPERATOR NOTE (not part of the story; he did not write this and never sees it): the draft above was rejected.\n"
    + rules.join("\n")
    + "\nRewrite it as Avelie with the same substance and none of those problems. Output only the message.";
  return [...messages, { role: "assistant", content: draft }, { role: "user", content: note }];
}

async function replayed(db: D1Database, user: MessageRow, assistant: MessageRow): Promise<TurnResponse> {
  const run = assistant.model_run_id
    ? await db.prepare("SELECT * FROM model_runs WHERE id = ?1").bind(assistant.model_run_id).first<ModelRunRow>()
    : null;
  return {
    conversationId: user.conversation_id,
    userMessage: user,
    assistantMessage: assistant,
    deliverAt: assistant.deliver_at ?? null,
    run: {
      provider: run?.provider ?? "",
      model: run?.model ?? "",
      inputTokens: run?.input_tokens ?? 0,
      outputTokens: run?.output_tokens ?? 0,
      costUsd: (run?.cost_usd_micro ?? 0) / MICRO,
      latencyMs: run?.latency_ms ?? 0,
      promptVersion: run?.prompt_version ?? "",
    },
    flags: parseFlags(assistant.flags_json),
    imagePending: assistant.image_status === "pending",
    replayed: true,
  };
}

async function findReply(db: D1Database, userMessageId: string): Promise<MessageRow | null> {
  return db
    .prepare("SELECT * FROM messages WHERE reply_to_id = ?1 AND role = 'assistant' ORDER BY seq ASC LIMIT 1")
    .bind(userMessageId)
    .first<MessageRow>();
}

// ------------------------------------------------------------------ the pending-tasting gate (SPEC_V3 section HH)

export interface PendingTasting {
  id: string;
  idempotency_key: string;
  created_at: string;
}

// One query for a pending tasting in the conversation. A pending row younger than the TTL
// blocks every turn shape with 409 tasting_pending, unless this request is a tasting turn
// with the same key, in which case the row is handed back for replay. A pending row past
// the TTL is abandoned: it is expired here, lazily, and blocks nothing. Without the table
// (a v3 Worker in front of a v2 database) nothing can be pending.
export async function pendingTastingGate(db: D1Database, conversationId: string, key: string, isTasting: boolean, ignoreId: string | null = null): Promise<PendingTasting | null> {
  let row: PendingTasting | null;
  try {
    row = await db
      .prepare("SELECT id, idempotency_key, created_at FROM tastings WHERE conversation_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .bind(conversationId)
      .first<PendingTasting>();
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
  if (!row || (ignoreId && row.id === ignoreId)) return null;
  const age = Date.now() - Date.parse(row.created_at);
  if (!(age < TASTING_TTL_MS)) {
    try {
      await db.prepare("UPDATE tastings SET status = 'expired', decided_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(row.id, nowIso()).run();
    } catch (e) {
      console.warn("stale tasting not expired", errorClass(e));
    }
    return null;
  }
  if (isTasting && key && row.idempotency_key === key) return row;
  throw new ApiHttpError(409, "tasting_pending", "a tasting is pending in this conversation; pick one first", false, row.id);
}

// ------------------------------------------------------------------ prepare

export interface Prepared {
  conversationId: string;
  actor: string;
  now: Date;
  settings: Settings;
  opener: boolean;
  openerNote: string | null;
  tasting: boolean;
  // His text as validated ("" for an opener) and the idempotency key ("" for an opener).
  text: string;
  key: string;
  // What the model saw as the final user turn: his stored or new text, or the opener cue.
  userText: string;
  // The stored user row this request resumes (an idempotent resume), else null.
  existingUser: MessageRow | null;
  // When the key already has a reply: the replay to return; nothing is generated.
  replay: TurnResponse | null;
  // A pending tasting with this key on a tasting turn (the page resuming it): replay it.
  tastingReplay: PendingTasting | null;
  assembled: AssembledContext;
  promptVersion: string;
  req: GenerateRequest;
  checkCtx: CheckContext;
  callbacks: PromptCallback[];
  pendingImages: ImageRef[];
  // The live performer (settings.provider and settings.model) and the estimate the budget
  // gate saw (USD) for one call at that performer.
  performer: Performer;
  estimateUsd: number;
  // The state sections exactly as sent (the opener block included), for the provenance row.
  stateText: string;
}

// Everything before the model call: validation, the idempotency lookup, the pending-tasting
// gate, the provider check, the context (read only), the budget from the real prompt size.
// Nothing is written. Throws the same errors a turn always has.
export async function prepareTurn(
  env: Env,
  db: D1Database,
  settings: Settings,
  conversationId: string,
  content: string,
  idempotencyKey: string,
  actor: string,
  opts?: TurnOptions,
): Promise<Prepared> {
  const openerNote = opts && typeof opts.openerNote === "string" && opts.openerNote.trim()
    ? opts.openerNote.trim().slice(0, MAX_OPENER_NOTE)
    : null;
  const opener = openerNote !== null;
  const tasting = opts?.tasting === true && !opener;
  const pickId = opts && typeof opts.tastingPickId === "string" && opts.tastingPickId.trim() ? opts.tastingPickId.trim() : null;

  // 1. validate (an opener carries no message of his and needs no key)
  const text = typeof content === "string" ? content.trim() : "";
  if (!opener) {
    if (!text) throw new ApiHttpError(400, "validation", "content is required");
    if (text.length > MAX_CONTENT) throw new ApiHttpError(400, "validation", `content exceeds ${MAX_CONTENT} characters`);
  }
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!opener && (key.length < KEY_MIN || key.length > KEY_MAX)) {
    throw new ApiHttpError(400, "validation", `idempotencyKey must be ${KEY_MIN} to ${KEY_MAX} characters`);
  }
  if (typeof conversationId !== "string" || !conversationId) throw new ApiHttpError(400, "validation", "conversationId is required");
  const conv = await getConversation(db, conversationId);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  if (conv.status !== "active") throw new ApiHttpError(400, "validation", "conversation is not active");

  // 2. idempotency (nothing to replay for an opener: no row of his exists)
  let existingUser: MessageRow | null = null;
  let replay: TurnResponse | null = null;
  if (!opener) {
    const prior = await findByIdempotencyKey(db, key);
    if (prior) {
      if (prior.conversation_id !== conversationId || prior.role !== "user") {
        throw new ApiHttpError(409, "idempotency_conflict", "idempotencyKey was already used elsewhere");
      }
      const reply = await findReply(db, prior.id);
      if (reply) replay = await replayed(db, prior, reply);
      existingUser = prior;
    }
  }
  const userText = opener ? OPENER_CUE : existingUser ? existingUser.content : text;

  // 2b. the pending-tasting gate: every turn shape passes through here (a plain turn, a
  // tasting turn, the page's Retry, an /open turn, a first text, a voice turn).
  const tastingReplay = replay ? null : await pendingTastingGate(db, conversationId, key, tasting, pickId);

  const performer: Performer = { provider: settings.provider, model: settings.model };
  const generates = !replay && !tastingReplay && !pickId;
  if (generates && !providerConfigured(env, settings.provider)) {
    throw new ApiHttpError(503, "provider_not_configured", `${settings.provider} is not configured`, false);
  }

  // 4. context (read only), then 3. budget from the real prompt size; nothing is written yet
  const now = new Date();
  const pendingImages: ImageRef[] = !opener && opts && Array.isArray(opts.images) ? opts.images : [];
  const assembled = await assembleContext(db, conversationId, settings, userText, existingUser ? existingUser.id : null, now, pendingImages, { opener, env });
  const statePart = opener ? assembled.systemParts.state + SYSTEM_SEPARATOR + openerBlock(openerNote) : assembled.systemParts.state;
  const system = assembled.systemParts.prefix + SYSTEM_SEPARATOR + statePart;
  const inputChars = system.length + assembled.messages.reduce((n, m) => n + m.content.length, 0);
  let estimate = 0;
  if (generates) {
    estimate = estimateUsd(settings, settings.model, inputChars, settings.maxTokens);
    await assertBudget(db, settings, estimate);
  }

  const req: GenerateRequest = {
    system,
    systemParts: { prefix: assembled.systemParts.prefix, state: statePart },
    messages: assembled.messages,
    model: settings.model,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    effort: settings.effort,
    cacheable: true,
  };
  const state = assembled.state;
  const checkCtx: CheckContext = {
    hasSharedHistory: state.hasSharedHistory,
    knownName: knownNameFrom(state),
    recentAssistantTexts: assembled.recentAssistantTexts,
    openUnknownTopics: state.unknowns.map((u) => u.topic),
    channel: "story",
    // v3: the offered bank lines and his standing rewrites (exemplar_verbatim: his version of
    // a line is his text, never hers to recite), the open asks (ask_nag), the shape window
    // (shape_uniform), whether this is an opener and what he wrote (ask_nag).
    exemplars: [
      ...(state.exemplars ?? []).map((l) => l.text),
      ...(state.corrections ?? []).map((c) => c.rewrite),
    ].filter((t): t is string => typeof t === "string" && t.trim().length > 0),
    openAsks: (state.asks ?? []).filter((a) => a && a.status === "open").map((a) => ({ text: a.text, broughtUp: a.brought_up })),
    recentSignatures: state.recentSignatures ?? [],
    opener,
    hisText: opener ? "" : userText,
  };

  return {
    conversationId,
    actor,
    now,
    settings,
    opener,
    openerNote,
    tasting,
    text,
    key,
    userText,
    existingUser,
    replay,
    tastingReplay,
    assembled,
    promptVersion: assembled.promptVersion,
    req,
    checkCtx,
    callbacks: state.callbacks,
    pendingImages,
    performer,
    estimateUsd: estimate,
    stateText: statePart,
  };
}

// ------------------------------------------------------------------ generate

export interface Generated {
  draft: Draft;
  // The run rows of this draft (the call and its retry), not yet stored; draft.runId names
  // the one that produced the chosen text.
  runs: BuiltRun[];
  latencyMs: number;
  retried: boolean;
  performer: Performer;
}

// A generation that produced nothing usable, thrown by generateDraft: the turn's error
// (502 provider_refused or provider_failed) carrying the failed run row (with its usage
// when tokens were spent) for the caller to record, or to void a tasting on.
export class GenerateFailure extends ApiHttpError {
  runs: BuiltRun[];
  failed: CallFailed;
  constructor(failed: CallFailed, runs: BuiltRun[]) {
    if (failed.status === "refused") super(502, "provider_refused", "the model refused this turn", false);
    else super(502, "provider_failed", "the model call failed", failed.retryable, failed.errorClass);
    this.name = "GenerateFailure";
    this.failed = failed;
    this.runs = runs;
  }
}

// The turn's error for a failed generation (a GenerateFailure is already one; any other
// carrier of a failed call maps the same way).
export function failedTurnError(g: { failed: CallFailed }): ApiHttpError {
  if (g instanceof GenerateFailure) return g;
  if (g.failed.status === "refused") return new ApiHttpError(502, "provider_refused", "the model refused this turn", false);
  return new ApiHttpError(502, "provider_failed", "the model call failed", g.failed.retryable, g.failed.errorClass);
}

// The call, the evaluation, the one retry, the run rows priced by the performer named.
// Nothing is written: a failed or refused call throws a GenerateFailure carrying its run
// row for the caller to record (or to void a tasting on). `runKind` names the first run
// row (turn by default, tasting for a tasting draft); the retry row is always kind retry.
export async function generateDraft(
  env: Env,
  db: D1Database,
  settings: Settings,
  prepared: Prepared,
  performer: Performer = prepared.performer,
  runKind: ModelRunRow["kind"] = "turn",
): Promise<Generated> {
  if (!providerConfigured(env, performer.provider)) {
    throw new ApiHttpError(503, "provider_not_configured", `${performer.provider} is not configured`, false);
  }
  let provider: TextProvider;
  try {
    provider = getTextProvider(performer.provider);
  } catch (e) {
    throw new ApiHttpError(503, "provider_not_configured", "unknown provider", false, errorClass(e));
  }
  const { conversationId, promptVersion, checkCtx, callbacks } = prepared;
  const req: GenerateRequest = performer.model === prepared.req.model ? prepared.req : { ...prepared.req, model: performer.model };

  // 5. generate
  const first = await callModel(provider, env, req);
  if (!first.ok) {
    throw new GenerateFailure(first, [buildRun(runKind, conversationId, settings, performer, promptVersion, first, [])]);
  }

  // 6 + 7. markers, checks
  const firstDraft = evaluate(first, checkCtx, callbacks);
  if (!firstDraft.text.trim()) {
    // A marker-only reply: nothing to show him, nothing that may enter the transcript.
    const failed: CallFailed = { ok: false, status: "failed", errorClass: "empty_reply", retryable: true, result: first.result, latencyMs: first.latencyMs };
    throw new GenerateFailure(failed, [buildRun(runKind, conversationId, settings, performer, promptVersion, failed, [])]);
  }
  let chosen = firstDraft;
  let retryCall: Call | null = null;
  let retryDraft: Draft | null = null;

  if (firstDraft.checks.action === "retry") {
    // The retry keeps the system prompt (and its parts) byte-identical: the cue and the
    // exemplars are the same on the retry, and the cache stays warm.
    const retryReq: GenerateRequest = { ...req, messages: retryMessages(req.messages, first.result.text, firstDraft.checks.flags) };
    // The retry is a second full call, gated like the first. The first call's own cost is
    // not on the meter yet (it is committed below), so it is counted into this estimate.
    // Over a cap the retry is skipped, the first draft stands, and the message says so.
    const firstCostUsd = costMicro(settings, performer.model, Math.max(0, first.result.inputTokens), Math.max(0, first.result.outputTokens)).micro / MICRO;
    const retryChars = retryReq.system.length + retryReq.messages.reduce((n, m) => n + m.content.length, 0);
    let retryAllowed = true;
    try {
      await assertBudget(db, settings, firstCostUsd + estimateUsd(settings, performer.model, retryChars, settings.maxTokens));
    } catch (e) {
      if (!(e instanceof ApiHttpError && e.status === 402)) throw e;
      retryAllowed = false;
      firstDraft.checks.flags.push({ code: "retry_skipped", severity: "flag", detail: e.detail ?? e.message });
    }
    if (retryAllowed) {
      retryCall = await callModel(provider, env, retryReq);
      if (retryCall.ok) {
        retryDraft = evaluate(retryCall, checkCtx, callbacks);
        // Still failing: keep whichever draft carries fewer retry flags; the retry wins a tie.
        if (retryDraft.text.trim() && retryDraft.retryFlags <= firstDraft.retryFlags) chosen = retryDraft;
      }
    }
  }

  // A [media: title] line names a library item (SPEC_V2 section V): the row when the
  // title matches, otherwise the marker is already gone and the reply is flagged.
  if (chosen.mediaTitle) {
    let found: Awaited<ReturnType<typeof resolveMediaTitle>> = null;
    try {
      found = await resolveMediaTitle(db, chosen.mediaTitle);
    } catch (e) {
      console.warn("media title lookup failed", errorClass(e));
    }
    if (found) chosen.mediaId = found.id;
    else chosen.checks.flags.push({ code: "media_unknown", severity: "flag", detail: "no library item titled " + JSON.stringify(chosen.mediaTitle.slice(0, 80)) });
  }

  // 8a. the model runs and their usage
  const runs: BuiltRun[] = [];
  const firstBuilt = buildRun(runKind, conversationId, settings, performer, promptVersion, first, firstDraft.checks.flags);
  runs.push(firstBuilt);
  firstDraft.runId = firstBuilt.run.id;
  let latencyMs = first.latencyMs;
  if (retryCall) {
    const retryBuilt = buildRun("retry", conversationId, settings, performer, promptVersion, retryCall, retryDraft ? retryDraft.checks.flags : []);
    runs.push(retryBuilt);
    if (retryDraft) retryDraft.runId = retryBuilt.run.id;
    latencyMs += retryCall.latencyMs;
  }

  return { draft: chosen, runs, latencyMs, retried: retryCall !== null, performer };
}

// A stored draft (a tasting candidate at pick time, SPEC_V3 section HH) in the shape
// commitReply takes, under a synthetic call (the tokens were metered when the draft was
// made). Its run rows were stored with the tasting, so it commits with an empty `runs`.
export function draftFromStored(args: { text: string; flags: Flag[]; photo: string | null; song: SongRef | null; runId: string; performer: Performer }): Draft {
  const flags = args.flags.slice();
  const checks: CheckResult = { flags, action: "accept" };
  return {
    call: { ok: true, result: { text: args.text, inputTokens: 0, outputTokens: 0, stopReason: "end", model: args.performer.model, provider: args.performer.provider }, latencyMs: 0 },
    text: args.text,
    photo: args.photo,
    song: args.song,
    voice: false,
    mediaTitle: null,
    checks,
    retryFlags: flags.filter((f) => f.severity === "retry").length,
    flags,
    raw: args.text,
    mediaId: null,
    runId: args.runId,
  };
}

// The same, as a Generated with no run rows to store.
export function generatedFromStored(args: { text: string; flags: Flag[]; photo: string | null; song: SongRef | null; runId: string; retried: boolean; performer: Performer }): Generated {
  return { draft: draftFromStored(args), runs: [], latencyMs: 0, retried: args.retried, performer: args.performer };
}

// ------------------------------------------------------------------ commit

// What the reply was built from (SPEC_V2 section L, SPEC_V3 every section): ids and
// counts, never prompt text.
function provenance(args: {
  state: PromptState;
  promptVersion: string;
  performer: Performer;
  recentMessageCount: number;
  flags: Flag[];
  runIds: string[];
  retried: boolean;
  deliverAt: string | null;
  song: SongRef | null;
  photoRequested: boolean;
  opener: boolean;
  voice: boolean;
  mediaId: string | null;
  imageCount: number;
  now: Date;
  replyText: string;
  tasting: Record<string, unknown> | null;
  callId: string | null;
}): Record<string, unknown> {
  const s = args.state;
  const recall = s.recall ?? null;
  const g = s.grounding;
  const mood = moodPhase(s.relationship, args.now, s.moodDaysDefault, s.relationshipSince ?? null);
  return {
    promptVersion: args.promptVersion,
    provider: args.performer.provider,
    model: args.performer.model,
    historyIds: s.history.map((h) => h.id),
    factIds: {
      avelie: s.avelieFacts.map((f) => f.id),
      justin: s.justinFacts.map((f) => f.id),
    },
    threadIds: s.life.threads.map((t) => t.id),
    callbacks: s.callbacks.map((c) => ({ sourceId: c.sourceId, ageDays: c.ageDays, text: c.text })),
    unknownIds: s.unknowns.map((u) => u.id),
    recentMessageCount: args.recentMessageCount,
    flags: args.flags.map((f) => f.code),
    mode: s.mode,
    runIds: args.runIds,
    retried: args.retried,
    deliverAt: args.deliverAt,
    song: args.song ? { artist: args.song.artist, title: args.song.title } : null,
    photoRequested: args.photoRequested,
    opener: args.opener,
    voice: args.voice,
    mediaId: args.mediaId,
    imageCount: args.imageCount,
    // v3 (SPEC_V3): AA, BB, CC, DD, GG, HH, EE and the turn's own key.
    turnKey: s.turnKey ?? null,
    turnTags: s.turnTags ?? [],
    exemplarIds: (s.exemplars ?? []).map((l) => l.id),
    correctionIds: (s.corrections ?? []).map((c) => c.id),
    recall: {
      provisional: recall ? { entity: recall.entity, entityId: recall.entityId, score: recall.score } : null,
      firmFactIds: s.justinFacts.map((f) => f.id),
      fadedCount: s.fadedFactCount ?? 0,
    },
    wantIds: (s.wants ?? []).map((w) => w.id),
    askIds: (s.asks ?? []).map((a) => a.id),
    weather: g ? g.weather !== null : false,
    outfitFrom: g && g.outfit ? g.outfit.from : null,
    groundingRowIds: g ? g.today.map((r) => r.id) : [],
    shapeCue: s.shapeCue ?? null,
    signature: signatureOf(args.replyText),
    moodPhase: mood,
    tasting: args.tasting,
    callId: args.callId,
  };
}

function signatureOf(text: string): string | null {
  try {
    return signature(text);
  } catch (e) {
    console.warn("signature skipped", errorClass(e));
    return null;
  }
}

// The memory rows this exchange touched (SPEC_V3 section BB): a fact, an entry, a person,
// place or arc, or a want whose keywords (two or more, or the subject word) appear in his
// message or her reply. At most ten (memory.findTouchHits).
function touchHits(state: PromptState, hisText: string, replyText: string): ReturnType<typeof findTouchHits> {
  const rows: TouchCandidate[] = [];
  for (const f of state.justinFacts) rows.push({ entity: "fact", entityId: f.id, text: f.fact, subject: f.subject, weight: 0.5 });
  for (const h of state.history) rows.push({ entity: "history", entityId: h.id, text: h.title + " " + h.body, weight: 0.7 });
  for (const t of state.life.threads) {
    if (t.kind === "person" || t.kind === "place" || t.kind === "arc") {
      rows.push({ entity: "thread", entityId: t.id, text: t.title + " " + (t.detail ?? ""), subject: t.title, weight: t.kind === "person" ? 0.6 : 0.5 });
    }
  }
  for (const w of state.wants ?? []) rows.push({ entity: "want", entityId: w.id, text: w.title, weight: 0.6 });
  return findTouchHits(rows, hisText, replyText, MAX_TOUCHES);
}

// The open asks she brought up again in this reply (SPEC_V3 section CC).
function askIdsBroughtUp(state: PromptState, replyText: string): string[] {
  const have = keywords(replyText);
  const out: string[] = [];
  for (const a of state.asks ?? []) {
    if (a && a.status === "open" && a.id && a.text && referenced("", a.text, have)) out.push(a.id);
  }
  return out;
}

// The memory_recalls row for the half-remembered detail shown this turn (section BB).
function recallRow(pick: NonNullable<PromptState["recall"]>, messageId: string, conversationId: string, at: string): Parameters<typeof recallStmt>[1] {
  return { messageId, conversationId, entity: pick.entity, entityId: pick.entityId, score: pick.score, textShown: pick.text, now: at };
}

// A v3 statement is built in a guard: a helper that throws costs its rows, never the turn.
function stmtsOfValue<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn("commit: " + name + " skipped", errorClass(e));
    return fallback;
  }
}

function stmtsOf(name: string, fn: () => D1PreparedStatement[]): D1PreparedStatement[] {
  const out = stmtsOfValue(name, fn, [] as D1PreparedStatement[]);
  return Array.isArray(out) ? out : [];
}

export interface CommitExtra {
  // The run the assistant row points at, when not the one that produced the draft.
  runIdOverride?: string;
  // The tasting this reply came from (SPEC_V3 section HH): its id, or the whole provenance
  // object ({ id, winner, loser }).
  tastingId?: string | null;
  tasting?: Record<string, unknown> | null;
  // A fixed deliver_at (ISO or null); absent = computed from her timing settings.
  deliverAt?: string | null;
  // The performer named in the provenance and the response when `runs` is empty (a pick).
  performer?: Performer;
  // The state the draft was actually generated from (a tasting pick, SPEC_V3 section HH:
  // "the same Prepared"): the state text as sent, the exemplars offered and the
  // half-remembered pick, stored with the tasting. The provenance row, the exemplar uses
  // and the recall row are written from these instead of the state rebuilt at pick time.
  stored?: StoredTurnContext;
}

// What a tasting keeps of the state its candidates saw (tastings.context_json).
export interface StoredTurnContext {
  stateText: string;
  exemplars: VoiceLine[];
  recall: RecallPick | null;
}

// The batch: the user row when new, the run rows, her row, the photo request, the
// provenance with its state text, the exemplar uses, the memory touches, the recall row,
// the asks she brought up again, the conversation touch. `runs` are the run rows to store
// with this reply (empty when they were stored earlier, as a tasting pick's were).
// Sequence numbers are read right before the batch; a collision with a concurrent turn
// fails the batch (unique index) and is recomputed once, with no new model call.
export async function commitReply(
  db: D1Database,
  prepared: Prepared,
  draft: Draft,
  runs: BuiltRun[],
  extra: CommitExtra = {},
): Promise<TurnResponse> {
  const { conversationId, settings, opener, existingUser, assembled, promptVersion, now } = prepared;
  const chosen = draft;
  const runStmts = runStatements(db, runs);
  const runIds = runs.map((r) => r.run.id);
  const chosenRunId = extra.runIdOverride ?? chosen.runId ?? runIds[runIds.length - 1] ?? null;
  const performer: Performer = extra.performer ?? (runs.length
    ? { provider: runs[0]!.run.provider as ProviderName, model: runs[0]!.run.model }
    : { provider: chosen.call.result.provider, model: chosen.call.result.model });
  const inputTokens = runs.reduce((n, r) => n + r.inputTokens, 0);
  const outputTokens = runs.reduce((n, r) => n + r.outputTokens, 0);
  const micro = runs.reduce((n, r) => n + r.micro, 0);
  const latencyMs = runs.reduce((n, r) => n + (r.run.latency_ms ?? 0), 0);
  const wantsVoice = voiceWanted(settings, chosen.voice);
  const mediaId = chosen.mediaId ?? null;
  const flags = chosen.checks.flags;
  const tasting: Record<string, unknown> | null = extra.tasting ?? (extra.tastingId ? { id: extra.tastingId } : null);
  // A pick commits the state its candidates were generated from, not the one rebuilt now.
  const state: PromptState = extra.stored
    ? { ...assembled.state, exemplars: extra.stored.exemplars, recall: extra.stored.recall }
    : assembled.state;
  const stateText = extra.stored ? extra.stored.stateText : prepared.stateText;

  // A requested photo is recorded now (the description lives on the request row) and
  // generated by the page's follow-up call: background work in a Worker is cut off 30 s
  // after the response, which is shorter than an image call. See images.ts.
  const assistantId = newId("m");
  const photoRequest: VisualAssetRow | null = chosen.photo
    ? photoRequestRow(conversationId, assistantId, chosen.photo, settings.imageProvider, settings.imageModel)
    : null;

  // Her timing (SPEC_V2 section B): in real mode the reply exists now and arrives later,
  // from her day when it says she is busy, otherwise a short jitter. An opener is hers to
  // send now. Never explained in-story.
  let deliverAt: string | null = null;
  if (extra.deliverAt !== undefined) {
    deliverAt = extra.deliverAt;
  } else if (!opener && settings.replyDelayMode === "real") {
    const at = computeDeliverAt(assembled.state.life.threads, now, assembled.state.life.tz, clampDelayMinutes(settings.realDelayMaxMinutes), assistantId);
    if (at instanceof Date && Number.isFinite(at.getTime()) && at.getTime() > now.getTime()) deliverAt = at.toISOString();
  }

  let userRow: MessageRow | null = opener ? null : existingUser ?? {
    id: newId("m"),
    conversation_id: conversationId,
    channel: "story",
    role: "user",
    content: prepared.text,
    created_at: nowIso(),
    seq: 0,
    idempotency_key: prepared.key,
    reply_to_id: null,
    model_run_id: null,
    flags_json: null,
    image_id: null,
    image_status: null,
    deliver_at: null,
    song_json: null,
  };
  let assistantRow: MessageRow = {
    id: assistantId,
    conversation_id: conversationId,
    channel: "story",
    role: "assistant",
    content: chosen.text,
    created_at: nowIso(),
    seq: 0,
    idempotency_key: null,
    reply_to_id: userRow ? userRow.id : null,
    model_run_id: chosenRunId,
    flags_json: JSON.stringify(flags),
    image_id: photoRequest ? photoRequest.id : null,
    image_status: photoRequest ? "pending" : null,
    deliver_at: deliverAt,
    song_json: chosen.song ? JSON.stringify(chosen.song) : null,
    audio_key: null,
    images_json: null,
    media_id: mediaId,
  };
  const context = provenance({
    state,
    promptVersion,
    performer,
    recentMessageCount: assembled.messages.length,
    flags,
    runIds: runIds.length ? runIds : chosenRunId ? [chosenRunId] : [],
    retried: runs.length > 1,
    deliverAt,
    song: chosen.song,
    photoRequested: photoRequest !== null,
    opener,
    voice: wantsVoice,
    mediaId,
    imageCount: prepared.pendingImages.length,
    now,
    replyText: chosen.text,
    tasting,
    callId: null,
  });

  // v3: the exemplar uses (AA), the memory touches and the recall row (BB), the asks she
  // brought up again (CC). Built per attempt with the attempt's stamp; the ids do not move.
  const hisText = opener ? "" : existingUser ? existingUser.content : prepared.text;
  const v3Stmts = (at: string): D1PreparedStatement[] => {
    const out: D1PreparedStatement[] = [];
    const exemplars = state.exemplars ?? [];
    if (exemplars.length) out.push(...stmtsOf("exemplar uses", () => useStmts(db, exemplars, assistantId, conversationId, at)));
    const hits = stmtsOfValue("memory touches", () => touchHits(state, hisText, chosen.text), []);
    if (hits.length) out.push(...stmtsOf("memory touches", () => touchStmts(db, hits, at)));
    if (state.recall) {
      const pick = state.recall;
      out.push(...stmtsOf("recall row", () => [recallStmt(db, recallRow(pick, assistantId, conversationId, at))]));
    }
    const askIds = askIdsBroughtUp(state, chosen.text);
    if (askIds.length) out.push(...stmtsOf("asks brought up", () => broughtUpStmts(db, askIds, at)));
    return out;
  };

  const buildCommit = async (): Promise<D1PreparedStatement[]> => {
    const t = nowIso();
    const stmts: D1PreparedStatement[] = [];
    let assistantSeq: number;
    if (existingUser || !userRow) {
      assistantSeq = await nextSeq(db, conversationId);
    } else {
      const seq = await nextSeq(db, conversationId);
      userRow = { ...userRow, created_at: t, seq };
      assistantSeq = seq + 1;
      stmts.push(insertMessageStmt(db, userRow));
    }
    assistantRow = { ...assistantRow, created_at: t, seq: assistantSeq };
    stmts.push(...runStmts);
    stmts.push(insertMessageStmt(db, assistantRow));
    if (photoRequest) stmts.push(insertAssetStmt(db, photoRequest));
    stmts.push(contextStmt(db, assistantRow.id, context, stateText));
    stmts.push(...v3Stmts(t));
    stmts.push(touchConversationStmt(db, conversationId, t));
    return stmts;
  };

  try {
    await db.batch(await buildCommit());
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    if (!existingUser && !opener) {
      // The same key landed from another request first: its pair stands, and this
      // run's spend is still recorded.
      const winner = await findByIdempotencyKey(db, prepared.key);
      if (winner && winner.role === "user" && winner.conversation_id === conversationId) {
        const reply = await findReply(db, winner.id);
        if (reply) {
          await recordRuns(db, runs);
          return replayed(db, winner, reply);
        }
      }
    }
    try {
      await db.batch(await buildCommit());
    } catch (e2) {
      // Still the key (a concurrent request holds the user row with no reply yet, a
      // tasting racing a plain turn): the spend is recorded and the caller hears why,
      // never a raw database error. A second seq collision on a resume is a real error.
      if (!isUniqueViolation(e2) || existingUser || opener) throw e2;
      await recordRuns(db, runs);
      throw new ApiHttpError(409, "idempotency_conflict", "idempotencyKey is in use by another request; retry with the same key once it settles", true);
    }
  }

  return {
    conversationId,
    userMessage: userRow,
    assistantMessage: assistantRow,
    deliverAt,
    run: {
      provider: performer.provider,
      model: performer.model,
      inputTokens,
      outputTokens,
      costUsd: micro / MICRO,
      latencyMs,
      promptVersion,
    },
    flags,
    imagePending: photoRequest !== null,
    replayed: false,
  };
}

// After the response: her voice note (SPEC_V2 section S) and the proposal pass, both best
// effort and short enough for the 30 s background window. The photo is generated on the
// page's follow-up request. A replayed response schedules nothing.
// `voice` is the draft's [voice] marker; whether a note is actually made follows the voice
// settings (voice mode all makes one for every reply, off never does).
export function afterReply(env: Env, ctx: ExecutionContext, db: D1Database, settings: Settings, response: TurnResponse, voice: boolean, actor: string): void {
  if (response.replayed) return;
  const assistantRow = response.assistantMessage;
  if (voiceWanted(settings, voice)) {
    ctx.waitUntil(
      attachVoiceNote(env, db, settings, { messageId: assistantRow.id, conversationId: response.conversationId, text: assistantRow.content, actor })
        .catch((e: unknown) => console.warn("voice note failed", errorClass(e))),
    );
  }
  if (settings.proposalsEnabled) {
    ctx.waitUntil(
      extractProposals(env, db, settings, response.conversationId, response.userMessage, assistantRow)
        .catch((e: unknown) => console.warn("proposal extraction failed", errorClass(e))),
    );
  }
}

// ------------------------------------------------------------------ the turn

export async function runTurn(
  env: Env,
  ctx: ExecutionContext,
  db: D1Database,
  settings: Settings,
  conversationId: string,
  content: string,
  idempotencyKey: string,
  actor: string,
  opts?: TurnOptions,
): Promise<TurnResponse> {
  const prepared = await prepareTurn(env, db, settings, conversationId, content, idempotencyKey, actor, opts);
  if (prepared.replay) return prepared.replay;
  let generated: Generated;
  try {
    generated = await generateDraft(env, db, settings, prepared);
  } catch (e) {
    // A call that produced nothing usable: its failed run row (with its usage when tokens
    // were spent), no messages, and the scene stays where it was.
    if (e instanceof GenerateFailure) await recordRuns(db, e.runs);
    throw e;
  }
  const response = await commitReply(db, prepared, generated.draft, generated.runs);
  afterReply(env, ctx, db, settings, response, generated.draft.voice, actor);
  return response;
}
