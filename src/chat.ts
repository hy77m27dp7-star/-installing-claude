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
import type {
  CheckContext, CheckResult, Env, Flag, GenerateRequest, GenerateResult, MessageRow, ModelRunRow, Settings, TextProvider,
  TurnResponse, VisualAssetRow,
} from "./types";

const MICRO = 1_000_000;
const MAX_CONTENT = 4000;
const KEY_MIN = 8;
const KEY_MAX = 80;

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
  let text = clean;
  const needsRepair = checks.action === "repair" || checks.repaired !== undefined;
  if (needsRepair) {
    const repaired = checks.repaired !== undefined ? checks.repaired : repairText(clean);
    if (repaired.trim()) text = repaired;
  }
  return { call, text, photo: description, checks, retryFlags: checks.flags.filter((f) => f.severity === "retry").length };
}

function retryNote(system: string, flags: Flag[]): string {
  const codes = Array.from(new Set(flags.filter((f) => f.severity === "retry").map((f) => f.code)));
  return system
    + "\n\nOPERATOR NOTE (not part of the story): your previous draft was rejected for: " + codes.join(", ")
    + ". Rewrite it as Avelie with the same substance and none of those problems. Output only the message.";
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
    const reply = await db
      .prepare("SELECT * FROM messages WHERE reply_to_id = ?1 AND role = 'assistant' ORDER BY seq ASC LIMIT 1")
      .bind(prior.id)
      .first<MessageRow>();
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
  const assembled = await assembleContext(db, conversationId, settings, userText);
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
    const built = buildRun("turn", conversationId, settings, promptVersion, first, []);
    const stmts: D1PreparedStatement[] = [insertModelRunStmt(db, built.run)];
    if (first.result) {
      stmts.push(usageStmt(db, dayKey(), settings.provider, settings.model, built.inputTokens, built.outputTokens, built.micro));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      console.error("model run not recorded", errorClass(e));
    }
    if (first.status === "refused") throw new ApiHttpError(502, "provider_refused", "the model refused this turn", false);
    throw new ApiHttpError(502, "provider_failed", "the model call failed", first.retryable, first.errorClass);
  }

  // 6 + 7. photo marker, checks
  const relationship = assembled.state.relationship;
  const checkCtx: CheckContext = {
    hasSharedHistory: assembled.state.hasSharedHistory,
    knownName: typeof relationship.his_name === "string" && relationship.his_name.trim() ? relationship.his_name.trim() : null,
    recentAssistantTexts: assembled.recentAssistantTexts,
    openUnknownTopics: assembled.state.unknowns.map((u) => u.topic),
    channel: "story",
  };
  const firstDraft = evaluate(first, checkCtx);
  let chosen = firstDraft;
  let retryCall: Call | null = null;
  let retryDraft: Draft | null = null;

  if (firstDraft.checks.action === "retry") {
    retryCall = await callModel(provider, env, { ...req, system: retryNote(assembled.system, firstDraft.checks.flags) });
    if (retryCall.ok) {
      retryDraft = evaluate(retryCall, checkCtx);
      // Still failing: keep whichever draft carries fewer retry flags; the retry wins a tie.
      if (retryDraft.retryFlags <= firstDraft.retryFlags) chosen = retryDraft;
    }
  }

  // 8. commit
  const t = nowIso();
  const stmts: D1PreparedStatement[] = [];
  let userRow: MessageRow;
  let assistantSeq: number;
  if (existingUser) {
    userRow = existingUser;
    assistantSeq = await nextSeq(db, conversationId);
  } else {
    const seq = await nextSeq(db, conversationId);
    userRow = {
      id: newId("m"),
      conversation_id: conversationId,
      channel: "story",
      role: "user",
      content: text,
      created_at: t,
      seq,
      idempotency_key: key,
      reply_to_id: null,
      model_run_id: null,
      flags_json: null,
      image_id: null,
      image_status: null,
    };
    assistantSeq = seq + 1;
    stmts.push(insertMessageStmt(db, userRow));
  }

  const firstBuilt = buildRun("turn", conversationId, settings, promptVersion, first, firstDraft.checks.flags);
  stmts.push(insertModelRunStmt(db, firstBuilt.run));
  stmts.push(usageStmt(db, dayKey(), settings.provider, settings.model, firstBuilt.inputTokens, firstBuilt.outputTokens, firstBuilt.micro));
  let chosenRunId = firstBuilt.run.id;
  let inputTokens = firstBuilt.inputTokens;
  let outputTokens = firstBuilt.outputTokens;
  let micro = firstBuilt.micro;
  let latencyMs = first.latencyMs;

  if (retryCall) {
    const retryBuilt = buildRun("retry", conversationId, settings, promptVersion, retryCall, retryDraft ? retryDraft.checks.flags : []);
    stmts.push(insertModelRunStmt(db, retryBuilt.run));
    if (retryCall.result) {
      stmts.push(usageStmt(db, dayKey(), settings.provider, settings.model, retryBuilt.inputTokens, retryBuilt.outputTokens, retryBuilt.micro));
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
  const assistantRow: MessageRow = {
    id: assistantId,
    conversation_id: conversationId,
    channel: "story",
    role: "assistant",
    content: chosen.text,
    created_at: t,
    seq: assistantSeq,
    idempotency_key: null,
    reply_to_id: userRow.id,
    model_run_id: chosenRunId,
    flags_json: JSON.stringify(chosen.checks.flags),
    image_id: photoRequest ? photoRequest.id : null,
    image_status: photoRequest ? "pending" : null,
  };
  stmts.push(insertMessageStmt(db, assistantRow));
  if (photoRequest) stmts.push(insertAssetStmt(db, photoRequest));
  stmts.push(touchConversationStmt(db, conversationId, t));
  await db.batch(stmts);

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
