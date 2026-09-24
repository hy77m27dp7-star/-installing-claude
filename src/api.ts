// Route table for /api/*. Handlers throw ApiHttpError (or a Response) and the wrapper
// renders every failure in the one JSON error shape. No handler reads identity from the
// request: the actor arrives already verified from index.ts.
import { ApiHttpError, errorResponse, json } from "./errors";
import {
  DEFAULT_SETTINGS, auditStmt, createConversation, getConversation, getMessage, getSettings, listAssets, listConversations,
  listMessages, listProposals, listStateVersions, mergedPrices, putSettings,
} from "./db";
import { runTurn } from "./chat";
import { operatorTurn, systemInfo } from "./operator";
import { usageSummary } from "./budget";
import { isKeylessImageProvider } from "./providers/index";
import { decideImage, generateCandidate, verifyMasters } from "./images";
import { decideProposal } from "./proposals";
import { exportAll, exportTranscript, importAll } from "./exportImport";
import {
  createFact, createHistory, createUnknown, deleteFact, deleteHistory, factVersions, getStateBundle, historyVersions, putState,
  restoreFact, restoreHistory, restoreState, updateFact, updateHistory, updateUnknown,
} from "./state";
import { safeErrorMessage } from "./providers/types";
import { ADAPTATIONS, ALWAYS_ON, CONSTITUTION_VERSION, OVERLAY } from "./generated/constitution";
import { PROMPT_VERSION } from "./prompt";
import type { Channel, Env, FactScope, ImageProviderName, ProposalKind, ProposalRow, ProviderName, Settings } from "./types";

// ------------------------------------------------------------------ router

interface RouteCtx {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  actor: string;
  url: URL;
  params: Record<string, string>;
  db: D1Database;
}

type Handler = (c: RouteCtx) => Promise<Response>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
}

function matchRoute(segments: string[], path: string[]): Record<string, string> | null {
  if (segments.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    const p = path[i] ?? "";
    if (s.startsWith(":")) {
      if (!p) return null;
      params[s.slice(1)] = p;
    } else if (s !== p) {
      return null;
    }
  }
  return params;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext, actor: string, url: URL): Promise<Response> {
  const path = url.pathname.split("/").filter(Boolean).map(safeDecode);
  let pathMatched = false;
  for (const r of routes) {
    const params = matchRoute(r.segments, path);
    if (!params) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;
    try {
      return await r.handler({ request, env, ctx, actor, url, params, db: env.DB });
    } catch (e) {
      if (e instanceof ApiHttpError || e instanceof Response) return errorResponse(e);
      // Class and a redacted message only; never a header, never a key.
      console.error("api error", request.method, url.pathname, e instanceof Error ? e.name : "error", safeErrorMessage(e, 200));
      return json({ error: safeErrorMessage(e, 200) || "internal error", code: "internal" }, 500);
    }
  }
  if (pathMatched) return json({ error: "method not allowed", code: "method_not_allowed" }, 405);
  return json({ error: "not found", code: "not_found" }, 404);
}

// ------------------------------------------------------------------ body helpers

type Body = Record<string, unknown>;

// Room for a full export (messages plus the log tables) and nothing like the 100 MB an
// isolate could be asked to parse.
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function invalid(message: string): ApiHttpError {
  return new ApiHttpError(400, "validation", message);
}

function tooLarge(): ApiHttpError {
  return new ApiHttpError(413, "too_large", "body exceeds " + MAX_BODY_BYTES + " bytes");
}

// A non-empty body must declare application/json: a browser form cannot, so a cross-site
// form post never reaches a handler as JSON.
async function readBody(request: Request): Promise<Body> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw invalid("body could not be read");
  }
  if (!raw.trim()) return {};
  if (raw.length > MAX_BODY_BYTES) throw tooLarge();
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json") throw new ApiHttpError(415, "unsupported_media_type", "body must be application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("body must be a JSON object");
  return parsed as Body;
}

function reqString(b: Body, key: string, max = 4000): string {
  const v = b[key];
  if (typeof v !== "string" || !v.trim()) throw invalid(`${key} is required`);
  if (v.length > max) throw invalid(`${key} exceeds ${max} characters`);
  return v;
}

// undefined when absent, null when null, the string otherwise.
function optString(b: Body, key: string, max = 4000): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  if (v.length > max) throw invalid(`${key} exceeds ${max} characters`);
  return v;
}

function optBool(b: Body, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw invalid(`${key} must be a boolean`);
  return v;
}

function oneOf<T extends string>(v: unknown, set: readonly T[], key: string): T {
  if (typeof v !== "string" || !(set as readonly string[]).includes(v)) throw invalid(`${key} must be one of ${set.join(", ")}`);
  return v as T;
}

function num(v: unknown, key: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${key} must be a number`);
  if (v < min || v > max) throw invalid(`${key} must be between ${min} and ${max}`);
  return v;
}

function int(v: unknown, key: string, min: number, max: number): number {
  const n = num(v, key, min, max);
  if (!Number.isInteger(n)) throw invalid(`${key} must be an integer`);
  return n;
}

function idParam(c: RouteCtx, name: string): string {
  const v = (c.params[name] ?? "").trim();
  if (!v || v.length > 120) throw invalid(`${name} is invalid`);
  return v;
}

function intQuery(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ------------------------------------------------------------------ settings validation

const PROVIDERS = ["anthropic", "openai", "workersai", "stub"] as const;
const IMAGE_PROVIDERS = ["openai", "stub"] as const;
const LEVELS = ["low", "medium", "high"] as const;
const SIZE_RE = /^(auto|\d{3,4}x\d{3,4})$/;

function validatePrices(v: unknown): Settings["prices"] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid("prices must be an object");
  const out: Settings["prices"] = {};
  for (const [model, p] of Object.entries(v as Record<string, unknown>)) {
    if (!model.trim() || model.length > 200) throw invalid("prices has an invalid model name");
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw invalid(`prices.${model} must be an object`);
    const price = p as Record<string, unknown>;
    out[model] = {
      inputPerMTok: num(price.inputPerMTok, `prices.${model}.inputPerMTok`, 0, 100000),
      outputPerMTok: num(price.outputPerMTok, `prices.${model}.outputPerMTok`, 0, 100000),
    };
  }
  return out;
}

// Local-only overlay: .dev.vars may name DEFAULT_PROVIDER / DEFAULT_IMAGE_PROVIDER so
// wrangler dev runs on the stub without touching the settings table. It applies only
// while ACCESS_AUD is empty, which production never is.
export function overlaySettings(env: Env, settings: Settings): Settings {
  if ((env.ACCESS_AUD ?? "").trim()) return settings;
  const out: Settings = { ...settings };
  const p = (env.DEFAULT_PROVIDER ?? "").trim();
  if ((PROVIDERS as readonly string[]).includes(p)) {
    out.provider = p as ProviderName;
    out.proposalProvider = p as ProviderName;
  }
  const ip = (env.DEFAULT_IMAGE_PROVIDER ?? "").trim();
  if ((IMAGE_PROVIDERS as readonly string[]).includes(ip)) out.imageProvider = ip as ImageProviderName;
  return out;
}

async function loadSettings(c: RouteCtx): Promise<Settings> {
  return overlaySettings(c.env, await getSettings(c.db));
}

export function validateSettingsPatch(body: Body): Partial<Settings> {
  for (const key of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) throw invalid("unknown setting: " + key);
  }
  const p: Partial<Settings> = {};
  const v = body;
  if (v.provider !== undefined) p.provider = oneOf(v.provider, PROVIDERS, "provider");
  if (v.model !== undefined) p.model = reqString(v, "model", 200).trim();
  if (v.effort !== undefined) p.effort = oneOf(v.effort, LEVELS, "effort");
  if (v.temperature !== undefined) p.temperature = num(v.temperature, "temperature", 0, 2);
  if (v.maxTokens !== undefined) p.maxTokens = int(v.maxTokens, "maxTokens", 64, 4000);
  if (v.proposalsEnabled !== undefined) {
    const b = optBool(v, "proposalsEnabled");
    if (b !== undefined) p.proposalsEnabled = b;
  }
  if (v.proposalProvider !== undefined) p.proposalProvider = oneOf(v.proposalProvider, PROVIDERS, "proposalProvider");
  if (v.proposalModel !== undefined) p.proposalModel = reqString(v, "proposalModel", 200).trim();
  if (v.imageProvider !== undefined) p.imageProvider = oneOf(v.imageProvider, IMAGE_PROVIDERS, "imageProvider");
  if (v.imageModel !== undefined) p.imageModel = reqString(v, "imageModel", 200).trim();
  if (v.imageQuality !== undefined) p.imageQuality = oneOf(v.imageQuality, LEVELS, "imageQuality");
  if (v.imageSize !== undefined) {
    const s = reqString(v, "imageSize", 20).trim();
    if (!SIZE_RE.test(s)) throw invalid("imageSize must look like 1024x1536 or auto");
    p.imageSize = s;
  }
  if (v.imageCostUsd !== undefined) p.imageCostUsd = num(v.imageCostUsd, "imageCostUsd", 0, 100);
  if (v.dailyCapUsd !== undefined) p.dailyCapUsd = num(v.dailyCapUsd, "dailyCapUsd", 0, 100000);
  if (v.monthlyCapUsd !== undefined) p.monthlyCapUsd = num(v.monthlyCapUsd, "monthlyCapUsd", 0, 1000000);
  if (v.contextRecentMessages !== undefined) p.contextRecentMessages = int(v.contextRecentMessages, "contextRecentMessages", 1, 400);
  if (v.contextMaxChars !== undefined) p.contextMaxChars = int(v.contextMaxChars, "contextMaxChars", 1000, 400000);
  if (v.prices !== undefined) p.prices = validatePrices(v.prices);
  return p;
}

// Rules that need the stored settings next to the patch. A model in use must be priced
// (an unpriced model would meter at $0 and no cap could trip), and a paid image provider
// needs a price per photo. The price table is read the way getSettings serves it: the
// stored entries over the built-in ones.
export function assertSettingsConsistent(current: Settings, patch: Partial<Settings>): void {
  const next = { ...current, ...patch };
  const prices = mergedPrices(next.prices);
  const touched = (key: keyof Settings): boolean => patch[key] !== undefined;
  for (const key of ["model", "proposalModel"] as const) {
    if (!touched(key) && !touched("prices")) continue;
    const model = String(next[key] ?? "").trim();
    const p = prices[model];
    if (!p || typeof p.inputPerMTok !== "number" || typeof p.outputPerMTok !== "number") {
      throw invalid(`${key} "${model}" has no entry in prices; add its price (USD per million tokens) in the Prices section of the Model page before selecting it`);
    }
  }
  if (touched("imageCostUsd") || touched("imageProvider")) {
    const cost = typeof next.imageCostUsd === "number" ? next.imageCostUsd : 0;
    if (!isKeylessImageProvider(next.imageProvider) && !(cost > 0)) {
      throw invalid(`imageCostUsd must be above 0 for image provider ${String(next.imageProvider)}; only a keyless provider may run at 0`);
    }
  }
}

// ------------------------------------------------------------------ identity and system

route("GET", "/api/me", async (c) => json({ email: c.actor, env: c.env.APP_ENV ?? null }));

route("GET", "/api/system", async (c) => {
  const settings = await loadSettings(c);
  return json(await systemInfo(c.env, c.db, settings));
});

// The Rulebook tab: what the build changed in the frozen files, and the always-on text.
route("GET", "/api/rulebook", async () => json({
  constitutionVersion: CONSTITUTION_VERSION,
  promptVersion: PROMPT_VERSION,
  adaptations: ADAPTATIONS.map((a) => `${a.file} ${a.id}: ${a.from} => ${a.to}`),
  overlay: OVERLAY,
  alwaysOn: ALWAYS_ON,
}));

// ------------------------------------------------------------------ conversations and turns

route("GET", "/api/conversations", async (c) => json(await listConversations(c.db)));

route("POST", "/api/conversations", async (c) => {
  const body = await readBody(c.request);
  const title = optString(body, "title", 200);
  const row = await createConversation(c.db, title && title.trim() ? title.trim() : null);
  await auditStmt(c.db, c.actor, "conversation.create", "conversation", row.id, null, row).run();
  return json(row, 201);
});

route("GET", "/api/conversations/:id/messages", async (c) => {
  const id = idParam(c, "id");
  const conv = await getConversation(c.db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const raw = c.url.searchParams.get("channel");
  let channel: Channel | undefined;
  if (raw !== null && raw !== "") channel = oneOf(raw, ["story", "operator"] as const, "channel");
  const limit = intQuery(c.url, "limit", 500, 1, 2000);
  return json(await listMessages(c.db, id, channel, limit));
});

route("DELETE", "/api/conversations/:id", async (c) => {
  const id = idParam(c, "id");
  const conv = await getConversation(c.db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  await c.db.batch([
    c.db.prepare("UPDATE conversations SET status = 'deleted' WHERE id = ?1").bind(id),
    auditStmt(c.db, c.actor, "conversation.delete", "conversation", id, conv, { ...conv, status: "deleted" }),
  ]);
  return json({ ok: true });
});

route("POST", "/api/conversations/:id/turn", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const content = reqString(body, "content", 20000);
  const idempotencyKey = reqString(body, "idempotencyKey", 200);
  const settings = await loadSettings(c);
  return json(await runTurn(c.env, c.ctx, c.db, settings, id, content, idempotencyKey, c.actor));
});

route("GET", "/api/messages/:id", async (c) => {
  const row = await getMessage(c.db, idParam(c, "id"));
  if (!row) throw new ApiHttpError(404, "not_found", "message not found");
  return json(row);
});

route("POST", "/api/operator", async (c) => {
  const body = await readBody(c.request);
  const content = reqString(body, "content", 20000);
  const conversationId = optString(body, "conversationId", 120);
  const settings = await loadSettings(c);
  return json(await operatorTurn(c.env, c.db, settings, content, conversationId ?? null, c.actor));
});

// ------------------------------------------------------------------ state

const ENTITIES = ["relationship", "scene"] as const;

route("GET", "/api/state", async (c) => json(await getStateBundle(c.db)));

async function putStateRoute(c: RouteCtx, entity: "relationship" | "scene"): Promise<Response> {
  const body = await readBody(c.request);
  const state = body.state;
  if (typeof state !== "object" || state === null || Array.isArray(state)) throw invalid("state must be a JSON object");
  const note = optString(body, "note", 1000);
  return json(await putState(c.db, entity, state as Record<string, unknown>, note ?? null, c.actor));
}

route("PUT", "/api/state/relationship", (c) => putStateRoute(c, "relationship"));
route("PUT", "/api/state/scene", (c) => putStateRoute(c, "scene"));

route("GET", "/api/state/versions/:entity", async (c) => {
  const entity = oneOf(c.params.entity, ENTITIES, "entity");
  const limit = intQuery(c.url, "limit", 50, 1, 500);
  return json(await listStateVersions(c.db, entity, limit));
});

route("POST", "/api/state/restore", async (c) => {
  const body = await readBody(c.request);
  const entity = oneOf(body.entity, ENTITIES, "entity");
  const version = int(body.version, "version", 1, Number.MAX_SAFE_INTEGER);
  return json(await restoreState(c.db, entity, version, c.actor));
});

// ------------------------------------------------------------------ facts

const FACT_SCOPES = ["fixed", "avelie", "justin", "shared"] as const;

route("POST", "/api/facts", async (c) => {
  const body = await readBody(c.request);
  const scope: FactScope = oneOf(body.scope, FACT_SCOPES, "scope");
  const row = await createFact(c.db, {
    scope,
    subject: optString(body, "subject", 200) ?? null,
    fact: reqString(body, "fact"),
    source: optString(body, "source", 500) ?? null,
    disclosed: optBool(body, "disclosed"),
    provisional: optBool(body, "provisional"),
  }, c.actor);
  return json(row, 201);
});

route("PUT", "/api/facts/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: Parameters<typeof updateFact>[2] = {};
  const fact = optString(body, "fact");
  if (fact !== undefined) {
    if (fact === null || !fact.trim()) throw invalid("fact cannot be empty");
    patch.fact = fact;
  }
  const subject = optString(body, "subject", 200);
  if (subject !== undefined) patch.subject = subject;
  const source = optString(body, "source", 500);
  if (source !== undefined) patch.source = source;
  const disclosed = optBool(body, "disclosed");
  if (disclosed !== undefined) patch.disclosed = disclosed;
  const provisional = optBool(body, "provisional");
  if (provisional !== undefined) patch.provisional = provisional;
  return json(await updateFact(c.db, id, patch, c.actor));
});

route("DELETE", "/api/facts/:id", async (c) => {
  await deleteFact(c.db, idParam(c, "id"), c.actor);
  return json({ ok: true });
});

route("POST", "/api/facts/:id/restore", async (c) => json(await restoreFact(c.db, idParam(c, "id"), c.actor)));

route("GET", "/api/facts/:id/versions", async (c) => json(await factVersions(c.db, idParam(c, "id"))));

// ------------------------------------------------------------------ history

route("POST", "/api/history", async (c) => {
  const body = await readBody(c.request);
  const row = await createHistory(c.db, {
    title: reqString(body, "title", 300),
    occurred: optString(body, "occurred", 200) ?? null,
    body: reqString(body, "body", 20000),
    what_changed: optString(body, "what_changed") ?? null,
    keep_consistent: optString(body, "keep_consistent") ?? null,
    source: optString(body, "source", 500) ?? null,
  }, c.actor);
  return json(row, 201);
});

route("PUT", "/api/history/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: Parameters<typeof updateHistory>[2] = {};
  const title = optString(body, "title", 300);
  if (title !== undefined) {
    if (title === null || !title.trim()) throw invalid("title cannot be empty");
    patch.title = title;
  }
  const text = optString(body, "body", 20000);
  if (text !== undefined) {
    if (text === null || !text.trim()) throw invalid("body cannot be empty");
    patch.body = text;
  }
  const occurred = optString(body, "occurred", 200);
  if (occurred !== undefined) patch.occurred = occurred;
  const whatChanged = optString(body, "what_changed");
  if (whatChanged !== undefined) patch.what_changed = whatChanged;
  const keepConsistent = optString(body, "keep_consistent");
  if (keepConsistent !== undefined) patch.keep_consistent = keepConsistent;
  const source = optString(body, "source", 500);
  if (source !== undefined) patch.source = source;
  return json(await updateHistory(c.db, id, patch, c.actor));
});

route("DELETE", "/api/history/:id", async (c) => {
  await deleteHistory(c.db, idParam(c, "id"), c.actor);
  return json({ ok: true });
});

route("POST", "/api/history/:id/restore", async (c) => json(await restoreHistory(c.db, idParam(c, "id"), c.actor)));

route("GET", "/api/history/:id/versions", async (c) => json(await historyVersions(c.db, idParam(c, "id"))));

// ------------------------------------------------------------------ unknowns

route("POST", "/api/unknowns", async (c) => {
  const body = await readBody(c.request);
  const row = await createUnknown(c.db, { topic: reqString(body, "topic", 500), note: optString(body, "note") ?? null }, c.actor);
  return json(row, 201);
});

route("PUT", "/api/unknowns/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: Parameters<typeof updateUnknown>[2] = {};
  if (body.status !== undefined) patch.status = oneOf(body.status, ["open", "resolved"] as const, "status");
  const note = optString(body, "note");
  if (note !== undefined) patch.note = note;
  const resolution = optString(body, "resolution");
  if (resolution !== undefined) patch.resolution = resolution;
  return json(await updateUnknown(c.db, id, patch, c.actor));
});

// ------------------------------------------------------------------ proposals

const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "edited", "all"] as const;
const PROPOSAL_KINDS = [
  "avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown",
] as const;

route("GET", "/api/proposals", async (c) => {
  const raw = c.url.searchParams.get("status");
  const status = raw === null || raw === "" ? "pending" : oneOf(raw, PROPOSAL_STATUSES, "status");
  const limit = intQuery(c.url, "limit", 200, 1, 1000);
  const rows = await listProposals(c.db, status === "all" ? undefined : (status as ProposalRow["status"]), limit);
  return json(rows);
});

route("POST", "/api/proposals/:id/decide", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const decision = oneOf(body.decision, ["approve", "reject", "edit"] as const, "decision");
  let edited: { proposal: string; kind?: ProposalKind } | undefined;
  if (body.edited !== undefined && body.edited !== null) {
    if (typeof body.edited !== "object" || Array.isArray(body.edited)) throw invalid("edited must be an object");
    const e = body.edited as Body;
    edited = { proposal: reqString(e, "proposal", 1000) };
    if (e.kind !== undefined && e.kind !== null) edited.kind = oneOf(e.kind, PROPOSAL_KINDS, "edited.kind");
  }
  const note = optString(body, "note", 1000);
  return json(await decideProposal(c.db, id, decision, c.actor, edited, note ?? undefined));
});

// ------------------------------------------------------------------ settings and usage

route("GET", "/api/settings", async (c) => json(await loadSettings(c)));

route("PUT", "/api/settings", async (c) => {
  const body = await readBody(c.request);
  const patch = validateSettingsPatch(body);
  const before = await getSettings(c.db);
  assertSettingsConsistent(before, patch);
  const after = await putSettings(c.db, patch);
  const keys = Object.keys(patch) as Array<keyof Settings>;
  const beforeSlice: Record<string, unknown> = {};
  const afterSlice: Record<string, unknown> = {};
  for (const k of keys) {
    beforeSlice[k] = before[k];
    afterSlice[k] = after[k];
  }
  if (keys.length) await auditStmt(c.db, c.actor, "settings.update", "settings", null, beforeSlice, afterSlice).run();
  return json(overlaySettings(c.env, after));
});

route("GET", "/api/usage", async (c) => {
  const settings = await loadSettings(c);
  return json(await usageSummary(c.db, settings));
});

route("GET", "/api/audit", async (c) => {
  const limit = intQuery(c.url, "limit", 100, 1, 500);
  const r = await c.db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?1").bind(limit).all();
  return json(r.results);
});

// ------------------------------------------------------------------ images

route("GET", "/api/assets", async (c) => {
  const rows = await listAssets(c.db);
  return json({
    masters: rows.filter((a) => a.role === "master"),
    candidates: rows.filter((a) => a.approval_status === "candidate"),
    scenes: rows.filter((a) => a.role === "scene" && a.approval_status === "approved"),
    rejected: rows.filter((a) => a.approval_status === "rejected"),
    archive: rows.filter((a) => a.role === "legacy_archive" || a.approval_status === "archive"),
  });
});

route("POST", "/api/assets/verify", async (c) => json(await verifyMasters(c.env, c.db)));

// With a description: the owner asks for a picture (attached to messageId when given).
// With messageId alone: the page resumes the photo request her message recorded; the
// request is held open for as long as the image call takes.
route("POST", "/api/images/generate", async (c) => {
  const body = await readBody(c.request);
  const conversationId = reqString(body, "conversationId", 120).trim();
  const description = optString(body, "description", 2000);
  const messageId = optString(body, "messageId", 120);
  const messageIdClean = messageId && messageId.trim() ? messageId.trim() : null;
  const descriptionClean = description && description.trim() ? description.trim() : null;
  if (!messageIdClean && !descriptionClean) throw invalid("description is required");
  const conv = await getConversation(c.db, conversationId);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const settings = await loadSettings(c);
  const asset = await generateCandidate(c.env, c.db, settings, {
    conversationId, messageId: messageIdClean, description: descriptionClean, actor: c.actor,
  });
  return json({ asset });
});

route("POST", "/api/images/:id/decide", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const decision = oneOf(body.decision, ["approve", "reject"] as const, "decision");
  const note = optString(body, "note", 1000);
  const asset = await decideImage(c.env, c.db, id, decision, c.actor, note ?? undefined);
  return json({ asset });
});

// ------------------------------------------------------------------ export and import

route("GET", "/api/export", async (c) => json(await exportAll(c.db, c.env)));

route("GET", "/api/export/transcript/:conversationId", async (c) => {
  const text = await exportTranscript(c.db, idParam(c, "conversationId"));
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
});

route("POST", "/api/import", async (c) => {
  const body = await readBody(c.request);
  const result = await importAll(c.db, body, c.actor);
  return json({ ok: true, ...result });
});
