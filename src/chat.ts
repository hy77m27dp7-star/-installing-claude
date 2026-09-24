// The turn pipeline. One user message in, one of her messages out, or nothing at all:
// a failed or refused model call writes no reply and leaves the scene exactly where it was.
// Everything that lands does so in one batch.
import { assembleContext } from "./context";
import { getTextProvider, providerConfigured } from "./providers/index";
import { repairText, runChecks } from "./checks";
import { parsePhotoMarker, photoRequestRow } from "./images";
import { extractProposals } from "./proposals";
import { assertBudget, costMicro, estimateUsd } from "./budget";
import {
  dayKey, findByIdempotencyKey, getConversation, insertAssetStmt, insertMessageStmt, insertModelRunStmt, newId, nextSeq, nowIso,
  touchConversationStmt, usageStmt,
} from "./db";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import { safeErrorMessage } from "./providers/types";
import type {
  ChatMessage, CheckContext, CheckResult, Env, Flag, GenerateRequest, GenerateResult, MessageRow, ModelRunRow, PromptState, Settings,
  TextProvider, TurnResponse, VisualAssetRow,
} from "./types";

const MICRO = 1_000_000;
const MAX_CONTENT = 4000;
const KEY_MIN = 8;
const KEY_MAX = 80;

// A fact he told her that carries his name ("His name is Justin.").
const NAME_FACT_RE = /\b(?:his (?:first )?name is|he is called|he goes by)\s+([A-Za-z][A-Za-z'-]*)/i;

// One plain sentence per retry code, so the model can actually rewrite the draft.
const RETRY_RULES: Record<string, string> = {
  question_chain: "do not end this reply with a question; react, decide or disclose instead",
  name_overuse: "use his name once at most, or not at all",
  braking_repeat: "do not repeat the braking line from your recent replies (slow down, stay with me, don't rush, not so fast)",
  therapy_cadence: "drop the therapist phrasing (that sounds really hard, i hear you, thank you for sharing) and say the actual thought the way you text",
  menu_offer: "do not offer a menu of options (do you want me to, i can either); pick one and say it",
  tech_leak: "you are a person; nothing about prompts, models, apps, tokens, AI or how this conversation is produced can appear",
  dependency_hook: "no lines that bind him to you (don't leave me, i've been waiting for you, you're all i have); you are fine on your own",
  first_meeting_replay: "you two already know each other; do not introduce yourself or say nice to meet you",
};

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

type CallOk = { ok: true; result: GenerateResult; latencyMs: number };
type CallFailed = {
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

interface BuiltRun {
  run: ModelRunRow;
  micro: number;
  inputTokens: number;
  outputTokens: number;
}

function buildRun(
  kind: "turn" | "retry",
  conversationId: string,
  settings: Settings,
  promptVersion: string,
  call: Call,
  flags: Flag[],
): BuiltRun {
  const res = call.result;
  const inputTokens = res ? Math.max(0, res.inputTokens) : 0;
  const outputTokens = res ? Math.max(0, res.outputTokens) : 0;
  const cost = res ? costMicro(settings, settings.model, inputTokens, outputTokens) : { micro: 0, priceKnown: true };
  const runFlags: Flag[] = [...flags];
  if (!cost.priceKnown) runFlags.push({ code: "price_unknown", severity: "flag", detail: "no price for model " + settings.model });
  const run: ModelRunRow = {
    id: newId("r"),
    conversation_id: conversationId,
    kind,
    provider: settings.provider,
    model: settings.model,
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
  return { run, micro: cost.micro, inputTokens, outputTokens };
}

// A call that produced nothing usable: one failed run row (with its usage when tokens
// were spent), no messages, and the scene stays where it was.
async function recordFailedTurn(db: D1Database, settings: Settings, conversationId: string, promptVersion: string, call: CallFailed): Promise<void> {
  const built = buildRun("turn", conversationId, settings, promptVersion, call, []);
  const stmts: D1PreparedStatement[] = [insertModelRunStmt(db, built.run)];
  if (call.result) {
    stmts.push(usageStmt(db, dayKey(), settings.provider, settings.model, built.inputTokens, built.outputTokens, built.micro));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    console.error("model run not recorded", errorClass(e));
  }
}

interface Draft {
  call: CallOk;
  text: string;
  photo: string | null;
  checks: CheckResult;
  retryFlags: number;
}

// Marker off, checks on, mechanical repair applied when the checks asked for one.
function evaluate(call: CallOk, checkCtx: CheckContext): Draft {
  const { clean, description } = parsePhotoMarker(call.result.text);
  const checks = runChecks(clean, checkCtx);
  if (call.result.stopReason === "max_tokens") {
    checks.flags.push({ code: "truncated", severity: "flag", detail: "reply stopped at max_tokens" });
  }
  let text = clean;
  const needsRepair = checks.action === "repair" || checks.repaired !== undefined;
  if (needsRepair) {
    const repaired = checks.repaired !== undefined ? checks.repaired : repairText(clean);
    if (repaired.trim()) text = repaired;
  }
  return { call, text, photo: description, checks, retryFlags: checks.flags.filter((f) => f.severity === "retry").length };
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
): Promise<TurnResponse> {
  // 1. validate
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new ApiHttpError(400, "validation", "content is required");
  if (text.length > MAX_CONTENT) throw new ApiHttpError(400, "validation", `content exceeds ${MAX_CONTENT} characters`);
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (key.length < KEY_MIN || key.length > KEY_MAX) {
    throw new ApiHttpError(400, "validation", `idempotencyKey must be ${KEY_MIN} to ${KEY_MAX} characters`);
  }
  if (typeof conversationId !== "string" || !conversationId) throw new ApiHttpError(400, "validation", "conversationId is required");
  const conv = await getConversation(db, conversationId);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  if (conv.status !== "active") throw new ApiHttpError(400, "validation", "conversation is not active");

  // 2. idempotency
  let existingUser: MessageRow | null = null;
  const prior = await findByIdempotencyKey(db, key);
  if (prior) {
    if (prior.conversation_id !== conversationId || prior.role !== "user") {
      throw new ApiHttpError(409, "idempotency_conflict", "idempotencyKey was already used elsewhere");
    }
    const reply = await findReply(db, prior.id);
    if (reply) return replayed(db, prior, reply);
    existingUser = prior;
  }
  const userText = existingUser ? existingUser.content : text;

  if (!providerConfigured(env, settings.provider)) {
    throw new ApiHttpError(503, "provider_not_configured", `${settings.provider} is not configured`, false);
  }
  let provider: TextProvider;
  try {
    provider = getTextProvider(settings.provider);
  } catch (e) {
    throw new ApiHttpError(503, "provider_not_configured", "unknown provider", false, errorClass(e));
  }

  // 4. context (read only), then 3. budget from the real prompt size; nothing is written yet
  const assembled = await assembleContext(db, conversationId, settings, userText, existingUser ? existingUser.id : null);
  const inputChars = assembled.system.length + assembled.messages.reduce((n, m) => n + m.content.length, 0);
  await assertBudget(db, settings, estimateUsd(settings, settings.model, inputChars, settings.maxTokens));

  const promptVersion = assembled.promptVersion;
  const req: GenerateRequest = {
    system: assembled.system,
    messages: assembled.messages,
    model: settings.model,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    effort: settings.effort,
    cacheable: true,
  };

  // 5. generate
  const first = await callModel(provider, env, req);
  if (!first.ok) {
    await recordFailedTurn(db, settings, conversationId, promptVersion, first);
    if (first.status === "refused") throw new ApiHttpError(502, "provider_refused", "the model refused this turn", false);
    throw new ApiHttpError(502, "provider_failed", "the model call failed", first.retryable, first.errorClass);
  }

  // 6 + 7. photo marker, checks
  const checkCtx: CheckContext = {
    hasSharedHistory: assembled.state.hasSharedHistory,
    knownName: knownNameFrom(assembled.state),
    recentAssistantTexts: assembled.recentAssistantTexts,
    openUnknownTopics: assembled.state.unknowns.map((u) => u.topic),
    channel: "story",
  };
  const firstDraft = evaluate(first, checkCtx);
  if (!firstDraft.text.trim()) {
    // A marker-only reply: nothing to show him, nothing that may enter the transcript.
    await recordFailedTurn(db, settings, conversationId, promptVersion, {
      ok: false, status: "failed", errorClass: "empty_reply", retryable: true, result: first.result, latencyMs: first.latencyMs,
    });
    throw new ApiHttpError(502, "provider_failed", "the model call failed", true, "empty_reply");
  }
  let chosen = firstDraft;
  let retryCall: Call | null = null;
  let retryDraft: Draft | null = null;

  if (firstDraft.checks.action === "retry") {
    const retryReq: GenerateRequest = { ...req, messages: retryMessages(req.messages, first.result.text, firstDraft.checks.flags) };
    // The retry is a second full call, gated like the first. The first call's own cost is
    // not on the meter yet (it is committed below), so it is counted into this estimate.
    // Over a cap the retry is skipped, the first draft stands, and the message says so.
    const firstCostUsd = costMicro(settings, settings.model, Math.max(0, first.result.inputTokens), Math.max(0, first.result.outputTokens)).micro / MICRO;
    const retryChars = retryReq.system.length + retryReq.messages.reduce((n, m) => n + m.content.length, 0);
    let retryAllowed = true;
    try {
      await assertBudget(db, settings, firstCostUsd + estimateUsd(settings, settings.model, retryChars, settings.maxTokens));
    } catch (e) {
      if (!(e instanceof ApiHttpError && e.status === 402)) throw e;
      retryAllowed = false;
      firstDraft.checks.flags.push({ code: "retry_skipped", severity: "flag", detail: e.detail ?? e.message });
    }
    if (retryAllowed) {
      retryCall = await callModel(provider, env, retryReq);
      if (retryCall.ok) {
        retryDraft = evaluate(retryCall, checkCtx);
        // Still failing: keep whichever draft carries fewer retry flags; the retry wins a tie.
        if (retryDraft.text.trim() && retryDraft.retryFlags <= firstDraft.retryFlags) chosen = retryDraft;
      }
    }
  }

  // 8. commit: the model runs and their usage, then the messages around them
  const runStmts: D1PreparedStatement[] = [];
  const firstBuilt = buildRun("turn", conversationId, settings, promptVersion, first, firstDraft.checks.flags);
  runStmts.push(insertModelRunStmt(db, firstBuilt.run));
  runStmts.push(usageStmt(db, dayKey(), settings.provider, settings.model, firstBuilt.inputTokens, firstBuilt.outputTokens, firstBuilt.micro));
  let chosenRunId = firstBuilt.run.id;
  let inputTokens = firstBuilt.inputTokens;
  let outputTokens = firstBuilt.outputTokens;
  let micro = firstBuilt.micro;
  let latencyMs = first.latencyMs;

  if (retryCall) {
    const retryBuilt = buildRun("retry", conversationId, settings, promptVersion, retryCall, retryDraft ? retryDraft.checks.flags : []);
    runStmts.push(insertModelRunStmt(db, retryBuilt.run));
    if (retryCall.result) {
      runStmts.push(usageStmt(db, dayKey(), settings.provider, settings.model, retryBuilt.inputTokens, retryBuilt.outputTokens, retryBuilt.micro));
    }
    if (chosen === retryDraft) chosenRunId = retryBuilt.run.id;
    inputTokens += retryBuilt.inputTokens;
    outputTokens += retryBuilt.outputTokens;
    micro += retryBuilt.micro;
    latencyMs += retryCall.latencyMs;
  }

  // A requested photo is recorded now (the description lives on the request row) and
  // generated by the page's follow-up call: background work in a Worker is cut off 30 s
  // after the response, which is shorter than an image call. See images.ts.
  const assistantId = newId("m");
  const photoRequest: VisualAssetRow | null = chosen.photo
    ? photoRequestRow(conversationId, assistantId, chosen.photo, settings.imageProvider, settings.imageModel)
    : null;

  let userRow: MessageRow = existingUser ?? {
    id: newId("m"),
    conversation_id: conversationId,
    channel: "story",
    role: "user",
    content: text,
    created_at: nowIso(),
    seq: 0,
    idempotency_key: key,
    reply_to_id: null,
    model_run_id: null,
    flags_json: null,
    image_id: null,
    image_status: null,
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
    reply_to_id: userRow.id,
    model_run_id: chosenRunId,
    flags_json: JSON.stringify(chosen.checks.flags),
    image_id: photoRequest ? photoRequest.id : null,
    image_status: photoRequest ? "pending" : null,
  };

  // Sequence numbers are read right before the batch; a collision with a concurrent
  // turn fails the batch (unique index) and is recomputed once, with no new model call.
  const buildCommit = async (): Promise<D1PreparedStatement[]> => {
    const t = nowIso();
    const stmts: D1PreparedStatement[] = [];
    let assistantSeq: number;
    if (existingUser) {
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
    stmts.push(touchConversationStmt(db, conversationId, t));
    return stmts;
  };

  try {
    await db.batch(await buildCommit());
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    if (!existingUser) {
      // The same key landed from another request first: its pair stands, and this
      // run's spend is still recorded.
      const winner = await findByIdempotencyKey(db, key);
      if (winner && winner.role === "user" && winner.conversation_id === conversationId) {
        const reply = await findReply(db, winner.id);
        if (reply) {
          try {
            await db.batch(runStmts);
          } catch (e2) {
            console.error("model run not recorded", errorClass(e2));
          }
          return replayed(db, winner, reply);
        }
      }
    }
    await db.batch(await buildCommit());
  }

  // 9. respond
  const response: TurnResponse = {
    conversationId,
    userMessage: userRow,
    assistantMessage: assistantRow,
    run: {
      provider: settings.provider,
      model: settings.model,
      inputTokens,
      outputTokens,
      costUsd: micro / MICRO,
      latencyMs,
      promptVersion,
    },
    flags: chosen.checks.flags,
    imagePending: photoRequest !== null,
    replayed: false,
  };

  // 10. after the response: the proposal pass, best effort and short enough for the
  // 30 s background window. The photo is generated on the page's follow-up request.
  if (settings.proposalsEnabled) {
    ctx.waitUntil(
      extractProposals(env, db, settings, conversationId, userRow, assistantRow)
        .catch((e: unknown) => console.warn("proposal extraction failed", errorClass(e))),
    );
  }

  return response;
}
