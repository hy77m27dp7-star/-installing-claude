// People get faces (SPEC_V3 section DD). Owner-triggered only: a face is made when he
// presses Make portrait on a person and types the description. Nothing in v3 proposes,
// schedules or prompts one: not a life update, not the extractor, not a marker.
//
// The pipeline is the photo pipeline's claim and lease pattern (images.ts) with three
// differences: no master references (it is not her), a candid single-person prompt that
// carries the relation, and a text-to-image call (the provider's generateFromText). The
// row is visual_assets with role portrait, file portraits/<id>.png and notes
// person:<threadId>; approval walks the same states as a photo, and the decision route
// (images.ts) sets life_threads.portrait_asset_id on approve. One approved portrait per
// person.
import { auditStmt, dayKey, getAsset, insertAssetStmt, insertModelRunStmt, newId, nowIso, sha256Hex, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { assertBudget } from "./budget";
import { getImageProvider, imageProviderConfigured } from "./providers";
import { safeErrorMessage } from "./providers/types";
import { ProviderError } from "./types";
import type { Env, ImageGenerateResult, ImageProvider, ModelRunRow, Settings, VisualAssetRow } from "./types";
import type { LifeThread } from "./life";

export const PORTRAIT_PREFIX = "portraits/";
export const PERSON_NOTE_PREFIX = "person:";
export const PORTRAIT_DEFAULTS = { portraitCostUsd: 0.04, portraitSize: "1024x1024" } as const;
const MAX_DESCRIPTION = 1000;
const MICRO = 1_000_000;
// A generating row older than this is dead (the page that held the request is gone).
const CLAIM_LEASE_MS = 4 * 60 * 1000;
const SIZE_RE = /^\d{3,4}x\d{3,4}$/;
// The role the migration allows and types.ts gains in v3 (M3); read as the union here.
const PORTRAIT_ROLE = "portrait" as unknown as VisualAssetRow["role"];

// The text-to-image request the provider layer gains in v3 (src/providers, M4). Named
// here so this module compiles against the v2 provider shape and the v3 one alike.
export interface PortraitGenerateRequest {
  prompt: string;
  model: string;
  quality: "low" | "medium" | "high";
  size: string;
}

type TextToImageProvider = ImageProvider & {
  generateFromText?: (env: Env, req: PortraitGenerateRequest) => Promise<ImageGenerateResult>;
};

// ------------------------------------------------------------------ pure

export function personNote(threadId: string): string {
  return PERSON_NOTE_PREFIX + threadId;
}

// The thread id a portrait row belongs to, from its notes ("person:<id>" with an optional
// " | ..." tail after a failure). Null for anything else.
export function personThreadId(notes: string | null | undefined): string | null {
  if (typeof notes !== "string" || !notes.startsWith(PERSON_NOTE_PREFIX)) return null;
  const id = notes.slice(PERSON_NOTE_PREFIX.length).split(" | ")[0]?.trim() ?? "";
  return id || null;
}

// "A candid phone photo of one person: {description}. Realistic, natural light, no text,
// no collage, a single person, not a celebrity." plus "They are her {relation}." when the
// person has one. No reference images anywhere: it is not her.
export function portraitPrompt(description: string, relation: string | null | undefined): string {
  const d = String(description ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  let p = `A candid phone photo of one person: ${d}. Realistic, natural light, no text, no collage, a single person, not a celebrity.`;
  const r = typeof relation === "string" ? relation.replace(/\s+/g, " ").trim() : "";
  if (r) p += ` They are her ${r}.`;
  return p;
}

function portraitSettings(settings: Settings): { costUsd: number; size: string } {
  const s = settings as unknown as Record<string, unknown>;
  const cost = typeof s.portraitCostUsd === "number" && Number.isFinite(s.portraitCostUsd) && s.portraitCostUsd >= 0 ? s.portraitCostUsd : PORTRAIT_DEFAULTS.portraitCostUsd;
  const size = typeof s.portraitSize === "string" && SIZE_RE.test(s.portraitSize.trim()) ? s.portraitSize.trim() : PORTRAIT_DEFAULTS.portraitSize;
  return { costUsd: cost, size };
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
  return new ApiHttpError(500, "image_failed", safeErrorMessage(e), false);
}

class ClaimLostError extends ApiHttpError {
  constructor() {
    super(409, "in_progress", "another request took over this portrait", true);
    this.name = "ClaimLostError";
  }
}

// ------------------------------------------------------------------ db helpers

async function requirePerson(db: D1Database, threadId: string): Promise<LifeThread> {
  if (typeof threadId !== "string" || !threadId.trim()) throw new ApiHttpError(400, "validation", "thread id is required");
  const row = await db.prepare("SELECT * FROM life_threads WHERE id = ?1").bind(threadId).first<LifeThread>();
  if (!row) throw new ApiHttpError(404, "not_found", "life thread not found");
  if (row.status === "superseded") throw new ApiHttpError(409, "not_current", "only the current version of a person can get a portrait");
  if (row.status === "dropped") throw new ApiHttpError(409, "dropped", "restore the person before making a portrait");
  if (row.kind !== "person") throw new ApiHttpError(400, "validation", "portraits are for people (kind person)");
  return row;
}

// Every portrait row of a person, newest first (candidates, approved, rejected, failed).
export async function listPortraits(db: D1Database, threadId?: string | null): Promise<VisualAssetRow[]> {
  if (threadId) {
    const note = personNote(threadId);
    // The failure tail is " | ..."; the id's underscores are escaped so LIKE reads them literally.
    const pattern = note.replace(/[\\%_]/g, "\\$&") + " | %";
    const r = await db.prepare("SELECT * FROM visual_assets WHERE role = 'portrait' AND (notes = ?1 OR notes LIKE ?2 ESCAPE '\\') ORDER BY created_at DESC").bind(note, pattern).all<VisualAssetRow>();
    return r.results;
  }
  const r = await db.prepare("SELECT * FROM visual_assets WHERE role = 'portrait' ORDER BY created_at DESC").all<VisualAssetRow>();
  return r.results;
}

function claimExpired(createdAt: string, now: number): boolean {
  const since = Date.parse(createdAt);
  return !Number.isFinite(since) || now - since > CLAIM_LEASE_MS;
}

async function recordFailure(db: D1Database, args: { assetId: string; note: string; provider: string; model: string; latencyMs: number; kind: string; message: string }): Promise<void> {
  const reason = args.kind + (args.message ? ": " + args.message : "");
  const run: ModelRunRow = {
    id: newId("run"),
    conversation_id: null,
    kind: "image",
    provider: args.provider,
    model: args.model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: args.latencyMs,
    status: "failed",
    error: reason,
    flags_json: null,
    created_at: nowIso(),
  };
  try {
    await db.batch([
      insertModelRunStmt(db, run),
      db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating' AND notes = ?3")
        .bind(args.assetId, (args.note + " | failed: " + reason).slice(0, 300), args.note),
    ]);
  } catch (e) {
    console.error("portrait failure record not written", safeErrorMessage(e));
  }
}

// ------------------------------------------------------------------ generation

export async function generatePortrait(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { threadId: string; description: string; actor: string },
): Promise<VisualAssetRow> {
  const description = typeof args.description === "string" ? args.description.replace(/\s+/g, " ").trim() : "";
  if (!description) throw new ApiHttpError(400, "validation", "description is required");
  if (description.length > MAX_DESCRIPTION) throw new ApiHttpError(400, "validation", `description exceeds ${MAX_DESCRIPTION} characters`);
  const thread = await requirePerson(db, args.threadId);
  const providerName = settings.imageProvider;
  const model = settings.imageModel;
  const { costUsd, size } = portraitSettings(settings);
  const note = personNote(thread.id);
  const started = Date.now();

  // 1. the claim: one live request per person. A dead claim is marked failed and replaced.
  const existing = await listPortraits(db, thread.id);
  for (const row of existing) {
    if (row.approval_status !== "generating") continue;
    if (!claimExpired(row.created_at, started)) throw new ApiHttpError(409, "in_progress", "a portrait is being generated for this person");
    await db.prepare("UPDATE visual_assets SET approval_status = 'failed', notes = ?2 WHERE id = ?1 AND approval_status = 'generating'")
      .bind(row.id, (note + " | failed: lease expired").slice(0, 300)).run();
  }
  const id = newId("img");
  const t = nowIso();
  const request: VisualAssetRow = {
    id,
    file: PORTRAIT_PREFIX + id + ".png",
    role: PORTRAIT_ROLE,
    sha256: null,
    bytes: null,
    approval_status: "generating",
    conversation_id: null,
    message_id: null,
    prompt: description,
    provider: providerName,
    model,
    notes: note,
    created_at: t,
    decided_at: null,
  };
  await db.batch([insertAssetStmt(db, request)]);

  try {
    if (!imageProviderConfigured(env, providerName)) {
      throw new ProviderError(providerName, "config", providerName + " image provider not configured", 503, false);
    }
    const provider = getImageProvider(providerName) as TextToImageProvider;
    if (typeof provider.generateFromText !== "function") {
      throw new ProviderError(providerName, "config", "text-to-image is not available on " + providerName, 503, false);
    }
    await assertBudget(db, settings, costUsd);

    // 2. generate: no references, the relation in the prompt.
    const result = await provider.generateFromText(env, {
      prompt: portraitPrompt(description, thread.relation),
      model,
      quality: settings.imageQuality,
      size,
    });
    const latencyMs = Date.now() - started;

    // 3. blacklist: a rejected face never comes back.
    const sha = await sha256Hex(result.png);
    const hit = await db.prepare("SELECT id FROM visual_assets WHERE approval_status = 'rejected' AND sha256 = ?1 LIMIT 1").bind(sha).first<{ id: string }>();
    if (hit) throw new ApiHttpError(422, "blacklisted", "candidate matches a rejected image", true, hit.id);

    // 4. store: the claim must still be ours before the bytes go to R2, then the row
    // becomes a candidate in one batch whose first statement is the same guard.
    const live = await db.prepare("SELECT 1 AS ok FROM visual_assets WHERE id = ?1 AND approval_status = 'generating' AND notes = ?2").bind(id, note).first<{ ok: number }>();
    if (!live) throw new ClaimLostError();
    await env.MEDIA.put(request.file, result.png, { httpMetadata: { contentType: "image/png" } });

    const costMicro = Math.max(0, Math.round(costUsd * MICRO));
    const run: ModelRunRow = {
      id: newId("run"),
      conversation_id: null,
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
      created_at: nowIso(),
    };
    const row: VisualAssetRow = { ...request, sha256: sha, bytes: result.png.byteLength, approval_status: "candidate", model: result.model };
    const results = await db.batch([
      db.prepare("UPDATE visual_assets SET sha256 = ?2, bytes = ?3, approval_status = 'candidate', model = ?4 WHERE id = ?1 AND approval_status = 'generating' AND notes = ?5")
        .bind(id, sha, row.bytes, row.model, note),
      insertModelRunStmt(db, run),
      usageStmt(db, dayKey(), providerName, model, 0, 0, costMicro),
      auditStmt(db, args.actor, "portrait.generate", "visual_asset", id, null, {
        file: request.file, sha256: sha, bytes: row.bytes, thread_id: thread.id, provider: providerName, model, size,
      }),
    ]);
    if (!results[0]?.meta.changes) {
      console.warn("portrait claim lost before commit", id);
      throw new ClaimLostError();
    }
    const stored = await getAsset(db, id);
    return stored ?? row;
  } catch (e) {
    if (e instanceof ClaimLostError) throw e;
    const kind = errorKind(e);
    const message = safeErrorMessage(e, 200);
    console.warn("portrait generation failed", kind, message);
    await recordFailure(db, { assetId: id, note, provider: providerName, model, latencyMs: Date.now() - started, kind, message });
    throw toApiError(e);
  }
}
