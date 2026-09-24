// Full JSON export, plain-text transcript export, and import with a snapshot taken first.
// Import replaces the story tables in one batch; settings and visual_assets are merged,
// never dropped. Fixed canon facts and master images are never touched by a payload.
// Every imported column is checked the way the API checks the same field: type, the
// allowed values, the length cap, and for state a plain JSON object under the size cap.
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
// the seed, and a payload cannot add a "master" that points at an arbitrary file.
const RUNTIME_ASSET_ROLES: readonly string[] = ["candidate", "scene"];
const ASSET_STATUSES: readonly string[] = ["approved", "candidate", "rejected", "archive", "missing", "pending", "generating", "failed"];
const CANDIDATE_PREFIX = "candidates/";

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
    const id = String(values[0]);
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
    if (!String(r.get("file")).startsWith(CANDIDATE_PREFIX)) throw bad("visualAssets", "file must be under " + CANDIDATE_PREFIX);
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
