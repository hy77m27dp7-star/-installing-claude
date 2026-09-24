// Memory proposals: a separate structured pass extracts candidate durable facts from one
// exchange and parks them as pending rows. Nothing here promotes on its own; the owner
// decides, and promotion goes through the state helpers so every write is audited.
import { getTextProvider, providerConfigured } from "./providers/index";
import { costMicro } from "./budget";
import { proposalSystemPrompt } from "./prompt";
import {
  auditStmt, dayKey, getCurrentState, getProposal, insertModelRunStmt, insertProposalStmt, listFacts, listProposals,
  listRecentStoryMessages, newId, nowIso, usageStmt,
} from "./db";
import { createFact, createHistory, createUnknown, putState } from "./state";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import type {
  ChatMessage, Env, MessageRow, ModelRunRow, ProposalKind, ProposalRow, RelationshipState, SceneState, Settings,
} from "./types";

export const PROPOSAL_KINDS: ProposalKind[] = [
  "avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown",
];
const CONFIDENCES = ["low", "medium", "high"] as const;
const MAX_PROPOSALS_PER_EXCHANGE = 12;
const MAX_PROPOSAL_CHARS = 1000;

export interface ParsedProposal {
  kind: ProposalKind;
  proposal: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
  scope: string;
}

function isKind(v: unknown): v is ProposalKind {
  return typeof v === "string" && (PROPOSAL_KINDS as string[]).includes(v);
}

function normText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
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
    out.push({ kind: o.kind, proposal, evidence, confidence, scope });
    if (out.length >= MAX_PROPOSALS_PER_EXCHANGE) break;
  }
  return out;
}

// ------------------------------------------------------------------ extraction

function exchangeText(rows: MessageRow[], userMessage: MessageRow, assistantMessage: MessageRow): string {
  const list = rows.slice();
  if (!list.some((m) => m.id === userMessage.id)) list.push(userMessage);
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
  return [
    `Relationship: ${rel.state.summary ?? ""}`,
    `Scene: ${scene.state.summary ?? ""}`,
    `Facts about him: ${him.length}`,
    `Facts about her: ${her.length}`,
  ].join("\n");
}

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
  userMessage: MessageRow,
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

  let text: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const result = await provider.generate(env, {
      system: proposalSystemPrompt(),
      messages,
      model,
      maxTokens: 800,
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
      payload_json: JSON.stringify({ user_message_id: userMessage.id, assistant_message_id: assistantMessage.id, raw: c }),
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
  return rows.length;
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

async function promote(db: D1Database, p: ProposalRow, kind: ProposalKind, text: string, actor: string): Promise<string> {
  const source = `proposal ${p.id}`;
  switch (kind) {
    case "avelie_fact": {
      const f = await createFact(db, { scope: "avelie", fact: text, source, disclosed: true }, actor);
      return f.id;
    }
    case "justin_fact": {
      const f = await createFact(db, { scope: "justin", fact: text, source, disclosed: true }, actor);
      return f.id;
    }
    case "opinion_change": {
      const f = await createFact(db, { scope: "avelie", subject: "opinion change", fact: text, source, disclosed: true }, actor);
      return f.id;
    }
    case "relationship": {
      const cur = await getCurrentState<RelationshipState>(db, "relationship");
      const next: Record<string, unknown> = { ...cur.state, summary: text, frontier: appendText(cur.state.frontier, text, " | ") };
      const r = await putState(db, "relationship", next, source, actor, "proposal");
      return `relationship:v${r.version}`;
    }
    case "private_language": {
      const cur = await getCurrentState<RelationshipState>(db, "relationship");
      const next: Record<string, unknown> = { ...cur.state, private_language: appendText(cur.state.private_language, text, "; ") };
      const r = await putState(db, "relationship", next, source, actor, "proposal");
      return `relationship:v${r.version}`;
    }
    case "scene": {
      const cur = await getCurrentState<SceneState>(db, "scene");
      const next: Record<string, unknown> = { ...cur.state, summary: text, last_beat: text };
      const r = await putState(db, "scene", next, source, actor, "proposal");
      return `scene:v${r.version}`;
    }
    case "history": {
      const h = await createHistory(db, { title: titleFrom(text), body: text, source }, actor);
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
    try {
      await db.prepare("UPDATE proposals SET status = 'pending', kind = ?2, proposal = ?3, payload_json = ?4, decision_note = NULL, decided_at = NULL WHERE id = ?1 AND status = ?5")
        .bind(p.id, p.kind, p.proposal, p.payload_json, status).run();
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
