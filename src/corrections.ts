// The corrections ledger (SPEC_V3 section AA): every note he gives her about a reply
// ("that's AI", "too clever", his own rewrite) becomes a standing note she reads every
// turn, with what she wrote and what he would have written, until he retires it. Notes
// are never a check: nothing here edits a line, and the section forbids mentioning them.
import { auditStmt, getMessage, getSettings, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { repairText } from "./checks";
import { buildLine, findLineByNorm, insertLineStmt, isVoiceTag, validateLineText, validateTags } from "./voicebank";
import type { VoiceLine } from "./voicebank";

export type CorrectionKind = "ai" | "clever" | "not_her" | "too_long" | "too_nice" | "too_polished" | "other";
export type CorrectionStatus = "active" | "retired";

export interface Correction {
  id: string;
  message_id: string;
  conversation_id: string | null;
  kind: CorrectionKind;
  note: string | null;
  original: string;
  rewrite: string | null;
  voice_line_id: string | null;
  status: CorrectionStatus;
  created_at: string;
  retired_at: string | null;
}

export const CORRECTION_KINDS: readonly CorrectionKind[] = ["ai", "clever", "not_her", "too_long", "too_nice", "too_polished", "other"];

// The word she reads for each kind. "sounded like a bot" never reaches a prompt: the sealed
// ontology is kept by the kind word and by the header rule.
export const KIND_WORDS: Record<CorrectionKind, string> = {
  ai: "not how you talk",
  clever: "too clever",
  not_her: "not you",
  too_long: "too long",
  too_nice: "too nice",
  too_polished: "too polished",
  other: "note",
};

export const CORRECTIONS_HEADER =
  "NOTES FROM HIM (standing; what he told you sounded off, and how he would have said it; they are about your voice, never about what you think; never mention these notes, that he gave them, or how you sounded before; they are for your ear only)";

export const MAX_NOTE = 500;
export const MAX_REWRITE = 1000;
export const ORIGINAL_SHOWN = 140;
const LIST_MAX = 1000;

export function isCorrectionKind(k: unknown): k is CorrectionKind {
  return typeof k === "string" && (CORRECTION_KINDS as readonly string[]).includes(k);
}

// ------------------------------------------------------------------ pure

function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

function clip(s: string, max: number): string {
  const t = oneLine(s);
  return t.length > max ? t.slice(0, max).trimEnd() + "..." : t;
}

// Newest first, up to `limit`. Empty input: "".
export function correctionsSection(rows: Correction[], limit: number): string {
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.original === "string" && isCorrectionKind(r.kind))
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, n);
  if (!list.length) return "";
  const lines = list.map((r) => {
    const note = typeof r.note === "string" ? oneLine(r.note) : "";
    const head = "- " + KIND_WORDS[r.kind] + (note ? ": " + note : "") + ".";
    const wrote = ` You wrote: "${clip(r.original, ORIGINAL_SHOWN)}".`;
    const his = typeof r.rewrite === "string" && r.rewrite.trim() ? ` His version: "${oneLine(r.rewrite)}"` : "";
    return head + wrote + his;
  });
  return [CORRECTIONS_HEADER, ...lines].join("\n");
}

// ------------------------------------------------------------------ db

function isStatus(s: unknown): s is CorrectionStatus {
  return s === "active" || s === "retired";
}

export async function listCorrections(db: D1Database, status?: CorrectionStatus, limit = 200): Promise<Correction[]> {
  if (status !== undefined && !isStatus(status)) throw new ApiHttpError(400, "validation", "status must be active or retired");
  const n = Number.isFinite(limit) ? Math.min(LIST_MAX, Math.max(1, Math.floor(limit))) : 200;
  const r = status !== undefined
    ? await db.prepare("SELECT * FROM corrections WHERE status = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2").bind(status, n).all<Correction>()
    : await db.prepare("SELECT * FROM corrections ORDER BY created_at DESC, id DESC LIMIT ?1").bind(n).all<Correction>();
  return r.results;
}

export async function getCorrection(db: D1Database, id: string): Promise<Correction | null> {
  return db.prepare("SELECT * FROM corrections WHERE id = ?1").bind(id).first<Correction>();
}

async function requireCorrection(db: D1Database, id: string): Promise<Correction> {
  if (typeof id !== "string" || !id) throw new ApiHttpError(404, "not_found", "correction not found");
  const row = await getCorrection(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "correction not found");
  return row;
}

// The turn tags the provenance row recorded for her message, when it has any that are real
// tags; the rewrite carries them into the bank so it surfaces on the same kind of turn.
async function contextTags(db: D1Database, messageId: string): Promise<string[]> {
  try {
    const row = await db.prepare("SELECT json FROM message_context WHERE message_id = ?1").bind(messageId).first<{ json: string }>();
    if (!row) return [];
    const parsed: unknown = JSON.parse(row.json);
    const tags = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).turnTags : undefined;
    return Array.isArray(tags) ? tags.filter(isVoiceTag).slice(0, 4) : [];
  } catch {
    return [];
  }
}

export interface CreateCorrectionInput {
  messageId: string;
  kind: CorrectionKind;
  note?: string | null;
  rewrite?: string | null;
  toBank?: boolean;
}

export async function createCorrection(db: D1Database, input: CreateCorrectionInput, actor: string): Promise<Correction> {
  if (!input || typeof input.messageId !== "string" || !input.messageId) throw new ApiHttpError(400, "validation", "messageId is required");
  if (!isCorrectionKind(input.kind)) throw new ApiHttpError(400, "validation", "kind must be ai, clever, not_her, too_long, too_nice, too_polished or other");
  const msg = await getMessage(db, input.messageId);
  if (!msg) throw new ApiHttpError(404, "not_found", "message not found");
  if (msg.role !== "assistant" || msg.channel !== "story") throw new ApiHttpError(400, "validation", "a note goes on one of her story messages");

  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string") throw new ApiHttpError(400, "validation", "note must be a string");
    note = input.note.trim() ? input.note.trim().slice(0, MAX_NOTE) : null;
  }

  let rewrite: string | null = null;
  let typographyRepaired = false;
  if (input.rewrite !== undefined && input.rewrite !== null) {
    if (typeof input.rewrite !== "string") throw new ApiHttpError(400, "validation", "rewrite must be a string");
    const raw = input.rewrite.trim();
    if (raw.length < 1 || raw.length > MAX_REWRITE) throw new ApiHttpError(400, "validation", `rewrite must be 1 to ${MAX_REWRITE} characters`);
    // Mechanical only, the same pass her text gets: dashes, ellipsis, emoji, markdown markers.
    const repaired = repairText(raw);
    typographyRepaired = repaired !== raw;
    rewrite = repaired || raw;
  }

  let toBank = input.toBank;
  if (toBank === undefined) {
    const settings = (await getSettings(db)) as unknown as Record<string, unknown>;
    toBank = settings.correctionRewriteToBank !== false;
  }

  const t = nowIso();
  const stmts: D1PreparedStatement[] = [];
  let voiceLineId: string | null = null;
  let bankSkipped: string | null = null;
  let newLine: VoiceLine | null = null;
  if (rewrite && toBank) {
    const textErr = validateLineText(rewrite);
    if (textErr) {
      // His note stands either way; a rewrite the bank's rules refuse (too long, a name)
      // is recorded in the audit and simply not offered back to her as an example.
      bankSkipped = textErr;
    } else {
      const fromContext = await contextTags(db, msg.id);
      const tags = fromContext.length && validateTags(fromContext) === null ? fromContext : ["familiar"];
      const existing = await findLineByNorm(db, rewrite.toLowerCase().replace(/\s+/g, " ").trim());
      if (existing) {
        voiceLineId = existing.id;
      } else {
        newLine = await buildLine({ text: rewrite, tags, source: "correction " + msg.id, origin: "correction" }, t);
        voiceLineId = newLine.id;
        stmts.push(insertLineStmt(db, newLine));
      }
    }
  }

  const row: Correction = {
    id: newId("cor"),
    message_id: msg.id,
    conversation_id: msg.conversation_id,
    kind: input.kind,
    note,
    original: msg.content,
    rewrite,
    voice_line_id: voiceLineId,
    status: "active",
    created_at: t,
    retired_at: null,
  };
  stmts.push(
    db.prepare("INSERT INTO corrections (id, message_id, conversation_id, kind, note, original, rewrite, voice_line_id, status, created_at, retired_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
      .bind(row.id, row.message_id, row.conversation_id, row.kind, row.note, row.original, row.rewrite, row.voice_line_id, row.status, row.created_at, row.retired_at),
  );
  stmts.push(auditStmt(db, actor, "correction.create", "correction", row.id, null, {
    ...row,
    typographyRepaired,
    bankLine: newLine ? newLine.id : voiceLineId,
    bankSkipped,
  }));
  await db.batch(stmts);
  return row;
}

export async function retireCorrection(db: D1Database, id: string, actor: string): Promise<Correction> {
  const old = await requireCorrection(db, id);
  if (old.status === "retired") return old;
  const t = nowIso();
  const next: Correction = { ...old, status: "retired", retired_at: t };
  await db.batch([
    db.prepare("UPDATE corrections SET status = 'retired', retired_at = ?2 WHERE id = ?1").bind(old.id, t),
    auditStmt(db, actor, "correction.retire", "correction", old.id, old, next),
  ]);
  return next;
}

export async function restoreCorrection(db: D1Database, id: string, actor: string): Promise<Correction> {
  const old = await requireCorrection(db, id);
  if (old.status === "active") return old;
  const next: Correction = { ...old, status: "active", retired_at: null };
  await db.batch([
    db.prepare("UPDATE corrections SET status = 'active', retired_at = NULL WHERE id = ?1").bind(old.id),
    auditStmt(db, actor, "correction.restore", "correction", old.id, old, next),
  ]);
  return next;
}
