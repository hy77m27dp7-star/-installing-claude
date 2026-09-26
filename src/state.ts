// Facts / history / unknowns / state versions: every edit is a new row, every write is
// audited in the same batch. Fixed canon is read-only through this module.
import {
  appendStateStmt, auditStmt, getCurrentState, getFact, getHistory, listFacts, listHistory, listUnknowns,
  newId, nowIso,
} from "./db";
import { ApiHttpError } from "./errors";
// v3 (SPEC_V3 section BB): the weight and last-touched of a fact or history entry follow the
// head of its version chain.
import { carryStmt } from "./memory";
// v5 (SPEC_V5 section 4): every scene version carries status, location, time and present.
import { normalizeSceneFields } from "./standing";
import type { FactRow, FactScope, HistoryRow, RelationshipState, SceneState, StateVersionRow, UnknownRow } from "./types";

// v5 (SPEC_V5 section 7): a fact may be a guess of hers about him (inferred 1). Read as
// optional so a database behind 0009 (no column) and a FactRow without the field both work.
type FactRowV5 = FactRow & { inferred?: number };

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
// `cooling_off_until` (ISO time or null). v3 (SPEC_V3 section CC) adds `mood_set_at` (ISO)
// and `mood_days` (1..14). All four are checked and normalised here so a malformed value
// can never reach the prompt; every other key passes through untouched.
const MAX_MOOD = 200;
export const MOOD_DAYS_MIN = 1;
export const MOOD_DAYS_MAX = 14;

export function normalizeRelationshipFields(state: Record<string, unknown>): Record<string, unknown> {
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
  if ("mood_set_at" in out) {
    const at = out.mood_set_at;
    if (at === null || at === undefined || (typeof at === "string" && !at.trim())) {
      delete out.mood_set_at;
    } else {
      if (typeof at !== "string") throw new ApiHttpError(400, "validation", "mood_set_at must be an ISO 8601 time or null");
      const t = Date.parse(at);
      if (!Number.isFinite(t)) throw new ApiHttpError(400, "validation", "mood_set_at must be an ISO 8601 time or null");
      out.mood_set_at = new Date(t).toISOString();
    }
  }
  if ("mood_days" in out) {
    const days = out.mood_days;
    if (days === null || days === undefined || days === "") {
      delete out.mood_days;
    } else {
      const n = typeof days === "number" ? days : typeof days === "string" ? Number(days) : NaN;
      if (!Number.isInteger(n) || n < MOOD_DAYS_MIN || n > MOOD_DAYS_MAX) {
        throw new ApiHttpError(400, "validation", `mood_days must be a whole number from ${MOOD_DAYS_MIN} to ${MOOD_DAYS_MAX}`);
      }
      out.mood_days = n;
    }
  }
  // v5 (SPEC_V5 section 4): friction with its stamp and days, the story-time cooling off
  // pair, and the rung a lateral state left.
  if ("friction" in out) {
    const f = out.friction;
    if (f === null || f === undefined) {
      delete out.friction;
    } else {
      if (typeof f !== "string") throw new ApiHttpError(400, "validation", "friction must be a string");
      const t = f.trim();
      if (t.length > MAX_FRICTION) throw new ApiHttpError(400, "validation", `friction exceeds ${MAX_FRICTION} characters`);
      if (t) out.friction = t;
      else delete out.friction;
    }
  }
  if ("friction_set_at" in out) {
    const at = isoOrNull(out.friction_set_at, "friction_set_at");
    if (at) out.friction_set_at = at;
    else delete out.friction_set_at;
  }
  if ("friction_days" in out) {
    const days = out.friction_days;
    if (days === null || days === undefined || days === "") {
      delete out.friction_days;
    } else {
      const n = typeof days === "number" ? days : typeof days === "string" ? Number(days) : NaN;
      if (!Number.isInteger(n) || n < FRICTION_DAYS_MIN || n > FRICTION_DAYS_MAX) {
        throw new ApiHttpError(400, "validation", `friction_days must be a whole number from ${FRICTION_DAYS_MIN} to ${FRICTION_DAYS_MAX}`);
      }
      out.friction_days = n;
    }
  }
  if ("cooling_off_set_at" in out) out.cooling_off_set_at = isoOrNull(out.cooling_off_set_at, "cooling_off_set_at");
  if ("cooling_off_hours" in out) {
    const h = out.cooling_off_hours;
    if (h === null || h === undefined || h === "") {
      out.cooling_off_hours = null;
    } else {
      const n = typeof h === "number" ? h : typeof h === "string" ? Number(h) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > COOLING_OFF_HOURS_MAX) {
        throw new ApiHttpError(400, "validation", `cooling_off_hours must be a number from 0 to ${COOLING_OFF_HOURS_MAX} or null`);
      }
      out.cooling_off_hours = n;
    }
  }
  if ("status_before" in out) {
    const b = out.status_before;
    if (b === null || b === undefined) {
      out.status_before = null;
    } else {
      if (typeof b !== "string") throw new ApiHttpError(400, "validation", "status_before must be a string or null");
      const t = b.trim();
      if (t.length > MAX_STATUS_BEFORE) throw new ApiHttpError(400, "validation", `status_before exceeds ${MAX_STATUS_BEFORE} characters`);
      out.status_before = t || null;
    }
  }
  // No mood, no clock.
  if (!("mood" in out)) delete out.mood_set_at;
  // No friction, no clock.
  if (!("friction" in out)) delete out.friction_set_at;
  return out;
}

const MAX_FRICTION = 200;
const MAX_STATUS_BEFORE = 200;
const FRICTION_DAYS_MIN = 1;
const FRICTION_DAYS_MAX = 14;
const COOLING_OFF_HOURS_MAX = 336;
const FRICTION_HEALED = /^(?:none|healed|no friction|nothing)$/i;

// An ISO 8601 time normalised, null for null or empty; anything else is a 400.
function isoOrNull(value: unknown, name: string): string | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "string") throw new ApiHttpError(400, "validation", `${name} must be an ISO 8601 time or null`);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new ApiHttpError(400, "validation", `${name} must be an ISO 8601 time or null`);
  return new Date(t).toISOString();
}

// The mood clock (SPEC_V3 section CC): a new or changed mood is stamped now unless the
// caller stamped it; an unchanged mood keeps the stamp it had, even when the caller sent
// the state without it (the Now tab round-trips the object; a proposal spreads it).
function stampMood(next: Record<string, unknown>, current: Record<string, unknown>, now: Date): Record<string, unknown> {
  const out = { ...next };
  const mood = typeof out.mood === "string" ? out.mood : "";
  if (!mood) return out;
  if (typeof out.mood_set_at === "string" && out.mood_set_at) return out;
  const curMood = typeof current.mood === "string" ? current.mood : "";
  const curAt = typeof current.mood_set_at === "string" ? current.mood_set_at : "";
  out.mood_set_at = mood === curMood && curAt ? curAt : now.toISOString();
  return out;
}

// The friction clock (SPEC_V5 section 4), the twin of stampMood: a new or changed friction
// is stamped now unless the caller stamped it (a stamp that differs from the current one);
// an unchanged friction keeps the stamp it had, even when the caller sent the state without
// it; a healed friction ("none") carries no stamp.
function stampFriction(next: Record<string, unknown>, current: Record<string, unknown>, now: Date): Record<string, unknown> {
  const out = { ...next };
  const friction = typeof out.friction === "string" ? out.friction.trim() : "";
  if (!friction || FRICTION_HEALED.test(friction)) {
    delete out.friction_set_at;
    return out;
  }
  const curFriction = typeof current.friction === "string" ? current.friction.trim() : "";
  const curAt = typeof current.friction_set_at === "string" ? current.friction_set_at : "";
  const given = typeof out.friction_set_at === "string" ? out.friction_set_at : "";
  if (given && given !== curAt) return out;
  out.friction_set_at = friction.toLowerCase() === curFriction.toLowerCase() && curAt ? curAt : now.toISOString();
  return out;
}

// The cooling-off control (v5 integration): the Now tab and the v2 flow write only
// `cooling_off_until`, while a v5 proposal also writes the story-time pair that coolingOffNow
// (src/standing.ts) reads first. When a write changes `cooling_off_until` and leaves the pair
// exactly as it was, his own deadline becomes the pair (review fix: set now, for the hours
// until his deadline, capped at 336), so held days of a together scene never run his
// deadline out either; his clear (or a deadline already past) drops the pair. A write that
// sets the pair itself (a proposal, moveRelationship) keeps what it wrote.
const COOLING_HOURS_MAX = 336;

function stampCooling(next: Record<string, unknown>, current: Record<string, unknown>, now: Date): Record<string, unknown> {
  const until = (s: Record<string, unknown>): string | null => (typeof s.cooling_off_until === "string" && s.cooling_off_until ? s.cooling_off_until : null);
  const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
  if (until(next) === until(current)) return next;
  if (!same(next.cooling_off_set_at, current.cooling_off_set_at) || !same(next.cooling_off_hours, current.cooling_off_hours)) return next;
  const u = until(next);
  const untilMs = u ? Date.parse(u) : NaN;
  const hours = Number.isFinite(untilMs) ? Math.min(COOLING_HOURS_MAX, (untilMs - now.getTime()) / 3_600_000) : NaN;
  if (!(hours > 0)) return { ...next, cooling_off_set_at: null, cooling_off_hours: null };
  return { ...next, cooling_off_set_at: now.toISOString(), cooling_off_hours: Math.round(hours * 1000) / 1000 };
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
  const current = await getCurrentState(db, entity);
  const curState = current.state as Record<string, unknown>;
  const at = new Date();
  // v5 (SPEC_V5 section 4): the owner's own scene write is strict (a together scene with no
  // place is refused); a proposal's state was already normalised by mergeSceneState, which
  // decided the time words from its payload, so it passes through the non-strict form with
  // the time kept as given (the result is the same object for an already normal state).
  const normalized = entity === "relationship"
    ? stampCooling(stampFriction(stampMood(normalizeRelationshipFields(state), curState, at), curState, at), curState, at)
    : source === "proposal"
      ? normalizeSceneFields(state, curState, { strict: false, timeSet: true })
      : normalizeSceneFields(state, curState, { strict: true });
  const json = JSON.stringify(normalized);
  if (json.length > MAX_STATE_JSON) throw new ApiHttpError(400, "validation", "state is too large");
  const stored = JSON.parse(json) as Record<string, unknown>;
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
  const raw = JSON.parse(row.state_json) as Record<string, unknown>;
  const current = await getCurrentState(db, entity);
  // Review fix (SPEC_V5 section 4): a restored scene version is written in the v5 shape (the
  // four keys, apart's carried place dropped), the restored time words kept as that scene's.
  const state = entity === "scene"
    ? normalizeSceneFields(raw, current.state as Record<string, unknown>, { strict: false, timeSet: true })
    : raw;
  const next = current.version + 1;
  await db.batch([
    appendStateStmt(db, entity, next, state, "restore", `restored from version ${version}`),
    auditStmt(db, actor, "state.restore", `state.${entity}`, String(next), { version: current.version, state: current.state }, { version: next, restoredFrom: version, state }),
  ]);
  return { version: next, state };
}

// ------------------------------------------------------------------ facts

// The inferred column is written only when the row is a guess (1), so a database behind
// 0009 keeps working for every fact that is not one (the pattern insertMessageStmt uses for
// call_id).
function insertFactStmt(db: D1Database, f: FactRowV5): D1PreparedStatement {
  if (f.inferred === 1) {
    return db.prepare("INSERT INTO facts (id, scope, subject, fact, source, status, disclosed, provisional, version, supersedes_id, created_at, updated_at, inferred) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
      .bind(f.id, f.scope, f.subject, f.fact, f.source, f.status, f.disclosed, f.provisional, f.version, f.supersedes_id, f.created_at, f.updated_at, 1);
  }
  return db.prepare("INSERT INTO facts (id, scope, subject, fact, source, status, disclosed, provisional, version, supersedes_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
    .bind(f.id, f.scope, f.subject, f.fact, f.source, f.status, f.disclosed, f.provisional, f.version, f.supersedes_id, f.created_at, f.updated_at);
}

async function requireFact(db: D1Database, id: string): Promise<FactRowV5> {
  const row = await getFact(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "fact not found");
  return row as FactRowV5;
}

export async function createFact(
  db: D1Database,
  input: { scope: FactScope; subject?: string | null; fact: string; source?: string | null; disclosed?: boolean; provisional?: boolean; inferred?: boolean },
  actor: string,
): Promise<FactRow> {
  if (!FACT_SCOPES.includes(input.scope)) throw new ApiHttpError(400, "validation", "scope must be avelie, justin or shared");
  assertFixed(input.scope, "created");
  const t = nowIso();
  const row: FactRowV5 = {
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
    inferred: input.inferred === true ? 1 : 0,
  };
  await db.batch([insertFactStmt(db, row), auditStmt(db, actor, "fact.create", "fact", row.id, null, row)]);
  return row;
}

export async function updateFact(
  db: D1Database,
  id: string,
  patch: { fact?: string; subject?: string | null; disclosed?: boolean; provisional?: boolean; source?: string | null; inferred?: boolean },
  actor: string,
): Promise<FactRow> {
  const old = await requireFact(db, id);
  assertFixed(old.scope, "edited");
  if (old.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a fact can be edited");
  if (patch.inferred === true && old.scope !== "justin" && old.scope !== "shared") {
    throw new ApiHttpError(400, "validation", "only a fact about him can be her guess");
  }
  const t = nowIso();
  const row: FactRowV5 = {
    ...old,
    id: newId("f"),
    fact: patch.fact === undefined ? old.fact : requireText(patch.fact, "fact"),
    subject: patch.subject === undefined ? old.subject : optionalText(patch.subject, "subject", 200),
    source: patch.source === undefined ? old.source : optionalText(patch.source, "source", 500),
    disclosed: patch.disclosed === undefined ? old.disclosed : patch.disclosed ? 1 : 0,
    provisional: patch.provisional === undefined ? old.provisional : patch.provisional ? 1 : 0,
    inferred: patch.inferred === undefined ? (old.inferred === 1 ? 1 : 0) : patch.inferred ? 1 : 0,
    status: "approved",
    version: old.version + 1,
    supersedes_id: old.id,
    updated_at: t,
  };
  await db.batch([
    supersedeStmt(db, "facts", old.id, t),
    insertFactStmt(db, row),
    carryStmt(db, "fact", old.id, row.id),
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
  const row: FactRowV5 = { ...old, id: newId("f"), status: "rejected", version: old.version + 1, supersedes_id: old.id, updated_at: t };
  await db.batch([
    supersedeStmt(db, "facts", old.id, t),
    insertFactStmt(db, row),
    auditStmt(db, actor, "fact.delete", "fact", row.id, old, row),
  ]);
}

export async function restoreFact(db: D1Database, id: string, actor: string): Promise<FactRow> {
  const target = await requireFact(db, id);
  assertFixed(target.scope, "restored");
  const chain = await chainRows<FactRowV5>(db, "facts", target.id);
  const latest = chain[chain.length - 1] ?? target;
  if (target.status === "approved" && latest.id === target.id) return target;
  const maxVersion = chain.reduce((m, r) => Math.max(m, r.version), target.version);
  const t = nowIso();
  const row: FactRowV5 = { ...target, id: newId("f"), status: "approved", version: maxVersion + 1, supersedes_id: latest.id, updated_at: t };
  const stmts: D1PreparedStatement[] = chain.filter((r) => r.status === "approved").map((r) => supersedeStmt(db, "facts", r.id, t));
  stmts.push(insertFactStmt(db, row));
  stmts.push(carryStmt(db, "fact", latest.id, row.id));
  stmts.push(auditStmt(db, actor, "fact.restore", "fact", row.id, { restoredFrom: target.id, latest: latest.id }, row));
  await db.batch(stmts);
  return row;
}

// v5 (SPEC_V5 section 7): one fact said several ways becomes one. The keep's chain gets a
// new head with the merged words and every source joined; each merged chain gets a rejected
// head sourced "merged into {id}", the way deleteFact leaves a restorable chain; the weights
// of the group follow the new head. Nothing is deleted.
const MERGE_MAX = 10;
const MERGE_SOURCE_MAX = 500;

function isHimScope(scope: FactScope): boolean {
  return scope === "justin" || scope === "shared";
}

export async function mergeFacts(
  db: D1Database,
  input: { keepId: string; mergeIds: string[]; text: string; source: string },
  actor: string,
): Promise<FactRow> {
  if (typeof input.keepId !== "string" || !input.keepId.trim()) throw new ApiHttpError(400, "validation", "keepId is required");
  const keep = await requireFact(db, input.keepId.trim());
  if (keep.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a fact can be kept in a merge");
  assertFixed(keep.scope, "merged");
  if (!Array.isArray(input.mergeIds)) throw new ApiHttpError(400, "validation", "mergeIds must be a list of fact ids");
  const ids: string[] = [];
  for (const raw of input.mergeIds) {
    if (typeof raw !== "string" || !raw.trim()) throw new ApiHttpError(400, "validation", "mergeIds must be fact ids");
    const id = raw.trim();
    if (id === keep.id) throw new ApiHttpError(400, "validation", "a fact cannot be merged into itself");
    if (ids.includes(id)) throw new ApiHttpError(400, "validation", "mergeIds must be distinct");
    ids.push(id);
  }
  if (ids.length < 1 || ids.length > MERGE_MAX) throw new ApiHttpError(400, "validation", `mergeIds must name 1 to ${MERGE_MAX} facts`);
  const text = requireText(input.text, "fact");
  const merged: FactRowV5[] = [];
  for (const id of ids) {
    const f = await requireFact(db, id);
    if (f.status !== "approved") throw new ApiHttpError(409, "not_current", "only the current version of a fact can be merged");
    assertFixed(f.scope, "merged");
    const sameSide = isHimScope(keep.scope) ? isHimScope(f.scope) : f.scope === keep.scope;
    if (!sameSide) throw new ApiHttpError(400, "validation", "a merge keeps to one side: facts about him with facts about him");
    merged.push(f);
  }
  const t = nowIso();
  const sources = [keep.source, ...merged.map((m) => m.source)].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  const head: FactRowV5 = {
    ...keep,
    id: newId("f"),
    fact: text,
    source: ("merged: " + sources.join("; ")).slice(0, MERGE_SOURCE_MAX),
    status: "approved",
    version: keep.version + 1,
    supersedes_id: keep.id,
    updated_at: t,
    inferred: [keep, ...merged].every((f) => f.inferred === 1) ? 1 : 0,
  };
  const rejected: FactRowV5[] = merged.map((m) => ({
    ...m,
    id: newId("f"),
    status: "rejected",
    version: m.version + 1,
    supersedes_id: m.id,
    source: `merged into ${head.id}`,
    updated_at: t,
  }));
  const groupIds = [keep.id, ...ids];
  const placeholders = groupIds.map((_, i) => `?${i + 3}`).join(", ");
  const weightStmt = db.prepare(
    `INSERT INTO memory_weights (entity, entity_id, weight, last_touched, touches, source, updated_at)
       SELECT 'fact', ?1, MAX(weight), MAX(last_touched), SUM(touches), 'merge', ?2 FROM memory_weights
       WHERE entity = 'fact' AND entity_id IN (${placeholders}) HAVING COUNT(*) > 0
       ON CONFLICT(entity, entity_id) DO UPDATE SET weight = excluded.weight, last_touched = excluded.last_touched, touches = excluded.touches, source = excluded.source, updated_at = excluded.updated_at`,
  ).bind(head.id, t, ...groupIds);
  const stmts: D1PreparedStatement[] = [
    supersedeStmt(db, "facts", keep.id, t),
    insertFactStmt(db, head),
    carryStmt(db, "fact", keep.id, head.id),
  ];
  merged.forEach((m, i) => {
    const r = rejected[i];
    if (!r) return;
    stmts.push(supersedeStmt(db, "facts", m.id, t));
    stmts.push(insertFactStmt(db, r));
  });
  stmts.push(weightStmt);
  stmts.push(auditStmt(db, actor, "fact.merge", "fact", head.id, { keep, merged }, { head, rejected, source: input.source ?? null }));
  await db.batch(stmts);
  return head;
}

// v5 (SPEC_V5 section 7): mark a fact about him as her guess (or not); a new head in its
// chain, the reason appended to its source.
export async function setFactInferred(db: D1Database, id: string, inferred: boolean, source: string, actor: string): Promise<FactRow> {
  const old = await requireFact(db, id);
  const add = typeof source === "string" ? source.trim() : "";
  const joined = (old.source ? old.source + (add ? " | " + add : "") : add).slice(0, MERGE_SOURCE_MAX);
  return updateFact(db, id, { inferred: inferred === true, source: joined || null }, actor);
}

export async function factVersions(db: D1Database, id: string): Promise<FactRow[]> {
  await requireFact(db, id);
  return chainRows<FactRowV5>(db, "facts", id);
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
    carryStmt(db, "history", old.id, row.id),
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
  stmts.push(carryStmt(db, "history", latest.id, row.id));
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
