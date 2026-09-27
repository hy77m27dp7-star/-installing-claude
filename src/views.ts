// v5 (SPEC_V5 section 3): her read of him. A read is built from what he has actually done with
// her ("you dodge when i ask about your family", "you asked before you kissed me"), carries the
// messages that show it and how sure she is, and colours how she takes him without ever being
// recited. The nightly `views` step files every change as a `her_view` proposal; nothing a model
// says becomes a read until the existing machinery keeps it (his Inbox, or his auto-keep switch).
// Reads are versioned: a surer or less sure read is a new row superseding the old one, and a read
// he proves wrong stays on the record as proven wrong. He sees every read and its evidence on the
// Memory page and can mark one not true.
import { auditStmt, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { safeTimezone } from "./life";
import { herDayKey } from "./clock";
import { cleanLine, fileNightlyProposals, paidJsonCall, parseJsonArray } from "./storycall";
import type { NightlyBudget, NightlyProposal, StepResult } from "./storycall";
import { saidLine } from "./said";
import type { Env, ProviderName, Settings } from "./types";

export const VIEWS_PREFIX = "Read the record for how Avelie";
export type ViewOp = "new" | "confirm" | "weaken" | "wrong";
export const VIEW_OPS: readonly ViewOp[] = ["new", "confirm", "weaken", "wrong"];
export const VIEW_CONFIDENCE_MIN = 0.05;
export const VIEW_CONFIDENCE_MAX = 0.95;
export const VIEW_EVIDENCE_MAX = 20;
export const VIEW_RETIRE_BELOW = 0.2;

// The her_views columns (migration 0009_v5.sql).
export interface HerViewRow {
  id: string;
  subject: string;
  subject_norm: string;
  view: string;
  confidence: number;
  evidence_json: string;
  status: "active" | "superseded" | "proven_wrong" | "retired";
  version: number;
  supersedes_id: string | null;
  source: string | null;
  wrong_note: string | null;
  wrong_evidence_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ViewOpParsed {
  op: ViewOp;
  viewId: string | null;
  subject: string;
  view: string;
  confidence: number;
  evidence: string[];
}

const WEAKEN_STEP = 0.15;
const SUBJECT_MIN = 2;
const SUBJECT_MAX = 60;
const SUBJECT_NORM_MAX = 80;
const VIEW_MAX = 200;
const OP_EVIDENCE_MAX = 10;
const MESSAGE_CHARS = 280;
const PASS_MESSAGES_MAX = 80;
const PASS_MESSAGES_MIN = 4;
const PASS_READS_MAX = 30;
const PASS_FALLBACK_MS = 24 * 60 * 60 * 1000;
const WRONG_SHOWN_MAX = 2;
const RETIRED_SHOWN_MAX = 20;

// A read about his body, his age, his work or money, a diagnosis, or built from his absence or
// his reply times is never hers to hold (the last group is a guilt read: skeptic 12). "answer" is
// deliberately not in it: "you answer fast when it matters" is about how he talks with her.
// Review fix: the frequency and waiting reads too ("you never text first", "you go quiet for
// days", "you leave me hanging", "you make me wait").
const VIEW_DROP_RE = /\b(?:body|fat|thin|skinny|weight|age|older|younger|ugly|handsome|bald|job|money|salary|diagnos\w*|narciss\w*|trauma\w*|toxic|red flag|away|disappear\w*|vanish\w*|ghost\w*|busy|repl(?:y|ies|ied)|texts? back|texted back|writes? back|wrote back|take forever|takes forever|texts? first|text(?:ed|ing) first|writes? first|go(?:es)? quiet|went quiet|going quiet|silent|silence|for days|days without|hanging|make me wait|made me wait|makes me wait|keep me waiting|kept me waiting|waiting|leave me|leaves me|left me)\b/i;

// ------------------------------------------------------------------ pure helpers

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clampConfidence(n: number): number {
  return clamp(Number.isFinite(n) ? n : 0.5, VIEW_CONFIDENCE_MIN, VIEW_CONFIDENCE_MAX);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim().replace(/^\[+|\]+$/g, "").trim();
    if (!t || t.length > 100 || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function parseEvidence(json: string | null | undefined): string[] {
  if (typeof json !== "string" || !json) return [];
  try {
    return stringList(JSON.parse(json), 1000);
  } catch {
    return [];
  }
}

// Lowercase, every run of characters that are not letters or digits to one space, trimmed, at most 80.
export function subjectNorm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, SUBJECT_NORM_MAX).trim();
}

export function confidenceWords(c: number): string {
  const n = typeof c === "number" && Number.isFinite(c) ? c : 0;
  if (n < 0.5) return "a hunch";
  if (n < 0.75) return "fairly sure";
  return "sure";
}

// One line of a read as she holds it: plain typography, no closing full stop.
function readLine(view: string): string {
  return saidLine(view, VIEW_MAX).replace(/[.!]+$/, "").trim();
}

export function viewsSection(views: HerViewRow[], wrong: HerViewRow[], opts: { limit: number; minConfidence: number }): string {
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
  if (limit <= 0) return "";
  const min = typeof opts?.minConfidence === "number" && Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0;
  const active = (Array.isArray(views) ? views : [])
    .filter((v) => !!v && v.status === "active" && typeof v.view === "string" && Number(v.confidence) >= min)
    .slice()
    .sort((a, b) => Number(b.confidence) - Number(a.confidence) || String(b.updated_at).localeCompare(String(a.updated_at)) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((v) => ({ line: readLine(v.view), c: Number(v.confidence) }))
    .filter((x) => x.line);
  const proven = (Array.isArray(wrong) ? wrong : [])
    .filter((v) => !!v && v.status === "proven_wrong" && typeof v.view === "string")
    .slice(0, WRONG_SHOWN_MAX)
    .map((v) => readLine(v.view))
    .filter(Boolean);
  if (!active.length && !proven.length) return "";
  const lines = [
    "HOW YOU READ HIM (your own read, from what he has actually done with you; it colours how you take him; never recite it, never list it, never announce it as a verdict; he can change your mind by what he does)",
  ];
  for (const a of active) lines.push(`- ${a.line} (${confidenceWords(a.c)})`);
  for (const p of proven) lines.push(`- you used to think ${p}; he proved you wrong`);
  return lines.join("\n");
}

export function viewsSystem(max: number): string {
  const m = typeof max === "number" && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  return `Read the record for how Avelie, a 22-year-old woman, reads the man she is talking to. You are not her and you write no dialogue. From the messages below and her current reads of him, output strictly a JSON array (no prose, no fences) of at most ${m} changes. Each: {"op": "new"|"confirm"|"weaken"|"wrong", "view_id": the id in brackets of an existing read for confirm, weaken or wrong, omitted for new, "subject": two to five words naming the pattern, "view": her read in her own plain words, second person, one line ("you dodge when i ask about your family", "you asked before you kissed me"), "confidence": 0 to 1, "evidence": the ids in brackets of the messages that show it}. A read is about what he does with her: how he talks, listens, answers, shows up, keeps or breaks his word, treats her. Never about his body, his age, his work or anything these messages do not show. Never about how often, how fast or when he writes, never about him being away, busy or gone for a while: time apart is not something he does to her. Never a diagnosis, never therapy words, never a list of flaws. "new" needs two messages as evidence unless one is unmistakable. "wrong" is only when these messages plainly prove an existing read wrong. If nothing changed, output [].`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function viewsUser(views: HerViewRow[], messages: Array<{ id: string; role: string; content: string }>, retired: HerViewRow[] = []): string {
  const reads = (Array.isArray(views) ? views : [])
    .filter((v) => !!v && typeof v.id === "string")
    .map((v) => `- [${v.id}] ${saidLine(v.view, VIEW_MAX)} (confidence ${round2(Number(v.confidence) || 0)})`);
  const msgs = (Array.isArray(messages) ? messages : [])
    .filter((m) => !!m && typeof m.id === "string" && typeof m.content === "string")
    .map((m) => `- [${m.id}] ${m.role === "user" ? "him" : "her"}: ${saidLine(m.content, MESSAGE_CHARS)}`);
  // Review fix: the reads he said are not true (and the ones that faded out) are shown so a
  // night never brings one back as a new read.
  const gone = (Array.isArray(retired) ? retired : [])
    .filter((v) => !!v && typeof v.view === "string" && v.view.trim())
    .map((v) => `- ${saidLine(v.view, VIEW_MAX)}`);
  const out = ["CURRENT READS:", ...(reads.length ? reads : ["(none)"])];
  if (gone.length) out.push("", "NOT TRUE (he said so, or it faded; never bring one back as a new read):", ...gone);
  out.push("", "MESSAGES:", ...(msgs.length ? msgs : ["(none)"]));
  return out.join("\n");
}

export function parseViewOps(
  text: string,
  known: ReadonlyMap<string, HerViewRow>,
  messageIds: ReadonlySet<string>,
  max: number,
  blocked: ReadonlySet<string> = new Set(),
): ViewOpParsed[] {
  const cap = typeof max === "number" && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (cap <= 0) return [];
  const out: ViewOpParsed[] = [];
  for (const raw of parseJsonArray(text)) {
    if (out.length >= cap) break;
    if (!isPlainObject(raw)) continue;
    const op = raw.op;
    if (typeof op !== "string" || !(VIEW_OPS as readonly string[]).includes(op)) continue;
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? clamp(raw.confidence, 0, 1) : 0.5;
    const evidence = stringList(raw.evidence, 1000).filter((id) => messageIds.has(id)).slice(0, OP_EVIDENCE_MAX);
    const subjectRaw = typeof raw.subject === "string" ? saidLine(raw.subject, 200).trim() : "";
    const subjectOk = subjectRaw.length >= SUBJECT_MIN && subjectRaw.length <= SUBJECT_MAX;
    let viewId: string | null = null;
    let base: HerViewRow | undefined;
    if (op !== "new") {
      const id = typeof raw.view_id === "string" ? raw.view_id.trim().replace(/^\[+|\]+$/g, "").trim() : "";
      base = id ? known.get(id) : undefined;
      if (!base) continue;
      viewId = base.id;
    } else {
      if (!subjectOk) continue;
      if (evidence.length < (confidence >= 0.8 ? 1 : 2)) continue;
      // Review fix: a read he said is not true never comes back as a new one (by its subject
      // or its words).
      if (blocked.size && (blocked.has(subjectNorm(subjectRaw)) || blocked.has(subjectNorm(typeof raw.view === "string" ? raw.view : "")))) continue;
    }
    let view = cleanLine(raw.view, VIEW_MAX);
    if (!view && base) view = cleanLine(base.view, VIEW_MAX);
    if (!view) continue;
    if (VIEW_DROP_RE.test(view)) continue;
    const subject = subjectOk ? subjectRaw : base ? base.subject : "";
    if (!subject) continue;
    out.push({ op: op as ViewOp, viewId, subject, view, confidence, evidence });
  }
  return out;
}

// Fix 2026-09-27 (the rerun duplicates): what a night files is settled against the reads she
// already holds, so a forced rerun over the same window files nothing and a read is never
// minted twice. Live case: "you asked before you kissed me" was confirmed three times in one
// night from the SAME two messages, each rerun raising the confidence and writing a version,
// the third leaving a second active row with the same subject.
//   - confirm or weaken: dropped when every evidence id is already in the read's evidence
//     (nothing new was seen; no evidence at all is nothing new either);
//   - new: when its subject or its words (subjectNorm) match an active read's subject_norm or
//     words, dropped unless it brings evidence the read lacks, and then it becomes a confirm
//     of that read (her existing words kept);
//   - one op per read, and one new per subject: a later op on the same read (or a second new
//     of the same subject) folds its evidence into the first when it is the same op, and is
//     dropped when it is another.
export function settleViewOps(ops: ViewOpParsed[], reads: HerViewRow[]): ViewOpParsed[] {
  const active = (Array.isArray(reads) ? reads : []).filter((r) => !!r && typeof r.id === "string" && r.status === "active");
  const byId = new Map(active.map((r) => [r.id, r] as const));
  const had = new Map(active.map((r) => [r.id, new Set(parseEvidence(r.evidence_json))] as const));
  const readKeys = (r: HerViewRow): string[] => [r.subject_norm || subjectNorm(r.subject), subjectNorm(r.view)].filter(Boolean);
  const opKeys = (o: ViewOpParsed): string[] => [subjectNorm(o.subject), subjectNorm(o.view)].filter(Boolean);
  const out: ViewOpParsed[] = [];
  const onRead = new Map<string, ViewOpParsed>();
  const fold = (into: ViewOpParsed, from: ViewOpParsed): void => {
    for (const id of from.evidence) if (!into.evidence.includes(id) && into.evidence.length < OP_EVIDENCE_MAX) into.evidence.push(id);
    into.confidence = into.op === "weaken" ? Math.min(into.confidence, from.confidence) : Math.max(into.confidence, from.confidence);
  };
  const place = (o: ViewOpParsed): void => {
    const vid = o.viewId;
    if (!vid) {
      out.push(o);
      return;
    }
    const first = onRead.get(vid);
    if (!first) {
      onRead.set(vid, o);
      out.push(o);
      return;
    }
    if (first.op === o.op && o.op !== "wrong") fold(first, o);
  };
  for (const raw of Array.isArray(ops) ? ops : []) {
    if (!raw) continue;
    const o: ViewOpParsed = { ...raw, evidence: Array.isArray(raw.evidence) ? raw.evidence.slice() : [] };
    if (o.op === "confirm" || o.op === "weaken") {
      const seen = o.viewId ? had.get(o.viewId) : undefined;
      if (seen && !o.evidence.some((id) => !seen.has(id))) continue;
      place(o);
      continue;
    }
    if (o.op === "new") {
      const keys = opKeys(o);
      const match = active.find((r) => readKeys(r).some((k) => keys.includes(k)));
      if (match) {
        const seen = had.get(match.id) ?? new Set<string>();
        if (!o.evidence.some((id) => !seen.has(id))) continue;
        place({ op: "confirm", viewId: match.id, subject: match.subject, view: cleanLine(match.view, VIEW_MAX) || o.view, confidence: o.confidence, evidence: o.evidence });
        continue;
      }
      const twin = out.find((x) => x.op === "new" && opKeys(x).some((k) => keys.includes(k)));
      if (twin) {
        fold(twin, o);
        continue;
      }
      out.push(o);
      continue;
    }
    place(o);
  }
  return out;
}

// ------------------------------------------------------------------ the store

const STATUSES = ["active", "proven_wrong", "all"] as const;

export async function listViews(db: D1Database, status: "active" | "proven_wrong" | "all" = "active", limit = 50): Promise<HerViewRow[]> {
  if (!(STATUSES as readonly string[]).includes(status)) throw new ApiHttpError(400, "validation", "status must be active, proven_wrong or all");
  const n = typeof limit === "number" && Number.isFinite(limit) ? clamp(Math.floor(limit), 1, 500) : 50;
  const r = status === "active"
    ? await db.prepare("SELECT * FROM her_views WHERE status = 'active' ORDER BY confidence DESC, updated_at DESC, id LIMIT ?1").bind(n).all<HerViewRow>()
    : status === "proven_wrong"
      ? await db.prepare("SELECT * FROM her_views WHERE status = 'proven_wrong' ORDER BY updated_at DESC, id LIMIT ?1").bind(n).all<HerViewRow>()
      // Review fix: "all" is every read she holds or held, never the superseded versions
      // behind them (a busy month of confirms would push a quiet active read off the page).
      : await db.prepare("SELECT * FROM her_views WHERE status != 'superseded' ORDER BY updated_at DESC, id LIMIT ?1").bind(n).all<HerViewRow>();
  return (r.results ?? []).filter((v) => !!v && typeof v.id === "string");
}

export async function recentWrongViews(db: D1Database, sinceIso: string, limit = 2): Promise<HerViewRow[]> {
  const n = typeof limit === "number" && Number.isFinite(limit) ? clamp(Math.floor(limit), 1, 50) : 2;
  const r = await db.prepare("SELECT * FROM her_views WHERE status = 'proven_wrong' AND updated_at >= ?1 ORDER BY updated_at DESC, id LIMIT ?2").bind(String(sinceIso ?? ""), n).all<HerViewRow>();
  return (r.results ?? []).filter((v) => !!v && typeof v.id === "string");
}

async function getView(db: D1Database, id: string): Promise<HerViewRow | null> {
  return db.prepare("SELECT * FROM her_views WHERE id = ?1").bind(id).first<HerViewRow>();
}

function insertViewStmt(db: D1Database, v: HerViewRow): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO her_views (id, subject, subject_norm, view, confidence, evidence_json, status, version, supersedes_id, source, wrong_note, wrong_evidence_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
  ).bind(v.id, v.subject, v.subject_norm, v.view, v.confidence, v.evidence_json, v.status, v.version, v.supersedes_id, v.source, v.wrong_note, v.wrong_evidence_json, v.created_at, v.updated_at);
}

function payloadText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = saidLine(v, max).trim();
  return t ? t : null;
}

function payloadNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// A new version of a read: the old one superseded, the new one inserted with version + 1.
async function supersedeView(
  db: D1Database,
  old: HerViewRow,
  next: { view: string; confidence: number; evidence: string[]; status: "active" | "retired" },
  source: string,
  actor: string,
  action: "view.confirm" | "view.weaken",
): Promise<string> {
  const t = nowIso();
  const row: HerViewRow = {
    ...old,
    id: newId("hv"),
    view: next.view,
    confidence: next.confidence,
    evidence_json: JSON.stringify(next.evidence),
    status: next.status,
    version: (Number(old.version) || 1) + 1,
    supersedes_id: old.id,
    source: source ? source.slice(0, 500) : old.source,
    wrong_note: null,
    wrong_evidence_json: null,
    created_at: t,
    updated_at: t,
  };
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE her_views SET status = 'superseded', updated_at = ?2 WHERE id = ?1 AND status = 'active'").bind(old.id, t),
  ];
  if (row.status === "active") stmts.push(supersedeSubjectStmt(db, row.subject_norm, row.id, t));
  stmts.push(insertViewStmt(db, row), auditStmt(db, actor, action, "her_view", row.id, old, row));
  await db.batch(stmts);
  return row.id;
}

// Fix 2026-09-27: whenever a new active row is written for a subject, every OTHER active row of
// that subject is superseded in the same batch, so two active reads of one subject can never
// exist (two confirms of one read racing each other both read it active; the second used to
// leave a second active row behind).
function supersedeSubjectStmt(db: D1Database, norm: string, keepId: string, t: string): D1PreparedStatement {
  return db.prepare("UPDATE her_views SET status = 'superseded', updated_at = ?2 WHERE status = 'active' AND subject_norm = ?1 AND id != ?3").bind(norm, t, keepId);
}

async function requireActive(db: D1Database, id: unknown): Promise<HerViewRow> {
  const vid = typeof id === "string" ? id.trim() : "";
  const row = vid ? await getView(db, vid) : null;
  if (!row || row.status !== "active") throw new ApiHttpError(400, "validation", "view_id must name an active read");
  return row;
}

async function confirmView(db: D1Database, old: HerViewRow, payload: Record<string, unknown>, source: string, actor: string): Promise<string> {
  const view = payloadText(payload.view, VIEW_MAX) ?? old.view;
  const had = parseEvidence(old.evidence_json);
  const incoming = stringList(payload.evidence, 1000);
  // Fix 2026-09-27: a confirm that saw nothing new (no evidence the read lacks) and keeps her
  // words is the read she already holds: its id, no version written, no confidence raised.
  if (!incoming.some((id) => !had.includes(id)) && view.trim() === String(old.view ?? "").trim()) return old.id;
  const c = payloadNumber(payload.confidence);
  const confidence = clampConfidence(Math.max(Number(old.confidence) || 0, c ?? 0));
  const union: string[] = [];
  for (const id of [...had, ...incoming]) if (!union.includes(id)) union.push(id);
  return supersedeView(db, old, { view, confidence, evidence: union.slice(-VIEW_EVIDENCE_MAX), status: "active" }, source, actor, "view.confirm");
}

export async function applyViewProposal(db: D1Database, payload: Record<string, unknown>, source: string, actor: string): Promise<string> {
  if (!isPlainObject(payload)) throw new ApiHttpError(400, "validation", "payload must be an object");
  const op = payload.op;
  if (typeof op !== "string" || !(VIEW_OPS as readonly string[]).includes(op)) throw new ApiHttpError(400, "validation", "op must be new, confirm, weaken or wrong");
  const src = typeof source === "string" ? source : "";
  if (op === "new") {
    const subject = payloadText(payload.subject, SUBJECT_MAX);
    const view = payloadText(payload.view, VIEW_MAX);
    if (!subject || subject.length < SUBJECT_MIN) throw new ApiHttpError(400, "validation", "subject is required");
    if (!view) throw new ApiHttpError(400, "validation", "view is required");
    const norm = subjectNorm(subject);
    if (!norm) throw new ApiHttpError(400, "validation", "subject is required");
    const same = await db.prepare("SELECT * FROM her_views WHERE status = 'active' AND subject_norm = ?1 ORDER BY updated_at DESC LIMIT 1").bind(norm).first<HerViewRow>();
    if (same) return confirmView(db, same, payload, src, actor);
    const t = nowIso();
    const row: HerViewRow = {
      id: newId("hv"),
      subject,
      subject_norm: norm,
      view,
      confidence: clampConfidence(payloadNumber(payload.confidence) ?? 0.5),
      evidence_json: JSON.stringify(stringList(payload.evidence, VIEW_EVIDENCE_MAX)),
      status: "active",
      version: 1,
      supersedes_id: null,
      source: src ? src.slice(0, 500) : null,
      wrong_note: null,
      wrong_evidence_json: null,
      created_at: t,
      updated_at: t,
    };
    await db.batch([supersedeSubjectStmt(db, norm, row.id, t), insertViewStmt(db, row), auditStmt(db, actor, "view.create", "her_view", row.id, null, row)]);
    return row.id;
  }
  if (op === "confirm") {
    const old = await requireActive(db, payload.view_id);
    return confirmView(db, old, payload, src, actor);
  }
  if (op === "weaken") {
    const old = await requireActive(db, payload.view_id);
    const prev = Number(old.confidence) || 0;
    const c = payloadNumber(payload.confidence);
    const confidence = clampConfidence(Math.min(prev - WEAKEN_STEP, c ?? prev - WEAKEN_STEP));
    const view = payloadText(payload.view, VIEW_MAX) ?? old.view;
    const union: string[] = [];
    for (const id of [...parseEvidence(old.evidence_json), ...stringList(payload.evidence, 1000)]) if (!union.includes(id)) union.push(id);
    return supersedeView(
      db,
      old,
      { view, confidence, evidence: union.slice(-VIEW_EVIDENCE_MAX), status: confidence < VIEW_RETIRE_BELOW ? "retired" : "active" },
      src,
      actor,
      "view.weaken",
    );
  }
  // wrong: the read stays on the record, marked proven wrong. A read that is no longer active
  // answers 409 not_active, so the proposal stays pending with the reason.
  const vid = typeof payload.view_id === "string" ? payload.view_id.trim() : "";
  if (!vid) throw new ApiHttpError(400, "validation", "view_id is required");
  const old = await getView(db, vid);
  if (!old) throw new ApiHttpError(400, "validation", "view_id must name a read");
  const t = nowIso();
  const note = payloadText(payload.note, 500) ?? payloadText(payload.view, VIEW_MAX);
  const evidence = JSON.stringify(stringList(payload.evidence, VIEW_EVIDENCE_MAX));
  const res = await db.prepare("UPDATE her_views SET status = 'proven_wrong', wrong_note = ?2, wrong_evidence_json = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'active'")
    .bind(vid, note, evidence, t).run();
  if (!res || !res.meta || !(Number(res.meta.changes) > 0)) throw new ApiHttpError(409, "not_active", "that read is no longer active");
  const after: HerViewRow = { ...old, status: "proven_wrong", wrong_note: note, wrong_evidence_json: evidence, updated_at: t };
  await auditStmt(db, actor, "view.wrong", "her_view", vid, old, after).run();
  return vid;
}

// He marks a read not true. A superseded version is not the read any more (409 not_current);
// a read already retired answers as it is.
export async function retireView(db: D1Database, id: string, note: string | null, actor: string): Promise<HerViewRow> {
  const vid = typeof id === "string" ? id.trim() : "";
  const old = vid ? await getView(db, vid) : null;
  if (!old) throw new ApiHttpError(404, "not_found", "read not found");
  if (old.status === "retired") return old;
  if (old.status === "superseded") throw new ApiHttpError(409, "not_current", "only the current version of a read can be retired");
  const t = nowIso();
  const n = typeof note === "string" && note.trim() ? saidLine(note, 500) : null;
  const row: HerViewRow = { ...old, status: "retired", wrong_note: n, updated_at: t };
  await db.batch([
    db.prepare("UPDATE her_views SET status = 'retired', wrong_note = ?2, updated_at = ?3 WHERE id = ?1").bind(vid, n, t),
    auditStmt(db, actor, "view.retire", "her_view", vid, old, row),
  ]);
  return row;
}

// ------------------------------------------------------------------ the nightly step

type ViewSettings = Settings & { nightlyProvider?: ProviderName; nightlyModel?: string; viewsPerNight?: number };

function intSetting(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? clamp(Math.floor(v), lo, hi) : fallback;
}

interface PassMessage { id: string; role: string; content: string; created_at: string }

export async function runViewPass(env: Env, db: D1Database, settings: Settings, budget: NightlyBudget, now: Date): Promise<StepResult> {
  const s = settings as ViewSettings;
  const tz = safeTimezone(typeof s.timezone === "string" ? s.timezone : "UTC");
  const day = herDayKey(now, tz);
  const perNight = intSetting(s.viewsPerNight, 3, 0, 6);
  if (perNight <= 0) return { step: "views", status: "skipped", reason: "off", proposalIds: [] };
  const nowIsoStr = now.toISOString();

  // The window: after the last views run marked done on another day (a forced rerun of the same
  // day reads the same window again), or the last 24 hours when there is none.
  let since = new Date(now.getTime() - PASS_FALLBACK_MS).toISOString();
  try {
    const last = await db.prepare("SELECT ran_at FROM nightly_runs WHERE step = 'views' AND status = 'done' AND day != ?1 ORDER BY ran_at DESC LIMIT 1").bind(day).first<{ ran_at: string }>();
    if (last && typeof last.ran_at === "string" && Number.isFinite(Date.parse(last.ran_at))) since = last.ran_at;
  } catch {
    // a database behind 0009: the 24-hour window
  }
  const r = await db.prepare(
    "SELECT id, role, content, created_at FROM messages WHERE channel = 'story' AND role IN ('user', 'assistant') AND created_at > ?1 AND created_at <= ?2 AND (deliver_at IS NULL OR deliver_at <= ?2) ORDER BY created_at DESC LIMIT ?3",
  ).bind(since, nowIsoStr, PASS_MESSAGES_MAX).all<PassMessage>();
  const messages = (r.results ?? []).filter((m) => !!m && typeof m.id === "string" && typeof m.content === "string").reverse();
  if (messages.length < PASS_MESSAGES_MIN) {
    return { step: "views", status: "skipped", reason: "not enough happened", proposalIds: [], detail: { messages: messages.length } };
  }
  const reads = await listViews(db, "active", PASS_READS_MAX);
  const known = new Map(reads.map((v) => [v.id, v] as const));
  const messageIds = new Set(messages.map((m) => m.id));
  let retired: HerViewRow[] = [];
  try {
    const rr = await db.prepare("SELECT * FROM her_views WHERE status = 'retired' ORDER BY updated_at DESC, id LIMIT ?1").bind(RETIRED_SHOWN_MAX).all<HerViewRow>();
    retired = (rr.results ?? []).filter((v) => !!v && typeof v.id === "string");
  } catch {
    retired = [];
  }
  const blocked = new Set<string>();
  for (const v of retired) {
    if (v.subject_norm) blocked.add(v.subject_norm);
    const n = subjectNorm(v.view ?? "");
    if (n) blocked.add(n);
  }

  const call = await paidJsonCall(env, db, settings, budget, {
    tag: "views",
    provider: (s.nightlyProvider ?? "anthropic") as ProviderName,
    model: typeof s.nightlyModel === "string" && s.nightlyModel ? s.nightlyModel : "claude-sonnet-5",
    system: viewsSystem(perNight),
    user: viewsUser(reads, messages, retired),
    maxTokens: 700,
    temperature: 0.3,
  });
  if (!call.ok) {
    const stopped = call.reason === "nightly budget" || call.reason === "caps";
    return { step: "views", status: stopped ? "skipped" : "failed", reason: call.reason, proposalIds: [], detail: { messages: messages.length } };
  }
  const parsed = parseViewOps(call.text, known, messageIds, perNight, blocked);
  const ops = settleViewOps(parsed, reads);
  const rows: NightlyProposal[] = ops.map((o) => {
    const oldView = o.viewId ? known.get(o.viewId)?.view ?? o.view : o.view;
    const text = o.op === "new"
      ? `her read (${day}): ${o.view}`
      : o.op === "confirm"
        ? `her read, surer (${day}): ${o.view}`
        : o.op === "weaken"
          ? `her read, less sure (${day}): ${o.view}`
          : `her read proven wrong (${day}): ${saidLine(oldView, VIEW_MAX)}`;
    return {
      kind: "her_view",
      proposal: text,
      evidence: `nightly views ${day}`,
      confidence: "medium",
      payload: { op: o.op, view_id: o.viewId, subject: o.subject, view: o.view, confidence: o.confidence, evidence: o.evidence },
      weight: 0.5,
      source: `nightly views ${day} ${call.runId}`,
    };
  });
  const filed = rows.length ? await fileNightlyProposals(db, rows) : [];
  const proposalIds = filed.filter((x): x is string => typeof x === "string");
  return {
    step: "views",
    status: "done",
    reason: ops.length ? `${proposalIds.length} filed` : "nothing changed",
    proposalIds,
    detail: { messages: messages.length, reads: reads.length, ops: ops.length, settled: parsed.length - ops.length, filed: proposalIds.length },
  };
}
