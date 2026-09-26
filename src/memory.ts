// Human memory (SPEC_V3 section BB): every fact about him, every history entry, every
// person, place and arc, every life note and every want carries an emotional weight and
// a last-touched time. Context assembly prefers what mattered and what came up recently
// and drops what a person would have let go. Nothing is deleted: a faded row is simply
// not in the prompt, and it comes back the moment it is touched.
//
// The pure half (scoring, ranking, the provisional pick, the touch hits, the section)
// never touches the database, so the unit suite runs it under Node. The db half writes
// memory_weights and memory_recalls; every owner write is audited in the same batch.
// The recall outcome bookkeeping (outcomeStmt and the corrected/confirmed outcomes) is
// v3.1; v3 writes outcome 'unknown' and never reads it.
import { auditStmt, listProposals, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import type { FactRow, HistoryRow, ProposalRow } from "./types";
import type { LifeThread } from "./life";
import { saidKey } from "./said";

export type MemoryEntity = "fact" | "history" | "thread" | "log" | "want";

export interface WeightRow {
  entity: MemoryEntity;
  entity_id: string;
  weight: number;
  last_touched: string;
  touches: number;
  source: string | null;
  updated_at: string;
}

export interface RecallRow {
  id: string;
  message_id: string;
  conversation_id: string;
  entity: string;
  entity_id: string;
  mode: "provisional";
  score: number;
  text_shown: string;
  outcome: "unknown" | "confirmed" | "corrected";
  outcome_message_id: string | null;
  created_at: string;
  updated_at: string;
}

// The settings this module reads (the SPEC_V3 Settings table). Every key is optional so
// a Settings object that predates them still resolves to the shipped defaults; `timezone`
// is listed so the v1 Settings shape overlaps and passes the weak-type check.
export interface MemorySettings {
  memoryDecayEnabled?: boolean;
  memoryFactsMax?: number;
  memoryHalfLifeLowDays?: number;
  memoryHalfLifeMidDays?: number;
  memoryHalfLifeHighDays?: number;
  provisionalRecallEvery?: number;
  timezone?: string;
}

export interface ResolvedMemorySettings {
  memoryDecayEnabled: boolean;
  memoryFactsMax: number;
  memoryHalfLifeLowDays: number;
  memoryHalfLifeMidDays: number;
  memoryHalfLifeHighDays: number;
  provisionalRecallEvery: number;
}

export const MEMORY_DEFAULTS: ResolvedMemorySettings = {
  memoryDecayEnabled: true,
  memoryFactsMax: 40,
  memoryHalfLifeLowDays: 10,
  memoryHalfLifeMidDays: 45,
  memoryHalfLifeHighDays: 400,
  provisionalRecallEvery: 0,
};

// Score bands (section BB).
export const FIRM_THRESHOLD = 0.2;
// The firm test allows this much under the threshold: a Low (0.2) fact touched a moment ago
// scores 0.2 x (0.35 + 0.65 x recency) with recency a hair under 1, which is a hair under
// 0.20; "Remind her" must make it firm, and a few hours later the low half-life takes over.
export const FIRM_EPSILON = 0.001;
export const HISTORY_OLDER_THRESHOLD = 0.25;
export const THREAD_THRESHOLD = 0.15;
export const LOW_WEIGHT_MAX = 0.34;
export const HIGH_WEIGHT_MIN = 0.67;
export const HISTORY_NEWEST_ALWAYS = 6;
export const HISTORY_MAX = 12;
export const TOUCH_MAX = 10;

// A missing memory_weights row means these: facts about him 0.5, history 0.7, person
// threads 0.6, other threads 0.5, log notes 0.3, wants 0.6.
export const DEFAULT_WEIGHTS = {
  fact: 0.5,
  history: 0.7,
  person: 0.6,
  thread: 0.5,
  log: 0.3,
  want: 0.6,
} as const;

export const MEMORY_ENTITIES: readonly MemoryEntity[] = ["fact", "history", "thread", "log", "want"];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYWORDS_FOR_RELEVANCE = 6;
const RECALL_TEXT_MAX = 300;
const TABLE: Record<MemoryEntity, string> = { fact: "facts", history: "history", thread: "life_threads", log: "life_log", want: "wants" };

// The same stop list context.ts uses (kept local: context.ts imports this module).
const STOP = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is", "it", "was", "i", "you", "he", "she", "we", "they", "that", "this", "my", "your", "her", "his", "me", "so", "do", "not", "just", "like", "what", "about", "have", "had", "be", "are", "were", "from", "as", "if", "then", "than", "too", "very", "ok", "okay", "yeah", "no", "yes"]);

// ------------------------------------------------------------------ small pure helpers

export function isMemoryEntity(v: unknown): v is MemoryEntity {
  return typeof v === "string" && (MEMORY_ENTITIES as readonly string[]).includes(v);
}

export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)) {
    const t = w.replace(/^'+|'+$/g, "");
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : fallback;
}

export function memorySettings(s: MemorySettings | null | undefined): ResolvedMemorySettings {
  const d = MEMORY_DEFAULTS;
  if (!s || typeof s !== "object") return { ...d };
  return {
    memoryDecayEnabled: typeof s.memoryDecayEnabled === "boolean" ? s.memoryDecayEnabled : d.memoryDecayEnabled,
    memoryFactsMax: int(s.memoryFactsMax, d.memoryFactsMax, 5, 200),
    memoryHalfLifeLowDays: int(s.memoryHalfLifeLowDays, d.memoryHalfLifeLowDays, 1, 365),
    memoryHalfLifeMidDays: int(s.memoryHalfLifeMidDays, d.memoryHalfLifeMidDays, 1, 3650),
    memoryHalfLifeHighDays: int(s.memoryHalfLifeHighDays, d.memoryHalfLifeHighDays, 1, 36500),
    provisionalRecallEvery: int(s.provisionalRecallEvery, d.provisionalRecallEvery, 0, 50),
  };
}

export function weightKey(entity: MemoryEntity, id: string): string {
  return entity + ":" + id;
}

// The default weight for a row that carries none. Threads split by kind (person 0.6).
export function defaultWeight(entity: MemoryEntity, row?: { kind?: string | null } | null): number {
  if (entity === "thread") return row && row.kind === "person" ? DEFAULT_WEIGHTS.person : DEFAULT_WEIGHTS.thread;
  return DEFAULT_WEIGHTS[entity];
}

export interface WeightInfo {
  weight: number;
  lastTouched: string;
  touches: number;
  // true when a memory_weights row exists for it; false means the defaults were used.
  stored: boolean;
}

// The weight and last-touched time of a row: the stored row when there is one, else the
// defaults with last_touched = the row's created_at.
export function weightFor(
  map: Map<string, WeightRow> | null | undefined,
  entity: MemoryEntity,
  row: { id: string; created_at: string; kind?: string | null },
  fallback?: number,
): WeightInfo {
  const stored = map ? map.get(weightKey(entity, row.id)) : undefined;
  if (stored) {
    const w = typeof stored.weight === "number" && Number.isFinite(stored.weight) ? clamp(stored.weight, 0, 1) : defaultWeight(entity, row);
    const lt = typeof stored.last_touched === "string" && Number.isFinite(Date.parse(stored.last_touched)) ? stored.last_touched : row.created_at;
    return { weight: w, lastTouched: lt, touches: Number.isFinite(stored.touches) ? stored.touches : 0, stored: true };
  }
  const w = typeof fallback === "number" && Number.isFinite(fallback) ? clamp(fallback, 0, 1) : defaultWeight(entity, row);
  return { weight: w, lastTouched: row.created_at, touches: 0, stored: false };
}

// ------------------------------------------------------------------ scoring (pure)

export function halfLifeDays(w: number, settings: MemorySettings | null | undefined): number {
  const s = memorySettings(settings);
  if (w < LOW_WEIGHT_MAX) return s.memoryHalfLifeLowDays;
  if (w < HIGH_WEIGHT_MIN) return s.memoryHalfLifeMidDays;
  return s.memoryHalfLifeHighDays;
}

export interface MemoryScore {
  score: number;
  recency: number;
  relevance: number;
  ageDays: number;
  halfLifeDays: number;
  weight: number;
  // Firm: in the prompt. Score at or above the threshold, or a high weight, or decay off.
  firm: boolean;
}

function ageInDays(lastTouched: string, now: Date): number {
  const t = Date.parse(lastTouched);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / DAY_MS);
}

export function relevanceOf(text: string, recentKeywords: Set<string> | null | undefined): number {
  const kw = keywords(text);
  if (!kw.size || !recentKeywords || !recentKeywords.size) return 0;
  let hits = 0;
  for (const k of kw) if (recentKeywords.has(k)) hits++;
  return clamp(hits / Math.max(1, Math.min(MAX_KEYWORDS_FOR_RELEVANCE, kw.size)), 0, 1);
}

export function scoreDetail(
  w: number,
  lastTouched: string,
  text: string,
  recentKeywords: Set<string> | null | undefined,
  now: Date,
  settings: MemorySettings | null | undefined,
): MemoryScore {
  const s = memorySettings(settings);
  const weight = clamp(Number.isFinite(w) ? w : 0.5, 0, 1);
  const age = ageInDays(lastTouched, now);
  const half = halfLifeDays(weight, s);
  const relevance = relevanceOf(text, recentKeywords);
  if (!s.memoryDecayEnabled) {
    return { score: 1, recency: 1, relevance, ageDays: age, halfLifeDays: half, weight, firm: true };
  }
  const recency = Math.pow(2, -age / half);
  const score = weight * (0.35 + 0.65 * recency) + 0.3 * relevance;
  return { score, recency, relevance, ageDays: age, halfLifeDays: half, weight, firm: weight >= HIGH_WEIGHT_MIN || score >= FIRM_THRESHOLD - FIRM_EPSILON };
}

export function score(
  w: number,
  lastTouched: string,
  text: string,
  recentKeywords: Set<string> | null | undefined,
  now: Date,
  settings: MemorySettings | null | undefined,
): number {
  return scoreDetail(w, lastTouched, text, recentKeywords, now, settings).score;
}

// ------------------------------------------------------------------ ranking (pure)

export interface Ranked<T> {
  kept: T[];
  faded: T[];
  scores: Map<string, MemoryScore>;
}

export function factText(f: FactRow): string {
  return (f.subject ? f.subject + " " : "") + f.fact;
}

export function historyText(h: HistoryRow): string {
  return h.title + " " + h.body;
}

export function threadText(t: LifeThread): string {
  return t.title + (t.detail ? " " + t.detail : "");
}

// Facts about him: every row with score >= 0.20 (or a high weight), ordered by score,
// capped at memoryFactsMax. Rows below the line are faded, never gone.
export function rankFacts(
  facts: FactRow[],
  map: Map<string, WeightRow> | null | undefined,
  recentKeywords: Set<string> | null | undefined,
  now: Date,
  settings: MemorySettings | null | undefined,
): Ranked<FactRow> {
  const s = memorySettings(settings);
  const scores = new Map<string, MemoryScore>();
  const scored: Array<{ row: FactRow; sc: MemoryScore }> = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f) continue;
    const w = weightFor(map, "fact", f);
    const sc = scoreDetail(w.weight, w.lastTouched, factText(f), recentKeywords, now, s);
    scores.set(f.id, sc);
    scored.push({ row: f, sc });
  }
  const firm = scored.filter((x) => x.sc.firm).sort((a, b) => b.sc.score - a.sc.score);
  const kept = firm.slice(0, s.memoryFactsMax).map((x) => x.row);
  const keptIds = new Set(kept.map((f) => f.id));
  const faded = scored.filter((x) => !keptIds.has(x.row.id)).map((x) => x.row);
  return { kept, faded, scores };
}

// History: the newest 6 always, plus older entries with score >= 0.25, capped at 12,
// ordered by seq. (This replaces selectHistory's vocabulary rule, now the relevance term.)
export function rankHistory(
  history: HistoryRow[],
  map: Map<string, WeightRow> | null | undefined,
  recentKeywords: Set<string> | null | undefined,
  now: Date,
  settings: MemorySettings | null | undefined,
): Ranked<HistoryRow> {
  const s = memorySettings(settings);
  const rows = (Array.isArray(history) ? history.filter((h) => !!h) : []).slice().sort((a, b) => a.seq - b.seq || a.created_at.localeCompare(b.created_at));
  const scores = new Map<string, MemoryScore>();
  const newest = rows.slice(-HISTORY_NEWEST_ALWAYS);
  const older = rows.slice(0, Math.max(0, rows.length - HISTORY_NEWEST_ALWAYS));
  const keptIds = new Set<string>(newest.map((h) => h.id));
  const candidates: Array<{ row: HistoryRow; sc: MemoryScore }> = [];
  for (const h of rows) {
    const w = weightFor(map, "history", h);
    scores.set(h.id, scoreDetail(w.weight, w.lastTouched, historyText(h), recentKeywords, now, s));
  }
  for (const h of older) {
    const sc = scores.get(h.id);
    if (sc && (!s.memoryDecayEnabled || sc.score >= HISTORY_OLDER_THRESHOLD || sc.weight >= HIGH_WEIGHT_MIN)) candidates.push({ row: h, sc });
  }
  // Ties (every score 1 with decay off) go to the newer entry.
  candidates.sort((a, b) => b.sc.score - a.sc.score || b.row.seq - a.row.seq);
  for (const c of candidates) {
    if (keptIds.size >= HISTORY_MAX) break;
    keptIds.add(c.row.id);
  }
  const kept = rows.filter((h) => keptIds.has(h.id));
  const faded = rows.filter((h) => !keptIds.has(h.id));
  return { kept, faded, scores };
}

// Threads of kind person, place, arc: shown with score >= 0.15; routines and events always.
export function rankThreads(
  threads: LifeThread[],
  map: Map<string, WeightRow> | null | undefined,
  recentKeywords: Set<string> | null | undefined,
  now: Date,
  settings: MemorySettings | null | undefined,
): Ranked<LifeThread> {
  const s = memorySettings(settings);
  const scores = new Map<string, MemoryScore>();
  const kept: LifeThread[] = [];
  const faded: LifeThread[] = [];
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t) continue;
    if (t.kind === "routine" || t.kind === "event") {
      kept.push(t);
      continue;
    }
    const w = weightFor(map, "thread", t);
    const sc = scoreDetail(w.weight, w.lastTouched, threadText(t), recentKeywords, now, s);
    scores.set(t.id, sc);
    if (!s.memoryDecayEnabled || sc.weight >= HIGH_WEIGHT_MIN || sc.score >= THREAD_THRESHOLD) kept.push(t);
    else faded.push(t);
  }
  return { kept, faded, scores };
}

// ------------------------------------------------------------------ the provisional recall (pure)

export interface ProvisionalPick {
  entity: "fact";
  entityId: string;
  score: number;
  text: string;
}

// A small, low-weight detail she has not touched in a while, that the conversation is
// brushing against: at most one, never for anything that mattered, never on an opener,
// never while cooling off, never before there is a shared history, never at a rate above
// one per `provisionalRecallEvery` assistant messages, and never while the setting is 0.
export function pickProvisional(
  facts: FactRow[],
  map: Map<string, WeightRow> | null | undefined,
  recentKeywords: Set<string> | null | undefined,
  now: Date,
  settings: MemorySettings | null | undefined,
  recentRecallCount: number,
  coolingOff: boolean,
  hasSharedHistory: boolean,
  opener: boolean,
): ProvisionalPick | null {
  const s = memorySettings(settings);
  if (s.provisionalRecallEvery <= 0) return null;
  if (!s.memoryDecayEnabled) return null;
  if (recentRecallCount > 0) return null;
  if (coolingOff || !hasSharedHistory || opener) return null;
  let best: ProvisionalPick | null = null;
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || f.status !== "approved") continue;
    const w = weightFor(map, "fact", f);
    if (w.weight > LOW_WEIGHT_MAX) continue;
    const sc = scoreDetail(w.weight, w.lastTouched, factText(f), recentKeywords, now, s);
    if (sc.firm || sc.recency >= 0.5 || sc.relevance <= 0) continue;
    if (!best || sc.score > best.score) best = { entity: "fact", entityId: f.id, score: sc.score, text: f.fact.trim().slice(0, RECALL_TEXT_MAX) };
  }
  return best;
}

export function halfRememberSection(pick: ProvisionalPick | null | undefined): string {
  if (!pick || typeof pick.text !== "string" || !pick.text.trim()) return "";
  return [
    "THINGS YOU HALF REMEMBER (real, but the detail is fuzzy in your memory; if it comes up, check the way a person does, once, lightly (\"wait, your sister or your cousin?\"); never use this to get him talking, never make it a bit; if he corrects you, take it, once, no apology loop, and move on)",
    "- " + pick.text.trim() + " (you think)",
  ].join("\n");
}

// ------------------------------------------------------------------ touches (pure half)

export interface TouchCandidate {
  entity: MemoryEntity;
  entityId: string;
  text: string;
  subject?: string | null;
  weight: number;
}

export interface TouchHit {
  entity: MemoryEntity;
  entityId: string;
  weight: number;
  matched: number;
}

// Rows whose keywords (2 or more, or the subject word) appear in his message or her
// reply. Up to `max`, most matched first. This is what makes decay honest: a detail that
// keeps coming up never fades.
export function findTouchHits(rows: TouchCandidate[], hisText: string, herText: string, max = TOUCH_MAX): TouchHit[] {
  const seen = keywords(String(hisText ?? "") + " " + String(herText ?? ""));
  if (!seen.size) return [];
  const hits: TouchHit[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.entityId) continue;
    let matched = 0;
    for (const k of keywords(r.text)) if (seen.has(k)) matched++;
    let subjectHit = false;
    if (r.subject) for (const k of keywords(r.subject)) if (seen.has(k)) subjectHit = true;
    if (matched >= 2 || subjectHit) hits.push({ entity: r.entity, entityId: r.entityId, weight: r.weight, matched: matched + (subjectHit ? 1 : 0) });
  }
  hits.sort((a, b) => b.matched - a.matched || a.entityId.localeCompare(b.entityId));
  return hits.slice(0, Math.max(0, max));
}

// ------------------------------------------------------------------ db: weights

export async function loadWeights(db: D1Database): Promise<Map<string, WeightRow>> {
  const r = await db.prepare("SELECT * FROM memory_weights").all<WeightRow>();
  const map = new Map<string, WeightRow>();
  for (const row of r.results) if (row && isMemoryEntity(row.entity) && typeof row.entity_id === "string") map.set(weightKey(row.entity, row.entity_id), row);
  return map;
}

function requireEntity(entity: unknown): MemoryEntity {
  if (!isMemoryEntity(entity)) throw new ApiHttpError(400, "validation", "entity must be fact, history, thread, log or want");
  return entity;
}

async function requireTarget(db: D1Database, entity: MemoryEntity, id: string): Promise<{ id: string; created_at: string; kind?: string | null }> {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "id is required");
  const row = await db.prepare(`SELECT * FROM ${TABLE[entity]} WHERE id = ?1`).bind(id).first<{ id: string; created_at: string; kind?: string | null }>();
  if (!row) throw new ApiHttpError(404, "not_found", entity + " not found");
  return row;
}

// Sets the weight and/or the last-touched time of one row. Weights change what is shown,
// never what is stored elsewhere. Audited.
export async function putWeight(
  db: D1Database,
  entity: MemoryEntity,
  id: string,
  patch: { weight?: number; lastTouched?: string },
  actor: string,
): Promise<WeightRow> {
  const e = requireEntity(entity);
  const target = await requireTarget(db, e, id);
  const p = patch && typeof patch === "object" ? patch : {};
  let weight: number | undefined;
  if (p.weight !== undefined) {
    if (typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight < 0 || p.weight > 1) throw new ApiHttpError(400, "validation", "weight must be a number from 0 to 1");
    weight = p.weight;
  }
  let lastTouched: string | undefined;
  if (p.lastTouched !== undefined) {
    const t = typeof p.lastTouched === "string" ? Date.parse(p.lastTouched) : NaN;
    if (!Number.isFinite(t)) throw new ApiHttpError(400, "validation", "lastTouched must be an ISO 8601 time");
    lastTouched = new Date(t).toISOString();
  }
  if (weight === undefined && lastTouched === undefined) throw new ApiHttpError(400, "validation", "weight or lastTouched is required");
  const existing = await db.prepare("SELECT * FROM memory_weights WHERE entity = ?1 AND entity_id = ?2").bind(e, target.id).first<WeightRow>();
  const t = nowIso();
  const row: WeightRow = {
    entity: e,
    entity_id: target.id,
    weight: weight ?? existing?.weight ?? defaultWeight(e, target),
    last_touched: lastTouched ?? existing?.last_touched ?? target.created_at,
    touches: existing?.touches ?? 0,
    source: "owner",
    updated_at: t,
  };
  await db.batch([
    db.prepare("INSERT INTO memory_weights (entity, entity_id, weight, last_touched, touches, source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(entity, entity_id) DO UPDATE SET weight = excluded.weight, last_touched = excluded.last_touched, source = excluded.source, updated_at = excluded.updated_at")
      .bind(row.entity, row.entity_id, row.weight, row.last_touched, row.touches, row.source, row.updated_at),
    auditStmt(db, actor, "memory.weight.put", "memory_weight", weightKey(e, target.id), existing ?? null, row),
  ]);
  return row;
}

// When a version chain gets a new head, the weight and last-touched follow it. A missing
// source row carries nothing (the defaults apply to the new head as they did to the old).
export function carryStmt(db: D1Database, entity: MemoryEntity, fromId: string, toId: string): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO memory_weights (entity, entity_id, weight, last_touched, touches, source, updated_at) SELECT entity, ?3, weight, last_touched, touches, source, ?4 FROM memory_weights WHERE entity = ?1 AND entity_id = ?2")
    .bind(entity, fromId, toId, nowIso());
}

// Refreshes last_touched and touches + 1 for the hit rows (up to 10). A row with no
// weight yet gets one at its default weight so the touch is recorded.
export function touchStmts(db: D1Database, hits: Array<{ entity: MemoryEntity; entityId: string; weight?: number }>, now: Date | string): D1PreparedStatement[] {
  const at = typeof now === "string" ? now : now.toISOString();
  const out: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const h of Array.isArray(hits) ? hits : []) {
    if (!h || !isMemoryEntity(h.entity) || typeof h.entityId !== "string" || !h.entityId) continue;
    const key = weightKey(h.entity, h.entityId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= TOUCH_MAX) break;
    const w = typeof h.weight === "number" && Number.isFinite(h.weight) ? clamp(h.weight, 0, 1) : defaultWeight(h.entity);
    out.push(db.prepare("INSERT INTO memory_weights (entity, entity_id, weight, last_touched, touches, source, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 'touch', ?4) ON CONFLICT(entity, entity_id) DO UPDATE SET last_touched = excluded.last_touched, touches = memory_weights.touches + 1, updated_at = excluded.updated_at")
      .bind(h.entity, h.entityId, w, at));
  }
  return out;
}

// ------------------------------------------------------------------ db: recalls

export interface RecallInput {
  id?: string;
  messageId: string;
  conversationId: string;
  entity: MemoryEntity;
  entityId: string;
  score: number;
  textShown: string;
  now?: Date | string;
}

export function recallStmt(db: D1Database, recall: RecallInput): D1PreparedStatement {
  const at = recall.now === undefined ? nowIso() : typeof recall.now === "string" ? recall.now : recall.now.toISOString();
  return db.prepare("INSERT INTO memory_recalls (id, message_id, conversation_id, entity, entity_id, mode, score, text_shown, outcome, outcome_message_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'provisional', ?6, ?7, 'unknown', NULL, ?8, ?8)")
    .bind(recall.id ?? newId("rc"), recall.messageId, recall.conversationId, recall.entity, recall.entityId, recall.score, String(recall.textShown ?? "").slice(0, RECALL_TEXT_MAX), at);
}

export async function listRecalls(db: D1Database, limit = 100): Promise<RecallRow[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 100;
  const r = await db.prepare("SELECT * FROM memory_recalls ORDER BY created_at DESC LIMIT ?1").bind(n).all<RecallRow>();
  return r.results;
}

// Recall rows among the last `turns` assistant messages of the conversation.
export async function recentRecallCount(db: D1Database, conversationId: string, turns: number): Promise<number> {
  const n = Number.isInteger(turns) && turns > 0 ? Math.min(500, turns) : 0;
  if (n <= 0 || !conversationId) return 0;
  const r = await db.prepare(
    "SELECT COUNT(*) AS n FROM memory_recalls WHERE conversation_id = ?1 AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?1 AND channel = 'story' AND role = 'assistant' ORDER BY seq DESC LIMIT ?2)",
  ).bind(conversationId, n).first<{ n: number }>();
  return r?.n ?? 0;
}

// ------------------------------------------------------------------ db: the Memory tab

export interface MemoryListRow {
  entity: MemoryEntity;
  entityId: string;
  text: string;
  weight: number;
  lastTouched: string;
  touches: number;
  score: number;
  // In the prompt at this score (firm), or faded.
  shown: boolean;
  stored: boolean;
  createdAt: string;
}

interface TextRow { id: string; created_at: string; kind?: string | null; text: string }

async function entityRows(db: D1Database, entity: MemoryEntity, limit: number): Promise<TextRow[]> {
  switch (entity) {
    case "fact": {
      const r = await db.prepare("SELECT id, created_at, subject, fact FROM facts WHERE status = 'approved' AND scope IN ('justin', 'shared') ORDER BY created_at DESC LIMIT ?1").bind(limit).all<{ id: string; created_at: string; subject: string | null; fact: string }>();
      return r.results.map((x) => ({ id: x.id, created_at: x.created_at, text: (x.subject ? x.subject + ": " : "") + x.fact }));
    }
    case "history": {
      const r = await db.prepare("SELECT id, created_at, title FROM history WHERE status = 'approved' ORDER BY seq DESC LIMIT ?1").bind(limit).all<{ id: string; created_at: string; title: string }>();
      return r.results.map((x) => ({ id: x.id, created_at: x.created_at, text: x.title }));
    }
    case "thread": {
      const r = await db.prepare("SELECT id, created_at, kind, title, relation FROM life_threads WHERE status IN ('active', 'done') ORDER BY created_at DESC LIMIT ?1").bind(limit).all<{ id: string; created_at: string; kind: string; title: string; relation: string | null }>();
      return r.results.map((x) => ({ id: x.id, created_at: x.created_at, kind: x.kind, text: x.title + (x.relation ? " (" + x.relation + ")" : "") }));
    }
    case "log": {
      const r = await db.prepare("SELECT id, created_at, note FROM life_log ORDER BY occurred DESC LIMIT ?1").bind(limit).all<{ id: string; created_at: string; note: string }>();
      return r.results.map((x) => ({ id: x.id, created_at: x.created_at, text: x.note }));
    }
    case "want": {
      const r = await db.prepare("SELECT id, created_at, title FROM wants WHERE status IN ('active', 'paused') ORDER BY created_at DESC LIMIT ?1").bind(limit).all<{ id: string; created_at: string; title: string }>();
      return r.results.map((x) => ({ id: x.id, created_at: x.created_at, text: x.title }));
    }
    default:
      return [];
  }
}

// The rows of one entity joined to their weights, with the score a turn would give them
// right now (no conversation, so relevance is 0). Newest first.
export async function listMemory(db: D1Database, entity: MemoryEntity, limit = 200, settings?: MemorySettings | null, now: Date = new Date()): Promise<MemoryListRow[]> {
  const e = requireEntity(entity);
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 200;
  const [rows, weights] = await Promise.all([
    entityRows(db, e, n),
    db.prepare("SELECT * FROM memory_weights WHERE entity = ?1").bind(e).all<WeightRow>(),
  ]);
  const map = new Map<string, WeightRow>();
  for (const w of weights.results) map.set(weightKey(e, w.entity_id), w);
  return rows.map((r) => {
    const w = weightFor(map, e, r);
    const sc = scoreDetail(w.weight, w.lastTouched, r.text, null, now, settings ?? null);
    const shown = e === "thread" ? (r.kind === "routine" || r.kind === "event" || sc.weight >= HIGH_WEIGHT_MIN || sc.score >= THREAD_THRESHOLD || !memorySettings(settings).memoryDecayEnabled) : sc.firm;
    return {
      entity: e,
      entityId: r.id,
      text: r.text,
      weight: w.weight,
      lastTouched: w.lastTouched,
      touches: w.touches,
      score: Math.round(sc.score * 1000) / 1000,
      shown,
      stored: w.stored,
      createdAt: r.created_at,
    };
  });
}

// ------------------------------------------------------------------ the memory map (SPEC_V4 section 7)
//
// A page he can see: every fact about him with its weight and its phase, what is fading,
// what came back, the history on a timeline, the untold things sealed (subject only), and
// what was kept automatically today. One read, nothing written. The pure half (phaseOf,
// returnedRecently) is what the unit suite binds; memoryMap runs on the D1 stand-in.

export type MemoryPhase = "vivid" | "firm" | "fading" | "faded";

// The four bands of one score: faded when it is out of the prompt; else by recency alone,
// so a high-weight fact that has not come up in a long while reads as fading, not gone.
export function phaseOf(sc: MemoryScore): MemoryPhase {
  if (!sc || !sc.firm) return "faded";
  const r = typeof sc.recency === "number" && Number.isFinite(sc.recency) ? sc.recency : 0;
  if (r >= 0.5) return "vivid";
  if (r >= 0.15) return "firm";
  return "fading";
}

export const RETURNED_WINDOW_DAYS = 7;
export const RETURNED_MIN_AGE_DAYS = 14;

// It came back: a stored row, touched at least once, touched within the last 7 days, and
// created at least 14 days before that touch. A fresh row touched on its first day is
// simply new, not returned.
export function returnedRecently(w: WeightInfo, createdAt: string, now: Date): boolean {
  if (!w || !w.stored || !(w.touches >= 1)) return false;
  const touched = Date.parse(w.lastTouched);
  const created = Date.parse(createdAt);
  if (!Number.isFinite(touched) || !Number.isFinite(created)) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (touched > nowMs) return false;
  if (nowMs - touched > RETURNED_WINDOW_DAYS * DAY_MS) return false;
  return touched - created >= RETURNED_MIN_AGE_DAYS * DAY_MS;
}

export interface MemoryMapFact {
  id: string;
  subject: string | null;
  text: string;
  weight: number;
  lastTouched: string;
  touches: number;
  score: number;
  recency: number;
  halfLifeDays: number;
  phase: MemoryPhase;
  returned: boolean;
  createdAt: string;
}

export interface MemoryMapHistory {
  id: string;
  seq: number;
  title: string;
  occurred: string | null;
  weight: number;
  score: number;
  phase: MemoryPhase;
  createdAt: string;
}

// An untold fact of hers: the subject only. The fact text never leaves the server here.
export interface MemoryMapSealed {
  id: string;
  subject: string;
  createdAt: string;
}

export interface MemoryMapKept {
  id: string;
  kind: string;
  proposal: string;
  decidedAt: string;
}

export interface MemoryMapCounts {
  facts: number;
  vivid: number;
  firm: number;
  fading: number;
  faded: number;
  returned: number;
  sealed: number;
  keptToday: number;
}

export interface MemoryMap {
  facts: MemoryMapFact[];
  history: MemoryMapHistory[];
  sealed: MemoryMapSealed[];
  keptToday: MemoryMapKept[];
  counts: MemoryMapCounts;
  settings: ResolvedMemorySettings;
  now: string;
}

export const KEPT_AUTOMATICALLY_NOTE = "kept automatically";
const KEPT_TODAY_MAX = 100;
// Approved proposals read newest-created first; an auto-kept row is created and decided in
// the same moment, so today's sit at the top. Wide enough for a long day of talking.
const KEPT_SCAN_LIMIT = 500;
const SEALED_UNTITLED = "(untitled)";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// "YYYY-MM-DD" of an instant in a timezone (a bad or empty name falls back to UTC). Kept
// local so this module never imports life.ts, which imports this one.
export function localDayKey(d: Date, tz: string | null | undefined): string {
  const name = typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: name, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const parts = fmt.formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return pick("year") + "-" + pick("month").padStart(2, "0") + "-" + pick("day").padStart(2, "0");
}

function isApprovedFact(f: FactRow | null | undefined): f is FactRow {
  return !!f && typeof f.id === "string" && f.status === "approved" && typeof f.fact === "string";
}

// Proposals kept automatically whose decision fell on the given local day, newest first.
// Every filter runs here as well as in SQL so the answer is the same on any store.
export function keptOnDay(rows: ProposalRow[], dayKey: string, tz: string | null | undefined, max = KEPT_TODAY_MAX): MemoryMapKept[] {
  const out: Array<{ row: ProposalRow; t: number }> = [];
  for (const p of Array.isArray(rows) ? rows : []) {
    if (!p || p.status !== "approved" || p.decision_note !== KEPT_AUTOMATICALLY_NOTE) continue;
    if (typeof p.decided_at !== "string") continue;
    const t = Date.parse(p.decided_at);
    if (!Number.isFinite(t)) continue;
    if (localDayKey(new Date(t), tz) !== dayKey) continue;
    out.push({ row: p, t });
  }
  out.sort((a, b) => b.t - a.t || a.row.id.localeCompare(b.row.id));
  return out.slice(0, Math.max(0, max)).map(({ row }) => ({
    id: row.id,
    kind: String(row.kind),
    proposal: String(row.proposal ?? ""),
    decidedAt: new Date(Date.parse(row.decided_at as string)).toISOString(),
  }));
}

interface ChainRow { id: string; supersedes_id: string | null; status: string }

// Every id in a version chain whose newest row is dead by `isDead` (a fact whose newest version
// is not approved, a thread whose newest version is dropped). Pure.
export function deadChainIds(rows: readonly ChainRow[], isDead: (status: string) => boolean): string[] {
  const next = new Map<string, string>();
  for (const r of rows) if (r && typeof r.supersedes_id === "string" && r.supersedes_id) next.set(r.supersedes_id, r.id);
  const byId = new Map(rows.filter((r) => r && typeof r.id === "string").map((r) => [r.id, r] as const));
  const out: string[] = [];
  for (const r of byId.values()) {
    let head = r;
    const seen = new Set<string>([r.id]);
    for (let n = next.get(head.id); n && !seen.has(n); n = next.get(head.id)) {
      const row = byId.get(n);
      if (!row) break;
      seen.add(n);
      head = row;
    }
    if (isDead(String(head.status))) out.push(r.id);
  }
  return out;
}

// The same kept thing in other words shows once, the newest. Two lines of the same kind are
// the same when their content words overlap by 60% of the union, or, when the shorter has at
// least four content words, when 60% of the shorter sits inside the longer ("they took a
// selfie at the sandwich place" inside "...then left for the record store"). Pure.
export function sameKept(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  if (inter / (a.size + b.size - inter) >= 0.6) return true;
  const small = Math.min(a.size, b.size);
  return small >= 4 && inter / small >= 0.6;
}

export function collapseKept(items: MemoryMapKept[]): MemoryMapKept[] {
  const out: MemoryMapKept[] = [];
  const seen: Array<{ kind: string; words: Set<string> }> = [];
  for (const k of items) {
    const words = new Set(saidKey(k.proposal).split(" ").filter(Boolean));
    if (seen.some((x) => x.kind === k.kind && sameKept(words, x.words))) continue;
    seen.push({ kind: k.kind, words });
    out.push(k);
  }
  return out;
}

export async function memoryMap(db: D1Database, settings: MemorySettings | null | undefined, now: Date = new Date()): Promise<MemoryMap> {
  const s = memorySettings(settings);
  const tz = settings && typeof settings.timezone === "string" ? settings.timezone : "UTC";
  const [factRows, historyRows, weights, proposals, factChain, threadChain] = await Promise.all([
    db.prepare("SELECT * FROM facts WHERE status = ?1 AND scope IN ('justin', 'shared', 'avelie')").bind("approved").all<FactRow>(),
    db.prepare("SELECT * FROM history WHERE status = ?1").bind("approved").all<HistoryRow>(),
    loadWeights(db),
    listProposals(db, "approved", KEPT_SCAN_LIMIT),
    db.prepare("SELECT id, supersedes_id, status FROM facts").all<ChainRow>().then((r) => r.results).catch(() => [] as ChainRow[]),
    db.prepare("SELECT id, supersedes_id, status FROM life_threads").all<ChainRow>().then((r) => r.results).catch(() => [] as ChainRow[]),
  ]);

  // Facts about him (scope justin and shared), scored as a turn with no conversation would.
  const his = factRows.results.filter(isApprovedFact).filter((f) => f.scope === "justin" || f.scope === "shared");
  const ranked = rankFacts(his, weights, null, now, s);
  const facts: MemoryMapFact[] = [];
  for (const f of his) {
    const sc = ranked.scores.get(f.id);
    if (!sc) continue;
    const w = weightFor(weights, "fact", f);
    facts.push({
      id: f.id,
      subject: f.subject ?? null,
      text: f.fact,
      weight: round3(w.weight),
      lastTouched: w.lastTouched,
      touches: w.touches,
      score: round3(sc.score),
      recency: round3(sc.recency),
      halfLifeDays: sc.halfLifeDays,
      phase: phaseOf(sc),
      returned: returnedRecently(w, f.created_at, now),
      createdAt: f.created_at,
    });
  }
  facts.sort((a, b) => b.score - a.score || b.weight - a.weight || a.createdAt.localeCompare(b.createdAt));

  // History on a timeline, by seq.
  const hist = historyRows.results.filter((h) => !!h && h.status === "approved" && typeof h.id === "string");
  const rankedHistory = rankHistory(hist, weights, null, now, s);
  const history: MemoryMapHistory[] = [];
  for (const h of hist.slice().sort((a, b) => a.seq - b.seq || a.created_at.localeCompare(b.created_at))) {
    const sc = rankedHistory.scores.get(h.id);
    if (!sc) continue;
    history.push({
      id: h.id,
      seq: h.seq,
      title: h.title,
      occurred: h.occurred ?? null,
      weight: round3(sc.weight),
      score: round3(sc.score),
      phase: phaseOf(sc),
      createdAt: h.created_at,
    });
  }

  // Hers, untold: the subject only. Newest first.
  const sealed: MemoryMapSealed[] = factRows.results
    .filter(isApprovedFact)
    .filter((f) => f.scope === "avelie" && Number(f.disclosed) === 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    .map((f) => ({ id: f.id, subject: typeof f.subject === "string" && f.subject.trim() ? f.subject.trim() : SEALED_UNTITLED, createdAt: f.created_at }))
    // One tile per subject ("singing x4"), newest first, so the untold list does not repeat.
    .reduce((acc: MemoryMapSealed[], f) => {
      const key = f.subject.toLowerCase();
      const hit = acc.find((x) => x.subject.toLowerCase().replace(/ x\d+$/, "") === key);
      if (!hit) { acc.push(f); return acc; }
      const m = / x(\d+)$/.exec(hit.subject);
      hit.subject = hit.subject.replace(/ x\d+$/, "") + " x" + String((m ? Number(m[1]) : 1) + 1);
      return acc;
    }, []);

  // 2026-09-26: the list read the raw proposal log, so every kept rewording showed (the coffee
  // place six times) even after the row behind it was merged away. Only what is still live in
  // her memory shows, and near-identical lines collapse into the newest one.
  const dead = new Set([...deadChainIds(factChain, (st) => st !== "approved"), ...deadChainIds(threadChain, (st) => st === "dropped")]);
  const live = proposals.filter((p) => !(typeof p.promoted_id === "string" && dead.has(p.promoted_id)));
  const keptToday = collapseKept(keptOnDay(live, localDayKey(now, tz), tz));

  const counts: MemoryMapCounts = {
    facts: facts.length,
    vivid: facts.filter((f) => f.phase === "vivid").length,
    firm: facts.filter((f) => f.phase === "firm").length,
    fading: facts.filter((f) => f.phase === "fading").length,
    faded: facts.filter((f) => f.phase === "faded").length,
    returned: facts.filter((f) => f.returned).length,
    sealed: sealed.length,
    keptToday: keptToday.length,
  };
  return { facts, history, sealed, keptToday, counts, settings: s, now: now.toISOString() };
}
