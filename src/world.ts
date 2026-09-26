// A stable world (SPEC_V5 section 8): the people of her life as named entities, and the fixed
// facts of her people and places. A `people` row shadows her person life threads the way v4's
// `places` row shadows her place threads: the thread chain may version (an edit is a new row),
// the person's id does not. A name is locked once it is a real name (src/life.ts refuses the
// rename; only the owner's Rename passes allowRename), a placeholder ("her mother") may be
// named once, and a `life` proposal for someone she already has never makes a second person.
//
// The pure half (relationNorm, nameNorm, mentionedEntities, whoAndWhereSection) runs under
// Node for the unit suite; the D1 half reads and writes `people` and `world_facts` (0009),
// audited. Nothing here becomes canon because a model said it: a world fact from a
// conversation arrives as an approved proposal (addWorldFactFromProposal) or the owner's own
// typing (addWorldFact).
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { createThread, isPlaceholderName, listThreads, updateThread } from "./life";
import type { LifeThread } from "./life";
import { listPlaces, placeTitleNorm, syncPlaces } from "./places";
import type { PlaceRow } from "./places";
import { saidKey, saidLine } from "./said";

// ------------------------------------------------------------------ rows

export interface PersonRow {
  id: string;
  thread_id: string | null;
  name: string;
  name_norm: string;
  relation: string | null;
  relation_norm: string | null;
  named: number;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorldFactRow {
  id: string;
  entity_kind: "person" | "place";
  entity_id: string;
  fact: string;
  fact_norm: string;
  source: string | null;
  status: "approved" | "retired";
  created_at: string;
  updated_at: string;
}

export const UNIQUE_RELATIONS: readonly string[] = ["mother", "father", "stepmother", "stepfather"];

const MAX_NAME = 300;
const MAX_FACT = 300;
const MAX_SOURCE = 500;
const MAX_RELATION = 200;
// A line of WHO AND WHERE carries at most this many fixed facts, so the section stays small.
const FACTS_PER_LINE = 4;
const PORTRAIT_WORDS = 120;
const DETAIL_WORDS = 200;

// ------------------------------------------------------------------ pure: names and relations

const RELATION_TABLE: Record<string, string> = {
  mom: "mother", mum: "mother", mama: "mother", mother: "mother",
  dad: "father", papa: "father", father: "father",
  stepmom: "stepmother", stepmother: "stepmother",
  stepdad: "stepfather", stepfather: "stepfather",
  ex: "ex", "ex boyfriend": "ex", "ex-boyfriend": "ex", "ex girlfriend": "ex",
  "best friend": "best friend", bff: "best friend",
};

// Lowercased, trimmed, a leading "her " or "my " removed, then the everyday words folded:
// mom, mum, mama -> mother; dad, papa -> father; stepmom -> stepmother; stepdad -> stepfather;
// ex boyfriend and ex girlfriend -> ex; bff -> best friend. Anything else as it is; empty -> null.
export function relationNorm(r: unknown): string | null {
  if (typeof r !== "string") return null;
  let t = r.toLowerCase().replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:her|my) /, "").trim();
  if (!t) return null;
  return RELATION_TABLE[t] ?? t;
}

export function nameNorm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function oneLine(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A whole word or phrase, case-insensitive; the edges are letters and digits (so "Mason's"
// is Mason and "Masonry" is not).
function phraseRe(phrase: string): RegExp {
  const words = phrase.trim().split(/\s+/).map(escapeRe).join("\\s+");
  return new RegExp("(?:^|[^\\p{L}\\p{N}])" + words + "(?![\\p{L}\\p{N}])", "iu");
}

function firstLine(s: string | null | undefined, max = DETAIL_WORDS): string {
  if (typeof s !== "string") return "";
  const t = (s.trim().split(/\r?\n/)[0] ?? "").trim();
  return t.length > max ? t.slice(0, max - 3).trimEnd() + "..." : t;
}

// Ends a sentence with a period unless it already ends with one of its own marks.
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return "";
  if (/(?:\.\.\.|[.!?])$/.test(t)) return t;
  return t.replace(/[,;:]+$/, "") + ".";
}

// ------------------------------------------------------------------ pure: what the recent messages name

// The everyday words that pull a person in by relation (SPEC_V5 section 8, skeptic 15): in HER
// lines anywhere, in his only right after "your" ("how is your mom"), never his "my mom".
const RELATION_WORDS: Record<string, string[]> = {
  mother: ["mom", "mum", "mother", "mama"],
  father: ["dad", "father", "papa"],
  ex: ["ex"],
};

export function mentionedEntities(args: {
  people: PersonRow[];
  places: PlaceRow[];
  texts: Array<{ hers: boolean; text: string }>;
  dayThreadIds: string[];
  dayPlaceTitles: string[];
}): { personIds: string[]; placeIds: string[] } {
  const people = Array.isArray(args?.people) ? args.people : [];
  const places = Array.isArray(args?.places) ? args.places : [];
  const texts = (Array.isArray(args?.texts) ? args.texts : []).filter((t) => t && typeof t.text === "string" && t.text.trim());
  const dayThreads = new Set((Array.isArray(args?.dayThreadIds) ? args.dayThreadIds : []).filter((x) => typeof x === "string" && x));
  const dayPlaces = new Set((Array.isArray(args?.dayPlaceTitles) ? args.dayPlaceTitles : []).map((x) => placeTitleNorm(String(x ?? ""))).filter(Boolean));

  // The index of the most recent text that names the entity (texts are oldest first, his
  // pending text last); an entity present only in her day ranks below every mention.
  const personRank = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string, rank: number): void => {
    const cur = m.get(id);
    if (cur === undefined || rank > cur) m.set(id, rank);
  };

  people.forEach((p) => {
    if (!p || typeof p.id !== "string") return;
    const named = Number(p.named) === 1 && !isPlaceholderName(p.name);
    const name = oneLine(p.name);
    const nameRe = named && name.replace(/[^\p{L}]/gu, "").length >= 3 ? phraseRe(name) : null;
    const rel = p.relation_norm ?? relationNorm(p.relation);
    const words = rel ? RELATION_WORDS[rel] ?? [] : [];
    const hersRe = words.length ? new RegExp("(?:^|[^\\p{L}\\p{N}])(?:" + words.map(escapeRe).join("|") + ")(?![\\p{L}\\p{N}])", "iu") : null;
    const hisRe = words.length ? new RegExp("(?:^|[^\\p{L}\\p{N}])your\\s+(?:" + words.map(escapeRe).join("|") + ")(?![\\p{L}\\p{N}])", "iu") : null;
    texts.forEach((t, i) => {
      if (nameRe && nameRe.test(t.text)) bump(personRank, p.id, i);
      else if (t.hers === true && hersRe && hersRe.test(t.text)) bump(personRank, p.id, i);
      else if (t.hers !== true && hisRe && hisRe.test(t.text)) bump(personRank, p.id, i);
    });
    if (typeof p.thread_id === "string" && dayThreads.has(p.thread_id)) bump(personRank, p.id, -1);
  });

  const placeRank = new Map<string, number>();
  places.forEach((pl) => {
    if (!pl || typeof pl.id !== "string") return;
    const title = oneLine(pl.title);
    if (!title) return;
    const whole = phraseRe(title);
    const long = Array.from(new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4)));
    const longRes = long.map((w) => phraseRe(w));
    texts.forEach((t, i) => {
      if (whole.test(t.text) || (longRes.length > 0 && longRes.every((re) => re.test(t.text)))) bump(placeRank, pl.id, i);
    });
    if (dayPlaces.has(placeTitleNorm(title))) bump(placeRank, pl.id, -1);
  });

  const order = (m: Map<string, number>, ids: string[]): string[] =>
    ids.filter((id) => m.has(id)).sort((a, b) => (m.get(b) ?? -2) - (m.get(a) ?? -2) || ids.indexOf(a) - ids.indexOf(b));
  return {
    personIds: order(personRank, people.map((p) => p.id)),
    placeIds: order(placeRank, places.map((p) => p.id)),
  };
}

// ------------------------------------------------------------------ pure: the prompt section

export const WHO_AND_WHERE_HEADER =
  "WHO AND WHERE (the people and places in this; their names and these facts are fixed: never rename anyone, never give anyone a second name, never contradict these)";

export function whoAndWhereSection(args: {
  people: PersonRow[];
  places: PlaceRow[];
  threads: LifeThread[];
  facts: WorldFactRow[];
  portraits: Record<string, string>;
  picked: { personIds: string[]; placeIds: string[] };
  limit: number;
}): string {
  const limit = Number.isFinite(args?.limit) ? Math.max(0, Math.floor(args.limit)) : 0;
  const pickedPeople = Array.isArray(args?.picked?.personIds) ? args.picked.personIds : [];
  const pickedPlaces = Array.isArray(args?.picked?.placeIds) ? args.picked.placeIds : [];
  if (limit === 0 || (!pickedPeople.length && !pickedPlaces.length)) return "";
  const people = new Map((Array.isArray(args.people) ? args.people : []).filter(Boolean).map((p) => [p.id, p] as const));
  const places = new Map((Array.isArray(args.places) ? args.places : []).filter(Boolean).map((p) => [p.id, p] as const));
  const threads = new Map((Array.isArray(args.threads) ? args.threads : []).filter(Boolean).map((t) => [t.id, t] as const));
  const portraits = args.portraits && typeof args.portraits === "object" ? args.portraits : {};
  const facts = (Array.isArray(args.facts) ? args.facts : []).filter((f) => f && f.status !== "retired" && typeof f.fact === "string" && f.fact.trim());
  const factsOf = (kind: "person" | "place", id: string): string => {
    const list = facts.filter((f) => f.entity_kind === kind && f.entity_id === id).slice(0, FACTS_PER_LINE).map((f) => oneLine(f.fact).replace(/[.;]+$/, ""));
    return list.length ? sentence(list.join("; ")) : "";
  };

  const lines: string[] = [];
  const seenPeople = new Set<string>();
  for (const id of pickedPeople) {
    if (lines.length >= limit) break;
    const p = people.get(id);
    if (!p || seenPeople.has(id)) continue;
    seenPeople.add(id);
    const thread = p.thread_id ? threads.get(p.thread_id) : undefined;
    const relation = oneLine(p.relation ?? thread?.relation ?? "");
    const head = `- ${oneLine(p.name)}${relation ? ` (${relation})` : ""}`;
    const parts: string[] = [];
    const detail = sentence(firstLine(thread?.detail ?? null));
    if (detail) parts.push(detail);
    const f = factsOf("person", p.id);
    if (f) parts.push(f);
    const assetId = thread?.portrait_asset_id ?? null;
    const raw = (p.thread_id ? portraits[p.thread_id] : undefined) ?? (assetId ? portraits[assetId] : undefined);
    const looks = typeof raw === "string" ? saidLine(raw, PORTRAIT_WORDS) : "";
    if (looks) parts.push("Looks: " + sentence(looks));
    lines.push(parts.length ? `${head}: ${parts.join(" ")}` : head);
  }
  const seenPlaces = new Set<string>();
  for (const id of pickedPlaces) {
    if (lines.length >= limit) break;
    const pl = places.get(id);
    if (!pl || seenPlaces.has(id)) continue;
    seenPlaces.add(id);
    const parts: string[] = [];
    const detail = sentence(firstLine(pl.detail));
    if (detail) parts.push(detail);
    const f = factsOf("place", pl.id);
    if (f) parts.push(f);
    lines.push(`- ${oneLine(pl.title)}${parts.length ? ": " + parts.join(" ") : ""}`);
  }
  if (!lines.length) return "";
  return [WHO_AND_WHERE_HEADER, ...lines].join("\n");
}

// ------------------------------------------------------------------ db: people

async function readPeople(db: D1Database): Promise<PersonRow[]> {
  const r = await db.prepare("SELECT * FROM people ORDER BY created_at, id").all<PersonRow>();
  return r.results ?? [];
}

export async function listPeople(db: D1Database): Promise<PersonRow[]> {
  return readPeople(db);
}

async function getPerson(db: D1Database, id: string): Promise<PersonRow | null> {
  if (typeof id !== "string" || !id.trim()) return null;
  return db.prepare("SELECT * FROM people WHERE id = ?1").bind(id.trim()).first<PersonRow>();
}

// The ids up a thread's version chain (itself first), so a head that moved more than once
// between two reads still finds the row its person already has.
async function ancestorIds(db: D1Database, id: string): Promise<string[]> {
  const r = await db.prepare(
    `WITH RECURSIVE up(id, sup, depth) AS (
       SELECT id, supersedes_id, 0 FROM life_threads WHERE id = ?1
       UNION ALL
       SELECT t.id, t.supersedes_id, up.depth + 1 FROM life_threads t JOIN up ON t.id = up.sup WHERE up.depth < 200
     ) SELECT id FROM up ORDER BY depth`,
  ).bind(id).all<{ id: string }>();
  return (r.results ?? []).map((x) => x.id);
}

function isPersonHead(t: LifeThread | null | undefined): t is LifeThread {
  return !!t && t.kind === "person" && (t.status === "active" || t.status === "done") && !!nameNorm(t.title);
}

// The newest head per normalised title (by created_at, then id), person threads of status
// active or done only (a person from her past is still a person; dropped and superseded rows
// are not).
function personHeads(threads: LifeThread[]): LifeThread[] {
  const heads = new Map<string, LifeThread>();
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!isPersonHead(t)) continue;
    const norm = nameNorm(t.title);
    const cur = heads.get(norm);
    if (!cur) { heads.set(norm, t); continue; }
    const c = String(t.created_at ?? "").localeCompare(String(cur.created_at ?? ""));
    if (c > 0 || (c === 0 && String(t.id).localeCompare(String(cur.id)) > 0)) heads.set(norm, t);
  }
  return Array.from(heads.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
}

// SPEC_V5 section 8, skeptic 4. For every person head: its row already points at it ->
// nothing; a row points at the head's supersedes_id (the chain moved: an edit or a rename) ->
// the row follows it (thread, name, relation, named, locked_at when it becomes named); a row
// has the head's name -> its thread_id follows; else a new row (INSERT OR IGNORE; named 0 for a
// placeholder, locked_at when named). A read with nothing new writes nothing. Answers every row.
export async function syncPeople(db: D1Database, threads: LifeThread[]): Promise<PersonRow[]> {
  const heads = personHeads(threads);
  const rows = await readPeople(db);
  if (!heads.length) return rows;
  const byThread = new Map<string, PersonRow>();
  const byNorm = new Map<string, PersonRow>();
  for (const r of rows) {
    if (typeof r.thread_id === "string" && r.thread_id) byThread.set(r.thread_id, r);
    if (!byNorm.has(r.name_norm)) byNorm.set(r.name_norm, r);
  }
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  const inserted: PersonRow[] = [];

  const follow = (row: PersonRow, head: LifeThread): void => {
    const name = oneLine(head.title).slice(0, MAX_NAME);
    const norm = nameNorm(name);
    const holder = byNorm.get(norm);
    // A name held by another row (a person whose thread was dropped) stays with that row; this
    // row follows its thread and keeps the name it had, so the UNIQUE name never breaks a batch.
    const nameFree = !holder || holder.id === row.id;
    const nextName = nameFree ? name : row.name;
    const nextNorm = nameFree ? norm : row.name_norm;
    const named = isPlaceholderName(nextName) ? 0 : 1;
    const lockedAt = named === 1 ? row.locked_at ?? now : row.locked_at;
    const relation = head.relation ?? null;
    const relNorm = relationNorm(relation);
    if (
      row.thread_id === head.id && row.name === nextName && row.name_norm === nextNorm && row.relation === relation &&
      row.relation_norm === relNorm && Number(row.named) === named && row.locked_at === lockedAt
    ) return;
    stmts.push(
      db.prepare("UPDATE people SET thread_id = ?2, name = ?3, name_norm = ?4, relation = ?5, relation_norm = ?6, named = ?7, locked_at = ?8, updated_at = ?9 WHERE id = ?1")
        .bind(row.id, head.id, nextName, nextNorm, relation, relNorm, named, lockedAt, now),
    );
    if (typeof row.thread_id === "string") byThread.delete(row.thread_id);
    if (row.name_norm !== nextNorm && byNorm.get(row.name_norm)?.id === row.id) byNorm.delete(row.name_norm);
    row.thread_id = head.id;
    row.name = nextName;
    row.name_norm = nextNorm;
    row.relation = relation;
    row.relation_norm = relNorm;
    row.named = named;
    row.locked_at = lockedAt;
    row.updated_at = now;
    byThread.set(head.id, row);
    byNorm.set(nextNorm, row);
  };

  for (const head of heads) {
    if (byThread.has(head.id)) continue;
    const moved = head.supersedes_id ? byThread.get(head.supersedes_id) : undefined;
    if (moved) { follow(moved, head); continue; }
    const same = byNorm.get(nameNorm(head.title));
    if (same) {
      // A new chain with the same name: the row takes it (its relation follows too).
      const sameHeadStillCurrent = typeof same.thread_id === "string" && heads.some((h) => h.id === same.thread_id);
      if (!sameHeadStillCurrent) { follow(same, head); continue; }
    }
    // The chain may have moved more than once since the last read: walk it once.
    let found: PersonRow | undefined;
    if (head.supersedes_id) {
      try {
        for (const anc of await ancestorIds(db, head.id)) {
          const r = byThread.get(anc);
          if (r) { found = r; break; }
        }
      } catch {
        found = undefined;
      }
    }
    if (found) { follow(found, head); continue; }
    if (same) continue;
    const name = oneLine(head.title).slice(0, MAX_NAME);
    const norm = nameNorm(name);
    const named = isPlaceholderName(name) ? 0 : 1;
    const relation = head.relation ?? null;
    const fresh: PersonRow = {
      id: newId("pe"),
      thread_id: head.id,
      name,
      name_norm: norm,
      relation,
      relation_norm: relationNorm(relation),
      named,
      locked_at: named === 1 ? now : null,
      created_at: now,
      updated_at: now,
    };
    stmts.push(
      db.prepare("INSERT OR IGNORE INTO people (id, thread_id, name, name_norm, relation, relation_norm, named, locked_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)")
        .bind(fresh.id, fresh.thread_id, fresh.name, fresh.name_norm, fresh.relation, fresh.relation_norm, fresh.named, fresh.locked_at, now),
    );
    inserted.push(fresh);
    byThread.set(head.id, fresh);
    byNorm.set(norm, fresh);
  }
  if (stmts.length) await db.batch(stmts);
  return rows.concat(inserted).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ db: world facts

function isEntityKind(v: unknown): v is "person" | "place" {
  return v === "person" || v === "place";
}

export async function listWorldFacts(
  db: D1Database,
  opts: { entityKind?: "person" | "place"; entityId?: string; status?: "approved" | "retired" | "all" } = {},
): Promise<WorldFactRow[]> {
  const o = opts && typeof opts === "object" ? opts : {};
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = o.status ?? "approved";
  if (status !== "approved" && status !== "retired" && status !== "all") throw new ApiHttpError(400, "validation", "status must be approved, retired or all");
  if (status !== "all") { binds.push(status); where.push(`status = ?${binds.length}`); }
  if (o.entityKind !== undefined) {
    if (!isEntityKind(o.entityKind)) throw new ApiHttpError(400, "validation", "entityKind must be person or place");
    binds.push(o.entityKind);
    where.push(`entity_kind = ?${binds.length}`);
  }
  if (o.entityId !== undefined) {
    if (typeof o.entityId !== "string" || !o.entityId.trim()) throw new ApiHttpError(400, "validation", "entityId must be a string");
    binds.push(o.entityId.trim());
    where.push(`entity_id = ?${binds.length}`);
  }
  const sql = `SELECT * FROM world_facts${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id LIMIT 2000`;
  const r = await db.prepare(sql).bind(...binds).all<WorldFactRow>();
  return r.results ?? [];
}

async function entityExists(db: D1Database, kind: "person" | "place", id: string): Promise<boolean> {
  const sql = kind === "person" ? "SELECT id FROM people WHERE id = ?1" : "SELECT id FROM places WHERE id = ?1";
  const row = await db.prepare(sql).bind(id).first<{ id: string }>();
  return !!row;
}

function factNormOf(fact: string): string {
  return saidKey(fact) || fact.toLowerCase();
}

async function liveDuplicate(db: D1Database, kind: string, entityId: string, norm: string): Promise<WorldFactRow | null> {
  return db.prepare("SELECT * FROM world_facts WHERE entity_kind = ?1 AND entity_id = ?2 AND fact_norm = ?3 AND status = 'approved' LIMIT 1")
    .bind(kind, entityId, norm).first<WorldFactRow>();
}

export async function addWorldFact(
  db: D1Database,
  input: { entityKind: "person" | "place"; entityId: string; fact: string; source?: string | null },
  actor: string,
): Promise<WorldFactRow> {
  if (!input || typeof input !== "object") throw new ApiHttpError(400, "validation", "body must be an object");
  if (!isEntityKind(input.entityKind)) throw new ApiHttpError(400, "validation", "entityKind must be person or place");
  if (typeof input.entityId !== "string" || !input.entityId.trim()) throw new ApiHttpError(400, "validation", "entityId is required");
  if (typeof input.fact !== "string") throw new ApiHttpError(400, "validation", "fact is required");
  const fact = saidLine(input.fact, 100_000);
  if (!fact) throw new ApiHttpError(400, "validation", "fact is required");
  if (fact.length > MAX_FACT) throw new ApiHttpError(400, "validation", `fact exceeds ${MAX_FACT} characters`);
  let source: string | null = null;
  if (input.source !== undefined && input.source !== null) {
    if (typeof input.source !== "string") throw new ApiHttpError(400, "validation", "source must be a string");
    source = input.source.trim().slice(0, MAX_SOURCE) || null;
  }
  const entityId = input.entityId.trim();
  if (!(await entityExists(db, input.entityKind, entityId))) {
    throw new ApiHttpError(404, "not_found", input.entityKind === "person" ? "person not found" : "place not found");
  }
  const norm = factNormOf(fact);
  if (await liveDuplicate(db, input.entityKind, entityId, norm)) throw new ApiHttpError(409, "duplicate", "that fact is already there");
  const t = nowIso();
  const row: WorldFactRow = {
    id: newId("wf"),
    entity_kind: input.entityKind,
    entity_id: entityId,
    fact,
    fact_norm: norm,
    source,
    status: "approved",
    created_at: t,
    updated_at: t,
  };
  try {
    await db.batch([
      db.prepare("INSERT INTO world_facts (id, entity_kind, entity_id, fact, fact_norm, source, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'approved', ?7, ?7)")
        .bind(row.id, row.entity_kind, row.entity_id, row.fact, row.fact_norm, row.source, t),
      auditStmt(db, actor, "world.fact.create", "world_fact", row.id, null, row),
    ]);
  } catch (e) {
    // Two writers racing on the partial unique index: the second is the duplicate.
    if (await liveDuplicate(db, input.entityKind, entityId, norm).catch(() => null)) throw new ApiHttpError(409, "duplicate", "that fact is already there");
    throw e;
  }
  return row;
}

export async function retireWorldFact(db: D1Database, id: string, actor: string): Promise<WorldFactRow> {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "fact id is required");
  const row = await db.prepare("SELECT * FROM world_facts WHERE id = ?1").bind(id.trim()).first<WorldFactRow>();
  if (!row) throw new ApiHttpError(404, "not_found", "fact not found");
  if (row.status === "retired") return row;
  const t = nowIso();
  const after: WorldFactRow = { ...row, status: "retired", updated_at: t };
  await db.batch([
    db.prepare("UPDATE world_facts SET status = 'retired', updated_at = ?2 WHERE id = ?1 AND status = 'approved'").bind(row.id, t),
    auditStmt(db, actor, "world.fact.retire", "world_fact", row.id, row, after),
  ]);
  return after;
}

// A `world_fact` proposal promoted (src/proposals.ts): `payload.entity` names a person (by name,
// then by relation among the unique relations) or a place (by title), read after both syncs;
// `payload.fact` or the proposal text is the fact. A live duplicate answers the existing id.
export async function addWorldFactFromProposal(
  db: D1Database,
  payload: Record<string, unknown>,
  text: string,
  source: string,
  actor: string,
): Promise<string> {
  const p = payload && typeof payload === "object" ? payload : {};
  const entity = oneLine(p.entity);
  const threads = await listThreads(db);
  const [people, places] = await Promise.all([syncPeople(db, threads), syncPlaces(db, threads)]);
  let kind: "person" | "place" | null = null;
  let entityId: string | null = null;
  if (entity) {
    const norm = nameNorm(entity);
    const byName = people.find((x) => x.name_norm === norm);
    if (byName) { kind = "person"; entityId = byName.id; }
    if (!entityId) {
      const rel = relationNorm(entity);
      if (rel && UNIQUE_RELATIONS.includes(rel)) {
        const activeIds = new Set(threads.filter((t) => t.kind === "person" && t.status === "active").map((t) => t.id));
        const holders = people.filter((x) => (x.relation_norm ?? relationNorm(x.relation)) === rel);
        const holder = holders.find((x) => typeof x.thread_id === "string" && activeIds.has(x.thread_id)) ?? holders[0];
        if (holder) { kind = "person"; entityId = holder.id; }
      }
    }
    if (!entityId) {
      const tn = placeTitleNorm(entity);
      const place = places.find((x) => x.title_norm === tn);
      if (place) { kind = "place"; entityId = place.id; }
    }
  }
  if (!kind || !entityId) throw new ApiHttpError(400, "validation", "world_fact names no person or place she has");
  const raw = typeof p.fact === "string" && p.fact.trim() ? p.fact : text;
  const fact = saidLine(raw, MAX_FACT);
  if (!fact) throw new ApiHttpError(400, "validation", "fact is required");
  const dup = await liveDuplicate(db, kind, entityId, factNormOf(fact));
  if (dup) return dup.id;
  try {
    const row = await addWorldFact(db, { entityKind: kind, entityId, fact, source: typeof source === "string" ? source : null }, actor);
    return row.id;
  } catch (e) {
    if (e instanceof ApiHttpError && e.code === "duplicate") {
      const again = await liveDuplicate(db, kind, entityId, factNormOf(fact));
      if (again) return again.id;
    }
    throw e;
  }
}

// ------------------------------------------------------------------ db: a person from a proposal, a rename

async function bestEffortSync(db: D1Database): Promise<void> {
  try {
    await syncPeople(db, await listThreads(db));
  } catch {
    // the next read syncs; a database behind 0009 has no people table yet
  }
}

function newestFirst(a: LifeThread, b: LifeThread): number {
  return String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id));
}

// A `life` proposal of kind person promoted (src/proposals.ts): someone she already has is
// never a second person. The same name among her active or done person threads -> that thread
// (a done one stays done). A unique relation (mother, father, stepmother, stepfather) held by
// an active person thread -> a placeholder title is named now (and locks), a different real
// name is refused, the same one answers that thread. Anyone else is a new thread.
export async function resolveLifePerson(
  db: D1Database,
  input: { kind: "person"; title: string; detail?: string | null; schedule_json?: string | null; relation?: string | null; source?: string | null },
  actor: string,
): Promise<LifeThread> {
  if (!input || typeof input !== "object") throw new ApiHttpError(400, "validation", "body must be an object");
  const title = oneLine(input.title);
  if (!title) throw new ApiHttpError(400, "validation", "title is required");
  if (title.length > MAX_NAME) throw new ApiHttpError(400, "validation", `title exceeds ${MAX_NAME} characters`);
  const threads = (await listThreads(db)).filter((t) => t.kind === "person" && (t.status === "active" || t.status === "done")).sort(newestFirst);
  const norm = nameNorm(title);
  const same = threads.find((t) => nameNorm(t.title) === norm);
  if (same) return same;
  const rel = relationNorm(input.relation);
  if (rel && UNIQUE_RELATIONS.includes(rel)) {
    const holder = threads.find((t) => t.status === "active" && relationNorm(t.relation) === rel);
    if (holder) {
      // A placeholder for a placeholder names nobody: she still has the one she had.
      if (isPlaceholderName(title)) return holder;
      if (isPlaceholderName(holder.title)) {
        const patch: { title: string; detail?: string | null } = { title };
        const detail = typeof input.detail === "string" ? input.detail.trim() : "";
        if (detail && !(typeof holder.detail === "string" && holder.detail.trim())) patch.detail = detail;
        const renamed = await updateThread(db, holder.id, patch, actor, { allowRename: true });
        await bestEffortSync(db);
        return renamed;
      }
      if (nameNorm(holder.title) !== norm) {
        throw new ApiHttpError(400, "validation", `her ${rel} already has a name: ${oneLine(holder.title)}`);
      }
      return holder;
    }
  }
  const created = await createThread(db, {
    kind: "person",
    title,
    detail: input.detail ?? null,
    schedule_json: input.schedule_json ?? null,
    relation: typeof input.relation === "string" ? input.relation.trim().slice(0, MAX_RELATION) || null : null,
    source: input.source ?? null,
  }, actor);
  await bestEffortSync(db);
  return created;
}

// The owner's override: the one path that changes a named person's name.
export async function renamePerson(db: D1Database, personId: string, name: string, actor: string): Promise<PersonRow> {
  if (typeof personId !== "string" || !personId.trim()) throw new ApiHttpError(400, "validation", "person id is required");
  if (typeof name !== "string") throw new ApiHttpError(400, "validation", "name is required");
  const next = oneLine(name);
  if (!next) throw new ApiHttpError(400, "validation", "name is required");
  if (next.length > MAX_NAME) throw new ApiHttpError(400, "validation", `name exceeds ${MAX_NAME} characters`);
  const threads = await listThreads(db);
  await syncPeople(db, threads);
  const before = await getPerson(db, personId);
  if (!before) throw new ApiHttpError(404, "not_found", "person not found");
  if (!before.thread_id) throw new ApiHttpError(409, "no_thread", "this person has no life thread to rename");
  if (nameNorm(next) === before.name_norm && next === before.name) return before;
  const holder = await db.prepare("SELECT id FROM people WHERE name_norm = ?1 AND id != ?2").bind(nameNorm(next), before.id).first<{ id: string }>();
  if (holder) throw new ApiHttpError(409, "duplicate", "someone else in her life already has that name");
  const renamed = await updateThread(db, before.thread_id, { title: next }, actor, { allowRename: true });
  const rows = await syncPeople(db, await listThreads(db));
  const after = rows.find((r) => r.id === before.id) ?? rows.find((r) => r.thread_id === renamed.id) ?? (await getPerson(db, before.id));
  if (!after) throw new ApiHttpError(404, "not_found", "person not found");
  await db.batch([auditStmt(db, actor, "person.rename", "person", before.id, before, after)]);
  return after;
}

// ------------------------------------------------------------------ db: the State page's view

export async function worldView(db: D1Database): Promise<{
  people: Array<PersonRow & { active: boolean; threadDetail: string | null; portraitAssetId: string | null; facts: WorldFactRow[] }>;
  places: Array<{ id: string; title: string; detail: string | null; active: boolean; facts: WorldFactRow[] }>;
}> {
  const threads = await listThreads(db);
  const [people, placesRaw, facts] = await Promise.all([
    syncPeople(db, threads),
    syncPlaces(db, threads).catch(() => listPlaces(db)),
    listWorldFacts(db, { status: "approved" }),
  ]);
  const byId = new Map(threads.map((t) => [t.id, t] as const));
  const factsOf = (kind: "person" | "place", id: string): WorldFactRow[] => facts.filter((f) => f.entity_kind === kind && f.entity_id === id);
  return {
    people: people.map((p) => {
      const t = p.thread_id ? byId.get(p.thread_id) : undefined;
      return {
        ...p,
        active: !!t && t.status === "active",
        threadDetail: t && typeof t.detail === "string" ? t.detail : null,
        portraitAssetId: t && typeof t.portrait_asset_id === "string" && t.portrait_asset_id ? t.portrait_asset_id : null,
        facts: factsOf("person", p.id),
      };
    }),
    places: placesRaw.map((pl) => ({
      id: pl.id,
      title: pl.title,
      detail: pl.detail ?? null,
      active: pl.active !== false,
      facts: factsOf("place", pl.id),
    })),
  };
}
