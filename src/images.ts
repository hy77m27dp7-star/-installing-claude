// Photos: marker parsing, candidate generation into R2, approve/reject, serving, and
// master verification. A candidate is never canon; the owner decides. Rejected hashes
// stay on file so the same picture can never come back.
import { auditStmt, dayKey, getAsset, insertAssetStmt, insertModelRunStmt, newId, nowIso, sha256Hex, usageStmt } from "./db";
import { ApiHttpError, json } from "./errors";
import { imageIdentityPrompt } from "./prompt";
import { assertBudget } from "./budget";
import { getImageProvider, imageProviderConfigured } from "./providers";
import { safeErrorMessage } from "./providers/types";
import { ProviderError } from "./types";
import type { Env, ModelRunRow, Settings, VisualAssetRow } from "./types";

const MARKER_LINE = /^\[photo:\s*(.+)\]\s*$/i;
const CANDIDATE_PREFIX = "candidates/";
const ASSETS_ORIGIN = "https://assets.local/";
const MICRO = 1_000_000;

// ------------------------------------------------------------------ marker

// The photo marker is the final non-blank line, "[photo: ...]". It is removed from the
// text. Any other marker line is dropped and ignored: one photo per message at most.
export function parsePhotoMarker(text: string): { clean: string; description: string | null } {
  const lines = text.split(/\r?\n/);
  let description: string | null = null;

  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") last--;
  if (last >= 0) {
    const m = MARKER_LINE.exec((lines[last] ?? "").trim());
    if (m) {
      const d = (m[1] ?? "").trim();
      description = d.length ? d : null;
      lines.splice(last, 1);
    }
  }

  const kept = lines.filter((l) => !MARKER_LINE.test(l.trim()));
  const clean = kept.join("\n").trimEnd();
  return { clean, description };
}

// ------------------------------------------------------------------ helpers

function assetUrl(file: string): string {
  const path = file.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return ASSETS_ORIGIN + path;
}

function basename(file: string): string {
  const parts = file.split("/");
  return parts[parts.length - 1] ?? file;
}

function errorKind(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof ApiHttpError) return e.code;
  return "other";
}

// Everything that leaves generateCandidate is an ApiHttpError so the router renders it.
function toApiError(e: unknown): ApiHttpError {
  if (e instanceof ApiHttpError) return e;
  if (e instanceof ProviderError) {
    const message = safeErrorMessage(e);
    if (e.kind === "config") return new ApiHttpError(503, "provider_not_configured", message, false, e.provider);
    return new ApiHttpError(502, "provider_failed", message, e.retryable, e.kind);
  }
  return new ApiHttpError(500, "image_failed", safeErrorMessage(e), false);
}

function notFound(): Response {
  return json({ error: "not found", code: "not_found" }, 404);
}

// ------------------------------------------------------------------ masters

export async function loadMasterBytes(env: Env, db: D1Database): Promise<Array<{ name: string; bytes: ArrayBuffer }>> {
  const rows = (await db
    .prepare("SELECT * FROM visual_assets WHERE role = 'master' AND approval_status = 'approved' ORDER BY file")
    .all<VisualAssetRow>()).results;
  if (!rows.length) throw new ProviderError("assets", "config", "no master images in the registry", 503, false);

  return Promise.all(rows.map(async (r) => {
    const res = await env.ASSETS.fetch(new Request(assetUrl(r.file)));
    if (!res.ok) throw new ProviderError("assets", "config", "master image missing: " + r.file, 503, false);
    const bytes = await res.arrayBuffer();
    // The hash is the identity. A master that drifted is not a reference.
    if (r.sha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== r.sha256) throw new ProviderError("assets", "config", "master image hash mismatch: " + r.file, 503, false);
    }
    return { name: basename(r.file), bytes };
  }));
}

export async function verifyMasters(env: Env, db: D1Database): Promise<{
  results: Array<{ id: string; file: string; expected: string | null; actual: string; ok: boolean }>;
  allOk: boolean;
}> {
  const rows = (await db.prepare("SELECT * FROM visual_assets WHERE role = 'master' ORDER BY file").all<VisualAssetRow>()).results;
  const results = await Promise.all(rows.map(async (r) => {
    let actual = "missing";
    try {
      const res = await env.ASSETS.fetch(new Request(assetUrl(r.file)));
      actual = res.ok ? await sha256Hex(await res.arrayBuffer()) : "missing";
    } catch {
      actual = "error";
    }
    const ok = r.sha256 !== null && actual === r.sha256;
    return { id: r.id, file: r.file, expected: r.sha256, actual, ok };
  }));
  return { results, allOk: results.length > 0 && results.every((x) => x.ok) };
}

// ------------------------------------------------------------------ generation

interface FailureRecord {
  conversationId: string;
  messageId: string | null;
  provider: string;
  model: string;
  latencyMs: number;
  kind: string;
  message: string;
}

async function recordFailure(db: D1Database, f: FailureRecord): Promise<void> {
  const run: ModelRunRow = {
    id: newId("run"),
    conversation_id: f.conversationId,
    kind: "image",
    provider: f.provider,
    model: f.model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: f.latencyMs,
    status: "failed",
    error: f.kind + (f.message ? ": " + f.message : ""),
    flags_json: null,
    created_at: nowIso(),
  };
  const stmts: D1PreparedStatement[] = [insertModelRunStmt(db, run)];
  if (f.messageId) stmts.push(db.prepare("UPDATE messages SET image_status = 'failed' WHERE id = ?1").bind(f.messageId));
  try {
    await db.batch(stmts);
  } catch (e) {
    console.error("image failure record not written", safeErrorMessage(e));
  }
}

export async function generateCandidate(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { conversationId: string; messageId: string | null; description: string; actor: string },
): Promise<VisualAssetRow> {
  const { conversationId, messageId, actor } = args;
  const providerName = settings.imageProvider;
  const model = settings.imageModel;
  const description = (args.description ?? "").trim();
  const started = Date.now();

  try {
    if (!description) throw new ApiHttpError(400, "validation", "description is required");
    if (!imageProviderConfigured(env, providerName)) {
      throw new ProviderError(providerName, "config", providerName + " image provider not configured", 503, false);
    }
    await assertBudget(db, settings, settings.imageCostUsd);

    if (messageId) await db.prepare("UPDATE messages SET image_status = 'pending' WHERE id = ?1").bind(messageId).run();

    const provider = getImageProvider(providerName);
    const references = await loadMasterBytes(env, db);
    const result = await provider.generate(env, {
      prompt: description,
      identityPrompt: imageIdentityPrompt(),
      references,
      model,
      quality: settings.imageQuality,
      size: settings.imageSize,
    });
    const latencyMs = Date.now() - started;

    const sha = await sha256Hex(result.png);
    const hit = await db
      .prepare("SELECT id FROM visual_assets WHERE approval_status = 'rejected' AND sha256 = ?1 LIMIT 1")
      .bind(sha)
      .first<{ id: string }>();
    if (hit) throw new ApiHttpError(422, "blacklisted", "candidate matches a rejected image", false, hit.id);

    const id = newId("img");
    const key = CANDIDATE_PREFIX + id + ".png";
    const t = nowIso();
    await env.MEDIA.put(key, result.png, { httpMetadata: { contentType: "image/png" } });

    const row: VisualAssetRow = {
      id,
      file: key,
      role: "candidate",
      sha256: sha,
      bytes: result.png.byteLength,
      approval_status: "candidate",
      conversation_id: conversationId,
      message_id: messageId,
      prompt: description,
      provider: providerName,
      model: result.model,
      notes: null,
      created_at: t,
      decided_at: null,
    };
    const costMicro = Math.max(0, Math.round((Number.isFinite(settings.imageCostUsd) ? settings.imageCostUsd : 0) * MICRO));
    const run: ModelRunRow = {
      id: newId("run"),
      conversation_id: conversationId,
      kind: "image",
      provider: providerName,
      model,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd_micro: costMicro,
      latency_ms: latencyMs,
      status: "ok",
      error: null,
      flags_json: null,
      created_at: t,
    };

    const stmts: D1PreparedStatement[] = [
      insertAssetStmt(db, row),
      insertModelRunStmt(db, run),
      usageStmt(db, dayKey(), providerName, model, 0, 0, costMicro),
      auditStmt(db, actor, "image.generate", "visual_asset", id, null, {
        file: key, sha256: sha, bytes: row.bytes, conversation_id: conversationId, message_id: messageId, provider: providerName, model,
      }),
    ];
    if (messageId) {
      stmts.push(db.prepare("UPDATE messages SET image_id = ?1, image_status = 'ready' WHERE id = ?2").bind(id, messageId));
    }
    await db.batch(stmts);
    return row;
  } catch (e) {
    const kind = errorKind(e);
    const message = safeErrorMessage(e, 200);
    console.warn("image generation failed", kind, message);
    await recordFailure(db, { conversationId, messageId, provider: providerName, model, latencyMs: Date.now() - started, kind, message });
    throw toApiError(e);
  }
}

// ------------------------------------------------------------------ decisions

export async function decideImage(
  env: Env,
  db: D1Database,
  id: string,
  decision: "approve" | "reject",
  actor: string,
  note?: string,
): Promise<VisualAssetRow> {
  const row = await getAsset(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "asset not found");
  if (row.role === "master") throw new ApiHttpError(403, "fixed_canon", "master images are not decided here");
  if (row.role !== "candidate" && row.role !== "scene") throw new ApiHttpError(409, "not_decidable", "asset role is " + row.role);
  if (decision !== "approve" && decision !== "reject") throw new ApiHttpError(400, "validation", "decision must be approve or reject");

  const t = nowIso();
  const trimmedNote = typeof note === "string" ? note.trim() : "";
  const notes = trimmedNote ? (row.notes ? row.notes + " | " + trimmedNote : trimmedNote) : row.notes;
  const stmts: D1PreparedStatement[] = [];

  if (decision === "approve") {
    if (row.approval_status === "rejected") {
      throw new ApiHttpError(409, "already_rejected", "a rejected image cannot be approved; its file is gone");
    }
    stmts.push(db
      .prepare("UPDATE visual_assets SET approval_status = 'approved', role = 'scene', decided_at = ?1, notes = ?2 WHERE id = ?3")
      .bind(t, notes, id));
  } else {
    if (row.approval_status !== "rejected") {
      // The row and its hash stay; only the bytes go.
      try {
        await env.MEDIA.delete(row.file);
      } catch (e) {
        console.warn("media delete failed", safeErrorMessage(e));
      }
    }
    stmts.push(db
      .prepare("UPDATE visual_assets SET approval_status = 'rejected', decided_at = ?1, notes = ?2 WHERE id = ?3")
      .bind(t, notes, id));
    if (row.message_id) {
      stmts.push(db.prepare("UPDATE messages SET image_status = 'rejected' WHERE id = ?1").bind(row.message_id));
    }
  }

  const after: VisualAssetRow = decision === "approve"
    ? { ...row, approval_status: "approved", role: "scene", decided_at: t, notes }
    : { ...row, approval_status: "rejected", decided_at: t, notes };
  stmts.push(auditStmt(db, actor, "image." + decision, "visual_asset", id, row, after));
  await db.batch(stmts);

  const stored = await getAsset(db, id);
  return stored ?? after;
}

// ------------------------------------------------------------------ serving

export async function serveMedia(env: Env, db: D1Database, id: string): Promise<Response> {
  if (!id || id.length > 80) return notFound();
  const row = await getAsset(db, id);
  if (!row) return notFound();
  const statusOk = row.approval_status === "candidate" || row.approval_status === "approved";
  const roleOk = row.role === "candidate" || row.role === "scene";
  if (!statusOk || !roleOk) return notFound();

  const obj = await env.MEDIA.get(row.file);
  if (!obj) return notFound();

  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(obj.size),
      "cache-control": "private, no-store",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    },
  });
}
