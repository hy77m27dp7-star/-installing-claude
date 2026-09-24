// Facts / history / unknowns / state versions: every edit is a new row, every write is
// audited in the same batch. Fixed canon is read-only through this module.
import {
  appendStateStmt, auditStmt, getCurrentState, getFact, getHistory, listFacts, listHistory, listUnknowns,
  newId, nowIso,
} from "./db";
import { ApiHttpError } from "./errors";
import type { FactRow, FactScope, HistoryRow, RelationshipState, SceneState, StateVersionRow, UnknownRow } from "./types";

type Entity = "relationship" | "scene";
const FACT_SCOPES: FactScope[] = ["fixed", "avelie", "justin", "shared"];
const MAX_TEXT = 4000;
const MAX_STATE_JSON = 100_000;

// ------------------------------------------------------------------ validation helpers

function requireText(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiHttpError(400, "validation", `${name} is required`);
  const t = value.trim();
  if (t.length > max) throw new ApiHttpError(400, "validation", `${name} exceeds ${max} characters`);
  return t;
}

function optionalText(value: unknown, name: string, max = MAX_TEXT): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiHttpError(400, "validation", `${name} must be a string`);
  const t = value.trim();
  if (t.length > max) throw new ApiHttpError(400, "validation", `${name} exceeds ${max} characters`);
  return t.length ? t : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function assertFixed(scope: FactScope, verb: string): void {
  if (scope === "fixed") throw new ApiHttpError(403, "fixed_canon", `fixed canon cannot be ${verb}`);
}

// v2 (SPEC_V2 section J): the relationship state may carry `mood` (free text) and
// `cooling_off_until` (ISO time or null). Both are checked and normalised here so a
// malformed value can never reach the prompt; every other key passes through untouched.
const MAX_MOOD = 200;

function normalizeRelationshipFields(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state };
  if ("mood" in out) {
    const mood = out.mood;
    if (mood === null || mood === undefined) {
      delete out.mood;
    } else {
      if (typeof mood !== "string") throw new ApiHttpError(400, "validation", "mood must be a string");
      const t = mood.trim();
      if (t.length > MAX_MOOD) throw new ApiHttpError(400, "validation", `mood exceeds ${MAX_MOOD} characters`);
      if (t) out.mood = t;
      else delete out.mood;
    }
  }
  if ("cooling_off_until" in out) {
    const until = out.cooling_off_until;
    if (until === null || until === undefined || (typeof until === "string" && !until.trim())) {
      out.cooling_off_until = null;
    } else {
      if (typeof until !== "string") throw new ApiHttpError(400, "validation", "cooling_off_until must be an ISO 8601 time or null");
      const t = Date.parse(until);
      if (!Number.isFinite(t)) throw new ApiHttpError(400, "validation", "cooling_off_until must be an ISO 8601 time or null");
      out.cooling_off_until = new Date(t).toISOString();
    }
  }
  return out;
}

// ------------------------------------------------------------------ version chains

interface Versioned { id: string; version: number; status: "approved" | "superseded" | "rejected"; supersedes_id: string | null }

// The whole supersedes chain a row belongs to, oldest version first. Two recursive walks:
// up to the root, then down through every row that supersedes something in the chain.
async function chainRows<T extends Versioned>(db: D1Database, table: "facts" | "history", id: string): Promise<T[]> {
  const root = await db.prepare(
    `WITH RECURSIVE up(id, sup, depth) AS (
       SELECT id, supersedes_id, 0 FROM ${table} WHERE id = ?1
       UNION ALL
       SELECT t.id, t.supersedes_id, up.depth + 1 FROM ${table} t JOIN up ON t.id = up.sup WHERE up.depth < 500
     ) SELECT id FROM up WHERE sup IS NULL LIMIT 1`,
  ).bind(id).first<{ id: string }>();
  const rootId = root?.id ?? id;
  const r = await db.prepare(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT ?1, 0
       UNION ALL
       SELECT t.id, down.depth + 1 FROM ${table} t JOIN down ON t.supersedes_id = down.id WHERE down.depth < 500
     ) SELECT t.* FROM ${table} t JOIN down ON t.id = down.id ORDER BY t.version ASC, t.created_at ASC`,
  ).bind(rootId).all<T>();
  return r.results;
}

function supersedeStmt(db: D1Database, table: "facts" | "history", id: string, at: string): D1PreparedStatement {
  return db.prepare(`UPDATE ${table} SET status = 'superseded', updated_at = ?2 WHERE id = ?1 AND status = 'approved'`).bind(id, at);
}

// ------------------------------------------------------------------ bundle

export async function getStateBundle(db: D1Database): Promise<{
  relationship: { version: number; state: RelationshipState };
  scene: { version: number; state: SceneState };
  facts: { fixed: FactRow[]; avelie: FactRow[]; justin: FactRow[] };
  history: HistoryRow[];
  unknowns: UnknownRow[];
  hasSharedHistory: boolean;
}> {
  const [rel, scene, facts, history, unknowns] = await Promise.all([
    getCurrentState<RelationshipState>(db, "relationship"),
    getCurrentState<SceneState>(db, "scene"),
    listFacts(db),
    listHistory(db),
    listUnknowns(db),
  ]);
  const justin = facts.filter((f) => f.scope === "justin" || f.scope === "shared");
  return {
    relationship: { version: rel.version, state: rel.state },
    scene: { version: scene.version, state: scene.state },
    facts: {
      fixed: facts.filter((f) => f.scope === "fixed"),
      avelie: facts.filter((f) => f.scope === "avelie"),
      justin,
    },
    history,
    unknowns,
    // The same rule context.ts applies to the prompt: anything known about him means they met.
    hasSharedHistory: history.length > 0 || justin.length > 0,
  };
}

// ------------------------------------------------------------------ relationship / scene versions

export async function putState(
  db: D1Database,
  entity: Entity,
  state: Record<string, unknown>,
  note: string | null,
  actor: string,
  source = "owner",
): Promise<{ version: number; state: Record<string, unknown> }> {
  if (entity !== "relationship" && entity !== "scene") throw new ApiHttpError(400, "validation", "entity must be relationship or scene");
  if (!isPlainObject(state)) throw new ApiHttpError(400, "validation", "state must be a plain JSON object");
  const json = JSON.stringify(entity === "relationship" ? normalizeRelationshipFields(state) : state);
  if (json.length > MAX_STATE_JSON) throw new ApiHttpError(400, "validation", "state is too large");
  const stored = JSON.parse(json) as Record<string, unknown>;
  const current = await getCurrentState(db, entity);
  const version = current.version + 1;
  const cleanNote = optionalText(note, "note", 1000);
  await db.batch([
    appendStateStmt(db, entity, version, stored, source, cleanNote),
    auditStmt(db, actor, "state.put", `state.${entity}`, String(version), { version: current.version, state: current.state }, { version, state: stored, note: cleanNote, source }),
  ]);
  return { version, state: stored };
}

export async function restoreState(db: D1Database, entity: Entity, version: number, actor: string): Promise<{ version: number; state: Record<string, unknown> }> {
  if (entity !== "relationship" && entity !== "scene") throw new ApiHttpError(400, "validation", "entity must be relationship or scene");
  if (!Number.isInteger(version) || version < 1) throw new ApiHttpError(400, "validation", "version must be a positive integer");
  const row = await db.prepare("SELECT * FROM state_versions WHERE entity = ?1 AND version = ?2").bind(entity, version).first<StateVersionRow>();
  if (!row) throw new ApiHttpError(404, "not_found", `${entity} version ${version} not found`);
  const state = JSON.parse(row.state_json) as Record<string, unknown>;
  const current = await getCurrentState(db, entity);
  const next = current.version + 1;
  await db.batch([
    appendStateStmt(db, entity, next, state, "restore", `restored from version ${version}`),
    auditStmt(db, actor, "state.restore", `state.${entity}`, String(next), { version: current.version, state: current.state }, { version: next, restoredFrom: version, state }),
  ]);
  return { version: next, state };
}

// ------------------------------------------------------------------ facts

function insertFactStmt(db: D1Database, f: FactRow): D1PreparedStatement {
  return db.prepare("INSERT INTO facts (id, scope, subject, fact, source, status, disclosed, provisional, version, supersedes_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
    .bind(f.id, f.scope, f.subject, f.fact, f.source, f.status, f.disclosed, f.provisional, f.version, f.supersedes_id, f.created_at, f.updated_at);
}

async function requireFact(db: D1Database, id: string): Promise<FactRow> {
  const row = await getFact(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "fact not found");
  return row;
}

export async function createFact(
  db: D1Database,
  input: { scope: FactScope; subject?: string | null; fact: string; source?: string | null; disclosed?: boolean; provisional?: boolean },
  actor: string,
): Promise<FactRow> {
  if (!FACT_SCOPES.includes(input.scope)) throw new ApiHttpError(400, "validation", "scope must be avelie, justin or shared");
  assertFixed(input.scope, "created");
  const t = nowIso();
  const row: FactRow = {
    id: newId("f"),
    scope: input.scope,
    subject: optionalText(input.subject, "subject", 200),
    fact: requireText(input.fact, "fact"),
    source: optionalText(input.source, "source", 500),
    status: "approved",
    disclosed: input.disclosed === undefined ? 1 : input.disclosed ? 1 : 0,
    provisional: input.provisional ? 1 : 0,
    version: 1,
    supersedes_id: null,
    created_at: t,
    updated_at: t,
  };
  await db.batch([insertFactStmt(db, row), auditStmt(db, actor, "fact.create", "fact", row.id, null, row)]);
  return row;
}

export async function updateFact(
  db: D1Database,
  id: string,
  patch: { fact?: string; subject?: string | null; disclosed?: boolean; provisional?: boolean; source?: string | null },
  actor: string,
): Promise<FactRow> {
  const old = await requireFact(db, id);
  assertFixed(old.scope, "edited");
  if (old.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a fact can be edited");
  const t = nowIso();
  const row: FactRow = {
    ...old,
    id: newId("f"),
    fact: patch.fact === undefined ? old.fact : requireText(patch.fact, "fact"),
    subject: patch.subject === undefined ? old.subject : optionalText(patch.subject, "subject", 200),
    source: patch.source === undefined ? old.source : optionalText(patch.source, "source", 500),
    disclosed: patch.disclosed === undefined ? old.disclosed : patch.disclosed ? 1 : 0,
    provisional: patch.provisional === undefined ? old.provisional : patch.provisional ? 1 : 0,
    status: "approved",
    version: old.version + 1,
    supersedes_id: old.id,
    updated_at: t,
  };
  await db.batch([
    supersedeStmt(db, "facts", old.id, t),
    insertFactStmt(db, row),
    auditStmt(db, actor, "fact.update", "fact", row.id, old, row),
  ]);
  return row;
}

// Deleting is superseding with a rejected head: the chain stays intact and restorable.
export async function deleteFact(db: D1Database, id: string, actor: string): Promise<void> {
  const old = await requireFact(db, id);
  assertFixed(old.scope, "deleted");
  if (old.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a fact can be deleted");
  const t = nowIso();
  const row: FactRow = { ...old, id: newId("f"), status: "rejected", version: old.version + 1, supersedes_id: old.id, updated_at: t };
  await db.batch([
    supersedeStmt(db, "facts", old.id, t),
    insertFactStmt(db, row),
    auditStmt(db, actor, "fact.delete", "fact", row.id, old, row),
  ]);
}

export async function restoreFact(db: D1Database, id: string, actor: string): Promise<FactRow> {
  const target = await requireFact(db, id);
  assertFixed(target.scope, "restored");
  const chain = await chainRows<FactRow>(db, "facts", target.id);
  const latest = chain[chain.length - 1] ?? target;
  if (target.status === "approved" && latest.id === target.id) return target;
  const maxVersion = chain.reduce((m, r) => Math.max(m, r.version), target.version);
  const t = nowIso();
  const row: FactRow = { ...target, id: newId("f"), status: "approved", version: maxVersion + 1, supersedes_id: latest.id, updated_at: t };
  const stmts: D1PreparedStatement[] = chain.filter((r) => r.status === "approved").map((r) => supersedeStmt(db, "facts", r.id, t));
  stmts.push(insertFactStmt(db, row));
  stmts.push(auditStmt(db, actor, "fact.restore", "fact", row.id, { restoredFrom: target.id, latest: latest.id }, row));
  await db.batch(stmts);
  return row;
}

export async function factVersions(db: D1Database, id: string): Promise<FactRow[]> {
  await requireFact(db, id);
  return chainRows<FactRow>(db, "facts", id);
}

// ------------------------------------------------------------------ history

function insertHistoryStmt(db: D1Database, h: HistoryRow): D1PreparedStatement {
  return db.prepare("INSERT INTO history (id, seq, title, occurred, body, what_changed, keep_consistent, source, status, version, supersedes_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
    .bind(h.id, h.seq, h.title, h.occurred, h.body, h.what_changed, h.keep_consistent, h.source, h.status, h.version, h.supersedes_id, h.created_at, h.updated_at);
}

async function requireHistory(db: D1Database, id: string): Promise<HistoryRow> {
  const row = await getHistory(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "history entry not found");
  return row;
}

export async function createHistory(
  db: D1Database,
  input: { title: string; occurred?: string | null; body: string; what_changed?: string | null; keep_consistent?: string | null; source?: string | null },
  actor: string,
): Promise<HistoryRow> {
  const t = nowIso();
  const maxSeq = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM history").first<{ m: number }>();
  const row: HistoryRow = {
    id: newId("h"),
    seq: (maxSeq?.m ?? 0) + 1,
    title: requireText(input.title, "title", 300),
    occurred: optionalText(input.occurred, "occurred", 200),
    body: requireText(input.body, "body", 20_000),
    what_changed: optionalText(input.what_changed, "what_changed"),
    keep_consistent: optionalText(input.keep_consistent, "keep_consistent"),
    source: optionalText(input.source, "source", 500),
    status: "approved",
    version: 1,
    supersedes_id: null,
    created_at: t,
    updated_at: t,
  };
  await db.batch([insertHistoryStmt(db, row), auditStmt(db, actor, "history.create", "history", row.id, null, row)]);
  return row;
}

export async function updateHistory(
  db: D1Database,
  id: string,
  patch: Partial<{ title: string; occurred: string | null; body: string; what_changed: string | null; keep_consistent: string | null; source: string | null }>,
  actor: string,
): Promise<HistoryRow> {
  const old = await requireHistory(db, id);
  if (old.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a history entry can be edited");
  const t = nowIso();
  const row: HistoryRow = {
    ...old,
    id: newId("h"),
    title: patch.title === undefined ? old.title : requireText(patch.title, "title", 300),
    occurred: patch.occurred === undefined ? old.occurred : optionalText(patch.occurred, "occurred", 200),
    body: patch.body === undefined ? old.body : requireText(patch.body, "body", 20_000),
    what_changed: patch.what_changed === undefined ? old.what_changed : optionalText(patch.what_changed, "what_changed"),
    keep_consistent: patch.keep_consistent === undefined ? old.keep_consistent : optionalText(patch.keep_consistent, "keep_consistent"),
    source: patch.source === undefined ? old.source : optionalText(patch.source, "source", 500),
    status: "approved",
    version: old.version + 1,
    supersedes_id: old.id,
    updated_at: t,
  };
  await db.batch([
    supersedeStmt(db, "history", old.id, t),
    insertHistoryStmt(db, row),
    auditStmt(db, actor, "history.update", "history", row.id, old, row),
  ]);
  return row;
}

export async function deleteHistory(db: D1Database, id: string, actor: string): Promise<void> {
  const old = await requireHistory(db, id);
  if (old.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a history entry can be deleted");
  const t = nowIso();
  const row: HistoryRow = { ...old, id: newId("h"), status: "rejected", version: old.version + 1, supersedes_id: old.id, updated_at: t };
  await db.batch([
    supersedeStmt(db, "history", old.id, t),
    insertHistoryStmt(db, row),
    auditStmt(db, actor, "history.delete", "history", row.id, old, row),
  ]);
}

export async function restoreHistory(db: D1Database, id: string, actor: string): Promise<HistoryRow> {
  const target = await requireHistory(db, id);
  const chain = await chainRows<HistoryRow>(db, "history", target.id);
  const latest = chain[chain.length - 1] ?? target;
  if (target.status === "approved" && latest.id === target.id) return target;
  const maxVersion = chain.reduce((m, r) => Math.max(m, r.version), target.version);
  const t = nowIso();
  const row: HistoryRow = { ...target, id: newId("h"), status: "approved", version: maxVersion + 1, supersedes_id: latest.id, updated_at: t };
  const stmts: D1PreparedStatement[] = chain.filter((r) => r.status === "approved").map((r) => supersedeStmt(db, "history", r.id, t));
  stmts.push(insertHistoryStmt(db, row));
  stmts.push(auditStmt(db, actor, "history.restore", "history", row.id, { restoredFrom: target.id, latest: latest.id }, row));
  await db.batch(stmts);
  return row;
}

export async function historyVersions(db: D1Database, id: string): Promise<HistoryRow[]> {
  await requireHistory(db, id);
  return chainRows<HistoryRow>(db, "history", id);
}

// ------------------------------------------------------------------ unknowns

async function requireUnknown(db: D1Database, id: string): Promise<UnknownRow> {
  const row = await db.prepare("SELECT * FROM unknowns WHERE id = ?1").bind(id).first<UnknownRow>();
  if (!row) throw new ApiHttpError(404, "not_found", "unknown not found");
  return row;
}

export async function createUnknown(db: D1Database, input: { topic: string; note?: string | null }, actor: string): Promise<UnknownRow> {
  const t = nowIso();
  const row: UnknownRow = {
    id: newId("u"),
    topic: requireText(input.topic, "topic", 500),
    note: optionalText(input.note, "note"),
    status: "open",
    resolution: null,
    created_at: t,
    updated_at: t,
  };
  await db.batch([
    db.prepare("INSERT INTO unknowns (id, topic, note, status, resolution, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(row.id, row.topic, row.note, row.status, row.resolution, row.created_at, row.updated_at),
    auditStmt(db, actor, "unknown.create", "unknown", row.id, null, row),
  ]);
  return row;
}

export async function updateUnknown(
  db: D1Database,
  id: string,
  patch: { status?: "open" | "resolved"; note?: string | null; resolution?: string | null },
  actor: string,
): Promise<UnknownRow> {
  const old = await requireUnknown(db, id);
  if (patch.status !== undefined && patch.status !== "open" && patch.status !== "resolved") {
    throw new ApiHttpError(400, "validation", "status must be open or resolved");
  }
  const row: UnknownRow = {
    ...old,
    status: patch.status ?? old.status,
    note: patch.note === undefined ? old.note : optionalText(patch.note, "note"),
    resolution: patch.resolution === undefined ? old.resolution : optionalText(patch.resolution, "resolution"),
    updated_at: nowIso(),
  };
  await db.batch([
    db.prepare("UPDATE unknowns SET status = ?2, note = ?3, resolution = ?4, updated_at = ?5 WHERE id = ?1")
      .bind(row.id, row.status, row.note, row.resolution, row.updated_at),
    auditStmt(db, actor, "unknown.update", "unknown", row.id, old, row),
  ]);
  return row;
}
