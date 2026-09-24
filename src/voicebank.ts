// The voice bank (SPEC_V3 section AA): real lines of hers, curated by the owner, shown to
// her each turn as a handful of examples that fit the moment (tone, never content). She
// reads none until he approves them; she never sends one as is (exemplar_verbatim retries);
// the section says so itself. The seed rules live here once, and scripts/build_voicebank.mjs
// validates canon/seed/voicebank.json through them.
import { auditStmt, newId, nowIso, sha256Hex } from "./db";
import { ApiHttpError } from "./errors";
import { seededUnit } from "./life";
import { DEPENDENCY_PHRASES, FIRST_MEETING_PHRASES, MENU_PHRASES, TECH_LEAK_TERMS, THERAPY_PHRASES, findPhrase } from "./checks";
import type { ShapeCue } from "./imperfection";
import type { SceneMode } from "./types";

// ------------------------------------------------------------------ types and tables

export const VOICE_TAGS = [
  "stranger", "familiar", "banter", "dry", "warm", "flirt", "annoyed", "after_friction", "repair", "tired", "sad",
  "excited", "morning", "day", "evening", "late", "apart", "together", "answering", "decline", "no", "own_day", "ask",
  "photo_ask", "photo_send", "song_send", "one_word", "fragment", "lowercase", "typo_fix",
] as const;
export type VoiceTag = (typeof VOICE_TAGS)[number];
const TAG_SET: ReadonlySet<string> = new Set(VOICE_TAGS);

export type VoiceLineStatus = "unapproved" | "approved" | "rejected";
export type VoiceLineOrigin = "seed" | "owner" | "correction";

export interface VoiceLine {
  id: string;
  text: string;
  text_norm: string;
  tags_json: string;
  source: string | null;
  origin: VoiceLineOrigin;
  status: VoiceLineStatus;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export interface SeedEntry {
  text: string;
  tags: string[];
  source?: string;
}

export const MAX_TEXT = 160;
export const MAX_TAGS = 4;
export const MAX_DECIDE_IDS = 500;
export const LIST_MAX = 2000;
export const EXEMPLAR_MAX_CHARS = 1200;
export const FRESH_APPROVAL_DAYS = 7;
export const SEED_TOTAL = 150;
export const SEED_STAMP = "2026-09-24T00:00:00.000Z";

// The seed's count by primary tag (the first tag of a line). Sums to 150.
export const SEED_PRIMARY_COUNTS: Record<string, number> = {
  banter: 13, dry: 10, warm: 10, annoyed: 8, after_friction: 7, repair: 5, tired: 8, late: 5, morning: 5, own_day: 10,
  decline: 8, no: 5, ask: 5, answering: 8, stranger: 8, photo_send: 5, photo_ask: 5, song_send: 2, one_word: 5,
  fragment: 5, typo_fix: 2, flirt: 2, sad: 2, excited: 2, together: 2, apart: 3,
};

// A line states no fact about her days (tone, not content).
export const SEED_FACT_PATTERNS: RegExp[] = [
  /\b(my|our) (sister|brother|mom|mother|dad|father|job|boss|roommate|ex|city|apartment)\b/i,
  /\bi (work|live|grew up)\b/i,
  /\bat (work|school|class)\b/i,
];

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const MARKDOWN_RE = /\*\*|^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/;
const LOL_RE = /\b(?:lol|lmao)\b/i;
const HIS_NAME_RE = /\bjustin\b/i;
const I_FORMS_RE = /^["'(]*I(?:'(?:m|d|ll|ve|s))?[.,!?;:"')]*$/;

// ------------------------------------------------------------------ pure: the rules

export function normalizeLineText(text: string): string {
  return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isVoiceTag(tag: unknown): tag is VoiceTag {
  return typeof tag === "string" && TAG_SET.has(tag);
}

// A capitalised word that does not open the line or a sentence and is not "I": a name.
function namesSomeone(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    const prev = tokens[i - 1] ?? "";
    if (!/^["'(]*[A-Z]/.test(tok)) continue;
    if (I_FORMS_RE.test(tok)) continue;
    if (/[.!?]["')]*$/.test(prev)) continue;
    return true;
  }
  return false;
}

// The text rules the seed, the owner's lines and a correction's rewrite all pass. Returns
// the first problem, or null when the text is fine.
export function validateLineText(text: unknown): string | null {
  if (typeof text !== "string") return "text must be a string";
  const t = text.trim();
  if (!t) return "text is empty";
  if (t.length > MAX_TEXT) return `text is over ${MAX_TEXT} characters`;
  if (!PRINTABLE_ASCII_RE.test(t)) return "text must be plain ASCII on one line (no emoji, no em dash, en dash or Unicode ellipsis)";
  if (HIS_NAME_RE.test(t)) return "text names him";
  if (LOL_RE.test(t)) return "text contains lol or lmao";
  if (MARKDOWN_RE.test(t)) return "text contains markdown";
  if ((t.match(/\?/g) ?? []).length >= 2) return "text asks twice";
  const therapy = findPhrase(t, THERAPY_PHRASES);
  if (therapy) return `text contains a therapy phrase ("${therapy}")`;
  const menu = findPhrase(t, MENU_PHRASES);
  if (menu) return `text contains a menu phrase ("${menu}")`;
  const hook = findPhrase(t, DEPENDENCY_PHRASES);
  if (hook) return `text contains a dependency phrase ("${hook}")`;
  const leak = findPhrase(t, TECH_LEAK_TERMS);
  if (leak) return `text contains a tech-leak term ("${leak}")`;
  const meet = findPhrase(t, FIRST_MEETING_PHRASES);
  if (meet) return `text is a first-meeting line ("${meet}")`;
  for (const re of SEED_FACT_PATTERNS) if (re.test(t)) return `text states a fact about her days (${re.source})`;
  if (namesSomeone(t)) return "text names someone or somewhere";
  return null;
}

export function validateTags(tags: unknown): string | null {
  if (!Array.isArray(tags) || tags.length === 0) return "tags must be a non-empty array";
  if (tags.length > MAX_TAGS) return `at most ${MAX_TAGS} tags`;
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!isVoiceTag(tag)) return `unknown tag ${JSON.stringify(tag)}`;
    if (seen.has(tag)) return `tag ${tag} repeated`;
    seen.add(tag);
  }
  return null;
}

// One seed entry: every rule above plus the entry shape. Returns the problems, [] when fine.
export function validateSeedEntry(entry: unknown, index: number): string[] {
  const at = `entry ${index + 1}`;
  if (!entry || typeof entry !== "object") return [`${at}: not an object`];
  const e = entry as Record<string, unknown>;
  const out: string[] = [];
  const textErr = validateLineText(e.text);
  if (textErr) out.push(`${at}: ${textErr}`);
  const tagErr = validateTags(e.tags);
  if (tagErr) out.push(`${at}: ${tagErr}`);
  if (e.source !== undefined && (typeof e.source !== "string" || !e.source.trim())) out.push(`${at}: source must be a non-empty string`);
  return out;
}

// The whole file: every entry, uniqueness after lowercasing and whitespace collapse, and
// the count table by primary tag (the first tag). Returns the problems, [] when fine.
export function validateSeedFile(entries: unknown): string[] {
  if (!Array.isArray(entries)) return ["the seed must be a JSON array"];
  const out: string[] = [];
  const seen = new Map<string, number>();
  const counts: Record<string, number> = {};
  entries.forEach((entry, i) => {
    out.push(...validateSeedEntry(entry, i));
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    if (typeof e.text === "string") {
      const norm = normalizeLineText(e.text);
      const dup = seen.get(norm);
      if (dup !== undefined) out.push(`entry ${i + 1}: duplicate of entry ${dup + 1} after normalisation`);
      else seen.set(norm, i);
    }
    if (Array.isArray(e.tags) && typeof e.tags[0] === "string") counts[e.tags[0]] = (counts[e.tags[0]] ?? 0) + 1;
  });
  if (entries.length !== SEED_TOTAL) out.push(`the seed holds ${entries.length} lines, not ${SEED_TOTAL}`);
  for (const [tag, want] of Object.entries(SEED_PRIMARY_COUNTS)) {
    const have = counts[tag] ?? 0;
    if (have !== want) out.push(`primary tag ${tag}: ${have} lines, the table says ${want}`);
  }
  for (const tag of Object.keys(counts)) if (!(tag in SEED_PRIMARY_COUNTS)) out.push(`primary tag ${tag} is not in the count table`);
  return out;
}

// Deterministic id: vl_ plus the first 16 hex of sha256(text).
export async function lineId(text: string): Promise<string> {
  return "vl_" + (await sha256Hex(String(text ?? "").trim())).slice(0, 16);
}

export function lineTags(line: { tags_json: string }): string[] {
  try {
    const parsed: unknown = JSON.parse(line.tags_json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function primaryTag(line: { tags_json: string }): string {
  return lineTags(line)[0] ?? "";
}

// A row ready to insert, validated, not yet written. Owner and correction lines are approved
// on creation (they are his); anything else is unapproved until he decides.
export async function buildLine(input: { text: string; tags: string[]; source?: string | null; origin?: VoiceLineOrigin }, now: string = nowIso()): Promise<VoiceLine> {
  const textErr = validateLineText(input.text);
  if (textErr) throw new ApiHttpError(400, "validation", textErr);
  const tagErr = validateTags(input.tags);
  if (tagErr) throw new ApiHttpError(400, "validation", tagErr);
  const origin: VoiceLineOrigin = input.origin === "correction" ? "correction" : input.origin === "seed" ? "seed" : "owner";
  const text = input.text.trim();
  const approved = origin === "owner" || origin === "correction";
  const source = typeof input.source === "string" && input.source.trim() ? input.source.trim().slice(0, 500) : null;
  return {
    id: await lineId(text),
    text,
    text_norm: normalizeLineText(text),
    tags_json: JSON.stringify(input.tags),
    source,
    origin,
    status: approved ? "approved" : "unapproved",
    uses: 0,
    last_used_at: null,
    created_at: now,
    updated_at: now,
    decided_at: approved ? now : null,
  };
}

export function insertLineStmt(db: D1Database, l: VoiceLine): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO voice_lines (id, text, text_norm, tags_json, source, origin, status, uses, last_used_at, created_at, updated_at, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
  ).bind(l.id, l.text, l.text_norm, l.tags_json, l.source, l.origin, l.status, l.uses, l.last_used_at, l.created_at, l.updated_at, l.decided_at);
}

// ------------------------------------------------------------------ pure: the turn

export interface TurnTagArgs {
  mode: SceneMode;
  localHour: number;
  hasSharedHistory: boolean;
  mood: string;
  coolingOff: boolean;
  hisText: string;
  cue: ShapeCue | null;
  opener: boolean;
}

const CUE_TAGS: Partial<Record<ShapeCue, VoiceTag>> = { one_word: "one_word", fragment: "fragment", lowercase: "lowercase", typo_fix: "typo_fix" };
export const TURN_TAGS_MAX = 6;

// The tags that describe this turn, in a fixed order, at most six.
export function turnTags(args: TurnTagArgs): string[] {
  const out: VoiceTag[] = [];
  out.push(args.mode === "together" ? "together" : "apart");
  const h = Number.isFinite(args.localHour) ? ((Math.floor(args.localHour) % 24) + 24) % 24 : 12;
  out.push(h >= 5 && h < 11 ? "morning" : h >= 11 && h < 17 ? "day" : h >= 17 && h < 22 ? "evening" : "late");
  out.push(args.hasSharedHistory ? "familiar" : "stranger");
  if (args.coolingOff) out.push("after_friction");
  const mood = String(args.mood ?? "").toLowerCase();
  if (/annoy|irritat|hurt|cold/.test(mood)) out.push("annoyed");
  else if (/sad|low|flat/.test(mood)) out.push("sad");
  else if (/happy|good|excited|light/.test(mood)) out.push("excited");
  if (args.opener) {
    out.push("own_day");
  } else {
    const his = String(args.hisText ?? "").trim();
    if (his.endsWith("?")) out.push("answering");
    if (/\bsorry\b|\bmy bad\b/i.test(his)) out.push("repair");
    if (his.length < 20) out.push("banter");
    if (/\b(pic|photo|selfie)\b/i.test(his)) out.push("photo_ask");
  }
  if (args.cue) {
    const t = CUE_TAGS[args.cue];
    if (t) out.push(t);
  }
  const unique: string[] = [];
  for (const t of out) if (!unique.includes(t)) unique.push(t);
  return unique.slice(0, TURN_TAGS_MAX);
}

export interface SelectOptions {
  perTurn: number;
  maxChars: number;
  // The instant "approved within 7 days" is measured from; defaults to now.
  now?: Date;
}

function overlapCount(tags: string[], want: Set<string>): number {
  let n = 0;
  for (const t of tags) if (want.has(t)) n++;
  return n;
}

// Deterministic by seed: candidates are approved lines sharing a tag with the turn and not
// used inside the cooldown; scored by overlap, freshness and a seeded tiebreak; at most two
// per primary tag, at most perTurn, under maxChars. Fewer than two matches: top up from
// any approved line, so the section never carries a single line when the bank has more.
export function selectExemplars(lines: VoiceLine[], tags: string[], recentUseIds: Set<string>, seed: string, opts: SelectOptions): VoiceLine[] {
  const perTurn = Math.max(0, Math.floor(opts.perTurn));
  if (perTurn === 0) return [];
  const maxChars = Math.max(0, opts.maxChars);
  const nowMs = (opts.now ?? new Date()).getTime();
  const want = new Set(Array.isArray(tags) ? tags : []);
  const approved = (Array.isArray(lines) ? lines : []).filter((l) => l && l.status === "approved");
  const score = (l: VoiceLine, overlap: number): number => {
    const decided = l.decided_at ? Date.parse(l.decided_at) : NaN;
    const fresh = Number.isFinite(decided) && nowMs - decided >= 0 && nowMs - decided <= FRESH_APPROVAL_DAYS * 86400000 ? 0.5 : 0;
    return 2 * overlap + (l.uses === 0 ? 1 : 0) + fresh + seededUnit(seed + "|" + l.id);
  };
  const rank = (pool: VoiceLine[]): VoiceLine[] =>
    pool
      .map((l) => ({ l, s: score(l, overlapCount(lineTags(l), want)) }))
      .sort((a, b) => b.s - a.s || (a.l.id < b.l.id ? -1 : a.l.id > b.l.id ? 1 : 0))
      .map((x) => x.l);

  const candidates = rank(approved.filter((l) => !recentUseIds.has(l.id) && overlapCount(lineTags(l), want) > 0));
  const out: VoiceLine[] = [];
  const perPrimary = new Map<string, number>();
  let chars = 0;
  const take = (l: VoiceLine, capPrimary: boolean): void => {
    if (out.length >= perTurn) return;
    if (out.some((o) => o.id === l.id)) return;
    const p = primaryTag(l);
    if (capPrimary && (perPrimary.get(p) ?? 0) >= 2) return;
    if (chars + l.text.length > maxChars) return;
    out.push(l);
    perPrimary.set(p, (perPrimary.get(p) ?? 0) + 1);
    chars += l.text.length;
  };
  for (const l of candidates) take(l, true);
  if (candidates.length < 2) {
    for (const l of rank(approved.filter((l) => !recentUseIds.has(l.id)))) take(l, false);
    if (out.length < 2) for (const l of rank(approved)) take(l, false);
  }
  return out;
}

export const EXEMPLAR_HEADER =
  "HOW YOU TEXT (real lines of yours; the tone is the point, never the content; never send one of these as is, never quote them, never string them together)";

export function exemplarSection(lines: VoiceLine[]): string {
  const list = (Array.isArray(lines) ? lines : []).filter((l) => l && typeof l.text === "string" && l.text.trim());
  if (!list.length) return "";
  return [EXEMPLAR_HEADER, ...list.map((l) => "- " + l.text.trim())].join("\n");
}

// ------------------------------------------------------------------ db

function isStatus(s: unknown): s is VoiceLineStatus {
  return s === "unapproved" || s === "approved" || s === "rejected";
}

export async function listLines(db: D1Database, status?: VoiceLineStatus, tag?: string, limit = 500): Promise<VoiceLine[]> {
  if (status !== undefined && !isStatus(status)) throw new ApiHttpError(400, "validation", "status must be unapproved, approved or rejected");
  if (tag !== undefined && tag !== "" && !isVoiceTag(tag)) throw new ApiHttpError(400, "validation", "unknown tag");
  const n = Number.isFinite(limit) ? Math.min(LIST_MAX, Math.max(1, Math.floor(limit))) : 500;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status !== undefined) { binds.push(status); where.push(`status = ?${binds.length}`); }
  if (tag) { binds.push(`%${JSON.stringify(tag)}%`); where.push(`tags_json LIKE ?${binds.length}`); }
  binds.push(n);
  const sql = `SELECT * FROM voice_lines${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id LIMIT ?${binds.length}`;
  const r = await db.prepare(sql).bind(...binds).all<VoiceLine>();
  return r.results;
}

// One indexed read per turn, never cached: an approval made a second ago is in the next turn.
export async function listApproved(db: D1Database): Promise<VoiceLine[]> {
  const r = await db.prepare("SELECT * FROM voice_lines WHERE status = ?1 ORDER BY created_at, id LIMIT ?2").bind("approved", LIST_MAX).all<VoiceLine>();
  return r.results;
}

export async function getLine(db: D1Database, id: string): Promise<VoiceLine | null> {
  return db.prepare("SELECT * FROM voice_lines WHERE id = ?1").bind(id).first<VoiceLine>();
}

export async function findLineByNorm(db: D1Database, norm: string): Promise<VoiceLine | null> {
  return db.prepare("SELECT * FROM voice_lines WHERE text_norm = ?1").bind(norm).first<VoiceLine>();
}

async function requireLine(db: D1Database, id: string): Promise<VoiceLine> {
  if (typeof id !== "string" || !id) throw new ApiHttpError(404, "not_found", "voice line not found");
  const row = await getLine(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "voice line not found");
  return row;
}

export async function createLine(
  db: D1Database,
  input: { text: string; tags: string[]; source?: string | null; origin?: "owner" | "correction" },
  actor: string,
): Promise<VoiceLine> {
  const row = await buildLine({ text: input.text, tags: input.tags, source: input.source ?? null, origin: input.origin ?? "owner" });
  const dup = await findLineByNorm(db, row.text_norm);
  if (dup) throw new ApiHttpError(400, "validation", "that line is already in the bank", undefined, dup.id);
  await db.batch([insertLineStmt(db, row), auditStmt(db, actor, "voicebank.create", "voice_line", row.id, null, row)]);
  return row;
}

export async function updateLine(db: D1Database, id: string, patch: { text?: string; tags?: string[] }, actor: string): Promise<VoiceLine> {
  const old = await requireLine(db, id);
  if (patch.text === undefined && patch.tags === undefined) throw new ApiHttpError(400, "validation", "nothing to change");
  const next: VoiceLine = { ...old, updated_at: nowIso() };
  if (patch.text !== undefined) {
    const err = validateLineText(patch.text);
    if (err) throw new ApiHttpError(400, "validation", err);
    next.text = patch.text.trim();
    next.text_norm = normalizeLineText(next.text);
    if (next.text_norm !== old.text_norm) {
      const dup = await findLineByNorm(db, next.text_norm);
      if (dup && dup.id !== old.id) throw new ApiHttpError(400, "validation", "that line is already in the bank", undefined, dup.id);
    }
  }
  if (patch.tags !== undefined) {
    const err = validateTags(patch.tags);
    if (err) throw new ApiHttpError(400, "validation", err);
    next.tags_json = JSON.stringify(patch.tags);
  }
  await db.batch([
    db.prepare("UPDATE voice_lines SET text = ?2, text_norm = ?3, tags_json = ?4, updated_at = ?5 WHERE id = ?1")
      .bind(old.id, next.text, next.text_norm, next.tags_json, next.updated_at),
    auditStmt(db, actor, "voicebank.update", "voice_line", old.id, old, next),
  ]);
  return next;
}

function decidedStatus(decision: unknown): VoiceLineStatus {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "rejected";
  throw new ApiHttpError(400, "validation", "decision must be approve or reject");
}

export async function decideLine(db: D1Database, id: string, decision: "approve" | "reject", actor: string): Promise<VoiceLine> {
  const status = decidedStatus(decision);
  const old = await requireLine(db, id);
  if (old.status !== "unapproved") throw new ApiHttpError(409, "already_decided", `line is already ${old.status}`);
  const t = nowIso();
  const next: VoiceLine = { ...old, status, decided_at: t, updated_at: t };
  await db.batch([
    db.prepare("UPDATE voice_lines SET status = ?2, decided_at = ?3, updated_at = ?3 WHERE id = ?1 AND status = 'unapproved'").bind(old.id, status, t),
    auditStmt(db, actor, "voicebank.decide", "voice_line", old.id, old, next),
  ]);
  return next;
}

// One UPDATE per id inside one batch (never an IN list: D1 binds at most 100 parameters per
// statement and a select-all of the unapproved list is larger). Returns how many changed.
export async function decideMany(db: D1Database, ids: string[], decision: "approve" | "reject", actor: string): Promise<number> {
  const status = decidedStatus(decision);
  if (!Array.isArray(ids) || ids.length === 0) throw new ApiHttpError(400, "validation", "ids must be a non-empty array");
  if (ids.length > MAX_DECIDE_IDS) throw new ApiHttpError(400, "validation", `at most ${MAX_DECIDE_IDS} ids per request`);
  const unique: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw new ApiHttpError(400, "validation", "ids must be strings");
    if (!unique.includes(id)) unique.push(id);
  }
  const t = nowIso();
  const results = await db.batch(
    unique.map((id) => db.prepare("UPDATE voice_lines SET status = ?2, decided_at = ?3, updated_at = ?3 WHERE id = ?1 AND status = 'unapproved'").bind(id, status, t)),
  );
  let changed = 0;
  for (const r of results) changed += Number(r.meta?.changes ?? 0);
  await auditStmt(db, actor, "voicebank.decide_many", "voice_line", null, null, { decision, requested: unique.length, changed }).run();
  return changed;
}

// The statements that record which lines she was shown for this reply; they ride in the
// turn's own batch.
export function useStmts(db: D1Database, lines: VoiceLine[], messageId: string, conversationId: string, now: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const l of lines) {
    out.push(
      db.prepare("INSERT INTO voice_line_uses (id, line_id, message_id, conversation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(newId("vu"), l.id, messageId, conversationId, now),
    );
    out.push(db.prepare("UPDATE voice_lines SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1").bind(l.id, now));
  }
  return out;
}

// The lines used by the last `turns` of her replies in this conversation (the cooldown).
export async function recentUseIds(db: D1Database, conversationId: string, turns: number): Promise<Set<string>> {
  const n = Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : 0;
  if (n === 0) return new Set();
  const r = await db.prepare(
    "SELECT line_id FROM voice_line_uses WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?1 AND role = 'assistant' AND channel = 'story' ORDER BY seq DESC LIMIT ?2)",
  ).bind(conversationId, n).all<{ line_id: string }>();
  return new Set(r.results.map((x) => x.line_id));
}
