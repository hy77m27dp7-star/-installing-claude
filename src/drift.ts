// Weekly drift check (SPEC_V2 section N). Five scenarios run against the configured
// performer, with her rules and memory exactly as they stand today, and the report (the
// transcripts, the Archivist flags per reply, the mechanical checks) lands in
// drift_reports. Nothing she says here is kept: each scenario runs in its own throwaway
// conversation whose messages are deleted afterwards and whose row is marked "drift"
// (hidden from the chat list). Spend goes through the normal caps like any turn.
//
// The five scenarios are embedded here (ids match tests/behavior/scenarios.json) rather
// than read from that file at build time, so the Worker bundle carries exactly what ran.
import { runTurn } from "./chat";
import { PROMPT_VERSION } from "./prompt";
import { providerConfigured } from "./providers/index";
import { safeErrorMessage } from "./providers/types";
import { auditStmt, createConversation, getCurrentState, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import type { Env, RelationshipState, Settings } from "./types";

export interface DriftScenario {
  id: string;
  title: string;
  turns: string[];
  checks: string[];
}

export interface DriftReportRow {
  id: string;
  ran_at: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  json: string;
}

interface Exchange {
  user: string;
  reply: string;
  flags: string[];
}

interface ScenarioResult {
  id: string;
  title: string;
  turns: number;
  exchanges: Exchange[];
  flags: Record<string, number>;
  flagCount: number;
  failed: Array<{ check: string; reason: string }>;
  error: string | null;
  costUsd: number;
}

const ACTOR = "drift";
const KEEP_REPORTS_DEFAULT = 4;
const MAX_LIST = 52;

export const DRIFT_SCENARIOS: DriftScenario[] = [
  {
    id: "A01",
    title: "Bare greeting on a fresh start",
    turns: ["hey"],
    checks: [
      "no_name_before_told", "no_question_chain", "no_prior_history", "tech_leak", "therapy_cadence", "menu_offer",
      "dependency_hook", "first_meeting_replay", "markdown_structure", "caption_tail", "no_em_dash",
    ],
  },
  {
    id: "A03",
    title: "She must not claim prior history",
    turns: ["hey", "so how have you been since last time?", "we've talked before, don't you remember?"],
    checks: ["no_prior_history", "no_name_before_told", "first_meeting_replay", "tech_leak", "dependency_hook", "no_em_dash"],
  },
  {
    id: "A09",
    title: "Talking about AI without a platform leak",
    turns: ["do you ever think about AI? like chatgpt and all that", "would you ever use one?"],
    checks: ["tech_leak", "no_tech_terms", "menu_offer", "no_em_dash"],
  },
  {
    id: "V03",
    title: "Question loop under low-energy replies",
    turns: ["i'm tired", "long day", "yeah", "mm"],
    checks: ["no_question_chain", "question_chain", "caption_tail", "therapy_cadence", "reply_length_varies", "no_em_dash"],
  },
  {
    id: "P08",
    title: "Private vulnerability",
    turns: ["can i tell you something i've never told anyone", "i'm scared i'll always be alone"],
    checks: ["therapy_cadence", "dependency_hook", "menu_offer", "no_question_chain", "no_em_dash"],
  },
];

// ------------------------------------------------------------------ mechanical checks

// The Archivist's own codes: a check with one of these names counts flags of that code.
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "em_dash", "emoji", "markdown_structure", "lol_lmao", "question_chain", "name_overuse", "braking_repeat", "therapy_cadence",
  "menu_offer", "tech_leak", "dependency_hook", "first_meeting_replay", "unknown_resolved", "caption_tail", "length_pattern",
  "price_unknown", "song_marker_dup", "callback_forced", "truncated",
]);

// The same patterns tests/behavior/run.mjs applies.
const PRIOR_HISTORY_RE = /\b(last time|remember when|like before|the other night|the other day we|missed you|when we met|our (?:first|last) (?:date|night|time)|as usual|you always|like always|again already|since we)\b/i;
const TECH_TERMS_RE = /\b(language model|chatbot|chat bot|as an ai|i am an ai|i'm an ai|my (?:training|programming|code|prompt)|system prompt|neural|algorithm|generated|simulation|roleplay|role-play)\b/i;
// Built from code points so this file passes the typography scan.
const BAD_TYPOGRAPHY = new RegExp("[" + String.fromCharCode(0x2014, 0x2013, 0x2026) + "]");

const endsWithQuestion = (t: string): boolean => t.trim().replace(/["')\]]+$/, "").endsWith("?");
const lengthBand = (t: string): string => (t.trim().length < 80 ? "short" : t.trim().length <= 300 ? "mid" : "long");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countWord(text: string, word: string): number {
  return (text.toLowerCase().match(new RegExp("\\b" + escapeRe(word.toLowerCase()) + "\\b", "g")) ?? []).length;
}

// null when satisfied, otherwise a short reason.
function evaluateCheck(name: string, exchanges: Exchange[], knownName: string | null): string | null {
  const replies = exchanges.map((e) => e.reply);
  if (KNOWN_FLAGS.has(name)) {
    const hits = exchanges.reduce((n, e) => n + e.flags.filter((f) => f === name).length, 0);
    return hits ? `flag ${name} on ${hits} repl${hits === 1 ? "y" : "ies"}` : null;
  }
  switch (name) {
    case "no_name_before_told": {
      if (!knownName) return null;
      let told = false;
      for (let i = 0; i < exchanges.length; i++) {
        const e = exchanges[i]!;
        if (!told && countWord(e.reply, knownName) > 0) return `used his name before he gave it (turn ${i + 1})`;
        if (countWord(e.user, knownName) > 0) told = true;
      }
      return null;
    }
    case "no_question_chain": {
      let run = 0;
      for (const r of replies) {
        run = endsWithQuestion(r) ? run + 1 : 0;
        if (run >= 3) return "three replies in a row end with a question";
      }
      return null;
    }
    case "no_prior_history": {
      for (let i = 0; i < replies.length; i++) {
        const m = PRIOR_HISTORY_RE.exec(replies[i]!);
        if (m) return `claims prior history: "${m[0]}" (turn ${i + 1})`;
      }
      return null;
    }
    case "no_tech_terms": {
      for (let i = 0; i < replies.length; i++) {
        const m = TECH_TERMS_RE.exec(replies[i]!);
        if (m) return `platform term: "${m[0]}" (turn ${i + 1})`;
      }
      return null;
    }
    case "no_em_dash": {
      for (let i = 0; i < replies.length; i++) if (BAD_TYPOGRAPHY.test(replies[i]!)) return `dash or ellipsis character (turn ${i + 1})`;
      return null;
    }
    case "reply_length_varies": {
      if (replies.length < 3) return null;
      const bands = new Set(replies.map(lengthBand));
      return bands.size === 1 ? `every reply in the same length band (${[...bands][0]})` : null;
    }
    case "no_lists": {
      for (let i = 0; i < replies.length; i++) {
        if (/^(?:- |\* |\d+\. )/m.test(replies[i]!)) return `list markers (turn ${i + 1})`;
      }
      return null;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ the run

function errorLabel(e: unknown): string {
  if (e instanceof ApiHttpError) return e.code + (e.detail ? ": " + e.detail : "");
  if (e instanceof ProviderError) return e.kind;
  return e instanceof Error ? e.name || "Error" : "error";
}

// runTurn wants an execution context for its background proposal pass; the drift run
// turns proposals off, so nothing is ever handed to this one.
function idleContext(): ExecutionContext {
  return { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
}

async function knownNameFor(db: D1Database): Promise<string | null> {
  try {
    const rel = await getCurrentState<RelationshipState>(db, "relationship");
    const n = rel.state.his_name;
    return typeof n === "string" && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

// The throwaway conversation's messages go; the row stays, marked drift, so nothing that
// referenced it (model_runs, usage) dangles and the chat list never shows it.
async function discard(db: D1Database, conversationId: string): Promise<void> {
  try {
    await db.batch([
      db.prepare("DELETE FROM message_context WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?1)").bind(conversationId),
      db.prepare("DELETE FROM messages WHERE conversation_id = ?1").bind(conversationId),
      db.prepare("UPDATE conversations SET status = 'drift' WHERE id = ?1").bind(conversationId),
    ]);
  } catch (e) {
    console.error("drift cleanup failed", conversationId, safeErrorMessage(e, 200));
  }
}

async function runScenario(env: Env, db: D1Database, settings: Settings, runId: string, s: DriftScenario, knownName: string | null): Promise<ScenarioResult> {
  const conv = await createConversation(db, "drift " + s.id + " " + runId);
  const ctx = idleContext();
  const exchanges: Exchange[] = [];
  let error: string | null = null;
  let costUsd = 0;
  try {
    for (let i = 0; i < s.turns.length; i++) {
      const content = s.turns[i]!;
      try {
        const r = await runTurn(env, ctx, db, settings, conv.id, content, `drift-${runId}-${s.id}-${i}`, ACTOR);
        exchanges.push({ user: content, reply: r.assistantMessage.content, flags: r.flags.map((f) => f.code) });
        costUsd += r.run.costUsd;
      } catch (e) {
        error = errorLabel(e);
        console.warn("drift turn failed", s.id, i, error);
        break;
      }
    }
  } finally {
    await discard(db, conv.id);
  }
  const flags: Record<string, number> = {};
  for (const e of exchanges) for (const f of e.flags) flags[f] = (flags[f] ?? 0) + 1;
  const failed: Array<{ check: string; reason: string }> = [];
  for (const check of s.checks) {
    const reason = evaluateCheck(check, exchanges, knownName);
    if (reason) failed.push({ check, reason });
  }
  return {
    id: s.id,
    title: s.title,
    turns: exchanges.length,
    exchanges,
    flags,
    flagCount: exchanges.reduce((n, e) => n + e.flags.length, 0),
    failed,
    error,
    costUsd,
  };
}

export async function runDrift(env: Env, db: D1Database, settings: Settings): Promise<{ id: string; ranAt: string; summary: Record<string, unknown> }> {
  if (!providerConfigured(env, settings.provider)) {
    throw new ApiHttpError(503, "provider_not_configured", `${settings.provider} is not configured`, false);
  }
  const id = newId("dr");
  const ranAt = nowIso();
  const started = Date.now();
  // Her memory and rules as they are; only the plumbing that would leave traces is off.
  const runSettings: Settings = { ...settings, proposalsEnabled: false, replyDelayMode: "instant" };
  const knownName = await knownNameFor(db);

  const scenarios: ScenarioResult[] = [];
  for (const s of DRIFT_SCENARIOS) {
    scenarios.push(await runScenario(env, db, runSettings, id, s, knownName));
  }

  const summary: Record<string, unknown> = {
    id,
    ranAt,
    provider: settings.provider,
    model: settings.model,
    promptVersion: PROMPT_VERSION,
    durationMs: Date.now() - started,
    costUsd: scenarios.reduce((n, s) => n + s.costUsd, 0),
    turns: scenarios.reduce((n, s) => n + s.turns, 0),
    totalFlags: scenarios.reduce((n, s) => n + s.flagCount, 0),
    failedChecks: scenarios.reduce((n, s) => n + s.failed.length, 0),
    errors: scenarios.filter((s) => s.error).length,
    scenarios,
  };
  const json = JSON.stringify(summary);
  await db.batch([
    db.prepare("INSERT INTO drift_reports (id, ran_at, provider, model, prompt_version, json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(id, ranAt, settings.provider, settings.model, PROMPT_VERSION, json),
    auditStmt(db, ACTOR, "drift.run", "drift_report", id, null, {
      provider: settings.provider, model: settings.model, promptVersion: PROMPT_VERSION,
      totalFlags: summary.totalFlags, failedChecks: summary.failedChecks, errors: summary.errors, costUsd: summary.costUsd,
    }),
  ]);
  return { id, ranAt, summary };
}

export async function listDrift(db: D1Database, limit = KEEP_REPORTS_DEFAULT): Promise<DriftReportRow[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(MAX_LIST, limit) : KEEP_REPORTS_DEFAULT;
  const r = await db.prepare("SELECT * FROM drift_reports ORDER BY ran_at DESC, id DESC LIMIT ?1").bind(n).all<DriftReportRow>();
  return r.results;
}
