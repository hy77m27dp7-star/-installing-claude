// The operator channel: the one place technical truth is spoken. Deterministic facts first
// (systemInfo), then an optional model call that never speaks in her voice. Operator
// messages are stored with channel "operator" and are never read by story context assembly.
//
// v3 (SPEC_V3 II): the console is a judgment job and runs on the proposal performer
// (settings.proposalProvider and proposalModel), never on her performer, so judgment stays
// on Claude while a fine-tuned texter is live. The counts gain the v3 tables.
import { CONSTITUTION_VERSION } from "./generated/constitution";
import { PROMPT_VERSION, operatorSystemPrompt } from "./prompt";
import { assertBudget, costMicro, estimateUsd, usageSummary } from "./budget";
import { finetuneStatus } from "./finetune";
import { getTextProvider, providerConfigured } from "./providers/index";
import { boundMessages } from "./context";
import { ApiHttpError } from "./errors";
import {
  dayKey, getConversation, getCurrentState, insertMessageStmt, insertModelRunStmt, newId, nextSeq, nowIso,
  touchConversationStmt, usageStmt,
} from "./db";
import { ProviderError } from "./types";
import type { ChatMessage, Env, MessageRow, ModelRunRow, RelationshipState, SceneState, Settings } from "./types";

const OPERATOR_MAX_TOKENS = 600;
const OPERATOR_HISTORY = 10;
const OPERATOR_MAX_CHARS = 16_000;

// ------------------------------------------------------------------ facts

export async function systemInfo(env: Env, db: D1Database, settings: Settings): Promise<Record<string, unknown>> {
  const countSql = [
    "SELECT COUNT(*) AS n FROM conversations WHERE status != 'deleted'",
    "SELECT COUNT(*) AS n FROM messages",
    "SELECT COUNT(*) AS n FROM facts WHERE status = 'approved'",
    "SELECT COUNT(*) AS n FROM history WHERE status = 'approved'",
    "SELECT COUNT(*) AS n FROM unknowns WHERE status = 'open'",
    "SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'",
    "SELECT COUNT(*) AS n FROM visual_assets WHERE approval_status = 'candidate'",
  ];
  // v3 counts, in their own batch: a database behind migration 0005 answers zeros here
  // instead of failing the whole read.
  const v3Sql = [
    "SELECT COUNT(*) AS n FROM voice_lines WHERE status = 'unapproved'",
    "SELECT COUNT(*) AS n FROM voice_lines WHERE status = 'approved'",
    "SELECT COUNT(*) AS n FROM corrections WHERE status = 'active'",
    "SELECT COUNT(*) AS n FROM wants WHERE status = 'active'",
    "SELECT COUNT(*) AS n FROM asks WHERE status = 'open'",
    "SELECT COUNT(*) AS n FROM calls WHERE started_at >= ?1",
    "SELECT COUNT(*) AS n FROM tastings WHERE status = 'pending'",
  ];
  const [counts, spend, rel, scene, v3Counts, finetune] = await Promise.all([
    db.batch<{ n: number }>(countSql.map((s) => db.prepare(s))),
    usageSummary(db, settings),
    getCurrentState<RelationshipState>(db, "relationship"),
    getCurrentState<SceneState>(db, "scene"),
    db.batch<{ n: number }>(v3Sql.map((s) => (s.includes("?1") ? db.prepare(s).bind(dayKey()) : db.prepare(s)))).catch(() => null),
    finetuneStatus(db, settings).catch(() => null),
  ]);
  const n = (i: number): number => Number(counts[i]?.results[0]?.n ?? 0);
  const v = (i: number): number => Number(v3Counts?.[i]?.results[0]?.n ?? 0);
  return {
    constitutionVersion: CONSTITUTION_VERSION,
    promptVersion: PROMPT_VERSION,
    settings: { ...settings },
    providerKeys: { anthropic: !!env.ANTHROPIC_API_KEY, openai: !!env.OPENAI_API_KEY, runway: !!env.RUNWAY_API_KEY },
    counts: {
      conversations: n(0),
      messages: n(1),
      facts: n(2),
      history: n(3),
      unknowns: n(4),
      pendingProposals: n(5),
      candidates: n(6),
      // v3 (SPEC_V3 "Routes added")
      voiceLinesUnapproved: v(0),
      voiceLinesApproved: v(1),
      correctionsActive: v(2),
      wantsActive: v(3),
      asksOpen: v(4),
      callsToday: v(5),
      tastingsPending: v(6),
      finetuneApproved: finetune ? finetune.approved : 0,
    },
    spend: {
      todayUsd: spend.todayUsd,
      monthUsd: spend.monthUsd,
      dailyCapUsd: spend.dailyCapUsd,
      monthlyCapUsd: spend.monthlyCapUsd,
    },
    state: {
      relationship: { version: rel.version, state: rel.state },
      scene: { version: scene.version, state: scene.state },
    },
  };
}

// ------------------------------------------------------------------ helpers

async function operatorHistory(db: D1Database, conversationId: string): Promise<ChatMessage[]> {
  const r = await db.prepare("SELECT role, content FROM messages WHERE conversation_id = ?1 AND channel = 'operator' ORDER BY seq DESC LIMIT ?2")
    .bind(conversationId, OPERATOR_HISTORY).all<{ role: MessageRow["role"]; content: string }>();
  return r.results.reverse().map((m) => ({ role: m.role, content: m.content }));
}

// Owner typography for the console: " -- " and "..." only. The characters are built from
// code points so this source stays pure ASCII.
const ELLIPSIS_RE = new RegExp(String.fromCodePoint(0x2026), "g");
const DASH_RE = new RegExp("\\s*[" + String.fromCodePoint(0x2014) + String.fromCodePoint(0x2013) + "]+\\s*", "g");
function tidy(text: string): string {
  return text.replace(ELLIPSIS_RE, "...").replace(DASH_RE, " -- ").trim();
}

function errorClass(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof Error) return e.name || "Error";
  return "error";
}

function runRow(base: Omit<ModelRunRow, "status" | "error" | "latency_ms">, status: ModelRunRow["status"], error: string | null, started: number): ModelRunRow {
  return { ...base, status, error, latency_ms: Date.now() - started };
}

// ------------------------------------------------------------------ the turn

export async function operatorTurn(
  env: Env,
  db: D1Database,
  settings: Settings,
  content: string,
  conversationId: string | null,
  actor: string,
): Promise<{ reply: string; info: Record<string, unknown> }> {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new ApiHttpError(400, "validation", "content is required");
  if (text.length > 4000) throw new ApiHttpError(400, "validation", "content exceeds 4000 characters");
  if (conversationId !== null && conversationId !== undefined) {
    if (typeof conversationId !== "string" || !conversationId) throw new ApiHttpError(400, "validation", "conversationId must be a string");
    const conv = await getConversation(db, conversationId);
    if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  } else {
    conversationId = null;
  }

  const info = await systemInfo(env, db, settings);
  // The judgment performer (v3): the console never runs on her performer.
  const judgeProvider = settings.proposalProvider;
  const useModel = judgeProvider !== "stub" && providerConfigured(env, judgeProvider);

  let reply: string;
  let run: ModelRunRow | null = null;
  let usage: D1PreparedStatement | null = null;

  if (useModel) {
    const provider = getTextProvider(judgeProvider);
    const model = settings.proposalModel;
    const system = operatorSystemPrompt(info);
    const prior = conversationId ? await operatorHistory(db, conversationId) : [];
    const messages = boundMessages([...prior, { role: "user", content: text }], OPERATOR_MAX_CHARS);
    const inputChars = system.length + messages.reduce((s, m) => s + m.content.length, 0);
    await assertBudget(db, settings, estimateUsd(settings, model, inputChars, OPERATOR_MAX_TOKENS));

    const started = Date.now();
    const base: Omit<ModelRunRow, "status" | "error" | "latency_ms"> = {
      id: newId("r"),
      conversation_id: conversationId,
      kind: "operator",
      provider: judgeProvider,
      model,
      prompt_version: PROMPT_VERSION,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd_micro: 0,
      flags_json: null,
      created_at: nowIso(),
    };

    let result;
    try {
      result = await provider.generate(env, {
        system,
        messages,
        model,
        maxTokens: OPERATOR_MAX_TOKENS,
        temperature: 0.2,
        effort: "low",
        cacheable: false,
      });
    } catch (e) {
      const cls = errorClass(e);
      try { await insertModelRunStmt(db, runRow(base, "failed", cls, started)).run(); } catch { /* best effort */ }
      const retryable = e instanceof ProviderError ? e.retryable : true;
      throw new ApiHttpError(502, "provider_failed", "the model call failed", retryable, cls);
    }

    const cost = costMicro(settings, model, result.inputTokens, result.outputTokens);
    const withTokens = {
      ...base,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_usd_micro: cost.micro,
      flags_json: cost.priceKnown ? null : JSON.stringify(["price_unknown"]),
    };
    if (result.stopReason === "refusal") {
      try {
        await db.batch([
          insertModelRunStmt(db, runRow(withTokens, "refused", "refusal", started)),
          usageStmt(db, dayKey(), judgeProvider, model, result.inputTokens, result.outputTokens, cost.micro),
        ]);
      } catch { /* best effort */ }
      throw new ApiHttpError(502, "provider_refused", "the model refused", false);
    }
    run = runRow(withTokens, "ok", null, started);
    usage = usageStmt(db, dayKey(), judgeProvider, model, result.inputTokens, result.outputTokens, cost.micro);
    reply = tidy(result.text);
    if (!reply) reply = JSON.stringify(info, null, 2);
  } else {
    reply = JSON.stringify(info, null, 2);
  }

  const userId = newId("m");
  const assistantId = newId("m");
  const build = async (): Promise<D1PreparedStatement[]> => {
    const stmts: D1PreparedStatement[] = [];
    if (conversationId) {
      const seq = await nextSeq(db, conversationId);
      const t = nowIso();
      const userRow: MessageRow = {
        id: userId,
        conversation_id: conversationId,
        channel: "operator",
        role: "user",
        content: text,
        created_at: t,
        seq,
        idempotency_key: null,
        reply_to_id: null,
        model_run_id: null,
        flags_json: null,
        image_id: null,
        image_status: null,
      };
      const assistantRow: MessageRow = {
        ...userRow,
        id: assistantId,
        role: "assistant",
        content: reply,
        seq: seq + 1,
        reply_to_id: userRow.id,
        model_run_id: run ? run.id : null,
      };
      stmts.push(insertMessageStmt(db, userRow), insertMessageStmt(db, assistantRow), touchConversationStmt(db, conversationId, t));
    }
    if (run) stmts.push(insertModelRunStmt(db, run));
    if (usage) stmts.push(usage);
    return stmts;
  };

  const stmts = await build();
  if (stmts.length) {
    try {
      await db.batch(stmts);
    } catch (e) {
      // A seq taken by a story turn landing at the same moment: recompute once.
      if (!(e instanceof Error && /UNIQUE constraint failed/i.test(e.message))) throw e;
      await db.batch(await build());
    }
  }

  return { reply, info };
}
