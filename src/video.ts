// Video clips (SPEC_V3 FF): short clips of her, made from a master image or an approved
// photo by Runway's image-to-video when RUNWAY_API_KEY exists; off otherwise. A clip is a
// candidate until he approves it, a rejected clip's hash never comes back, the identity
// comes from the same five masters, and the price is metered like a photo. He asks for one
// from the Images page; nothing in v3 asks for one on its own (the [clip:] marker is v3.1).
//
// The row is a visual_assets row with role video, file videos/<id>.mp4, prompt = the
// motion description, notes = "source:<assetId>|task:<taskId>|since <t>" while
// generating, then null. Runway charges when the task runs, so the meter charges at
// start; a failed task stays charged, honestly.
import { auditStmt, dayKey, getAsset, insertAssetStmt, insertModelRunStmt, newId, nowIso, sha256Hex, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { assertBudget } from "./budget";
import { VIDEO_PREFIX, loadSourceBytes, roleOf } from "./images";
import { getVideoProvider, videoProviderConfigured } from "./providers/index";
import { safeErrorMessage } from "./providers/types";
export { stubMp4 } from "./providers/stub";
import type { VideoAdapterName } from "./providers/types";
import { ProviderError } from "./types";
import type { Env, ModelRunRow, Settings, VisualAssetRow } from "./types";

const MICRO = 1_000_000;
// Runway caps a data-URI input at 5 MB encoded (SPEC_V3 FF, fetched 2026-09-24).
export const MAX_ENCODED_SOURCE = 5 * 1024 * 1024;
// A claim older than this counts as abandoned: a new poll takes it over.
export const CLAIM_LEASE_MS = 15 * 60 * 1000;
const NOTE_SOURCE = "source:";
const NOTE_TASK = "task:";
const NOTE_SINCE = "since ";
const MAX_DESCRIPTION = 1000;
const SIZE_UNKNOWN_FALLBACK = 0;

export interface VideoSettings {
  provider: string;
  model: string;
  seconds: 5 | 10;
  ratio: string;
  costUsd: number;
}

export type ClipStatus = "running" | "candidate" | "failed";

// ------------------------------------------------------------------ pure pieces

// The video settings as stored (SPEC_V3 Settings table), the spec's defaults for a
// value that is missing or malformed.
export function videoSettingsOf(settings: Settings): VideoSettings {
  const provider = typeof settings.videoProvider === "string" && settings.videoProvider.trim() ? settings.videoProvider.trim() : "runway";
  const model = typeof settings.videoModel === "string" && settings.videoModel.trim() ? settings.videoModel.trim().slice(0, 60) : "gen4_turbo";
  const seconds: 5 | 10 = settings.videoSeconds === 10 ? 10 : 5;
  const ratio = typeof settings.videoRatio === "string" && /^\d{3,4}:\d{3,4}$/.test(settings.videoRatio.trim()) ? settings.videoRatio.trim() : "720:1280";
  const costUsd = typeof settings.videoCostUsd === "number" && Number.isFinite(settings.videoCostUsd) && settings.videoCostUsd >= 0 ? settings.videoCostUsd : 0.25;
  return { provider, model, seconds, ratio, costUsd };
}

// The price of one clip: videoCostUsd is per 5 seconds. Takes the stored settings or the
// video settings view.
export function clipCostUsd(vs: { costUsd: number; seconds: number } | { videoCostUsd?: unknown; videoSeconds?: unknown }): number {
  const cost = "costUsd" in vs && typeof vs.costUsd === "number" ? vs.costUsd : typeof (vs as { videoCostUsd?: unknown }).videoCostUsd === "number" ? (vs as { videoCostUsd: number }).videoCostUsd : 0.25;
  const seconds = "seconds" in vs && typeof vs.seconds === "number" ? vs.seconds : (vs as { videoSeconds?: unknown }).videoSeconds === 10 ? 10 : 5;
  return (Math.max(0, cost) * Math.max(0, seconds)) / 5;
}

type Sized = number | ArrayBuffer | Uint8Array | { byteLength: number };

function byteCount(source: Sized): number {
  if (typeof source === "number") return Math.max(0, source);
  return typeof source.byteLength === "number" ? source.byteLength : 0;
}

// The length of a base64 data URI for the given bytes (a count or the buffer itself).
export function encodedDataUriLength(source: Sized, mime = "image/png"): number {
  return ("data:" + mime + ";base64,").length + Math.ceil(byteCount(source) / 3) * 4;
}

// True when the source, encoded as a data URI, is over the provider's input cap.
export function sourceTooLarge(source: Sized, mime = "image/png"): boolean {
  return encodedDataUriLength(source, mime) > MAX_ENCODED_SOURCE;
}

// The claim note while a clip generates, and its reader.
export function claimNote(sourceId: string, taskId: string, at: string): string {
  return `${NOTE_SOURCE}${sourceId}|${NOTE_TASK}${taskId}|${NOTE_SINCE}${at}`;
}

export function parseClaimNote(notes: string | null | undefined): { sourceId: string; taskId: string; since: string } | null {
  if (typeof notes !== "string" || !notes.startsWith(NOTE_SOURCE)) return null;
  const parts = notes.split("|");
  const sourceId = parts[0]?.slice(NOTE_SOURCE.length).trim() ?? "";
  const task = parts.find((p) => p.startsWith(NOTE_TASK));
  const since = parts.find((p) => p.startsWith(NOTE_SINCE));
  if (!sourceId || !task || !since) return null;
  return { sourceId, taskId: task.slice(NOTE_TASK.length).trim(), since: since.slice(NOTE_SINCE.length).trim() };
}

// A claim older than the lease is abandoned (the page that held it is gone). Takes the
// row's notes (or the bare since time); no claim at all counts as abandoned.
export function claimAbandoned(notesOrSince: string | null | undefined, now: Date | number, leaseMs = CLAIM_LEASE_MS): boolean {
  if (typeof notesOrSince !== "string" || !notesOrSince.trim()) return true;
  const parsed = parseClaimNote(notesOrSince);
  const since = parsed ? parsed.since : notesOrSince.startsWith(NOTE_SINCE) ? notesOrSince.slice(NOTE_SINCE.length) : notesOrSince;
  const t = Date.parse(since.trim());
  const at = typeof now === "number" ? now : now.getTime();
  return !Number.isFinite(t) || at - t > leaseMs;
}

type Base64Proto = { toBase64?: () => string };

// Base64 for a multi-megabyte PNG: the native encoder where the runtime has it, else
// btoa over 32 KB chunks.
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const native = (view as unknown as Base64Proto).toBase64;
  if (typeof native === "function") return native.call(view);
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < view.length; i += CHUNK) s += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + CHUNK)));
  return btoa(s);
}

export function dataUri(bytes: ArrayBuffer, mime = "image/png"): string {
  return "data:" + mime + ";base64," + toBase64(bytes);
}

function errorKind(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof ApiHttpError) return e.code;
  return "other";
}

function toApiError(e: unknown): ApiHttpError {
  if (e instanceof ApiHttpError) return e;
  if (e instanceof ProviderError) {
    const message = safeErrorMessage(e);
    if (e.kind === "config") return new ApiHttpError(503, "provider_not_configured", message, false, e.provider);
    return new ApiHttpError(502, "provider_failed", message, e.retryable, e.kind);
  }
  return new ApiHttpError(500, "video_failed", safeErrorMessage(e), false);
}

function failedRun(conversationId: string | null, provider: string, model: string, latencyMs: number, reason: string): ModelRunRow {
  return {
    id: newId("run"), conversation_id: conversationId, kind: "video", provider, model, prompt_version: null,
    input_tokens: 0, output_tokens: 0, cost_usd_micro: 0, latency_ms: latencyMs, status: "failed", error: reason.slice(0, 300),
    flags_json: null, created_at: nowIso(),
  };
}

// ------------------------------------------------------------------ start

export async function startClip(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { sourceAssetId: string; description: string; actor: string },
): Promise<VisualAssetRow> {
  const vs = videoSettingsOf(settings);
  const description = typeof args.description === "string" ? args.description.trim().slice(0, MAX_DESCRIPTION) : "";
  if (!description) throw new ApiHttpError(400, "validation", "description is required");
  if (typeof args.sourceAssetId !== "string" || !args.sourceAssetId) throw new ApiHttpError(400, "validation", "sourceAssetId is required");

  // 1. the source: a master or an approved photo of her, nothing else (identity from the masters).
  const source = await getAsset(db, args.sourceAssetId);
  const sourceRole = source ? roleOf(source) : null;
  const sourceOk = source && source.approval_status === "approved" && (sourceRole === "master" || sourceRole === "scene");
  if (!source || !sourceOk) throw new ApiHttpError(404, "not_found", "the source must be a master or an approved photo");

  // 2. the provider, the size gate, the caps: nothing is written before all three pass.
  if (vs.provider === "off" || !videoProviderConfigured(env, vs.provider)) {
    throw new ApiHttpError(503, "provider_not_configured", vs.provider === "off" ? "clips are off" : `${vs.provider} is not configured for clips`, false, vs.provider);
  }
  const provider = getVideoProvider(vs.provider as VideoAdapterName);
  if (sourceTooLarge(source.bytes ?? SIZE_UNKNOWN_FALLBACK)) {
    throw new ApiHttpError(400, "source_too_large", `the source encodes past ${MAX_ENCODED_SOURCE} bytes; pick a smaller picture`, false);
  }
  if (vs.provider !== "stub" && !(vs.costUsd > 0)) {
    throw new ApiHttpError(402, "price_unknown", "videoCostUsd is 0 for video provider " + vs.provider + "; set the price per clip on the Model page", false);
  }
  const cost = clipCostUsd(vs);
  await assertBudget(db, settings, cost);

  // 3. the bytes (hash-verified for a master); the gate again on the real size.
  const bytes = await loadSourceBytes(env, source);
  if (sourceTooLarge(bytes.byteLength)) {
    throw new ApiHttpError(400, "source_too_large", `the source encodes past ${MAX_ENCODED_SOURCE} bytes; pick a smaller picture`, false);
  }

  // 4. the request row, claimed; then the task. A start that fails leaves the row failed
  // and charges nothing (the provider ran nothing).
  const id = newId("vid");
  const t = nowIso();
  const row: VisualAssetRow = {
    id,
    file: VIDEO_PREFIX + id + ".mp4",
    role: "video" as VisualAssetRow["role"],
    sha256: null,
    bytes: null,
    approval_status: "generating",
    conversation_id: null,
    message_id: null,
    prompt: description,
    provider: vs.provider,
    model: vs.model,
    notes: claimNote(source.id, "pending", t),
    created_at: t,
    decided_at: null,
  };
  await db.batch([insertAssetStmt(db, row)]);

  const started = Date.now();
  let taskId: string;
  try {
    const task = await provider.startImageToVideo(env, {
      model: vs.model,
      promptImage: dataUri(bytes),
      promptText: description,
      ratio: vs.ratio,
      duration: vs.seconds,
    });
    taskId = task.id;
  } catch (e) {
    const reason = errorKind(e) + ": " + safeErrorMessage(e, 200);
    console.warn("clip start failed", errorKind(e), safeErrorMessage(e, 200));
    try {
      await db.batch([
        db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating'").bind(id, reason.slice(0, 300)),
        insertModelRunStmt(db, failedRun(null, vs.provider, vs.model, Date.now() - started, reason)),
      ]);
    } catch (e2) {
      console.error("clip failure not recorded", errorKind(e2));
    }
    throw toApiError(e);
  }

  // 5. charged now: Runway bills when the task runs.
  const costMicro = Math.max(0, Math.round(cost * MICRO));
  const run: ModelRunRow = {
    id: newId("run"), conversation_id: null, kind: "video", provider: vs.provider, model: vs.model, prompt_version: null,
    input_tokens: 0, output_tokens: 0, cost_usd_micro: costMicro, latency_ms: Date.now() - started, status: "ok", error: null,
    flags_json: null, created_at: nowIso(),
  };
  const notes = claimNote(source.id, taskId, nowIso());
  await db.batch([
    db.prepare("UPDATE visual_assets SET notes = ?2 WHERE id = ?1 AND approval_status = 'generating'").bind(id, notes),
    insertModelRunStmt(db, run),
    usageStmt(db, dayKey(), vs.provider, vs.model, 0, 0, costMicro),
    auditStmt(db, args.actor, "video.start", "visual_asset", id, null, { source: source.id, task: taskId, provider: vs.provider, model: vs.model, seconds: vs.seconds, ratio: vs.ratio, costUsd: cost }),
  ]);
  return { ...row, notes };
}

// ------------------------------------------------------------------ poll

export async function pollClip(
  env: Env,
  db: D1Database,
  settings: Settings,
  id: string,
  actor: string,
): Promise<{ asset: VisualAssetRow; status: ClipStatus }> {
  const vs = videoSettingsOf(settings);
  const row = await getAsset(db, id);
  if (!row || roleOf(row) !== "video") throw new ApiHttpError(404, "not_found", "clip not found");
  if (row.approval_status === "candidate" || row.approval_status === "approved" || row.approval_status === "rejected" || row.approval_status === "archive") {
    throw new ApiHttpError(409, "already_generated", "this clip already exists");
  }
  if (row.approval_status === "failed") return { asset: row, status: "failed" };
  if (row.approval_status !== "generating") throw new ApiHttpError(409, "not_a_request", "asset is not a clip request");
  const claim = parseClaimNote(row.notes);
  if (!claim || !claim.taskId || claim.taskId === "pending") {
    throw new ApiHttpError(409, "in_progress", "the clip has not started yet");
  }
  const providerName = row.provider ?? vs.provider;
  if (!videoProviderConfigured(env, providerName)) {
    throw new ApiHttpError(503, "provider_not_configured", `${providerName} is not configured for clips`, false, providerName);
  }
  const provider = getVideoProvider(providerName as VideoAdapterName);

  // An abandoned claim is taken over: the note is re-stamped so the lease starts again.
  let notes = row.notes ?? "";
  if (claimAbandoned(row.notes, Date.now())) {
    const fresh = claimNote(claim.sourceId, claim.taskId, nowIso());
    const r = await db.prepare("UPDATE visual_assets SET notes = ?2 WHERE id = ?1 AND approval_status = 'generating' AND notes IS ?3").bind(id, fresh, row.notes).run();
    if (r.meta.changes) notes = fresh;
  }

  const fail = async (reason: string): Promise<{ asset: VisualAssetRow; status: ClipStatus }> => {
    const short = reason.slice(0, 300);
    await db.batch([
      db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating'").bind(id, short),
      auditStmt(db, actor, "video.failed", "visual_asset", id, null, { reason: short, task: claim.taskId }),
    ]);
    return { asset: { ...row, approval_status: "failed", notes: short }, status: "failed" };
  };

  let status;
  try {
    status = await provider.taskStatus(env, claim.taskId);
  } catch (e) {
    throw toApiError(e);
  }
  if (status.status === "PENDING" || status.status === "RUNNING") return { asset: { ...row, notes }, status: "running" };
  if (status.status !== "SUCCEEDED") {
    return fail(status.status.toLowerCase() + (status.failure ? ": " + status.failure : status.failureCode ? ": " + status.failureCode : ""));
  }
  const url = status.output?.[0];
  if (!url) return fail("succeeded with no output");

  let bytes: ArrayBuffer;
  try {
    bytes = await provider.fetchOutput(env, url);
  } catch (e) {
    throw toApiError(e);
  }
  const sha = await sha256Hex(bytes);
  const hit = await db.prepare("SELECT id FROM visual_assets WHERE approval_status = 'rejected' AND sha256 = ?1 LIMIT 1").bind(sha).first<{ id: string }>();
  if (hit) {
    await fail("blacklisted: matches rejected " + hit.id);
    throw new ApiHttpError(422, "blacklisted", "clip matches a rejected one", false, hit.id);
  }

  // The claim must still be ours before the bytes go to R2; the row becomes a candidate in
  // one batch whose first statement is the same guard.
  const live = await db.prepare("SELECT 1 AS ok FROM visual_assets WHERE id = ?1 AND approval_status = 'generating' AND notes = ?2").bind(id, notes).first<{ ok: number }>();
  if (!live) throw new ApiHttpError(409, "in_progress", "another request took over this clip", true);
  await env.MEDIA.put(row.file, bytes, { httpMetadata: { contentType: "video/mp4" } });

  const candidate: VisualAssetRow = { ...row, sha256: sha, bytes: bytes.byteLength, approval_status: "candidate", provider: providerName, model: row.model ?? vs.model, notes: null };
  const results = await db.batch([
    db.prepare("UPDATE visual_assets SET sha256 = ?2, bytes = ?3, approval_status = 'candidate', provider = ?4, model = ?5, notes = NULL WHERE id = ?1 AND approval_status = 'generating' AND notes = ?6")
      .bind(id, sha, candidate.bytes, providerName, candidate.model, notes),
    auditStmt(db, actor, "video.generate", "visual_asset", id, null, { file: row.file, sha256: sha, bytes: candidate.bytes, source: claim.sourceId, task: claim.taskId, provider: providerName, model: candidate.model }),
  ]);
  if (!results[0]?.meta.changes) throw new ApiHttpError(409, "in_progress", "another request took over this clip", true);
  return { asset: candidate, status: "candidate" };
}
