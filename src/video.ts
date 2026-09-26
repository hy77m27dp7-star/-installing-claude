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
//
// v4 (SPEC_V4 section 2 and amendment A3): the same path makes her call face (role
// callface, a kind:<kind> part on the claim note, "callface:<kind>" once a candidate) and
// the clips she sends from the chat (role video bound to a conversation and a message,
// the source chosen for her: today's approved photo from this conversation, else her
// newest approved photo, else the avatar master).
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
import type { CallFaceKind } from "./callface";

const MICRO = 1_000_000;
// Runway caps a data-URI input at 5 MB encoded (SPEC_V3 FF, fetched 2026-09-24).
export const MAX_ENCODED_SOURCE = 5 * 1024 * 1024;
// A claim older than this counts as abandoned: a new poll takes it over.
export const CLAIM_LEASE_MS = 15 * 60 * 1000;
const NOTE_SOURCE = "source:";
const NOTE_TASK = "task:";
const NOTE_SINCE = "since ";
const NOTE_KIND = "kind:";
const MAX_DESCRIPTION = 1000;
// Runway's promptText cap on image_to_video (1000 UTF-16 units, the same as text_to_image).
const MAX_PROMPT_UNITS = 1000;
const SIZE_UNKNOWN_FALLBACK = 0;

// The roles a clip row may carry: a clip of her (video) or her call face (callface, v4).
export type ClipRole = "video" | "callface";
export const CLIP_ROLES: readonly ClipRole[] = ["video", "callface"];
export const CALLFACE_NOTE_PREFIX = "callface:";
// The kinds a call face clip may be (mirrors callface.ts CALL_FACE_KINDS; a value copy so
// this module never imports a value from the module that imports it).
const CLIP_KINDS: readonly string[] = ["idle", "listening", "talking"];
// The avatar master a message clip falls back to (SPEC_V4 section 0's default).
export const DEFAULT_AVATAR_ASSET_ID = "master-05";
const AVATAR_ID_RE = /^master-0[0-5]$/;

function isClipKind(x: unknown): x is CallFaceKind {
  return typeof x === "string" && CLIP_KINDS.includes(x);
}

export function isClipRole(x: unknown): x is ClipRole {
  return typeof x === "string" && (CLIP_ROLES as readonly string[]).includes(x);
}

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

// The claim note while a clip generates, and its reader. A call face clip carries a
// fourth part, kind:<idle|listening|talking> (v4); a re-stamp must pass it on.
export function claimNote(sourceId: string, taskId: string, at: string, kind?: CallFaceKind | null): string {
  const base = `${NOTE_SOURCE}${sourceId}|${NOTE_TASK}${taskId}|${NOTE_SINCE}${at}`;
  return isClipKind(kind) ? base + `|${NOTE_KIND}${kind}` : base;
}

export function parseClaimNote(notes: string | null | undefined): { sourceId: string; taskId: string; since: string; kind: CallFaceKind | null } | null {
  if (typeof notes !== "string" || !notes.startsWith(NOTE_SOURCE)) return null;
  const parts = notes.split("|");
  const sourceId = parts[0]?.slice(NOTE_SOURCE.length).trim() ?? "";
  const task = parts.find((p) => p.startsWith(NOTE_TASK));
  const since = parts.find((p) => p.startsWith(NOTE_SINCE));
  if (!sourceId || !task || !since) return null;
  const kindPart = parts.find((p) => p.trim().startsWith(NOTE_KIND));
  const kindValue = kindPart ? kindPart.trim().slice(NOTE_KIND.length).trim() : null;
  return { sourceId, taskId: task.slice(NOTE_TASK.length).trim(), since: since.slice(NOTE_SINCE.length).trim(), kind: isClipKind(kindValue) ? kindValue : null };
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

// The statement that marks a message's clip failed (the message carries the clip in
// image_id / image_status, the way it carries a photo; amendment A3).
function messageClipFailedStmt(db: D1Database, messageId: string, assetId: string): D1PreparedStatement {
  return db.prepare("UPDATE messages SET image_status = 'failed' WHERE id = ?1 AND image_id = ?2 AND image_status = 'pending'").bind(messageId, assetId);
}

// ------------------------------------------------------------------ start

export interface StartClipArgs {
  sourceAssetId: string;
  description: string;
  actor: string;
  // v4: the row's role (default video) and, for a call face, its kind; a ratio and a
  // duration that override the stored video settings.
  role?: ClipRole;
  kind?: CallFaceKind;
  ratio?: string;
  seconds?: 5 | 10;
  // Amendment A3: a clip she sends from the chat is bound to its message, and the words
  // the provider gets carry the identity clause on top of her description (the row's
  // prompt stays her description alone).
  conversationId?: string | null;
  messageId?: string | null;
  promptText?: string;
}

export async function startClip(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: StartClipArgs,
): Promise<VisualAssetRow> {
  const stored = videoSettingsOf(settings);
  const role: ClipRole = isClipRole(args.role) ? args.role : "video";
  const kind: CallFaceKind | null = role === "callface" && isClipKind(args.kind) ? args.kind : null;
  if (role === "callface" && !kind) throw new ApiHttpError(400, "validation", "a call face clip needs a kind");
  const ratio = typeof args.ratio === "string" && /^\d{3,4}:\d{3,4}$/.test(args.ratio.trim()) ? args.ratio.trim() : stored.ratio;
  const seconds: 5 | 10 = args.seconds === 5 || args.seconds === 10 ? args.seconds : stored.seconds;
  const vs: VideoSettings = { ...stored, ratio, seconds };
  const description = typeof args.description === "string" ? args.description.trim().slice(0, MAX_DESCRIPTION) : "";
  if (!description) throw new ApiHttpError(400, "validation", "description is required");
  if (typeof args.sourceAssetId !== "string" || !args.sourceAssetId) throw new ApiHttpError(400, "validation", "sourceAssetId is required");
  const promptText = typeof args.promptText === "string" && args.promptText.trim() ? args.promptText.trim().slice(0, MAX_PROMPT_UNITS) : description;
  const conversationId = typeof args.conversationId === "string" && args.conversationId ? args.conversationId : null;
  const messageId = typeof args.messageId === "string" && args.messageId ? args.messageId : null;

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
    role: role as VisualAssetRow["role"],
    sha256: null,
    bytes: null,
    approval_status: "generating",
    conversation_id: conversationId,
    message_id: messageId,
    prompt: description,
    provider: vs.provider,
    model: vs.model,
    notes: claimNote(source.id, "pending", t, kind),
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
      promptText,
      ratio: vs.ratio,
      duration: vs.seconds,
    });
    taskId = task.id;
  } catch (e) {
    const reason = errorKind(e) + ": " + safeErrorMessage(e, 200);
    console.warn("clip start failed", errorKind(e), safeErrorMessage(e, 200));
    try {
      const stmts = [
        db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating'").bind(id, reason.slice(0, 300)),
        insertModelRunStmt(db, failedRun(conversationId, vs.provider, vs.model, Date.now() - started, reason)),
      ];
      if (messageId) stmts.push(messageClipFailedStmt(db, messageId, id));
      await db.batch(stmts);
    } catch (e2) {
      console.error("clip failure not recorded", errorKind(e2));
    }
    throw toApiError(e);
  }

  // 5. charged now: Runway bills when the task runs.
  const costMicro = Math.max(0, Math.round(cost * MICRO));
  const run: ModelRunRow = {
    id: newId("run"), conversation_id: conversationId, kind: "video", provider: vs.provider, model: vs.model, prompt_version: null,
    input_tokens: 0, output_tokens: 0, cost_usd_micro: costMicro, latency_ms: Date.now() - started, status: "ok", error: null,
    flags_json: null, created_at: nowIso(),
  };
  const notes = claimNote(source.id, taskId, nowIso(), kind);
  await db.batch([
    db.prepare("UPDATE visual_assets SET notes = ?2 WHERE id = ?1 AND approval_status = 'generating'").bind(id, notes),
    insertModelRunStmt(db, run),
    usageStmt(db, dayKey(), vs.provider, vs.model, 0, 0, costMicro),
    auditStmt(db, args.actor, "video.start", "visual_asset", id, null, {
      source: source.id, task: taskId, provider: vs.provider, model: vs.model, seconds: vs.seconds, ratio: vs.ratio, costUsd: cost, role,
      ...(kind ? { kind } : {}), ...(conversationId ? { conversation_id: conversationId } : {}), ...(messageId ? { message_id: messageId } : {}),
    }),
  ]);
  return { ...row, notes };
}

// ------------------------------------------------------------------ a clip for a message (amendment A3)

// The identity words a message clip rides with: the woman in the source frame stays
// exactly herself (the source is her own photo or a master, so the face and figure are
// already the references'); her description is the motion. Never a word about
// recording, sending or the app: this is provider text, not story text.
export const CLIP_IDENTITY_TEXT = "The same young woman as in the source image, her face and figure exactly as the image shows them, fully clothed as the scene has her; natural motion, a candid phone video, no text, no captions, no watermark, the camera mostly still.";

export function clipPromptText(description: string): string {
  const clean = String(description ?? "").replace(/\s+/g, " ").trim();
  const head = CLIP_IDENTITY_TEXT + " ";
  const room = Math.max(0, MAX_PROMPT_UNITS - head.length);
  return (head + clean.slice(0, room)).trim().slice(0, MAX_PROMPT_UNITS);
}

// The source chosen for her (pure, on the rows the caller loaded): the newest approved
// photo she sent in this conversation today (same outfit, same place), else her newest
// approved photo from any conversation, else the avatar master (settings.avatarAssetId,
// or master-05). `today` is the UTC day key (YYYY-MM-DD) the rows' created_at is
// compared against. Null when not even the master exists.
export function chooseClipSource(
  rows: readonly VisualAssetRow[],
  args: { conversationId: string; today: string; avatarAssetId?: string | null },
): VisualAssetRow | null {
  // A picture with him in it (with_him 1) never dresses a clip: a clip is never made with
  // him in it (SPEC_V4 A3), and his face never rides where her line did not put him.
  const approvedPhotos = rows.filter((r) => roleOf(r) === "scene" && r.approval_status === "approved" && Number(r.with_him ?? 0) !== 1);
  const byNewest = (a: VisualAssetRow, b: VisualAssetRow): number => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
  const sent = (r: VisualAssetRow): boolean => typeof r.message_id === "string" && r.message_id.trim() !== "";
  const todayHere = approvedPhotos
    .filter((r) => r.conversation_id === args.conversationId && sent(r) && r.created_at.slice(0, 10) === args.today)
    .sort(byNewest);
  if (todayHere[0]) return todayHere[0];
  const anyPhoto = approvedPhotos.filter(sent).sort(byNewest);
  if (anyPhoto[0]) return anyPhoto[0];
  const wanted = typeof args.avatarAssetId === "string" && AVATAR_ID_RE.test(args.avatarAssetId.trim()) ? args.avatarAssetId.trim() : DEFAULT_AVATAR_ASSET_ID;
  const masters = rows.filter((r) => roleOf(r) === "master" && r.approval_status === "approved");
  return masters.find((r) => r.id === wanted) ?? masters.find((r) => r.id === DEFAULT_AVATAR_ASSET_ID) ?? null;
}

// Starts the clip a reply asked for with its [clip:] line, after the reply is committed
// (src/chat.ts calls this). The row is role video, bound to the conversation and the
// message (the message carries it in image_id / image_status, the pipeline lane's
// write); everything else is startClip: the size gate, the key, the price at
// videoCostUsd for videoSeconds, the caps, the charge at start. The candidate and the
// blacklist come from pollClip as for any clip.
export async function startClipForMessage(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { conversationId: string; messageId: string; description: string; actor: string },
): Promise<VisualAssetRow> {
  const description = typeof args.description === "string" ? args.description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION) : "";
  if (!description) throw new ApiHttpError(400, "validation", "description is required");
  if (typeof args.conversationId !== "string" || !args.conversationId) throw new ApiHttpError(400, "validation", "conversationId is required");
  if (typeof args.messageId !== "string" || !args.messageId) throw new ApiHttpError(400, "validation", "messageId is required");
  const rows = (await db.prepare("SELECT * FROM visual_assets WHERE approval_status = 'approved' AND role IN ('scene', 'master')").all<VisualAssetRow>()).results;
  const avatarAssetId = (settings as unknown as Record<string, unknown>).avatarAssetId;
  const source = chooseClipSource(rows, { conversationId: args.conversationId, today: dayKey(), avatarAssetId: typeof avatarAssetId === "string" ? avatarAssetId : null });
  if (!source) throw new ApiHttpError(404, "not_found", "no photo or master to make the clip from");
  return startClip(env, db, settings, {
    sourceAssetId: source.id,
    description,
    actor: args.actor,
    role: "video",
    conversationId: args.conversationId,
    messageId: args.messageId,
    promptText: clipPromptText(description),
  });
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
  if (!row || !isClipRole(roleOf(row))) throw new ApiHttpError(404, "not_found", "clip not found");
  const role: ClipRole = roleOf(row) as ClipRole;
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
    // The kind rides along, so a call face clip taken over keeps its kind.
    const fresh = claimNote(claim.sourceId, claim.taskId, nowIso(), claim.kind);
    const r = await db.prepare("UPDATE visual_assets SET notes = ?2 WHERE id = ?1 AND approval_status = 'generating' AND notes IS ?3").bind(id, fresh, row.notes).run();
    if (r.meta.changes) notes = fresh;
  }

  const fail = async (reason: string): Promise<{ asset: VisualAssetRow; status: ClipStatus }> => {
    const short = reason.slice(0, 300);
    const stmts = [
      db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating'").bind(id, short),
      auditStmt(db, actor, "video.failed", "visual_asset", id, null, { reason: short, task: claim.taskId, role, ...(claim.kind ? { kind: claim.kind } : {}) }),
    ];
    if (row.message_id) stmts.push(messageClipFailedStmt(db, row.message_id, id));
    await db.batch(stmts);
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

  // A call face candidate keeps its kind in notes ("callface:<kind>"); a clip's notes clear.
  const candidateNotes = role === "callface" && claim.kind ? CALLFACE_NOTE_PREFIX + claim.kind : null;
  const candidate: VisualAssetRow = { ...row, sha256: sha, bytes: bytes.byteLength, approval_status: "candidate", provider: providerName, model: row.model ?? vs.model, notes: candidateNotes };
  const stmts = [
    db.prepare("UPDATE visual_assets SET sha256 = ?2, bytes = ?3, approval_status = 'candidate', provider = ?4, model = ?5, notes = ?7 WHERE id = ?1 AND approval_status = 'generating' AND notes = ?6")
      .bind(id, sha, candidate.bytes, providerName, candidate.model, notes, candidateNotes),
    auditStmt(db, actor, "video.generate", "visual_asset", id, null, {
      file: row.file, sha256: sha, bytes: candidate.bytes, source: claim.sourceId, task: claim.taskId, provider: providerName, model: candidate.model, role,
      ...(claim.kind ? { kind: claim.kind } : {}), ...(row.message_id ? { message_id: row.message_id } : {}),
    }),
  ];
  // A clip she sent from the chat: the message's clip is ready (it carries the clip in
  // image_id / image_status, the way it carries a photo).
  if (row.message_id) {
    stmts.push(db.prepare("UPDATE messages SET image_status = 'ready' WHERE id = ?1 AND image_id = ?2 AND image_status = 'pending'").bind(row.message_id, id));
  }
  const results = await db.batch(stmts);
  if (!results[0]?.meta.changes) throw new ApiHttpError(409, "in_progress", "another request took over this clip", true);
  return { asset: candidate, status: "candidate" };
}
