// Full JSON export, plain-text transcript export, and import with a snapshot taken first.
// Import replaces the story tables in one batch; settings and visual_assets are merged,
// never dropped. Fixed canon facts and master images are never touched by a payload.
// Every imported column is checked the way the API checks the same field: type, the
// allowed values, the length cap, and for state a plain JSON object under the size cap.
//
// v3 (SPEC_V3 "Export and import"): the export carries every v2 and v3 table except
// weather_cache (a cache); the import takes the v3 tables that hold his curation and the
// story's record (the voice bank, the corrections, the weights and recalls, wants, asks,
// the grounding log, calls, tastings, marks) with the same one-of rules the schema
// states; a table absent from the payload keeps its rows, one present replaces them.
// visual_assets rows with roles portrait and video merge like the rest.
import { CONSTITUTION_VERSION } from "./generated/constitution";
import { PROMPT_VERSION } from "./prompt";
import { DEFAULT_SETTINGS, auditStmt, getSettings, listMessages, newId, nowIso, putSettings } from "./db";
import { ApiHttpError } from "./errors";
import type { ConversationRow, Env, MessageRow, Settings } from "./types";

const LOG_LIMIT = 5000;
const TRANSCRIPT_LIMIT = 100_000;

// ------------------------------------------------------------------ export

async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const stmt = binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  return (await stmt.all<T>()).results;
}

// A table a later migration adds answers [] until it exists, so an export on a database
// behind the migrations still completes.
async function allOrEmpty<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    return await all<T>(db, sql, ...binds);
  } catch {
    return [];
  }
}

// The v2 and v3 tables, keyed by the export name. Two are left out on purpose:
// weather_cache (a cache) and push_subscriptions (its keys_json holds the browser's
// subscription secrets, which never leave through the export; a subscription is per
// browser and is made again from the Model page).
const EXTRA_TABLES: ReadonlyArray<{ key: string; sql: string }> = [
  // v2
  { key: "lifeThreads", sql: "SELECT * FROM life_threads ORDER BY created_at, id" },
  { key: "lifeLog", sql: "SELECT * FROM life_log ORDER BY occurred, created_at, id" },
  { key: "messageContext", sql: "SELECT * FROM message_context ORDER BY created_at, message_id" },
  { key: "driftReports", sql: "SELECT * FROM drift_reports ORDER BY ran_at, id" },
  { key: "firstTextsDaily", sql: "SELECT * FROM first_texts_daily ORDER BY day" },
  { key: "mediaLibrary", sql: "SELECT * FROM media_library ORDER BY created_at, id" },
  { key: "voiceprints", sql: "SELECT * FROM voiceprints ORDER BY created_at, id" },
  // v3
  { key: "voiceLines", sql: "SELECT * FROM voice_lines ORDER BY created_at, id" },
  { key: "voiceLineUses", sql: "SELECT * FROM voice_line_uses ORDER BY created_at, id" },
  { key: "corrections", sql: "SELECT * FROM corrections ORDER BY created_at, id" },
  { key: "memoryWeights", sql: "SELECT * FROM memory_weights ORDER BY entity, entity_id" },
  { key: "memoryRecalls", sql: "SELECT * FROM memory_recalls ORDER BY created_at, id" },
  { key: "wants", sql: "SELECT * FROM wants ORDER BY created_at, id" },
  { key: "wantLog", sql: "SELECT * FROM want_log ORDER BY occurred, created_at, id" },
  { key: "asks", sql: "SELECT * FROM asks ORDER BY asked_at, created_at, id" },
  { key: "groundingLog", sql: "SELECT * FROM grounding_log ORDER BY occurred, created_at, id" },
  { key: "calls", sql: "SELECT * FROM calls ORDER BY started_at, id" },
  { key: "tastings", sql: "SELECT * FROM tastings ORDER BY created_at, id" },
  { key: "tastingCandidates", sql: "SELECT * FROM tasting_candidates ORDER BY created_at, id" },
  { key: "messageMarks", sql: "SELECT * FROM message_marks ORDER BY created_at, message_id" },
];

async function collectRows(db: D1Database): Promise<Record<string, unknown>> {
  const [
    settings, facts, history, unknowns, stateVersions, conversations, messages, proposals, visualAssets, usage, audit, modelRuns,
  ] = await Promise.all([
    getSettings(db),
    all(db, "SELECT * FROM facts ORDER BY created_at, id"),
    all(db, "SELECT * FROM history ORDER BY seq, version, created_at, id"),
    all(db, "SELECT * FROM unknowns ORDER BY created_at, id"),
    all(db, "SELECT * FROM state_versions ORDER BY entity, version"),
    all(db, "SELECT * FROM conversations ORDER BY created_at, id"),
    all(db, "SELECT * FROM messages ORDER BY conversation_id, seq, created_at"),
    all(db, "SELECT * FROM proposals ORDER BY created_at, id"),
    all(db, "SELECT * FROM visual_assets ORDER BY created_at, id"),
    all(db, "SELECT * FROM usage_daily ORDER BY day DESC, provider, model LIMIT ?1", LOG_LIMIT),
    all(db, "SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?1", LOG_LIMIT),
    all(db, "SELECT * FROM model_runs ORDER BY created_at DESC, id DESC LIMIT ?1", LOG_LIMIT),
  ]);
  const extra: Record<string, unknown> = {};
  const extraRows = await Promise.all(EXTRA_TABLES.map((t) => allOrEmpty(db, t.sql)));
  EXTRA_TABLES.forEach((t, i) => { extra[t.key] = extraRows[i]; });
  return {
    version: 1,
    exportedAt: nowIso(),
    constitutionVersion: CONSTITUTION_VERSION,
    promptVersion: PROMPT_VERSION,
    settings,
    facts,
    history,
    unknowns,
    stateVersions,
    conversations,
    messages,
    proposals,
    visualAssets,
    usage,
    audit,
    modelRuns,
    ...extra,
  };
}

export async function exportAll(db: D1Database, env: Env): Promise<Record<string, unknown>> {
  const rows = await collectRows(db);
  return { ...rows, appEnv: env.APP_ENV ?? null };
}

export async function exportTranscript(db: D1Database, conversationId: string): Promise<string> {
  const conv = await db.prepare("SELECT * FROM conversations WHERE id = ?1").bind(conversationId).first<ConversationRow>();
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const rows: MessageRow[] = await listMessages(db, conversationId, "story", TRANSCRIPT_LIMIT);
  const lines = rows.map((m) => `[${m.created_at}] ${m.role === "assistant" ? "Avelie" : "You"}: ${m.content}`);
  return lines.length ? lines.join("\n\n") + "\n" : "";
}

// ------------------------------------------------------------------ import: column whitelist

type ColType = "text" | "int" | "num" | "time" | "json";

interface Col {
  name: string;
  type: ColType;
  required?: boolean;
  default?: string | number | null;
  oneOf?: readonly string[];
  // Longest accepted string (characters). Text columns carry the cap the API puts on the
  // same field; a json column caps its serialized form. Unset: DEFAULT_TEXT_MAX.
  max?: number;
}

interface TableSpec {
  table: string;
  key: string;
  cols: Col[];
}

// The same ceilings the API enforces (api.ts, state.ts, chat.ts, proposals.ts).
const DEFAULT_TEXT_MAX = 4000;
const ID_MAX = 120;
const TIME_MAX = 64;
const MESSAGE_CONTENT_MAX = 20_000;
// A user line is capped where the turn and operator routes cap it (chat.ts, operator.ts);
// only her replies may run to the column's ceiling.
const USER_CONTENT_MAX = 4000;
const HISTORY_BODY_MAX = 20_000;
const STATE_JSON_MAX = 100_000;
const PROPOSAL_MAX = 1000;

const CONVERSATIONS: TableSpec = {
  table: "conversations",
  key: "conversations",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "title", type: "text", max: 200 },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "last_message_at", type: "text", max: TIME_MAX },
    { name: "status", type: "text", default: "active", oneOf: ["active", "deleted"] },
  ],
};

const MESSAGES: TableSpec = {
  table: "messages",
  key: "messages",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", required: true, max: ID_MAX },
    { name: "channel", type: "text", default: "story", oneOf: ["story", "operator"] },
    { name: "role", type: "text", required: true, oneOf: ["user", "assistant"] },
    { name: "content", type: "text", required: true, max: MESSAGE_CONTENT_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "seq", type: "int", required: true },
    { name: "idempotency_key", type: "text", max: 200 },
    { name: "reply_to_id", type: "text", max: ID_MAX },
    { name: "model_run_id", type: "text", max: ID_MAX },
    { name: "flags_json", type: "text", max: MESSAGE_CONTENT_MAX },
    { name: "image_id", type: "text", max: ID_MAX },
    { name: "image_status", type: "text", max: 40 },
    // v3 (0005_v3.sql): the call a transcript row belongs to.
    { name: "call_id", type: "text", max: ID_MAX },
  ],
};

const FACTS: TableSpec = {
  table: "facts",
  key: "facts",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "scope", type: "text", required: true, oneOf: ["fixed", "avelie", "justin", "shared"] },
    { name: "subject", type: "text", max: 200 },
    { name: "fact", type: "text", required: true, max: DEFAULT_TEXT_MAX },
    { name: "source", type: "text", max: 500 },
    { name: "status", type: "text", default: "approved", oneOf: ["approved", "superseded", "rejected"] },
    { name: "disclosed", type: "int", default: 1 },
    { name: "provisional", type: "int", default: 0 },
    { name: "version", type: "int", default: 1 },
    { name: "supersedes_id", type: "text", max: ID_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "updated_at", type: "time", max: TIME_MAX },
  ],
};

const HISTORY: TableSpec = {
  table: "history",
  key: "history",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "seq", type: "int", required: true },
    { name: "title", type: "text", required: true, max: 300 },
    { name: "occurred", type: "text", max: 200 },
    { name: "body", type: "text", required: true, max: HISTORY_BODY_MAX },
    { name: "what_changed", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "keep_consistent", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "source", type: "text", max: 500 },
    { name: "status", type: "text", default: "approved", oneOf: ["approved", "superseded", "rejected"] },
    { name: "version", type: "int", default: 1 },
    { name: "supersedes_id", type: "text", max: ID_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "updated_at", type: "time", max: TIME_MAX },
  ],
};

const UNKNOWNS: TableSpec = {
  table: "unknowns",
  key: "unknowns",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "topic", type: "text", required: true, max: 500 },
    { name: "note", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "status", type: "text", default: "open", oneOf: ["open", "resolved"] },
    { name: "resolution", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "updated_at", type: "time", max: TIME_MAX },
  ],
};

const STATE_VERSIONS: TableSpec = {
  table: "state_versions",
  key: "stateVersions",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "entity", type: "text", required: true, oneOf: ["relationship", "scene"] },
    { name: "version", type: "int", required: true },
    { name: "state_json", type: "json", required: true, max: STATE_JSON_MAX },
    { name: "source", type: "text", max: 200 },
    { name: "note", type: "text", max: 1000 },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const PROPOSALS: TableSpec = {
  table: "proposals",
  key: "proposals",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", max: ID_MAX },
    { name: "message_id", type: "text", max: ID_MAX },
    { name: "kind", type: "text", required: true, max: 40 },
    { name: "proposal", type: "text", required: true, max: PROPOSAL_MAX },
    { name: "evidence", type: "text", max: PROPOSAL_MAX },
    { name: "confidence", type: "text", max: 20 },
    { name: "scope", type: "text", max: 100 },
    { name: "payload_json", type: "text", max: MESSAGE_CONTENT_MAX },
    { name: "status", type: "text", default: "pending", oneOf: ["pending", "approved", "rejected", "edited"] },
    { name: "decision_note", type: "text", max: 1000 },
    { name: "promoted_id", type: "text", max: 200 },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "decided_at", type: "text", max: TIME_MAX },
  ],
};

// Only what the runtime itself produces is imported: masters and archive rows come from
// the seed, and a payload cannot add a "master" that points at an arbitrary file. v3 adds
// the portrait (DD) and the clip (FF), each under its own prefix.
const RUNTIME_ASSET_ROLES: readonly string[] = ["candidate", "scene", "portrait", "video"];
const ASSET_STATUSES: readonly string[] = ["approved", "candidate", "rejected", "archive", "missing", "pending", "generating", "failed"];
const CANDIDATE_PREFIX = "candidates/";
const PORTRAIT_PREFIX = "portraits/";
const VIDEO_PREFIX = "videos/";
const ASSET_PREFIXES: readonly string[] = [CANDIDATE_PREFIX, PORTRAIT_PREFIX, VIDEO_PREFIX];

const VISUAL_ASSETS: TableSpec = {
  table: "visual_assets",
  key: "visualAssets",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "file", type: "text", required: true, max: 300 },
    { name: "role", type: "text", required: true, oneOf: RUNTIME_ASSET_ROLES },
    { name: "sha256", type: "text", max: 64 },
    { name: "bytes", type: "int" },
    { name: "approval_status", type: "text", required: true, oneOf: ASSET_STATUSES },
    { name: "conversation_id", type: "text", max: ID_MAX },
    { name: "message_id", type: "text", max: ID_MAX },
    { name: "prompt", type: "text", max: 2000 },
    { name: "provider", type: "text", max: 40 },
    { name: "model", type: "text", max: 200 },
    { name: "notes", type: "text", max: 300 },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "decided_at", type: "text", max: TIME_MAX },
  ],
};

// ------------------------------------------------------------------ v3 tables (SPEC_V3 migration 0005)

const VOICE_LINES: TableSpec = {
  table: "voice_lines",
  key: "voiceLines",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "text", type: "text", required: true, max: 160 },
    { name: "text_norm", type: "text", required: true, max: 160 },
    { name: "tags_json", type: "text", required: true, max: 500 },
    { name: "source", type: "text", max: 500 },
    { name: "origin", type: "text", required: true, oneOf: ["seed", "owner", "correction"] },
    { name: "status", type: "text", default: "unapproved", oneOf: ["unapproved", "approved", "rejected"] },
    { name: "uses", type: "int", default: 0 },
    { name: "last_used_at", type: "text", max: TIME_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "updated_at", type: "time", max: TIME_MAX },
    { name: "decided_at", type: "text", max: TIME_MAX },
  ],
};

const VOICE_LINE_USES: TableSpec = {
  table: "voice_line_uses",
  key: "voiceLineUses",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "line_id", type: "text", required: true, max: ID_MAX },
    { name: "message_id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", required: true, max: ID_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const CORRECTIONS: TableSpec = {
  table: "corrections",
  key: "corrections",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "message_id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", max: ID_MAX },
    { name: "kind", type: "text", required: true, oneOf: ["ai", "clever", "not_her", "too_long", "too_nice", "too_polished", "other"] },
    { name: "note", type: "text", max: 1000 },
    { name: "original", type: "text", required: true, max: MESSAGE_CONTENT_MAX },
    { name: "rewrite", type: "text", max: 1000 },
    { name: "voice_line_id", type: "text", max: ID_MAX },
    { name: "status", type: "text", default: "active", oneOf: ["active", "retired"] },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "retired_at", type: "text", max: TIME_MAX },
  ],
};

const MEMORY_WEIGHTS: TableSpec = {
  table: "memory_weights",
  // The key is (entity, entity_id): the first column is not unique on its own, so the
  // duplicate check below uses both.
  key: "memoryWeights",
  cols: [
    { name: "entity", type: "text", required: true, oneOf: ["fact", "history", "thread", "log", "want"] },
    { name: "entity_id", type: "text", required: true, max: ID_MAX },
    { name: "weight", type: "num", default: 0.5 },
    { name: "last_touched", type: "time", max: TIME_MAX },
    { name: "touches", type: "int", default: 0 },
    { name: "source", type: "text", max: 500 },
    { name: "updated_at", type: "time", max: TIME_MAX },
  ],
};

const MEMORY_RECALLS: TableSpec = {
  table: "memory_recalls",
  key: "memoryRecalls",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "message_id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", required: true, max: ID_MAX },
    { name: "entity", type: "text", required: true, max: 40 },
    { name: "entity_id", type: "text", required: true, max: ID_MAX },
    { name: "mode", type: "text", default: "provisional", oneOf: ["provisional"] },
    { name: "score", type: "num", default: 0 },
    { name: "text_shown", type: "text", required: true, max: DEFAULT_TEXT_MAX },
    { name: "outcome", type: "text", default: "unknown", oneOf: ["unknown", "confirmed", "corrected"] },
    { name: "outcome_message_id", type: "text", max: ID_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "updated_at", type: "time", max: TIME_MAX },
  ],
};

const WANTS: TableSpec = {
  table: "wants",
  key: "wants",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "title", type: "text", required: true, max: 300 },
    { name: "why", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "stakes", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "next_step", type: "text", max: DEFAULT_TEXT_MAX },
    { name: "progress", type: "int", default: 0 },
    { name: "status", type: "text", default: "active", oneOf: ["active", "paused", "done", "dropped"] },
    { name: "horizon_days", type: "int", default: 42 },
    { name: "last_moved", type: "text", max: TIME_MAX },
    { name: "source", type: "text", max: 500 },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "updated_at", type: "time", max: TIME_MAX },
  ],
};

const WANT_LOG: TableSpec = {
  table: "want_log",
  key: "wantLog",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "want_id", type: "text", required: true, max: ID_MAX },
    { name: "occurred", type: "time", max: TIME_MAX },
    { name: "kind", type: "text", required: true, oneOf: ["progress", "setback", "note"] },
    { name: "delta", type: "int" },
    { name: "note", type: "text", required: true, max: DEFAULT_TEXT_MAX },
    { name: "source", type: "text", max: 500 },
    { name: "message_id", type: "text", max: ID_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const ASKS: TableSpec = {
  table: "asks",
  key: "asks",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "want_id", type: "text", max: ID_MAX },
    { name: "text", type: "text", required: true, max: 1000 },
    { name: "status", type: "text", default: "open", oneOf: ["open", "granted", "declined", "let_go"] },
    { name: "asked_message_id", type: "text", max: ID_MAX },
    { name: "asked_at", type: "time", max: TIME_MAX },
    { name: "brought_up", type: "int", default: 0 },
    { name: "resolved_at", type: "text", max: TIME_MAX },
    { name: "resolution_note", type: "text", max: 1000 },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const GROUNDING_LOG: TableSpec = {
  table: "grounding_log",
  key: "groundingLog",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "kind", type: "text", required: true, oneOf: ["meal", "outfit", "errand", "misc"] },
    { name: "note", type: "text", required: true, max: 500 },
    { name: "occurred", type: "time", max: TIME_MAX },
    { name: "source", type: "text", max: 500 },
    { name: "message_id", type: "text", max: ID_MAX },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const CALLS: TableSpec = {
  table: "calls",
  key: "calls",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", required: true, max: ID_MAX },
    { name: "provider", type: "text", required: true, max: 40 },
    { name: "model", type: "text", max: 200 },
    { name: "voice", type: "text", max: 40 },
    { name: "status", type: "text", required: true, oneOf: ["starting", "live", "ended", "failed", "expired"] },
    { name: "started_at", type: "time", max: TIME_MAX },
    { name: "last_tick_at", type: "text", max: TIME_MAX },
    { name: "ended_at", type: "text", max: TIME_MAX },
    { name: "seconds", type: "int", default: 0 },
    { name: "cost_usd_micro", type: "int", default: 0 },
    { name: "usage_json", type: "text", max: 2000 },
    { name: "transcript_rows", type: "int", default: 0 },
    { name: "end_reason", type: "text", max: 40 },
    { name: "prompt_version", type: "text", max: 200 },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const TASTINGS: TableSpec = {
  table: "tastings",
  key: "tastings",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "conversation_id", type: "text", required: true, max: ID_MAX },
    { name: "user_message_id", type: "text", required: true, max: ID_MAX },
    { name: "idempotency_key", type: "text", required: true, max: 200 },
    { name: "left_side", type: "text", required: true, oneOf: ["A", "B"] },
    { name: "status", type: "text", default: "pending", oneOf: ["pending", "picked", "void", "expired"] },
    { name: "a_provider", type: "text", required: true, max: 40 },
    { name: "a_model", type: "text", required: true, max: 200 },
    { name: "b_provider", type: "text", required: true, max: 40 },
    { name: "b_model", type: "text", required: true, max: 200 },
    { name: "pick", type: "text", oneOf: ["left", "right", "neither"] },
    { name: "winner_side", type: "text", oneOf: ["A", "B"] },
    { name: "cost_usd_micro", type: "int", default: 0 },
    { name: "created_at", type: "time", max: TIME_MAX },
    { name: "decided_at", type: "text", max: TIME_MAX },
    // The state the candidates saw (migration 0006): the state text (at most 24,000
    // characters), the exemplars offered and the recall pick, as one JSON object.
    { name: "context_json", type: "json", max: STATE_JSON_MAX },
  ],
};

const TASTING_CANDIDATES: TableSpec = {
  table: "tasting_candidates",
  key: "tastingCandidates",
  cols: [
    { name: "id", type: "text", required: true, max: ID_MAX },
    { name: "tasting_id", type: "text", required: true, max: ID_MAX },
    { name: "side", type: "text", required: true, oneOf: ["A", "B"] },
    { name: "text", type: "text", required: true, max: MESSAGE_CONTENT_MAX },
    { name: "photo", type: "text", max: 2000 },
    { name: "song_json", type: "text", max: 2000 },
    { name: "clip", type: "text", max: 2000 },
    { name: "flags_json", type: "text", max: MESSAGE_CONTENT_MAX },
    { name: "run_id", type: "text", required: true, max: ID_MAX },
    { name: "retried", type: "int", default: 0 },
    { name: "cost_usd_micro", type: "int", default: 0 },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

const MESSAGE_MARKS: TableSpec = {
  table: "message_marks",
  key: "messageMarks",
  cols: [
    { name: "message_id", type: "text", required: true, max: ID_MAX },
    { name: "mark", type: "text", required: true, oneOf: ["keep", "drop"] },
    { name: "note", type: "text", max: 500 },
    { name: "actor", type: "text", required: true, max: 200 },
    { name: "created_at", type: "time", max: TIME_MAX },
  ],
};

// The v3 tables an import replaces when the payload carries them (absent = untouched).
const V3_TABLES: readonly TableSpec[] = [
  VOICE_LINES, VOICE_LINE_USES, CORRECTIONS, MEMORY_WEIGHTS, MEMORY_RECALLS, WANTS, WANT_LOG, ASKS, GROUNDING_LOG, CALLS, TASTINGS,
  TASTING_CANDIDATES, MESSAGE_MARKS,
];

type Cell = string | number | null;

function bad(where: string, msg: string): ApiHttpError {
  return new ApiHttpError(400, "validation", `${where}: ${msg}`);
}

// The same rule state.ts applies to a PUT: an object with named fields, nothing else.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function coerce(value: unknown, col: Col, where: string, at: string): Cell {
  if (value === undefined || value === null) {
    if (col.type === "time") return at;
    if (col.default !== undefined) return col.default;
    if (col.required) throw bad(where, `${col.name} is required`);
    return null;
  }
  const max = col.max ?? DEFAULT_TEXT_MAX;
  switch (col.type) {
    case "text":
    case "time": {
      if (typeof value !== "string") throw bad(where, `${col.name} must be a string`);
      if (col.oneOf && !col.oneOf.includes(value)) throw bad(where, `${col.name} must be one of ${col.oneOf.join(", ")}`);
      if (value.length > max) throw bad(where, `${col.name} exceeds ${max} characters`);
      return value;
    }
    case "json": {
      // State is read back as an object with named fields; "null", an array or a bare
      // value is valid JSON that would break every turn after it.
      let parsed: unknown;
      let text: string;
      if (typeof value === "string") {
        if (value.length > max) throw bad(where, `${col.name} exceeds ${max} characters`);
        try {
          parsed = JSON.parse(value);
        } catch {
          throw bad(where, `${col.name} must be valid JSON`);
        }
        text = value;
      } else {
        parsed = value;
        text = JSON.stringify(value);
        if (text.length > max) throw bad(where, `${col.name} exceeds ${max} characters`);
      }
      if (!isPlainObject(parsed)) throw bad(where, `${col.name} must be a JSON object`);
      return text;
    }
    case "int": {
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad(where, `${col.name} must be a number`);
      return Math.trunc(value);
    }
    case "num": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad(where, `${col.name} must be a number`);
      return value;
    }
    default:
      return null;
  }
}

interface PreparedRow {
  values: Cell[];
  get(name: string): Cell;
}

function prepareRows(spec: TableSpec, raw: unknown, at: string): PreparedRow[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad(spec.key, "must be an array");
  const out: PreparedRow[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const where = `${spec.key}[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw bad(where, "must be an object");
    const obj = item as Record<string, unknown>;
    const values = spec.cols.map((c) => coerce(obj[c.name], c, where, at));
    // The row key: the first column, or the first two for a table keyed on a pair.
    const id = spec.table === "memory_weights" ? String(values[0]) + "#" + String(values[1]) : String(values[0]);
    if (seen.has(id)) throw bad(where, "duplicate id " + id);
    seen.add(id);
    out.push({ values, get: (name) => values[spec.cols.findIndex((c) => c.name === name)] ?? null });
  });
  return out;
}

// The payload's asset rows that the runtime itself could have written. Everything else
// (masters, the legacy archive, blacklist rows) lives in the seed and is skipped here.
function runtimeAssetRows(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.filter((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return true;
    return RUNTIME_ASSET_ROLES.includes(String((item as Record<string, unknown>).role));
  });
}

function insertStmt(db: D1Database, spec: TableSpec, row: PreparedRow, orIgnore = false): D1PreparedStatement {
  const cols = spec.cols.map((c) => c.name).join(", ");
  const marks = spec.cols.map((_, i) => "?" + (i + 1)).join(", ");
  const verb = orIgnore ? "INSERT OR IGNORE INTO" : "INSERT INTO";
  return db.prepare(`${verb} ${spec.table} (${cols}) VALUES (${marks})`).bind(...row.values);
}

// Settings from a payload: known keys only, and only when the value has the default's type.
function settingsPatch(raw: unknown): Partial<Settings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    const want = typeof defaults[key];
    if (typeof v !== want) continue;
    if (want === "number" && !Number.isFinite(v as number)) continue;
    if (want === "object" && (Array.isArray(v) || v === null)) continue;
    patch[key] = v;
  }
  return patch as Partial<Settings>;
}

// ------------------------------------------------------------------ import

export async function importAll(
  db: D1Database,
  payload: Record<string, unknown>,
  actor: string,
): Promise<{ snapshotId: string; counts: Record<string, number> }> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw bad("payload", "must be an object");
  if (payload.version !== 1) throw bad("payload", "version must be 1");

  const at = nowIso();
  const conversations = prepareRows(CONVERSATIONS, payload.conversations, at);
  const messages = prepareRows(MESSAGES, payload.messages, at);
  const allFacts = prepareRows(FACTS, payload.facts, at);
  const history = prepareRows(HISTORY, payload.history, at);
  const unknowns = prepareRows(UNKNOWNS, payload.unknowns, at);
  const stateVersions = prepareRows(STATE_VERSIONS, payload.stateVersions, at);
  const proposals = prepareRows(PROPOSALS, payload.proposals, at);
  const visualAssets = prepareRows(VISUAL_ASSETS, runtimeAssetRows(payload.visualAssets), at);
  const settings = settingsPatch(payload.settings);
  // v3 tables: only the ones the payload names.
  const v3: Array<{ spec: TableSpec; rows: PreparedRow[] }> = [];
  for (const spec of V3_TABLES) {
    if (payload[spec.key] === undefined || payload[spec.key] === null) continue;
    v3.push({ spec, rows: prepareRows(spec, payload[spec.key], at) });
  }

  // Fixed canon is never imported: it changes through migrations only (403 fixed_canon
  // everywhere else). Rows with that scope are dropped from the payload and counted, the
  // fixed rows on file stay, and no other row may take a fixed row's id (the insert would
  // collide with it, or a later version would claim to supersede it).
  const facts = allFacts.filter((r) => r.get("scope") !== "fixed");
  const fixedIgnored = allFacts.length - facts.length;
  const fixedIds = new Set((await all<{ id: string }>(db, "SELECT id FROM facts WHERE scope = 'fixed'")).map((r) => r.id));
  for (const r of facts) {
    if (fixedIds.has(String(r.get("id")))) throw bad("facts", `id ${String(r.get("id"))} belongs to fixed canon`);
    const sup = r.get("supersedes_id");
    if (sup !== null && fixedIds.has(String(sup))) throw bad("facts", `${String(r.get("id"))} cannot supersede fixed canon`);
  }

  // A state entity present in the payload is replaced; one absent keeps its current versions.
  const entities = new Set<string>();
  for (const r of stateVersions) entities.add(String(r.get("entity")));
  for (const entity of entities) {
    const versions = stateVersions.filter((r) => r.get("entity") === entity).map((r) => Number(r.get("version")));
    if (new Set(versions).size !== versions.length) throw bad("stateVersions", `duplicate version for ${entity}`);
  }
  // One seq per conversation (the unique index would otherwise fail the whole batch), and
  // a user line no longer than the API would have taken.
  const seqSeen = new Set<string>();
  messages.forEach((r, i) => {
    const k = String(r.get("conversation_id")) + "#" + String(r.get("seq"));
    if (seqSeen.has(k)) throw bad("messages", `duplicate seq ${String(r.get("seq"))} in conversation ${String(r.get("conversation_id"))}`);
    seqSeen.add(k);
    if (r.get("role") === "user" && String(r.get("content")).length > USER_CONTENT_MAX) {
      throw bad(`messages[${i}]`, `content exceeds ${USER_CONTENT_MAX} characters for a user message`);
    }
  });
  for (const r of visualAssets) {
    const file = String(r.get("file"));
    if (!ASSET_PREFIXES.some((p) => file.startsWith(p))) throw bad("visualAssets", "file must be under " + ASSET_PREFIXES.join(", "));
  }
  for (const { spec, rows } of v3) {
    for (const r of rows) {
      if (spec.table === "wants") {
        const progress = Number(r.get("progress"));
        if (progress < 0 || progress > 100) throw bad(spec.key, "progress must be 0 to 100");
      }
      if (spec.table === "memory_weights") {
        const w = Number(r.get("weight"));
        if (!(w >= 0 && w <= 1)) throw bad(spec.key, "weight must be 0 to 1");
      }
    }
  }

  // Snapshot first, outside the batch, so a failed import still leaves the old world on
  // file. Only what an import replaces is kept (the log tables are not restored and would
  // push the one JSON value past D1's per-value limit over time).
  const snapshotId = newId("snap");
  const full = await collectRows(db);
  const snapshot: Record<string, unknown> = { ...full };
  delete snapshot.audit;
  delete snapshot.modelRuns;
  delete snapshot.usage;
  await db
    .prepare("INSERT INTO snapshots (id, reason, json, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(snapshotId, "pre-import", JSON.stringify(snapshot), at)
    .run();

  const counts: Record<string, number> = {
    conversations: conversations.length,
    messages: messages.length,
    facts: facts.length,
    fixedIgnored,
    history: history.length,
    unknowns: unknowns.length,
    stateVersions: stateVersions.length,
    proposals: proposals.length,
    visualAssets: visualAssets.length,
    settings: Object.keys(settings).length,
  };
  for (const { spec, rows } of v3) counts[spec.key] = rows.length;

  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM messages"),
    db.prepare("DELETE FROM conversations"),
    db.prepare("DELETE FROM proposals"),
    db.prepare("DELETE FROM history"),
    db.prepare("DELETE FROM unknowns"),
    db.prepare("DELETE FROM facts WHERE scope != 'fixed'"),
  ];
  for (const entity of entities) stmts.push(db.prepare("DELETE FROM state_versions WHERE entity = ?1").bind(entity));

  for (const r of conversations) stmts.push(insertStmt(db, CONVERSATIONS, r));
  for (const r of messages) stmts.push(insertStmt(db, MESSAGES, r));
  for (const r of facts) stmts.push(insertStmt(db, FACTS, r));
  for (const r of history) stmts.push(insertStmt(db, HISTORY, r));
  for (const r of unknowns) stmts.push(insertStmt(db, UNKNOWNS, r));
  for (const r of stateVersions) stmts.push(insertStmt(db, STATE_VERSIONS, r));
  for (const r of proposals) stmts.push(insertStmt(db, PROPOSALS, r));
  for (const r of visualAssets) stmts.push(insertStmt(db, VISUAL_ASSETS, r, true));
  for (const { spec, rows } of v3) {
    stmts.push(db.prepare(`DELETE FROM ${spec.table}`));
    for (const r of rows) stmts.push(insertStmt(db, spec, r));
  }
  stmts.push(auditStmt(db, actor, "import", "snapshot", snapshotId, null, {
    counts,
    entities: Array.from(entities),
    fixedReplaced: false,
    exportedAt: typeof payload.exportedAt === "string" ? payload.exportedAt : null,
    constitutionVersion: typeof payload.constitutionVersion === "string" ? payload.constitutionVersion : null,
  }));

  await db.batch(stmts);

  if (Object.keys(settings).length) await putSettings(db, settings);

  return { snapshotId, counts };
}
