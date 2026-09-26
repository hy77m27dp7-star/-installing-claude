// The nightly story pass's shared paid call and filing helpers (SPEC_V5 section 1).
//
// Every pass (her day, arcs, views, hygiene) makes its model call through paidJsonCall: the
// daily and monthly caps (src/budget.ts, an unpriced model refused), plus the night's own
// budget line (nightlyBudgetUsd), metered as a model run of kind "nightly" with the step in
// flags_json. Whatever a pass decides is filed through fileNightlyProposals as a proposal
// with a source: nothing a model says is written to a story table directly.
//
// No pass imports another pass, and nothing here imports src/proposals.ts (which imports the
// passes' promotion helpers), so the module graph has no cycle through this file.
import { assertBudget, costMicro, estimateUsd } from "./budget";
import { DEPENDENCY_PHRASES, TECH_LEAK_TERMS, findPhrase } from "./checks";
import { dayKey, insertModelRunStmt, insertProposalStmt, newId, nowIso, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { getTextProvider, providerConfigured } from "./providers/index";
import { saidLine } from "./said";
import type { Env, GenerateResult, ModelRunRow, ProposalKind, ProposalRow, ProviderName, Settings } from "./types";

export type NightlyTag = "her_day" | "arcs" | "views" | "hygiene_merge" | "hygiene_inferred";

export interface NightlyBudget { limitUsd: number; spentUsd: number; stopped: string | null; runIds: string[] }

export const NIGHTLY_BUDGET_DEFAULT_USD = 0.25;
export const NIGHTLY_BUDGET_MAX_USD = 5;
export const NIGHTLY_REFILE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MICRO = 1_000_000;

export function newNightlyBudget(limitUsd: unknown): NightlyBudget {
  const limit = typeof limitUsd === "number" && Number.isFinite(limitUsd)
    ? Math.min(NIGHTLY_BUDGET_MAX_USD, Math.max(0, limitUsd))
    : NIGHTLY_BUDGET_DEFAULT_USD;
  return { limitUsd: limit, spentUsd: 0, stopped: null, runIds: [] };
}

export interface PaidJsonCall {
  tag: NightlyTag;
  provider: ProviderName;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

export type PaidJsonResult = { ok: true; text: string; costUsd: number; runId: string } | { ok: false; reason: string };

function errorClass(e: unknown): string {
  return e instanceof Error ? e.name || "Error" : "error";
}

export async function paidJsonCall(env: Env, db: D1Database, settings: Settings, budget: NightlyBudget, call: PaidJsonCall): Promise<PaidJsonResult> {
  if (budget.stopped) return { ok: false, reason: budget.stopped };
  if (!providerConfigured(env, call.provider)) return { ok: false, reason: "provider_not_configured" };

  let estimate: number;
  try {
    estimate = estimateUsd(settings, call.model, call.system.length + call.user.length, call.maxTokens);
  } catch (e) {
    if (e instanceof ApiHttpError && e.status === 402) return { ok: false, reason: "price_unknown" };
    throw e;
  }
  if (budget.spentUsd + estimate > budget.limitUsd) {
    budget.stopped = "nightly budget";
    return { ok: false, reason: budget.stopped };
  }
  try {
    await assertBudget(db, settings, estimate);
  } catch (e) {
    if (e instanceof ApiHttpError && e.status === 402) {
      budget.stopped = "caps";
      return { ok: false, reason: budget.stopped };
    }
    throw e;
  }

  const runId = newId("r");
  const started = Date.now();
  const base: ModelRunRow = {
    id: runId,
    conversation_id: null,
    kind: "nightly",
    provider: call.provider,
    model: call.model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: null,
    status: "ok",
    error: null,
    flags_json: JSON.stringify(["nightly:" + call.tag]),
    created_at: nowIso(),
  };

  let result: GenerateResult;
  try {
    result = await getTextProvider(call.provider).generate(env, {
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      model: call.model,
      maxTokens: call.maxTokens,
      temperature: typeof call.temperature === "number" && Number.isFinite(call.temperature) ? call.temperature : 0.3,
      effort: "low",
      cacheable: false,
    });
  } catch (e) {
    const failed: ModelRunRow = { ...base, latency_ms: Date.now() - started, status: "failed", error: errorClass(e) };
    try {
      await insertModelRunStmt(db, failed).run();
    } catch {
      /* the run log is best effort */
    }
    console.warn("nightly: provider failed", call.tag, errorClass(e));
    return { ok: false, reason: "provider_failed" };
  }

  const cost = costMicro(settings, call.model, result.inputTokens, result.outputTokens);
  const refused = result.stopReason === "refusal";
  const run: ModelRunRow = {
    ...base,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    cost_usd_micro: cost.micro,
    latency_ms: Date.now() - started,
    status: refused ? "refused" : "ok",
  };
  try {
    await db.batch([
      insertModelRunStmt(db, run),
      usageStmt(db, dayKey(), call.provider, call.model, result.inputTokens, result.outputTokens, cost.micro),
    ]);
  } catch (e) {
    // The money is spent either way; the night's own line still counts it.
    console.error("nightly: run not recorded", call.tag, errorClass(e));
  }
  const costUsd = cost.micro / MICRO;
  budget.spentUsd += costUsd;
  budget.runIds.push(runId);
  return { ok: true, text: refused ? "[]" : result.text, costUsd, runId };
}

// ------------------------------------------------------------------ tolerant JSON

function stripFences(text: string): string {
  return text.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "");
}

export function parseJsonArray(text: string): unknown[] {
  if (typeof text !== "string") return [];
  const body = stripFences(text);
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const v: unknown = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const body = stripFences(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const v: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// One plain line a pass may file: plain typography, capped, at least three characters, and
// never a word about the machinery or a dependency hook.
export function cleanLine(text: unknown, max: number): string | null {
  const line = saidLine(text, max);
  if (line.length < 3) return null;
  if (findPhrase(line, TECH_LEAK_TERMS) !== null) return null;
  if (findPhrase(line, DEPENDENCY_PHRASES) !== null) return null;
  return line;
}

// ------------------------------------------------------------------ filing

export interface NightlyProposal {
  kind: ProposalKind;
  proposal: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
  payload: Record<string, unknown>;
  weight?: number;
  source: string;
}

export interface StepResult {
  step: "her_day" | "arcs" | "views" | "hygiene";
  status: "done" | "skipped" | "failed";
  reason: string;
  proposalIds: string[];
  detail?: Record<string, unknown>;
}

function refileKey(kind: string, proposal: string): string {
  return kind + "|" + proposal.trim().toLowerCase().replace(/\s+/g, " ");
}

// One entry per input row, in order: the new proposal id, or null for a row skipped as a
// refile of a pending, approved or edited proposal of the same kind and text in the last 30
// days (or of an earlier row of the same call). Every nightly text carries its day, so this
// only ever catches a refile of the same night.
export async function fileNightlyProposals(db: D1Database, rows: NightlyProposal[]): Promise<Array<string | null>> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const since = new Date(Date.now() - NIGHTLY_REFILE_DAYS * DAY_MS).toISOString();
  const existing = await db
    .prepare("SELECT kind, proposal FROM proposals WHERE status IN ('pending','approved','edited') AND created_at >= ?1")
    .bind(since)
    .all<{ kind: string; proposal: string }>();
  const seen = new Set<string>();
  for (const p of existing.results ?? []) {
    if (p && typeof p.proposal === "string") seen.add(refileKey(String(p.kind), p.proposal));
  }
  const t = nowIso();
  const out: Array<string | null> = [];
  const stmts: D1PreparedStatement[] = [];
  for (const r of list) {
    const text = r && typeof r.proposal === "string" ? r.proposal.trim() : "";
    if (!text) {
      out.push(null);
      continue;
    }
    const key = refileKey(r.kind, text);
    if (seen.has(key)) {
      out.push(null);
      continue;
    }
    seen.add(key);
    const row: ProposalRow = {
      id: newId("p"),
      conversation_id: null,
      message_id: null,
      kind: r.kind,
      proposal: text,
      evidence: typeof r.evidence === "string" && r.evidence ? r.evidence : null,
      confidence: r.confidence,
      scope: "general",
      payload_json: JSON.stringify({
        payload: r.payload ?? null,
        weight: typeof r.weight === "number" && Number.isFinite(r.weight) ? r.weight : null,
        source: r.source,
        raw: null,
      }),
      status: "pending",
      decision_note: null,
      promoted_id: null,
      created_at: t,
      decided_at: null,
    };
    stmts.push(insertProposalStmt(db, row));
    out.push(row.id);
  }
  if (stmts.length) await db.batch(stmts);
  return out;
}
