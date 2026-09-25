// Photos: marker parsing, photo requests, candidate generation into R2, approve/reject,
// serving, and master verification. A candidate is never canon; the owner decides.
// Rejected hashes stay on file so the same picture can never come back.
//
// Why the browser asks for the picture: a Worker may keep working for at most 30 seconds
// after its response is sent (ctx.waitUntil is cancelled after that), and an image edit
// with five reference photos takes longer. So the turn only records the request (a
// visual_assets row with status pending and the description as its prompt) and the page
// calls POST /api/images/generate, a request it holds open for as long as the call takes.
// A claim on the row keeps two tabs from paying for the same picture twice.
import {
  auditStmt, dayKey, getAsset, getMessage, insertAssetStmt, insertModelRunStmt, newId, nowIso, sha256Hex, usageStmt,
} from "./db";
import { ApiHttpError, json } from "./errors";
import { imageIdentityPrompt } from "./prompt";
import { assertBudget } from "./budget";
import { getImageProvider, imageProviderConfigured, isKeylessImageProvider } from "./providers";
import { safeErrorMessage } from "./providers/types";
import { ProviderError } from "./types";
import type { Env, ModelRunRow, Settings, VisualAssetRow } from "./types";

// The marker parser lives in markers.ts (with the song marker); re-exported here so the
// v1 contract (chat.ts, the unit suite) keeps importing it from images.
export { parsePhotoMarker } from "./markers";

const CANDIDATE_PREFIX = "candidates/";
const ASSETS_ORIGIN = "https://assets.local/";
const MICRO = 1_000_000;

// A claim older than this is treated as dead (the page that held the request is gone).
// Longer than the longest provider call (openai.ts waits up to 180 s).
const CLAIM_LEASE_MS = 4 * 60 * 1000;
const CLAIM_NOTE = "generating since ";

type RequestStatus = "pending" | "generating" | "failed";
const REQUEST_STATUSES: ReadonlySet<string> = new Set<RequestStatus>(["pending", "generating", "failed"]);

// Verified master bytes, kept for the life of the isolate: hashing ~5 MB on every photo
// is CPU the request does not have to spend twice. Keyed by file and stored hash, so a
// changed registry row re-verifies.
const masterCache = new Map<string, ArrayBuffer>();

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

// Thrown when another request took the claim over while this one was still working. The
// row and the message belong to that other request now, so nothing is recorded as failed.
class ClaimLostError extends ApiHttpError {
  constructor() {
    super(409, "in_progress", "another request took over this photo", true);
    this.name = "ClaimLostError";
  }
}

function notFound(): Response {
  return json({ error: "not found", code: "not_found" }, 404);
}

function isRequestStatus(s: string): s is RequestStatus {
  return REQUEST_STATUSES.has(s);
}

function claimExpired(notes: string | null, now: number): boolean {
  if (!notes || !notes.startsWith(CLAIM_NOTE)) return true;
  const since = Date.parse(notes.slice(CLAIM_NOTE.length));
  return !Number.isFinite(since) || now - since > CLAIM_LEASE_MS;
}

// ------------------------------------------------------------------ requests

// The row that records a requested photo before any bytes exist. chat.ts puts it in the
// turn's batch (status pending) so the description outlives the response; the owner
// route opens one already claimed (status generating).
export function photoRequestRow(
  conversationId: string,
  messageId: string | null,
  description: string,
  provider: string,
  model: string,
  status: "pending" | "generating" = "pending",
): VisualAssetRow {
  const id = newId("img");
  const t = nowIso();
  return {
    id,
    file: CANDIDATE_PREFIX + id + ".png",
    role: "candidate",
    sha256: null,
    bytes: null,
    approval_status: status,
    conversation_id: conversationId,
    message_id: messageId,
    prompt: description,
    provider,
    model,
    notes: status === "generating" ? CLAIM_NOTE + t : null,
    created_at: t,
    decided_at: null,
  };
}

// Finds or opens the request and claims it. A message that already carries a request is
// always resumed (a description from the owner replaces its prompt); a live claim by
// another request answers 409 in_progress and a finished photo 409 already_generated,
// whatever else the call carried. Without a message, a description opens a new request.
async function claimRequest(
  db: D1Database,
  conversationId: string,
  messageId: string | null,
  description: string | null | undefined,
  provider: string,
  model: string,
): Promise<VisualAssetRow> {
  const text = typeof description === "string" ? description.trim() : "";
  let row: VisualAssetRow | null = null;

  if (messageId) {
    const m = await getMessage(db, messageId);
    if (!m || m.conversation_id !== conversationId) {
      throw new ApiHttpError(404, "not_found", "message not found in this conversation");
    }
    if (m.image_id) {
      row = await getAsset(db, m.image_id);
      if (!row && !text) throw new ApiHttpError(404, "not_found", "photo request not found");
    } else if (!text) {
      throw new ApiHttpError(404, "not_found", "no photo request on this message");
    }
  }
  if (!text && !row) throw new ApiHttpError(400, "validation", "description is required");

  const t = nowIso();
  const note = CLAIM_NOTE + t;

  if (row) {
    if (row.role !== "candidate" || !isRequestStatus(row.approval_status)) {
      if (row.approval_status === "candidate" || row.approval_status === "approved" || row.approval_status === "rejected") {
        throw new ApiHttpError(409, "already_generated", "this photo already exists");
      }
      throw new ApiHttpError(409, "not_a_request", "asset is not a photo request");
    }
    if (row.approval_status === "generating" && !claimExpired(row.notes, Date.now())) {
      throw new ApiHttpError(409, "in_progress", "the photo is being generated");
    }
    const prompt = text || row.prompt;
    // Compare-and-set on the status and the claim note so two requests never both win.
    const res = await db
      .prepare("UPDATE visual_assets SET approval_status = 'generating', notes = ?2, prompt = ?5 WHERE id = ?1 AND approval_status = ?3 AND notes IS ?4")
      .bind(row.id, note, row.approval_status, row.notes, prompt)
      .run();
    if (!res.meta.changes) throw new ApiHttpError(409, "in_progress", "the photo is being generated");
    if (row.message_id) {
      await db.prepare("UPDATE messages SET image_status = 'pending' WHERE id = ?1 AND image_id = ?2").bind(row.message_id, row.id).run();
    }
    return { ...row, approval_status: "generating", notes: note, prompt };
  }

  const fresh = photoRequestRow(conversationId, messageId, text, provider, model, "generating");
  const stmts: D1PreparedStatement[] = [insertAssetStmt(db, fresh)];
  if (messageId) {
    stmts.push(db.prepare("UPDATE messages SET image_id = ?1, image_status = 'pending' WHERE id = ?2").bind(fresh.id, messageId));
  }
  await db.batch(stmts);
  return fresh;
}

// ------------------------------------------------------------------ masters

const MASTER_ORDER = ["master-04", "master-05", "master-03", "master-01", "master-02"];

export async function loadMasterBytes(env: Env, db: D1Database): Promise<Array<{ name: string; bytes: ArrayBuffer }>> {
  const rows = (await db
    .prepare("SELECT * FROM visual_assets WHERE role = 'master' AND approval_status = 'approved' ORDER BY file")
    .all<VisualAssetRow>()).results;
  if (!rows.length) throw new ProviderError("assets", "config", "no master images in the registry", 503, false);
  // The generator leans hardest on the first references: clearest faces first (Justin, 2026-09-25).
  const rank = (id: string): number => { const i = MASTER_ORDER.indexOf(id); return i < 0 ? MASTER_ORDER.length : i; };
  rows.sort((a, b) => rank(a.id) - rank(b.id) || a.file.localeCompare(b.file));

  return Promise.all(rows.map(async (r) => {
    // The hash is the identity. A master with no hash on file is not a reference (the same
    // rule verifyMasters applies), and neither is one whose bytes drifted from it.
    if (!r.sha256) throw new ProviderError("assets", "config", "master image has no recorded hash: " + r.file, 503, false);
    const cacheKey = r.file + "|" + r.sha256;
    const cached = masterCache.get(cacheKey);
    // A copy, so nothing downstream can detach or alter the cached buffer.
    if (cached) return { name: basename(r.file), bytes: cached.slice(0) };

    const res = await env.ASSETS.fetch(new Request(assetUrl(r.file)));
    if (!res.ok) throw new ProviderError("assets", "config", "master image missing: " + r.file, 503, false);
    const bytes = await res.arrayBuffer();
    const actual = await sha256Hex(bytes);
    if (actual !== r.sha256) throw new ProviderError("assets", "config", "master image hash mismatch: " + r.file, 503, false);
    masterCache.set(cacheKey, bytes.slice(0));
    return { name: basename(r.file), bytes };
  }));
}

// One asset's bytes for a derived picture (v3, SPEC_V3 FF: the source of a clip). A
// master is fetched from ASSETS and verified against its recorded hash, exactly as a
// reference set is; an approved scene photo comes from R2. Anything else is not a source.
export async function loadSourceBytes(env: Env, row: VisualAssetRow): Promise<ArrayBuffer> {
  const role = roleOf(row);
  if (role === "master") {
    if (row.approval_status !== "approved") throw new ApiHttpError(404, "not_found", "master is not approved");
    if (!row.sha256) throw new ProviderError("assets", "config", "master image has no recorded hash: " + row.file, 503, false);
    const cacheKey = row.file + "|" + row.sha256;
    const cached = masterCache.get(cacheKey);
    if (cached) return cached.slice(0);
    const res = await env.ASSETS.fetch(new Request(assetUrl(row.file)));
    if (!res.ok) throw new ProviderError("assets", "config", "master image missing: " + row.file, 503, false);
    const bytes = await res.arrayBuffer();
    const actual = await sha256Hex(bytes);
    if (actual !== row.sha256) throw new ProviderError("assets", "config", "master image hash mismatch: " + row.file, 503, false);
    masterCache.set(cacheKey, bytes.slice(0));
    return bytes;
  }
  if (role === "scene" && row.approval_status === "approved") {
    const obj = await env.MEDIA.get(row.file);
    if (!obj) throw new ApiHttpError(404, "not_found", "the photo's file is missing");
    return obj.arrayBuffer();
  }
  throw new ApiHttpError(404, "not_found", "the source must be a master or an approved photo");
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
  assetId: string;
  claimNote: string;
  provider: string;
  model: string;
  latencyMs: number;
  kind: string;
  message: string;
}

// The request row stays (status failed, the reason in notes) so the owner can retry it.
// Both updates are guarded: only this request's own claim, and only a message that still
// waits on this very row, are touched.
async function recordFailure(db: D1Database, f: FailureRecord): Promise<void> {
  const reason = f.kind + (f.message ? ": " + f.message : "");
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
    error: reason,
    flags_json: null,
    created_at: nowIso(),
  };
  const stmts: D1PreparedStatement[] = [
    insertModelRunStmt(db, run),
    db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating' AND notes = ?3")
      .bind(f.assetId, reason.slice(0, 300), f.claimNote),
  ];
  if (f.messageId) {
    stmts.push(db.prepare("UPDATE messages SET image_status = 'failed' WHERE id = ?1 AND image_id = ?2 AND image_status = 'pending'")
      .bind(f.messageId, f.assetId));
  }
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
  args: { conversationId: string; messageId: string | null; description?: string | null; actor: string },
): Promise<VisualAssetRow> {
  const { conversationId, messageId, actor } = args;
  const providerName = settings.imageProvider;
  const model = settings.imageModel;
  const started = Date.now();

  // 1. the request: resumed from the message, or opened for the owner. Claimed either way.
  const request = await claimRequest(db, conversationId, messageId, args.description, providerName, model);
  const description = (request.prompt ?? "").trim();
  const requestMessageId = request.message_id;
  const claimNote = request.notes ?? "";

  try {
    if (!description) throw new ApiHttpError(400, "validation", "description is required");
    if (!imageProviderConfigured(env, providerName)) {
      throw new ProviderError(providerName, "config", providerName + " image provider not configured", 503, false);
    }
    // A paid provider at a zero price would put every photo on the meter for free.
    if (!isKeylessImageProvider(providerName) && !(settings.imageCostUsd > 0)) {
      throw new ApiHttpError(402, "price_unknown", "imageCostUsd is 0 for image provider " + providerName + "; set the price per photo on the Model page", false);
    }
    await assertBudget(db, settings, settings.imageCostUsd);

    // 2. generate
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

    // 3. blacklist. A rejected hash stays refused; a real provider can still be asked again.
    const sha = await sha256Hex(result.png);
    const hit = await db
      .prepare("SELECT id FROM visual_assets WHERE approval_status = 'rejected' AND sha256 = ?1 LIMIT 1")
      .bind(sha)
      .first<{ id: string }>();
    if (hit) throw new ApiHttpError(422, "blacklisted", "candidate matches a rejected image", true, hit.id);

    // 4. store: the claim must still be ours before the bytes go to R2, then the row
    // becomes a candidate in one batch whose first statement is the same guard.
    const id = request.id;
    const key = CANDIDATE_PREFIX + id + ".png";
    const t = nowIso();
    const live = await db
      .prepare("SELECT 1 AS ok FROM visual_assets WHERE id = ?1 AND approval_status = 'generating' AND notes = ?2")
      .bind(id, claimNote)
      .first<{ ok: number }>();
    if (!live) throw new ClaimLostError();
    await env.MEDIA.put(key, result.png, { httpMetadata: { contentType: "image/png" } });

    const row: VisualAssetRow = {
      ...request,
      file: key,
      sha256: sha,
      bytes: result.png.byteLength,
      approval_status: "candidate",
      provider: providerName,
      model: result.model,
      notes: null,
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
      db.prepare("UPDATE visual_assets SET file = ?2, sha256 = ?3, bytes = ?4, approval_status = 'candidate', provider = ?5, model = ?6, notes = NULL WHERE id = ?1 AND approval_status = 'generating' AND notes = ?7")
        .bind(id, key, sha, row.bytes, providerName, row.model, claimNote),
      insertModelRunStmt(db, run),
      usageStmt(db, dayKey(), providerName, model, 0, 0, costMicro),
      auditStmt(db, actor, "image.generate", "visual_asset", id, null, {
        file: key, sha256: sha, bytes: row.bytes, conversation_id: conversationId, message_id: requestMessageId, provider: providerName, model,
      }),
    ];
    if (requestMessageId) {
      stmts.push(db.prepare("UPDATE messages SET image_id = ?1, image_status = 'ready' WHERE id = ?2 AND image_id = ?1 AND image_status = 'pending'")
        .bind(id, requestMessageId));
    }
    const results = await db.batch(stmts);
    if (!results[0]?.meta.changes) {
      console.warn("image claim lost before commit", id);
      throw new ClaimLostError();
    }
    return row;
  } catch (e) {
    if (e instanceof ClaimLostError) throw e;
    const kind = errorKind(e);
    const message = safeErrorMessage(e, 200);
    console.warn("image generation failed", kind, message);
    await recordFailure(db, {
      conversationId, messageId: requestMessageId, assetId: request.id, claimNote, provider: providerName, model,
      latencyMs: Date.now() - started, kind, message,
    });
    throw toApiError(e);
  }
}

// ------------------------------------------------------------------ decisions

// v3 (SPEC_V3 DD, FF): the rows of a portrait and a clip. VisualAssetRow.role in
// ../types is the pipeline lane's; these two roles are read through this view until it
// carries them (0001_init.sql has no CHECK on the column, so they insert as they are).
export type AssetRole = VisualAssetRow["role"] | "portrait" | "video";
export const PORTRAIT_PREFIX = "portraits/";
export const VIDEO_PREFIX = "videos/";
// A portrait row names its person in notes, while pending and after (SPEC_V3 DD).
const PERSON_NOTE = "person:";

export function roleOf(row: VisualAssetRow): AssetRole {
  return row.role as AssetRole;
}

// The thread id a portrait row was made for, from its notes ("person:<threadId>", which
// may be followed by a claim note or a decision note after " | ").
export function portraitThreadId(notes: string | null | undefined): string | null {
  if (typeof notes !== "string" || !notes.startsWith(PERSON_NOTE)) return null;
  const id = notes.slice(PERSON_NOTE.length).split("|")[0]?.trim() ?? "";
  return id && id.length <= 120 ? id : null;
}

// The current head of a life thread, whichever version id names it: the newest row in
// the chain that is not superseded (a dropped head is still the head).
async function threadHead(db: D1Database, threadId: string): Promise<{ id: string; portrait_asset_id: string | null } | null> {
  const r = await db.prepare(
    `WITH RECURSIVE up(id, sup, depth) AS (
       SELECT id, supersedes_id, 0 FROM life_threads WHERE id = ?1
       UNION ALL
       SELECT t.id, t.supersedes_id, up.depth + 1 FROM life_threads t JOIN up ON t.id = up.sup WHERE up.depth < 500
     ), down(id, depth) AS (
       SELECT (SELECT id FROM up WHERE sup IS NULL LIMIT 1), 0
       UNION ALL
       SELECT t.id, down.depth + 1 FROM life_threads t JOIN down ON t.supersedes_id = down.id WHERE down.depth < 500
     ) SELECT t.id AS id, t.portrait_asset_id AS portrait_asset_id FROM life_threads t JOIN down ON t.id = down.id
       WHERE t.status != 'superseded' ORDER BY t.version DESC LIMIT 1`,
  ).bind(threadId).first<{ id: string; portrait_asset_id: string | null }>();
  return r ?? null;
}

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
  const role = roleOf(row);
  if (role === "master") throw new ApiHttpError(403, "fixed_canon", "master images are not decided here");
  if (role !== "candidate" && role !== "scene" && role !== "portrait" && role !== "video") {
    throw new ApiHttpError(409, "not_decidable", "asset role is " + row.role);
  }
  if (isRequestStatus(row.approval_status)) throw new ApiHttpError(409, "not_ready", "the picture has not been generated");
  if (decision !== "approve" && decision !== "reject") throw new ApiHttpError(400, "validation", "decision must be approve or reject");

  const t = nowIso();
  const trimmedNote = typeof note === "string" ? note.trim() : "";
  const notes = trimmedNote ? (row.notes ? row.notes + " | " + trimmedNote : trimmedNote) : row.notes;
  const stmts: D1PreparedStatement[] = [];
  // A photo becomes a scene on approval; a portrait and a clip keep their role.
  const approvedRole: string = role === "candidate" ? "scene" : row.role;

  if (decision === "approve") {
    if (row.approval_status === "rejected") {
      throw new ApiHttpError(409, "already_rejected", "a rejected image cannot be approved; its file is gone");
    }
    stmts.push(db
      .prepare("UPDATE visual_assets SET approval_status = 'approved', role = ?4, decided_at = ?1, notes = ?2 WHERE id = ?3")
      .bind(t, notes, id, approvedRole));
    // A portrait approval (SPEC_V3 DD): the person's current head gets the face, and the
    // earlier approved portrait of that person, if any, goes to the archive. One face per person.
    if (role === "portrait") {
      const threadId = portraitThreadId(row.notes);
      const head = threadId ? await threadHead(db, threadId) : null;
      if (head) {
        if (head.portrait_asset_id && head.portrait_asset_id !== id) {
          stmts.push(db
            .prepare("UPDATE visual_assets SET approval_status = 'archive', decided_at = ?2 WHERE id = ?1 AND role = 'portrait' AND approval_status = 'approved'")
            .bind(head.portrait_asset_id, t));
        }
        stmts.push(db.prepare("UPDATE life_threads SET portrait_asset_id = ?1 WHERE id = ?2").bind(id, head.id));
      }
    }
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
    ? { ...row, approval_status: "approved", role: approvedRole as VisualAssetRow["role"], decided_at: t, notes }
    : { ...row, approval_status: "rejected", decided_at: t, notes };
  stmts.push(auditStmt(db, actor, "image." + decision, "visual_asset", id, row, after));
  await db.batch(stmts);

  const stored = await getAsset(db, id);
  return stored ?? after;
}

// ------------------------------------------------------------------ serving

// v1: a photo (candidate or scene) as image/png. v3 (SPEC_V3 DD, FF): a portrait as
// image/png and a clip (role video) as video/mp4 with Range support, so <video> can seek.
export async function serveMedia(env: Env, db: D1Database, id: string, range: string | null = null): Promise<Response> {
  if (!id || id.length > 80) return notFound();
  const row = await getAsset(db, id);
  if (!row) return notFound();
  const role = roleOf(row);
  const statusOk = row.approval_status === "candidate" || row.approval_status === "approved";
  const roleOk = role === "candidate" || role === "scene" || role === "portrait" || role === "video";
  if (!statusOk || !roleOk) return notFound();
  if (role === "video") return streamObject(env, row.file, "video/mp4", range);
  if (role === "portrait") return streamObject(env, row.file, "image/png", range);

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

// ------------------------------------------------------------------ regenerate (v2, SPEC_V2 section O)

// Reject this candidate (its hash joins the blacklist, its bytes go) and ask for the same
// picture again: a fresh request on the same message, through the same pipeline, held
// open by the page exactly like the first one. Only a candidate can be regenerated; an
// approved photo is canon and a request that has no picture yet is retried, not remade.
export async function regenerateImage(env: Env, db: D1Database, settings: Settings, id: string, actor: string): Promise<VisualAssetRow> {
  const row = await getAsset(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "asset not found");
  if (row.role !== "candidate" || row.approval_status !== "candidate") {
    throw new ApiHttpError(409, "not_candidate", "only a candidate can be regenerated");
  }
  const description = (row.prompt ?? "").trim();
  if (!description) throw new ApiHttpError(409, "no_description", "the candidate carries no description to regenerate from");
  if (!row.conversation_id) throw new ApiHttpError(409, "no_conversation", "the candidate belongs to no conversation");

  await decideImage(env, db, id, "reject", actor, "regenerate");
  if (row.message_id) {
    // The message lets go of the rejected row so a fresh request can open on it.
    await db.prepare("UPDATE messages SET image_id = NULL, image_status = NULL WHERE id = ?1 AND image_id = ?2").bind(row.message_id, id).run();
  }
  return generateCandidate(env, db, settings, { conversationId: row.conversation_id, messageId: row.message_id, description, actor });
}

// ------------------------------------------------------------------ v2 media: voice notes, his photos, the library

// Voice notes live at voice/<messageId>.mp3 (hers) and voice_in/<id>.<ext> (his), the
// key on messages.audio_key; his photos at inbox/<id>/<n>.<ext>, listed in
// messages.images_json; the owner's library at library/<id>.<ext>, one media_library row
// each. All private, all no-store, all after the owner gate. A column or table that a
// later migration adds answers 404 until it exists, never a crash.

interface AudioRow { audio_key: string | null }
interface InboxRow { images_json: string | null }
interface LibraryRow { id: string; key: string | null; mime: string | null; status: string | null }
export interface InboxImage { key: string; mime: string; width?: number | null; height?: number | null; bytes?: number | null }

const MAX_INBOX_IMAGES = 10;

async function firstOrNull<T>(stmt: D1PreparedStatement): Promise<T | null> {
  try {
    return await stmt.first<T>();
  } catch {
    return null;
  }
}

// messages.images_json as an array of { key, mime, ... }; a bare list of keys and the
// { images: [...] } wrapper are read too.
export function parseInboxImages(json: string | null | undefined): InboxImage[] {
  if (!json) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : typeof v === "object" && v !== null && Array.isArray((v as { images?: unknown }).images) ? (v as { images: unknown[] }).images : [];
  const out: InboxImage[] = [];
  for (const item of list) {
    if (typeof item === "string" && item) out.push({ key: item, mime: "" });
    else if (typeof item === "object" && item !== null && typeof (item as InboxImage).key === "string") {
      const i = item as InboxImage;
      out.push({ key: i.key, mime: typeof i.mime === "string" ? i.mime : "", width: i.width ?? null, height: i.height ?? null, bytes: i.bytes ?? null });
    }
    if (out.length >= MAX_INBOX_IMAGES) break;
  }
  return out;
}

// "bytes=start-end" against a known size, or null for the whole object. A range that
// cannot be satisfied is reported as such.
function parseRange(header: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

// Streams one private object, honouring a Range header so audio and video can seek.
async function streamObject(env: Env, key: string, contentType: string, range: string | null): Promise<Response> {
  const head = await env.MEDIA.head(key);
  if (!head) return notFound();
  const type = contentType || head.httpMetadata?.contentType || "application/octet-stream";
  const base: Record<string, string> = {
    "content-type": type,
    "cache-control": "private, no-store",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  const r = parseRange(range, head.size);
  if (r === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${head.size}` } });
  }
  const obj = r ? await env.MEDIA.get(key, { range: r }) : await env.MEDIA.get(key);
  if (!obj) return notFound();
  if (r) {
    return new Response(obj.body, {
      status: 206,
      headers: { ...base, "content-length": String(r.length), "content-range": `bytes ${r.offset}-${r.offset + r.length - 1}/${head.size}` },
    });
  }
  return new Response(obj.body, { status: 200, headers: { ...base, "content-length": String(head.size) } });
}

export async function serveAudio(env: Env, db: D1Database, messageId: string, range: string | null = null): Promise<Response> {
  if (!messageId || messageId.length > 80) return notFound();
  const row = await firstOrNull<AudioRow>(db.prepare("SELECT audio_key FROM messages WHERE id = ?1").bind(messageId));
  if (!row || !row.audio_key) return notFound();
  return streamObject(env, row.audio_key, "", range);
}

export async function serveInbox(env: Env, db: D1Database, messageId: string, index: string, range: string | null = null): Promise<Response> {
  if (!messageId || messageId.length > 80) return notFound();
  const n = /^\d{1,2}$/.test(index) ? Number(index) : -1;
  if (n < 0 || n >= MAX_INBOX_IMAGES) return notFound();
  const row = await firstOrNull<InboxRow>(db.prepare("SELECT images_json FROM messages WHERE id = ?1").bind(messageId));
  const img = parseInboxImages(row?.images_json)[n];
  if (!img) return notFound();
  return streamObject(env, img.key, img.mime, range);
}

export async function serveLibrary(env: Env, db: D1Database, id: string, range: string | null = null): Promise<Response> {
  if (!id || id.length > 80) return notFound();
  const row = await firstOrNull<LibraryRow>(db.prepare("SELECT id, key, mime, status FROM media_library WHERE id = ?1").bind(id));
  if (!row || !row.key || row.status === "deleted") return notFound();
  return streamObject(env, row.key, row.mime ?? "", range);
}
