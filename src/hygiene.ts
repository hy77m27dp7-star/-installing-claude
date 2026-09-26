// v5 (SPEC_V5 section 7): memory hygiene. Her memory of him stops stuttering: one fact said three
// ways is one fact, "44" and "forty-four" are the same age, and a thing she guessed about him is
// held as her guess, not as something he said. Nothing is deleted: every merge and every guess
// mark is a proposal (`fact_merge`, `fact_mark`) kept by the existing machinery, and the merge
// itself (src/state.ts mergeFacts) leaves every wording in a restorable version chain. Scope:
// facts about him (`justin` and `shared`); her own facts are canon and are never merged here.
//
// This module NEVER imports src/proposals.ts: proposals.ts imports it for the two promotions.
import { ApiHttpError } from "./errors";
import { listFacts } from "./db";
import { safeTimezone } from "./life";
import { herDayKey } from "./clock";
import { cleanLine, fileNightlyProposals, paidJsonCall, parseJsonArray } from "./storycall";
import type { NightlyBudget, NightlyProposal, StepResult } from "./storycall";
import { mergeFacts, setFactInferred } from "./state";
import { normalizeForMatch } from "./checks";
import { numberWordsToDigits, saidKey, saidLine } from "./said";
import type { Env, FactRow, ProposalRow, ProviderName, Settings } from "./types";

export const MERGE_PREFIX = "Decide which groups of facts";
export const INFERRED_PREFIX = "Decide whether he said";

export interface DupGroup {
  id: string;
  ids: string[];
  texts: string[];
  reason: "same_words" | "near";
}

export interface InferredCandidate {
  factId: string;
  text: string;
  quote: string | null;
  hisText: string | null;
}

const NEAR_MAX_DEFAULT = 12;
const GROUP_KEEP = 5;
const NEAR_JACCARD = 0.5;
const NEAR_JACCARD_SAME_SUBJECT = 0.25;
const INFERRED_MAX = 20;
const IN_CHUNK = 90;
const MERGE_TEXT_MAX = 300;
const PROPOSAL_TEXT_MAX = 300;
const HIS_TEXT_MAX = 600;
// Review fix: a merged head's source reads "merged: proposal p_..; ...", so the proposal id is
// found anywhere in the source, not only at its start.
const PROPOSAL_SOURCE_RE = /\bproposal (p_[A-Za-z0-9]+)/;
// Review fix: mergeFacts takes a keep and at most ten merged ids.
const EXACT_KEEP = 11;
// Review fix: what the last nights already looked at (the facts asked "did he say it", the
// near groups judged) is not asked again for this many nights, so each night reaches further
// into the backlog instead of paying for the same newest few again.
export const HYGIENE_MEMORY_NIGHTS = 30;
const CHECKED_KEPT = 60;
const JUDGED_KEPT = 36;

// ------------------------------------------------------------------ pure helpers

function isInferred(f: FactRow): boolean {
  return Number((f as FactRow & { inferred?: unknown }).inferred) === 1;
}

function byAge(a: FactRow, b: FactRow): number {
  return String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
}

// Approved, about him (scope justin or shared), and not one of his opinions.
export function hygieneScope(f: FactRow): boolean {
  if (!f || typeof f.id !== "string" || typeof f.fact !== "string") return false;
  if (f.status !== "approved") return false;
  if (f.scope !== "justin" && f.scope !== "shared") return false;
  const subject = typeof f.subject === "string" ? f.subject.trim().toLowerCase() : "";
  return !subject.startsWith("opinion:");
}

// The content words as a set (saidKey drops pronouns and the small words): near duplicates.
export function factKey(f: FactRow): string {
  return saidKey(saidLine(f.fact));
}

// Every word kept, in order, number words as digits, punctuation gone: exact duplicates.
// "He trusts her" and "She trusts him" share a factKey but never a rawKey (skeptic 20).
export function rawKey(f: FactRow): string {
  return numberWordsToDigits(saidLine(f.fact)).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function group(prefix: string, reason: DupGroup["reason"], n: number, members: FactRow[]): DupGroup {
  return { id: prefix + String(n), ids: members.map((f) => f.id), texts: members.map((f) => f.fact), reason };
}

export function exactDuplicateGroups(facts: FactRow[]): DupGroup[] {
  const buckets = new Map<string, FactRow[]>();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!hygieneScope(f)) continue;
    const k = rawKey(f);
    if (!k) continue;
    const list = buckets.get(k);
    if (list) {
      if (!list.some((x) => x.id === f.id)) list.push(f);
    } else buckets.set(k, [f]);
  }
  const groups = Array.from(buckets.values()).filter((g) => g.length >= 2).map((g) => g.slice().sort(byAge).slice(0, EXACT_KEEP));
  groups.sort((a, b) => byAge(a[0] as FactRow, b[0] as FactRow));
  return groups.map((g, i) => group("g", "same_words", i + 1, g));
}

// A short stable key for a set of fact ids (FNV-1a over the sorted ids): what a judged near
// group is remembered by. A group that gains or loses a member is a new group.
export function groupKey(ids: readonly string[]): string {
  const text = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string").slice().sort().join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + String(ids.length);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function nearDuplicateGroups(facts: FactRow[], exclude: ReadonlySet<string>, opts: { max?: number; judged?: ReadonlySet<string> } = {}): DupGroup[] {
  const max = typeof opts?.max === "number" && Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : NEAR_MAX_DEFAULT;
  if (max <= 0) return [];
  const seen = new Set<string>();
  const pool: Array<{ f: FactRow; words: Set<string>; subject: string }> = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!hygieneScope(f) || exclude.has(f.id) || seen.has(f.id)) continue;
    const words = new Set(factKey(f).split(" ").filter(Boolean));
    if (!words.size) continue;
    seen.add(f.id);
    pool.push({ f, words, subject: typeof f.subject === "string" ? f.subject.trim().toLowerCase() : "" });
  }
  // Union by the pairs.
  const parent = pool.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    let c = i;
    while (parent[c] !== r) {
      const nx = parent[c] as number;
      parent[c] = r;
      c = nx;
    }
    return r;
  };
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i] as (typeof pool)[number];
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j] as (typeof pool)[number];
      const jac = jaccard(a.words, b.words);
      const together = jac >= NEAR_JACCARD || (a.subject !== "" && a.subject === b.subject && jac >= NEAR_JACCARD_SAME_SUBJECT);
      if (!together) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[rb] = ra;
    }
  }
  const byRoot = new Map<number, FactRow[]>();
  pool.forEach((p, i) => {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(p.f);
    else byRoot.set(r, [p.f]);
  });
  // Review fix: a large group is shown in windows (its oldest member with the next four), and
  // a window judged on an earlier night (opts.judged, by groupKey) gives way to the next one,
  // so the sixth member of a big group and a newer real duplicate both reach the model.
  const judged = opts && opts.judged ? opts.judged : null;
  const groups: FactRow[][] = [];
  for (const g of byRoot.values()) {
    if (g.length < 2) continue;
    const sorted = g.slice().sort(byAge);
    const head = sorted[0] as FactRow;
    const rest = sorted.slice(1);
    const windows: FactRow[][] = [];
    for (let i = 0; i < rest.length; i += GROUP_KEEP - 1) windows.push([head, ...rest.slice(i, i + GROUP_KEEP - 1)]);
    const pick = judged ? windows.find((w) => !judged.has(groupKey(w.map((f) => f.id)))) : windows[0];
    if (pick) groups.push(pick);
  }
  groups.sort((a, b) => byAge(a[0] as FactRow, b[0] as FactRow));
  return groups.slice(0, max).map((g, i) => group("n", "near", i + 1, g));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The merged line adds no name, no number and no place: after number words become digits, every
// digit run and every capitalised word that is not the merged text's first word must appear
// (case-insensitively, as a whole word) in at least one source.
export function mergeGuard(merged: string, sources: string[]): boolean {
  if (typeof merged !== "string" || !merged.trim()) return false;
  const m = numberWordsToDigits(merged);
  const srcs = (Array.isArray(sources) ? sources : []).filter((x): x is string => typeof x === "string").map((x) => numberWordsToDigits(x));
  if (!srcs.length) return false;
  for (const d of m.match(/\d+/g) ?? []) {
    const re = new RegExp("(?:^|\\D)" + d + "(?:\\D|$)");
    if (!srcs.some((x) => re.test(x))) return false;
  }
  const words = m.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    if (!/^\p{Lu}/u.test(w)) continue;
    const re = new RegExp("(?:^|[^\\p{L}\\p{N}])" + escapeRe(w) + "(?:[^\\p{L}\\p{N}]|$)", "iu");
    if (!srcs.some((x) => re.test(x))) return false;
  }
  return true;
}

export function mergeSystem(): string {
  return "Decide which groups of facts say the same thing. Each GROUP lists facts about him in different words. For each group output whether they are one fact (\"same\": true) and, when they are, one merged line that keeps every specific detail the group states and adds nothing: no new name, number, place or guess. Output strictly a JSON array, no prose, no fences: [{\"group\": the group id, \"same\": true|false, \"text\": the merged line or omitted}].";
}

export function mergeUser(groups: DupGroup[]): string {
  return (Array.isArray(groups) ? groups : [])
    .map((g) => [`GROUP ${g.id}:`, ...g.ids.map((id, i) => `- [${id}] ${saidLine(g.texts[i] ?? "", MERGE_TEXT_MAX)}`)].join("\n"))
    .join("\n\n");
}

export function parseMergeAnswer(text: string, groups: DupGroup[]): Array<{ group: DupGroup; text: string }> {
  const byId = new Map((Array.isArray(groups) ? groups : []).map((g) => [g.id, g] as const));
  const done = new Set<string>();
  const out: Array<{ group: DupGroup; text: string }> = [];
  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.same !== true) continue;
    const gid = typeof item.group === "string" ? item.group.trim() : "";
    const g = gid ? byId.get(gid) : undefined;
    if (!g || done.has(g.id)) continue;
    const line = cleanLine(item.text, MERGE_TEXT_MAX);
    if (!line || !mergeGuard(line, g.texts)) continue;
    done.add(g.id);
    out.push({ group: g, text: line });
  }
  return out;
}

// The user_message_id at the TOP level of payload_json, where extractProposals writes it beside
// `payload`. The same read as the private proposalMessageIds in src/proposals.ts.
export function proposalUserMessageId(p: Pick<ProposalRow, "payload_json">): string | null {
  if (!p || typeof p.payload_json !== "string" || !p.payload_json) return null;
  try {
    const outer: unknown = JSON.parse(p.payload_json);
    if (!outer || typeof outer !== "object" || Array.isArray(outer)) return null;
    const u = (outer as Record<string, unknown>).user_message_id;
    return typeof u === "string" && u ? u : null;
  } catch {
    return null;
  }
}

function proposalIdOf(f: FactRow): string | null {
  const m = typeof f.source === "string" ? PROPOSAL_SOURCE_RE.exec(f.source) : null;
  return m && m[1] ? m[1] : null;
}

// Facts about him filed from a proposal whose quote is not in his own message: the model is asked
// whether he said them. Newest first, so each night reaches what the last turns filed.
export function inferredCandidates(
  facts: FactRow[],
  proposals: ReadonlyMap<string, { evidence: string | null; userMessageId: string | null }>,
  hisTexts: ReadonlyMap<string, string>,
  skip: ReadonlySet<string> = new Set(),
): InferredCandidate[] {
  const out: InferredCandidate[] = [];
  // Review fix: `skip` holds the facts a merge proposed tonight takes (a mark on one would
  // name a superseded fact) and the ones asked on the last nights.
  const pool = (Array.isArray(facts) ? facts : []).filter((f) => hygieneScope(f) && f.scope === "justin" && !isInferred(f) && !skip.has(f.id)).slice().sort((a, b) => byAge(b, a));
  for (const f of pool) {
    if (out.length >= INFERRED_MAX) break;
    const pid = proposalIdOf(f);
    if (!pid) continue;
    const info = proposals.get(pid);
    const quote = info && typeof info.evidence === "string" && info.evidence.trim() ? info.evidence.trim() : null;
    const umid = info && typeof info.userMessageId === "string" ? info.userMessageId : null;
    const his = umid ? hisTexts.get(umid) : undefined;
    const hisText = typeof his === "string" && his.trim() ? his : null;
    if (quote && hisText) {
      const q = normalizeForMatch(quote);
      if (q && normalizeForMatch(hisText).includes(q)) continue;
    }
    out.push({ factId: f.id, text: f.fact, quote, hisText });
  }
  return out;
}

export function inferredSystem(): string {
  return "Decide whether he said each fact himself. For each FACT you get the fact, the quote it was filed from, and his own message. \"said\": true only when his own message states it, in any words; false when it was worked out from hints, guessed, or said by her. Output strictly a JSON array, no prose, no fences: [{\"fact\": the fact id, \"said\": true|false}].";
}

export function inferredUser(cands: ReturnType<typeof inferredCandidates>): string {
  return (Array.isArray(cands) ? cands : [])
    .map((c) => [
      `FACT ${c.factId}: ${saidLine(c.text, MERGE_TEXT_MAX)}`,
      `QUOTE: ${c.quote ? saidLine(c.quote, HIS_TEXT_MAX) : "(none)"}`,
      `HIS MESSAGE: ${c.hisText ? saidLine(c.hisText, HIS_TEXT_MAX) : "(none)"}`,
    ].join("\n"))
    .join("\n\n");
}

// Every fact id the model answered for (said true or false): what the night checked.
export function answeredInferredIds(text: string, ids: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.said !== true && item.said !== false) continue;
    const id = typeof item.fact === "string" ? item.fact.trim() : "";
    if (id && ids.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

// Every near group the model answered for (same true or false): what the night judged.
export function answeredGroupIds(text: string, groups: DupGroup[]): string[] {
  const known = new Set((Array.isArray(groups) ? groups : []).map((g) => g.id));
  const out: string[] = [];
  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.same !== true && item.same !== false) continue;
    const gid = typeof item.group === "string" ? item.group.trim() : "";
    if (gid && known.has(gid) && !out.includes(gid)) out.push(gid);
  }
  return out;
}

// The facts checked and the near groups judged on the last HYGIENE_MEMORY_NIGHTS nights,
// read from the hygiene step's own nightly_runs rows (detail.checked, detail.judged). A
// database behind 0009, or a row that does not parse, adds nothing.
export async function recentHygieneMarks(db: D1Database, day: string): Promise<{ checked: Set<string>; judged: Set<string>; todayChecked: string[]; todayJudged: string[] }> {
  const out = { checked: new Set<string>(), judged: new Set<string>(), todayChecked: [] as string[], todayJudged: [] as string[] };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof day === "string" ? day : "");
  if (!m) return out;
  const since = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - HYGIENE_MEMORY_NIGHTS)).toISOString().slice(0, 10);
  let rows: Array<{ day: string; result_json: string | null }> = [];
  try {
    const r = await db.prepare("SELECT day, result_json FROM nightly_runs WHERE step = 'hygiene' AND day >= ?1 AND day <= ?2 ORDER BY day DESC LIMIT ?3")
      .bind(since, day, HYGIENE_MEMORY_NIGHTS + 1).all<{ day: string; result_json: string | null }>();
    rows = r.results ?? [];
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!row || typeof row.result_json !== "string") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.result_json); } catch { continue; }
    const detail = parsed && typeof parsed === "object" ? (parsed as { detail?: unknown }).detail : null;
    if (!detail || typeof detail !== "object") continue;
    const d = detail as { checked?: unknown; judged?: unknown };
    const checked = Array.isArray(d.checked) ? d.checked.filter((x): x is string => typeof x === "string") : [];
    const judged = Array.isArray(d.judged) ? d.judged.filter((x): x is string => typeof x === "string") : [];
    for (const x of checked) out.checked.add(x);
    for (const x of judged) out.judged.add(x);
    if (row.day === day) {
      out.todayChecked = checked;
      out.todayJudged = judged;
    }
  }
  return out;
}

export function parseInferredAnswer(text: string, ids: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const raw of parseJsonArray(text)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.said !== false) continue;
    const id = typeof item.fact === "string" ? item.fact.trim() : "";
    if (!id || !ids.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

// ------------------------------------------------------------------ the two promotions

export async function applyFactMerge(db: D1Database, payload: Record<string, unknown>, source: string, actor: string): Promise<string> {
  if (!payload || typeof payload !== "object") throw new ApiHttpError(400, "validation", "payload must be an object");
  const keepId = typeof payload.keep === "string" ? payload.keep.trim() : "";
  const merge = Array.isArray(payload.merge) ? payload.merge.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
  const text = typeof payload.text === "string" ? saidLine(payload.text, 4000).trim() : "";
  if (!keepId) throw new ApiHttpError(400, "validation", "keep is required");
  if (!merge.length || merge.length !== (payload.merge as unknown[]).length) throw new ApiHttpError(400, "validation", "merge must list the fact ids to merge");
  if (!text) throw new ApiHttpError(400, "validation", "text is required");
  const head = await mergeFacts(db, { keepId, mergeIds: merge, text, source: typeof source === "string" ? source : "" }, actor);
  return head.id;
}

export async function applyFactMark(db: D1Database, payload: Record<string, unknown>, source: string, actor: string): Promise<string> {
  if (!payload || typeof payload !== "object") throw new ApiHttpError(400, "validation", "payload must be an object");
  const id = typeof payload.fact_id === "string" ? payload.fact_id.trim() : "";
  if (!id) throw new ApiHttpError(400, "validation", "fact_id is required");
  const head = await setFactInferred(db, id, true, typeof source === "string" ? source : "", actor);
  return head.id;
}

// ------------------------------------------------------------------ the nightly step

type HygieneSettings = Settings & { nightlyProvider?: ProviderName; hygieneModel?: string };

async function readProposals(db: D1Database, ids: string[]): Promise<Map<string, { evidence: string | null; userMessageId: string | null }>> {
  const out = new Map<string, { evidence: string | null; userMessageId: string | null }>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const marks = chunk.map((_, j) => "?" + (j + 1)).join(", ");
    const r = await db.prepare(`SELECT id, evidence, payload_json FROM proposals WHERE id IN (${marks})`).bind(...chunk)
      .all<{ id: string; evidence: string | null; payload_json: string | null }>();
    for (const p of r.results ?? []) {
      if (!p || typeof p.id !== "string") continue;
      out.set(p.id, { evidence: typeof p.evidence === "string" ? p.evidence : null, userMessageId: proposalUserMessageId(p) });
    }
  }
  return out;
}

async function readHisMessages(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const marks = chunk.map((_, j) => "?" + (j + 1)).join(", ");
    const r = await db.prepare(`SELECT id, content FROM messages WHERE role = 'user' AND id IN (${marks})`).bind(...chunk).all<{ id: string; content: string }>();
    for (const m of r.results ?? []) if (m && typeof m.id === "string" && typeof m.content === "string") out.set(m.id, m.content);
  }
  return out;
}

export async function runHygienePass(env: Env, db: D1Database, settings: Settings, budget: NightlyBudget, now: Date): Promise<StepResult> {
  const s = settings as HygieneSettings;
  const tz = safeTimezone(typeof s.timezone === "string" ? s.timezone : "UTC");
  const day = herDayKey(now, tz);
  const provider = (s.nightlyProvider ?? "anthropic") as ProviderName;
  const model = typeof s.hygieneModel === "string" && s.hygieneModel ? s.hygieneModel : "claude-haiku-4-5";
  const evidence = `nightly hygiene ${day}`;
  const problems: string[] = [];

  // (1) the approved facts, and what the last nights already looked at.
  const facts = await listFacts(db, undefined, "approved");
  const marks = await recentHygieneMarks(db, day);
  const judgedNow: string[] = [];
  const checkedNow: string[] = [];

  // (2) exact duplicates: the same words in the same order once number words are digits. No model.
  const exact = exactDuplicateGroups(facts);
  const rows: NightlyProposal[] = exact.map((g) => ({
    kind: "fact_merge",
    proposal: saidLine(`same fact: ${g.texts.join(" = ")}`, PROPOSAL_TEXT_MAX),
    evidence,
    confidence: "high",
    payload: { keep: g.ids[0], merge: g.ids.slice(1), text: g.texts[0] },
    source: `nightly hygiene ${day} exact`,
  }));

  // (3) near duplicates (every exact id excluded), confirmed and worded by the cheap model.
  const exclude = new Set(exact.flatMap((g) => g.ids));
  const near = nearDuplicateGroups(facts, exclude, { judged: marks.judged });
  // The facts a merge proposed tonight takes are not asked "did he say it" (review fix).
  const merging = new Set<string>(exclude);
  let mergedNear = 0;
  if (near.length) {
    const call = await paidJsonCall(env, db, settings, budget, {
      tag: "hygiene_merge", provider, model, system: mergeSystem(), user: mergeUser(near), maxTokens: 600, temperature: 0,
    });
    if (call.ok) {
      const byGroup = new Map(near.map((g) => [g.id, g] as const));
      for (const gid of answeredGroupIds(call.text, near)) {
        const g = byGroup.get(gid);
        if (g) judgedNow.push(groupKey(g.ids));
      }
      for (const a of parseMergeAnswer(call.text, near)) {
        for (const id of a.group.ids) merging.add(id);
        mergedNear++;
        rows.push({
          kind: "fact_merge",
          proposal: saidLine(`same fact: ${a.text} (was: ${a.group.texts.join(" = ")})`, PROPOSAL_TEXT_MAX),
          evidence,
          confidence: "medium",
          payload: { keep: a.group.ids[0], merge: a.group.ids.slice(1), text: a.text },
          source: `nightly hygiene ${day} ${call.runId}`,
        });
      }
    } else problems.push("merge: " + call.reason);
  }

  // (4) facts filed from a proposal whose quote is not in his own message: did he say it?
  let marked = 0;
  const pids = Array.from(new Set(
    facts.filter((f) => hygieneScope(f) && f.scope === "justin" && !isInferred(f)).map(proposalIdOf).filter((x): x is string => !!x),
  ));
  if (pids.length) {
    const proposals = await readProposals(db, pids);
    const umids = Array.from(new Set(Array.from(proposals.values()).map((p) => p.userMessageId).filter((x): x is string => !!x)));
    const hisTexts = umids.length ? await readHisMessages(db, umids) : new Map<string, string>();
    const skip = new Set<string>([...merging, ...marks.checked]);
    const cands = inferredCandidates(facts, proposals, hisTexts, skip);
    if (cands.length) {
      const call = await paidJsonCall(env, db, settings, budget, {
        tag: "hygiene_inferred", provider, model, system: inferredSystem(), user: inferredUser(cands), maxTokens: 400, temperature: 0,
      });
      if (call.ok) {
        const byId = new Map(cands.map((c) => [c.factId, c] as const));
        checkedNow.push(...answeredInferredIds(call.text, new Set(byId.keys())));
        for (const id of parseInferredAnswer(call.text, new Set(byId.keys()))) {
          const c = byId.get(id);
          if (!c) continue;
          marked++;
          rows.push({
            kind: "fact_mark",
            proposal: saidLine(`a guess, not his words: ${c.text}`, PROPOSAL_TEXT_MAX),
            evidence,
            confidence: "medium",
            payload: { fact_id: id, inferred: true },
            source: `nightly hygiene ${day} ${call.runId}`,
          });
        }
      } else problems.push("inferred: " + call.reason);
    }
  }

  const filed = rows.length ? await fileNightlyProposals(db, rows) : [];
  const proposalIds = filed.filter((x): x is string => typeof x === "string");
  const mergedFiled = rows.filter((r, i) => r.kind === "fact_merge" && typeof filed[i] === "string").length;
  const markedFiled = rows.filter((r, i) => r.kind === "fact_mark" && typeof filed[i] === "string").length;
  const detail: Record<string, unknown> = { exactGroups: exact.length, nearGroups: near.length, merged: mergedFiled, marked: markedFiled };
  // Rows fileNightlyProposals skipped: the same proposal is already pending or kept this month.
  if (rows.length > proposalIds.length) detail.alreadyFiled = rows.length - proposalIds.length;
  detail.answered = { nearMerged: mergedNear, marked };
  // What this night looked at (with what an earlier run of the same day did), for the nights after.
  const union = (a: string[], b: string[], max: number): string[] => Array.from(new Set([...a, ...b])).slice(0, max);
  detail.checked = union(checkedNow, marks.todayChecked, CHECKED_KEPT);
  detail.judged = union(judgedNow, marks.todayJudged, JUDGED_KEPT);
  if (problems.length) detail.problems = problems;
  return {
    step: "hygiene",
    status: "done",
    reason: rows.length ? `${proposalIds.length} filed` + (problems.length ? "; " + problems.join("; ") : "") : problems.length ? problems.join("; ") : "nothing to tidy",
    proposalIds,
    detail,
  };
}
