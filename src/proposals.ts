// Memory proposals: a separate structured pass extracts candidate durable facts from one
// exchange and parks them as pending rows. Nothing here promotes on its own; the owner
// decides, and promotion goes through the state helpers so every write is audited.
import { getTextProvider, providerConfigured } from "./providers/index";
import { assertBudget, costMicro, estimateUsd } from "./budget";
import { proposalSystemPrompt } from "./prompt";
import { saidKey, saidLine } from "./said";
import {
  auditStmt, dayKey, getCurrentState, getProposal, insertModelRunStmt, insertProposalStmt, listFacts, listProposals,
  listRecentStoryMessages, newId, nowIso, usageStmt,
} from "./db";
import { createFact, createHistory, createUnknown, putState, updateFact } from "./state";
import { createThread, listThreads, logLife, updateThread } from "./life";
// v3 (SPEC_V3): the weight a proposal carries (BB), wants and asks (CC), grounding rows (DD).
import { putWeight } from "./memory";
import { createAsk, createWant, findAsk, findWant, logWant, updateAsk } from "./wants";
import { createGroundingRow } from "./grounding";
import type { GroundingKind } from "./grounding";
import type { WantLogKind } from "./wants";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import type {
  ChatMessage, Env, FactRow, MessageRow, ModelRunRow, ProposalKind, ProposalRow, RelationshipState, SceneState, Settings,
} from "./types";
import type { LifeThread } from "./life";

export const PROPOSAL_KINDS: ProposalKind[] = [
  "avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown", "life",
  // v3
  "want", "want_update", "ask", "ask_update", "grounding", "life_update",
];
// v3 (BB): the weight an element may carry, "how much this mattered" (0.1 passing, 1 a loss,
// a love, a fear). Absent = the entity's default, written by nobody.
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 1;
const WANT_LOG_KINDS = ["progress", "setback", "note"] as const;
const GROUNDING_KINDS = ["meal", "outfit", "errand", "misc"] as const;
const MOOD_DAYS_MIN = 1;
const MOOD_DAYS_MAX = 14;
const CONFIDENCES = ["low", "medium", "high"] as const;
const MAX_PROPOSALS_PER_EXCHANGE = 12;
const MAX_PROPOSAL_CHARS = 1000;
// A payload is a small object of plain values; anything bigger is not a proposal.
const MAX_PAYLOAD_CHARS = 4000;
const LIFE_KINDS: ReadonlyArray<LifeThread["kind"]> = ["routine", "event", "person", "place", "arc"];
const OPINION_PREFIX = "opinion:";
const MAX_COOLING_OFF_HOURS = 24 * 14;
const PROPOSAL_MAX_TOKENS = 800;
// The flag on a run row when the pass was skipped by the caps rather than run.
export const BUDGET_SKIPPED_FLAG = "budget_skipped";

export interface ParsedProposal {
  kind: ProposalKind;
  proposal: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
  scope: string;
  // v2: structured fields for life, relationship (mood, cooling_off_hours) and opinion_change (subject).
  // v3: want { title, why?, stakes?, next_step?, horizon_days? }; want_update { want: title or id,
  // kind: progress|setback|note, delta?, note }; ask { text, want?: title }; ask_update { ask: text
  // or id, status: granted|declined }; grounding { kind, note, occurred? }; life_update { thread:
  // title or id, detail?, note? }; relationship gains mood_days (1..14).
  payload?: Record<string, unknown>;
  // v3 (BB): how much this mattered, 0.1 to 1; absent when the element carried none.
  weight?: number;
}

function isKind(v: unknown): v is ProposalKind {
  return typeof v === "string" && (PROPOSAL_KINDS as string[]).includes(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// The weight an element carried, clipped to 0.1..1; anything that is not a finite number
// (or a numeric string) is no weight.
export function parseWeight(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, n));
}

// The payload an element carried, when it is a plain object of reasonable size.
function parsePayload(v: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(v)) return undefined;
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return undefined;
  }
  if (json.length > MAX_PAYLOAD_CHARS) return undefined;
  return JSON.parse(json) as Record<string, unknown>;
}

// ------------------------------------------------------------------ parsing (tolerant)

export function parseProposalJson(text: string): ParsedProposal[] {
  if (typeof text !== "string") return [];
  let body = text.trim();
  body = body.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "");
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ParsedProposal[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (!isKind(o.kind)) continue;
    if (typeof o.proposal !== "string") continue;
    const proposal = o.proposal.trim().slice(0, MAX_PROPOSAL_CHARS);
    if (!proposal) continue;
    const evidence = typeof o.evidence === "string" ? o.evidence.trim().slice(0, MAX_PROPOSAL_CHARS) : "";
    const confidence = (CONFIDENCES as readonly string[]).includes(String(o.confidence)) ? (o.confidence as ParsedProposal["confidence"]) : "low";
    const scope = typeof o.scope === "string" && o.scope.trim() ? o.scope.trim().slice(0, 100) : "general";
    const parsed: ParsedProposal = { kind: o.kind, proposal, evidence, confidence, scope };
    const payload = parsePayload(o.payload);
    if (payload) parsed.payload = payload;
    const weight = parseWeight(o.weight);
    if (weight !== undefined) parsed.weight = weight;
    out.push(parsed);
    if (out.length >= MAX_PROPOSALS_PER_EXCHANGE) break;
  }
  return out;
}

// ------------------------------------------------------------------ extraction

// userMessage is null when she opened the conversation herself (SPEC_V2 section Q).
function exchangeText(rows: MessageRow[], userMessage: MessageRow | null, assistantMessage: MessageRow): string {
  const list = rows.slice();
  if (userMessage && !list.some((m) => m.id === userMessage.id)) list.push(userMessage);
  if (!list.some((m) => m.id === assistantMessage.id)) list.push(assistantMessage);
  return list.map((m) => `${m.role === "user" ? "User" : "Avelie"}: ${m.content}`).join("\n\n");
}

async function stateSummary(db: D1Database): Promise<string> {
  const [rel, scene, him, her] = await Promise.all([
    getCurrentState<RelationshipState>(db, "relationship"),
    getCurrentState<SceneState>(db, "scene"),
    listFacts(db, "justin"),
    listFacts(db, "avelie"),
  ]);
  // 2026-09-26: the extractor saw only the counts, so every time a topic came up it proposed
  // it again in new words and auto-keep stored it (the coffee place six times, "no boyfriend"
  // six times). It now sees what is already kept, and the system prompt tells it to propose
  // only what is new or changed. Capped so a long memory never swamps the call.
  const threads = await listThreads(db, "active").catch(() => [] as LifeThread[]);
  const line = (t: string) => "- " + t.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LINE_MAX);
  const factLines = (rows: typeof him) => rows.filter((f) => f.status === "approved").slice(-SUMMARY_LIST_MAX).map((f) => line(f.fact));
  return [
    `Relationship: ${rel.state.summary ?? ""}`,
    `Scene: ${scene.state.summary ?? ""}`,
    "Already kept about him:",
    ...factLines(him),
    "Already kept about her:",
    ...factLines(her),
    "Already in her life (kind: title: detail):",
    ...threads.slice(-SUMMARY_LIST_MAX).map((t) => line(t.kind + ": " + t.title + (t.detail ? ": " + t.detail : ""))),
  ].join("\n");
}

const SUMMARY_LIST_MAX = 120;
const SUMMARY_LINE_MAX = 180;

function errorClass(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof Error) return e.name || "Error";
  return "error";
}

export async function extractProposals(
  env: Env,
  db: D1Database,
  settings: Settings,
  conversationId: string,
  userMessage: MessageRow | null,
  assistantMessage: MessageRow,
): Promise<number> {
  const providerName = settings.proposalProvider;
  if (!providerConfigured(env, providerName)) return 0;
  const provider = getTextProvider(providerName);
  const model = settings.proposalModel;

  const [recent, summary] = await Promise.all([
    listRecentStoryMessages(db, conversationId, 6),
    stateSummary(db),
  ]);
  const content = "EXCHANGE:\n" + exchangeText(recent, userMessage, assistantMessage) + "\n\nAPPROVED STATE:\n" + summary;
  const messages: ChatMessage[] = [{ role: "user", content }];
  const system = proposalSystemPrompt();

  const started = Date.now();
  const runId = newId("r");
  const runBase = {
    id: runId,
    conversation_id: conversationId,
    kind: "proposal" as const,
    provider: providerName,
    model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: null,
    flags_json: null,
    created_at: nowIso(),
  };

  // The pass is a paid call like any other, so it sits under the same caps and needs a
  // priced model. A refusal skips the pass quietly: the turn is already answered, nothing
  // is retried, and the run log keeps a flagged row saying why nothing was proposed.
  try {
    await assertBudget(db, settings, estimateUsd(settings, model, system.length + content.length, PROPOSAL_MAX_TOKENS));
  } catch (e) {
    if (!(e instanceof ApiHttpError && e.status === 402)) throw e;
    const skipped: ModelRunRow = {
      ...runBase, latency_ms: Date.now() - started, status: "failed", error: e.code, flags_json: JSON.stringify([BUDGET_SKIPPED_FLAG]),
    };
    try { await insertModelRunStmt(db, skipped).run(); } catch { /* the run log is best effort */ }
    return 0;
  }

  let text: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const result = await provider.generate(env, {
      system,
      messages,
      model,
      maxTokens: PROPOSAL_MAX_TOKENS,
      temperature: 0.2,
      effort: "low",
      cacheable: false,
    });
    text = result.stopReason === "refusal" ? "[]" : result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } catch (e) {
    const failed: ModelRunRow = { ...runBase, latency_ms: Date.now() - started, status: "failed", error: errorClass(e) };
    try { await insertModelRunStmt(db, failed).run(); } catch { /* the run log is best effort */ }
    return 0;
  }

  const candidates = parseProposalJson(text);
  // The same exchange is read for several turns, so anything already proposed, decided
  // or approved (including the original text of an edited proposal) is not proposed again.
  const [pending, rejected, edited, approved, approvedFacts] = await Promise.all([
    listProposals(db, "pending"), listProposals(db, "rejected"), listProposals(db, "edited"), listProposals(db, "approved"), listFacts(db),
  ]);
  const seen = new Set<string>();
  for (const p of [...pending, ...rejected, ...edited, ...approved]) {
    seen.add(normText(p.proposal));
    if (p.status === "edited" && p.payload_json) {
      try {
        const original = (JSON.parse(p.payload_json) as { original_proposal?: unknown }).original_proposal;
        if (typeof original === "string") seen.add(normText(original));
      } catch { /* an unreadable payload hides nothing that matters */ }
    }
  }
  for (const f of approvedFacts) seen.add(normText(f.fact));

  const t = nowIso();
  const rows: ProposalRow[] = [];
  for (const c of candidates) {
    const key = normText(c.proposal);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: newId("p"),
      conversation_id: conversationId,
      message_id: assistantMessage.id,
      kind: c.kind,
      proposal: c.proposal,
      evidence: c.evidence || null,
      confidence: c.confidence,
      scope: c.scope,
      payload_json: JSON.stringify({
        user_message_id: userMessage ? userMessage.id : null,
        assistant_message_id: assistantMessage.id,
        payload: c.payload ?? null,
        weight: c.weight ?? null,
        raw: c,
      }),
      status: "pending",
      decision_note: null,
      promoted_id: null,
      created_at: t,
      decided_at: null,
    });
  }

  const cost = costMicro(settings, model, inputTokens, outputTokens);
  const run: ModelRunRow = {
    ...runBase,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd_micro: cost.micro,
    latency_ms: Date.now() - started,
    status: "ok",
    error: null,
    flags_json: cost.priceKnown ? null : JSON.stringify(["price_unknown"]),
  };
  const stmts: D1PreparedStatement[] = rows.map((r) => insertProposalStmt(db, r));
  stmts.push(insertModelRunStmt(db, run));
  stmts.push(usageStmt(db, dayKey(), providerName, model, inputTokens, outputTokens, cost.micro));
  await db.batch(stmts);
  // v3.2: her memory keeps itself when the switch is on (the owner's Inbox is then the
  // place to remove, not a gate). A failure here never costs the turn.
  if (settings.proposalsAutoApprove === true && rows.length) {
    try { await keepAutomatically(db, rows.map((r) => r.id)); } catch (e) { console.warn("auto keep skipped", errorClass(e)); }
  }
  return rows.length;
}

// v3.2 "memory keeps itself": every proposal the extractor files is approved on the spot
// unless an approved or edited proposal of the same kind already says the same thing (same
// content words), in which case it is rejected as a duplicate. Oldest first, so the first
// wording of a fact is the one kept.
export function duplicateKey(kind: string, text: string): string {
  return kind + "|" + saidKey(saidLine(text));
}

export async function keepAutomatically(db: D1Database, ids: readonly string[], actor = "auto"): Promise<{ kept: number; duplicates: number }> {
  const [approved, edited] = await Promise.all([listProposals(db, "approved", 2000), listProposals(db, "edited", 2000)]);
  const seen = new Set([...approved, ...edited].map((q) => duplicateKey(q.kind, q.proposal)));
  let kept = 0;
  let duplicates = 0;
  for (const id of ids) {
    try {
      const q = await getProposal(db, id);
      if (!q || q.status !== "pending") continue;
      const key = duplicateKey(q.kind, q.proposal);
      if (seen.has(key)) {
        await decideProposal(db, id, "reject", actor, undefined, "duplicate: the same thing is already kept");
        duplicates += 1;
        continue;
      }
      await decideProposal(db, id, "approve", actor, undefined, "kept automatically");
      seen.add(key);
      kept += 1;
    } catch (e) {
      console.warn("auto keep: one proposal skipped", errorClass(e));
    }
  }
  return { kept, duplicates };
}

// ------------------------------------------------------------------ decide / promote

function appendText(existing: unknown, addition: string, sep: string): string {
  const cur = typeof existing === "string" ? existing.trim() : "";
  if (!cur || cur.toLowerCase() === "none" || cur.toLowerCase() === "none established") return addition;
  return cur + sep + addition;
}

function titleFrom(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const t = first.trim().replace(/[.!?]+$/, "");
  return t.length > 120 ? t.slice(0, 117) + "..." : t;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// The structured fields the extractor attached (payload_json.payload, or raw.payload from
// a v2 row written before the copy at the top level existed). {} when there are none.
export function proposalPayload(p: ProposalRow): Record<string, unknown> {
  if (!p.payload_json) return {};
  let outer: unknown;
  try {
    outer = JSON.parse(p.payload_json);
  } catch {
    return {};
  }
  if (!isPlainObject(outer)) return {};
  if (isPlainObject(outer.payload)) return outer.payload;
  if (isPlainObject(outer.raw) && isPlainObject((outer.raw as Record<string, unknown>).payload)) {
    return (outer.raw as Record<string, unknown>).payload as Record<string, unknown>;
  }
  return {};
}

// The weight a proposal carried (payload_json.weight, or raw.weight), or undefined.
export function proposalWeight(p: ProposalRow): number | undefined {
  if (!p.payload_json) return undefined;
  let outer: unknown;
  try {
    outer = JSON.parse(p.payload_json);
  } catch {
    return undefined;
  }
  if (!isPlainObject(outer)) return undefined;
  const direct = parseWeight(outer.weight);
  if (direct !== undefined) return direct;
  if (isPlainObject(outer.raw)) return parseWeight((outer.raw as Record<string, unknown>).weight);
  return undefined;
}

// The message ids the proposal was extracted from (payload_json.user_message_id and
// assistant_message_id); null when the row predates the copy.
function proposalMessageIds(p: ProposalRow): { userMessageId: string | null; assistantMessageId: string | null } {
  if (!p.payload_json) return { userMessageId: null, assistantMessageId: p.message_id };
  try {
    const outer: unknown = JSON.parse(p.payload_json);
    if (!isPlainObject(outer)) return { userMessageId: null, assistantMessageId: p.message_id };
    const u = outer.user_message_id;
    const a = outer.assistant_message_id;
    return { userMessageId: typeof u === "string" ? u : null, assistantMessageId: typeof a === "string" ? a : p.message_id };
  } catch {
    return { userMessageId: null, assistantMessageId: p.message_id };
  }
}

// "opinion: <topic>", normalised, so two proposals about the same thing meet the same subject.
export function opinionSubject(payload: Record<string, unknown>, text: string): string {
  const raw = str(payload.subject, 200) ?? str(payload.topic, 200) ?? "";
  let topic = raw.toLowerCase().startsWith(OPINION_PREFIX) ? raw.slice(OPINION_PREFIX.length) : raw;
  topic = topic.trim().replace(/\s+/g, " ");
  if (!topic) topic = titleFrom(text).slice(0, 150);
  return (OPINION_PREFIX + " " + topic).slice(0, 200);
}

function sameSubject(a: string | null, b: string): boolean {
  return typeof a === "string" && normText(a) === normText(b);
}

// The life thread a "life" proposal describes: kind and title from the payload, the
// proposal text as the title when the payload has none, the detail carried as given.
function lifeInput(payload: Record<string, unknown>, text: string, source: string): Parameters<typeof createThread>[1] {
  const kindRaw = str(payload.kind, 20);
  const kind = kindRaw && (LIFE_KINDS as readonly string[]).includes(kindRaw.toLowerCase()) ? (kindRaw.toLowerCase() as LifeThread["kind"]) : "arc";
  const title = str(payload.title, 300) ?? titleFrom(text).slice(0, 300);
  const detail = str(payload.detail, 4000) ?? (title === text.trim() ? null : text.trim().slice(0, 4000));
  let scheduleJson: string | null = null;
  if (isPlainObject(payload.schedule_json)) {
    scheduleJson = JSON.stringify(payload.schedule_json).slice(0, MAX_PAYLOAD_CHARS);
  } else if (typeof payload.schedule_json === "string" && payload.schedule_json.trim()) {
    try {
      const parsed: unknown = JSON.parse(payload.schedule_json);
      if (isPlainObject(parsed)) scheduleJson = JSON.stringify(parsed).slice(0, MAX_PAYLOAD_CHARS);
    } catch { /* an unreadable schedule is no schedule */ }
  }
  return { kind, title, detail, schedule_json: scheduleJson, relation: str(payload.relation, 200), source };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
}

// mood, mood_days (v3) and cooling_off_hours from a relationship payload (SPEC_V2 section
// J, SPEC_V3 section CC). A missing field leaves the current value alone; cooling_off_hours
// 0 ends a cooling-off; a new mood gets mood_set_at from putState.
function relationshipMood(payload: Record<string, unknown>, now: Date): { mood?: string; mood_days?: number; cooling_off_until?: string | null } {
  const out: { mood?: string; mood_days?: number; cooling_off_until?: string | null } = {};
  const mood = str(payload.mood, 200);
  if (mood) out.mood = mood;
  const days = num(payload.mood_days);
  if (Number.isFinite(days)) out.mood_days = Math.min(MOOD_DAYS_MAX, Math.max(MOOD_DAYS_MIN, Math.round(days)));
  const hoursRaw = payload.cooling_off_hours;
  const hours = typeof hoursRaw === "number" ? hoursRaw : typeof hoursRaw === "string" && hoursRaw.trim() ? Number(hoursRaw) : NaN;
  if (Number.isFinite(hours)) {
    if (hours <= 0) out.cooling_off_until = null;
    else out.cooling_off_until = new Date(now.getTime() + Math.min(hours, MAX_COOLING_OFF_HOURS) * 3600_000).toISOString();
  }
  return out;
}

// The weight the proposal carried, written to the promoted row (SPEC_V3 section BB).
// Nothing is written when the element carried none: the entity's default applies by absence.
async function weighRow(db: D1Database, p: ProposalRow, entity: "fact" | "history" | "thread" | "want", id: string, actor: string): Promise<void> {
  const w = proposalWeight(p);
  if (w === undefined) return;
  try {
    await putWeight(db, entity, id, { weight: w }, actor);
  } catch (e) {
    // The row is promoted; the weight is a nicety and its default stands.
    console.warn("proposal weight not written", entity, errorClass(e));
  }
}

function sameName(a: unknown, b: string): boolean {
  return typeof a === "string" && normText(a) === normText(b);
}

// ------------------------------------------------------------------ the scene and relationship merges (v4, SPEC_V4 section 8)

// A non-empty string from a payload field, cut at max; undefined when the field is absent,
// empty or not a string (the current value then stands).
function payloadText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

const SCENE_STATUSES: readonly string[] = ["together", "apart", "none"];
const SCENE_LOCATION_MAX = 300;
const SCENE_TIME_MAX = 100;
const SCENE_PRESENT_MAX = 10;
const SCENE_PERSON_MAX = 100;
const RELATIONSHIP_FIELD_MAX = 200;
const RELATIONSHIP_TEXT_FIELDS = ["status", "trust", "affection", "attraction", "nicknames"] as const;

// The next scene state from a promoted scene proposal (pure). The previous version's fields
// are kept and the payload's status, location, time and present are TAKEN when it carries
// them: before v4 the promotion wrote summary and last_beat only, so a scene that moved
// somewhere new stayed apart at the old place (HQ CONFLICTS 33a). A status of together
// with no location keeps the previous location. An auto-kept proposal (opts.auto) never
// moves the scene INTO together: that is his picker or his own decision in the Inbox, so an
// extractor reading can never put him in the room with her (and the IN BED section, which
// runs only in a Together scene, can never switch on because a model said so).
export function mergeSceneState(cur: SceneState, payload: Record<string, unknown>, text: string, opts: { auto?: boolean } = {}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...cur, summary: text, last_beat: text };
  const p = payload && typeof payload === "object" ? payload : {};
  const status = payloadText(p.status, 20)?.toLowerCase();
  const intoTogether = status === "together" && String(cur.status ?? "").trim().toLowerCase() !== "together";
  if (status && SCENE_STATUSES.includes(status) && !(opts.auto === true && intoTogether)) next.status = status;
  const location = payloadText(p.location, SCENE_LOCATION_MAX);
  if (location) next.location = location;
  const time = payloadText(p.time, SCENE_TIME_MAX);
  if (time) next.time = time;
  if (Array.isArray(p.present)) {
    const present = p.present
      .map((x) => payloadText(x, SCENE_PERSON_MAX))
      .filter((x): x is string => typeof x === "string")
      .slice(0, SCENE_PRESENT_MAX);
    if (present.length) next.present = present;
  }
  return next;
}

// The next relationship state from a promoted relationship proposal (pure): summary and the
// frontier as before, the mood keys from the payload, and status, his_name, trust,
// affection, attraction and nicknames TAKEN when the payload carries them (his_name accepts
// null to clear it, never undefined). This is the v3.2 gap: the auto-kept relationship
// proposals only appended to the frontier, so the state still read strangers and his_name
// null after two days of talking.
export function mergeRelationshipState(cur: RelationshipState, payload: Record<string, unknown>, text: string, now: Date): Record<string, unknown> {
  const p = payload && typeof payload === "object" ? payload : {};
  const next: Record<string, unknown> = {
    ...cur,
    summary: text,
    frontier: appendText(cur.frontier, text, " | "),
    ...relationshipMood(p, now),
  };
  for (const key of RELATIONSHIP_TEXT_FIELDS) {
    const v = payloadText(p[key], RELATIONSHIP_FIELD_MAX);
    if (v) next[key] = v;
  }
  if (p.his_name === null) next.his_name = null;
  else {
    const name = payloadText(p.his_name, RELATIONSHIP_FIELD_MAX);
    if (name) next.his_name = name;
  }
  return next;
}

async function promote(db: D1Database, p: ProposalRow, kind: ProposalKind, text: string, actor: string): Promise<string> {
  const source = `proposal ${p.id}`;
  const payload = proposalPayload(p);
  switch (kind) {
    case "avelie_fact": {
      const f = await createFact(db, { scope: "avelie", fact: text, source, disclosed: true }, actor);
      await weighRow(db, p, "fact", f.id, actor);
      return f.id;
    }
    case "justin_fact": {
      const f = await createFact(db, { scope: "justin", fact: text, source, disclosed: true }, actor);
      await weighRow(db, p, "fact", f.id, actor);
      return f.id;
    }
    // v3 (CC): a goal of hers; a step or setback on one; a small thing she asked him for;
    // his answer to it. A want_update or ask_update that names no known want or ask is
    // refused with 400 validation (the proposal stays pending with the error in decision_note).
    case "want": {
      const horizon = num(payload.horizon_days);
      const w = await createWant(db, {
        title: str(payload.title, 300) ?? titleFrom(text).slice(0, 300),
        why: str(payload.why, 2000),
        stakes: str(payload.stakes, 2000),
        next_step: str(payload.next_step, 2000),
        ...(Number.isFinite(horizon) ? { horizon_days: Math.max(1, Math.round(horizon)) } : {}),
        source,
      }, actor);
      await weighRow(db, p, "want", w.id, actor);
      return w.id;
    }
    case "want_update": {
      const ref = str(payload.want, 300) ?? str(payload.title, 300);
      const want = ref ? await findWant(db, ref) : null;
      if (!want) throw new ApiHttpError(400, "validation", "want_update names no want the record knows");
      const kindRaw = str(payload.kind, 20)?.toLowerCase();
      const logKind: WantLogKind = kindRaw && (WANT_LOG_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as WantLogKind) : "note";
      const delta = num(payload.delta);
      const ids = proposalMessageIds(p);
      const r = await logWant(db, want.id, {
        kind: logKind,
        delta: Number.isFinite(delta) ? Math.max(-100, Math.min(100, Math.round(delta))) : null,
        note: str(payload.note, 2000) ?? text,
        occurred: str(payload.occurred, 100),
        source,
        messageId: ids.assistantMessageId,
      }, actor);
      return r.log.id;
    }
    case "ask": {
      const wantRef = str(payload.want, 300);
      const want = wantRef ? await findWant(db, wantRef) : null;
      const ids = proposalMessageIds(p);
      const a = await createAsk(db, {
        text: str(payload.text, 1000) ?? text,
        wantId: want ? want.id : null,
        askedMessageId: ids.assistantMessageId,
        source,
      }, actor);
      return a.id;
    }
    case "ask_update": {
      const ref = str(payload.ask, 1000) ?? str(payload.text, 1000);
      const status = str(payload.status, 20)?.toLowerCase();
      if (status !== "granted" && status !== "declined") throw new ApiHttpError(400, "validation", "ask_update status must be granted or declined");
      const ask = ref ? await findAsk(db, ref) : null;
      if (!ask || ask.status !== "open") throw new ApiHttpError(400, "validation", "ask_update names no open ask");
      const row = await updateAsk(db, ask.id, { status, note: text }, actor);
      return row.id;
    }
    // v3 (DD): what she ate, wore or ran out to do today.
    case "grounding": {
      const kindRaw = str(payload.kind, 20)?.toLowerCase();
      const gKind: GroundingKind = kindRaw && (GROUNDING_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as GroundingKind) : "misc";
      const ids = proposalMessageIds(p);
      const row = await createGroundingRow(db, {
        kind: gKind,
        note: str(payload.note, 2000) ?? text,
        occurred: str(payload.occurred, 100),
        source,
        messageId: ids.assistantMessageId,
      }, actor);
      return row.id;
    }
    // v3 (DD): news about a person, place or arc already in her life: the thread's detail
    // moves and/or a life log note lands on it. The portrait is never touched.
    case "life_update": {
      const ref = str(payload.thread, 300) ?? str(payload.title, 300);
      const active = await listThreads(db, "active");
      const thread = ref ? active.find((t) => t.id === ref) ?? active.find((t) => sameName(t.title, ref)) : undefined;
      if (!thread) throw new ApiHttpError(400, "validation", "life_update names no active thread");
      const detail = str(payload.detail, 4000);
      const note = str(payload.note, 4000) ?? (detail ? null : text);
      let headId = thread.id;
      if (detail) {
        const updated = await updateThread(db, thread.id, { detail }, actor);
        headId = updated.id;
      }
      if (note) await logLife(db, headId, nowIso(), note, source, actor);
      return headId;
    }
    case "opinion_change": {
      // One opinion per subject: a changed mind supersedes the old row (a new version in
      // the same chain) instead of sitting beside it. No match: a new opinion.
      const subject = opinionSubject(payload, text);
      const existing: FactRow | undefined = (await listFacts(db, "avelie")).find((f) => sameSubject(f.subject, subject));
      if (existing) {
        // The chain keeps the subject it was opened with; only the opinion itself moves.
        const f = await updateFact(db, existing.id, { fact: text, source, disclosed: true }, actor);
        return f.id;
      }
      const f = await createFact(db, { scope: "avelie", subject, fact: text, source, disclosed: true }, actor);
      return f.id;
    }
    case "relationship": {
      const cur = await getCurrentState<RelationshipState>(db, "relationship");
      const next = mergeRelationshipState(cur.state, payload, text, new Date());
      const r = await putState(db, "relationship", next, source, actor, "proposal");
      return `relationship:v${r.version}`;
    }
    case "life": {
      const t = await createThread(db, lifeInput(payload, text, source), actor);
      await weighRow(db, p, "thread", t.id, actor);
      return t.id;
    }
    case "private_language": {
      const cur = await getCurrentState<RelationshipState>(db, "relationship");
      const next: Record<string, unknown> = { ...cur.state, private_language: appendText(cur.state.private_language, text, "; ") };
      const r = await putState(db, "relationship", next, source, actor, "proposal");
      return `relationship:v${r.version}`;
    }
    case "scene": {
      const cur = await getCurrentState<SceneState>(db, "scene");
      const next = mergeSceneState(cur.state, payload, text, { auto: actor === "auto" });
      const r = await putState(db, "scene", next, source, actor, "proposal");
      return `scene:v${r.version}`;
    }
    case "history": {
      const h = await createHistory(db, { title: titleFrom(text), body: text, source }, actor);
      await weighRow(db, p, "history", h.id, actor);
      return h.id;
    }
    case "unknown": {
      const u = await createUnknown(db, { topic: text, note: p.evidence }, actor);
      return u.id;
    }
    default:
      throw new ApiHttpError(400, "validation", "unknown proposal kind");
  }
}

export async function decideProposal(
  db: D1Database,
  id: string,
  decision: "approve" | "reject" | "edit",
  actor: string,
  edited?: { proposal: string; kind?: ProposalKind },
  note?: string,
): Promise<{ proposal: ProposalRow; promotedId?: string }> {
  if (decision !== "approve" && decision !== "reject" && decision !== "edit") {
    throw new ApiHttpError(400, "validation", "decision must be approve, reject or edit");
  }
  const p = await getProposal(db, id);
  if (!p) throw new ApiHttpError(404, "not_found", "proposal not found");
  if (p.status !== "pending") throw new ApiHttpError(409, "already_decided", `proposal is already ${p.status}`);
  const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 1000) : null;
  const decidedAt = nowIso();

  if (decision === "reject") {
    const after: ProposalRow = { ...p, status: "rejected", decision_note: cleanNote, decided_at: decidedAt };
    await db.batch([
      db.prepare("UPDATE proposals SET status = 'rejected', decision_note = ?2, decided_at = ?3 WHERE id = ?1 AND status = 'pending'")
        .bind(p.id, cleanNote, decidedAt),
      auditStmt(db, actor, "proposal.reject", "proposal", p.id, p, after),
    ]);
    return { proposal: after };
  }

  let text = p.proposal;
  let kind: ProposalKind = p.kind;
  if (decision === "edit") {
    if (!edited || typeof edited.proposal !== "string" || !edited.proposal.trim()) {
      throw new ApiHttpError(400, "validation", "edited.proposal is required");
    }
    text = edited.proposal.trim().slice(0, MAX_PROPOSAL_CHARS);
    if (edited.kind !== undefined) {
      if (!isKind(edited.kind)) throw new ApiHttpError(400, "validation", "edited.kind is not a proposal kind");
      kind = edited.kind;
    }
  }
  if (!isKind(kind)) throw new ApiHttpError(400, "validation", "proposal kind is not promotable");

  const status: ProposalRow["status"] = decision === "edit" ? "edited" : "approved";
  let payload: Record<string, unknown> = {};
  if (p.payload_json) {
    try { payload = JSON.parse(p.payload_json) as Record<string, unknown>; } catch { payload = {}; }
  }
  if (decision === "edit") payload = { ...payload, original_proposal: p.proposal, original_kind: p.kind };
  const payloadJson = JSON.stringify(payload);

  // Take the proposal first (compare-and-set on pending), so a second approve from
  // another tab finds nothing to promote. Promotion failing hands the proposal back.
  const taken = await db
    .prepare("UPDATE proposals SET status = ?2, kind = ?3, proposal = ?4, payload_json = ?5, decision_note = ?6, decided_at = ?7 WHERE id = ?1 AND status = 'pending'")
    .bind(p.id, status, kind, text, payloadJson, cleanNote, decidedAt)
    .run();
  if (!taken.meta.changes) throw new ApiHttpError(409, "already_decided", "proposal was decided by another request");

  let promotedId: string;
  try {
    promotedId = await promote(db, p, kind, text, actor);
  } catch (e) {
    // The proposal goes back to pending; a validation error (a want_update naming no want,
    // a life_update naming no thread) is written into decision_note so the inbox shows why.
    const why = e instanceof ApiHttpError ? e.message.slice(0, 1000) : null;
    try {
      await db.prepare("UPDATE proposals SET status = 'pending', kind = ?2, proposal = ?3, payload_json = ?4, decision_note = ?6, decided_at = NULL WHERE id = ?1 AND status = ?5")
        .bind(p.id, p.kind, p.proposal, p.payload_json, status, why).run();
    } catch { /* the proposal stays decided without a promoted id; the audit shows the gap */ }
    throw e;
  }

  const after: ProposalRow = {
    ...p, kind, proposal: text, payload_json: payloadJson, status, decision_note: cleanNote, promoted_id: promotedId, decided_at: decidedAt,
  };
  await db.batch([
    db.prepare("UPDATE proposals SET promoted_id = ?2 WHERE id = ?1").bind(p.id, promotedId),
    auditStmt(db, actor, decision === "edit" ? "proposal.edit" : "proposal.approve", "proposal", p.id, p, after),
  ]);
  return { proposal: after, promotedId };
}
