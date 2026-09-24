// Route table for /api/*. Handlers throw ApiHttpError (or a Response) and the wrapper
// renders every failure in the one JSON error shape. No handler reads identity from the
// request: the actor arrives already verified from index.ts.
//
// v2 (SPEC_V2): her life (threads, log), provenance per message, she opens, real-mode
// timing on the message list, regenerate, drift check, her first texts, voice in, photos
// in (multipart turn), push, the owner's media library, timeline, voiceprint, character
// export, and the new settings.
import { ApiHttpError, errorResponse, json } from "./errors";
import {
  DEFAULT_SETTINGS, auditStmt, createConversation, getConversation, getMessage, getSettings, listAssets, listConversations,
  listMessages, listMessagesVisible, listProposals, listStateVersions, mergedPrices, newId, nowIso, putSettings, sha256Hex,
} from "./db";
import { runTurn } from "./chat";
import type { TurnOptions } from "./chat";
import { operatorTurn, systemInfo } from "./operator";
import { usageSummary } from "./budget";
import { isKeylessImageProvider } from "./providers/index";
import { decideImage, generateCandidate, regenerateImage, verifyMasters } from "./images";
import type { InboxImage } from "./images";
import { decideProposal } from "./proposals";
import { exportAll, exportTranscript, importAll } from "./exportImport";
import {
  createFact, createHistory, createUnknown, deleteFact, deleteHistory, factVersions, getStateBundle, historyVersions, putState,
  restoreFact, restoreHistory, restoreState, updateFact, updateHistory, updateUnknown,
} from "./state";
import { createThread, dropThread, listLog, listThreads, logLife, restoreThread, updateThread } from "./life";
import { readContext } from "./provenance";
import { listDrift, runDrift } from "./drift";
import { maybeTextFirst } from "./herfirst";
import { subscribe as pushSubscribe, unsubscribe as pushUnsubscribe } from "./push";
import { getTimeline } from "./timeline";
import { listVoiceprints, runVoiceprint } from "./voiceprint";
import { exportCharacterJson, exportCharacterMarkdown } from "./exportCharacter";
import { transcribe } from "./voice";
import { safeErrorMessage } from "./providers/types";
import { ADAPTATIONS, ALWAYS_ON, CONSTITUTION_VERSION, OVERLAY } from "./generated/constitution";
import { PROMPT_VERSION } from "./prompt";
import { ProviderError } from "./types";
import type {
  Channel, Env, FactScope, ImageProviderName, MessageRow, ProposalKind, ProposalRow, ProviderName, Settings, TurnResponse,
} from "./types";

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
      if (e instanceof ProviderError) return errorResponse(providerToApi(e));
      // Class and a redacted message only; never a header, never a key.
      console.error("api error", request.method, url.pathname, e instanceof Error ? e.name : "error", safeErrorMessage(e, 200));
      return json({ error: safeErrorMessage(e, 200) || "internal error", code: "internal" }, 500);
    }
  }
  if (pathMatched) return json({ error: "method not allowed", code: "method_not_allowed" }, 405);
  return json({ error: "not found", code: "not_found" }, 404);
}

// A provider failure that reaches a route (voice transcription, for one) in the turn's shape.
function providerToApi(e: ProviderError): ApiHttpError {
  const message = safeErrorMessage(e);
  if (e.kind === "config") return new ApiHttpError(503, "provider_not_configured", message, false, e.provider);
  return new ApiHttpError(502, "provider_failed", message, e.retryable, e.kind);
}

// ------------------------------------------------------------------ body helpers

type Body = Record<string, unknown>;

// Room for a full export (messages plus the log tables) and nothing like the 100 MB an
// isolate could be asked to parse.
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function invalid(message: string): ApiHttpError {
  return new ApiHttpError(400, "validation", message);
}

function tooLarge(limit = MAX_BODY_BYTES): ApiHttpError {
  return new ApiHttpError(413, "too_large", "body exceeds " + limit + " bytes");
}

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isMultipart(request: Request): boolean {
  return mediaType(request) === "multipart/form-data";
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
  if (mediaType(request) !== "application/json") throw new ApiHttpError(415, "unsupported_media_type", "body must be application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("body must be a JSON object");
  return parsed as Body;
}

// Multipart bodies (his photos, a voice note, a library upload). The declared length is
// checked before anything is read; each file is checked again against its own limit.
async function readForm(request: Request, maxBytes: number): Promise<FormData> {
  if (!isMultipart(request)) throw new ApiHttpError(415, "unsupported_media_type", "body must be multipart/form-data");
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  try {
    return await request.formData();
  } catch {
    throw invalid("multipart body could not be read");
  }
}

function formString(form: FormData, key: string, max: number, required: boolean): string {
  const v = form.get(key);
  if (v === null || typeof v !== "string") {
    if (required) throw invalid(`${key} is required`);
    return "";
  }
  if (required && !v.trim()) throw invalid(`${key} is required`);
  if (v.length > max) throw invalid(`${key} exceeds ${max} characters`);
  return v;
}

function formFiles(form: FormData, key: string): File[] {
  return form.getAll(key).filter((v): v is File => typeof v !== "string");
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

function flagQuery(url: URL, key: string): boolean {
  const raw = (url.searchParams.get(key) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// A JSON string column that the page may send as a string or as the object itself.
function optJsonString(b: Body, key: string, max = 4000): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") {
    if (v.length > max) throw invalid(`${key} exceeds ${max} characters`);
    return v.trim() ? v : null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const s = JSON.stringify(v);
    if (s.length > max) throw invalid(`${key} exceeds ${max} characters`);
    return s;
  }
  throw invalid(`${key} must be a JSON string or object`);
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await env.MEDIA.delete(keys);
  } catch (e) {
    console.warn("media delete failed", safeErrorMessage(e, 120));
  }
}

// ------------------------------------------------------------------ bytes: what a file really is

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/flac": "flac",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

const VOICE_MIMES: ReadonlySet<string> = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/mpeg", "audio/wav", "audio/x-wav", "video/webm"]);

function extFor(mime: string): string {
  return EXT_BY_MIME[mime] ?? "bin";
}

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number): number => ((u16be(b, i) << 16) | u16be(b, i + 2)) >>> 0;
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...Array.from(b.slice(i, i + n)));

// Image type and size from the bytes themselves (never from the declared type): PNG,
// JPEG or WebP, or null for anything else.
export function sniffImage(b: Uint8Array): { mime: string; width: number | null; height: number | null } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && ascii(b, 12, 4) === "IHDR") {
    return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let width: number | null = null;
    let height: number | null = null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = u16be(b, i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = u16be(b, i + 5);
        width = u16be(b, i + 7);
        break;
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { mime: "image/jpeg", width, height };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === "VP8L") {
      const b0 = b[21] ?? 0;
      const b1 = b[22] ?? 0;
      const b2 = b[23] ?? 0;
      const b3 = b[24] ?? 0;
      return { mime: "image/webp", width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
    }
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
    return { mime: "image/webp", width: null, height: null };
  }
  return null;
}

// ------------------------------------------------------------------ settings validation

const PROVIDERS = ["anthropic", "openai", "workersai", "stub"] as const;
const IMAGE_PROVIDERS = ["openai", "stub"] as const;
const LEVELS = ["low", "medium", "high"] as const;
const SIZE_RE = /^(auto|\d{3,4}x\d{3,4})$/;
// v2
const REPLY_DELAY_MODES = ["instant", "real"] as const;
const VOICE_PROVIDERS = ["elevenlabs", "workersai", "stub", "off"] as const;
const VOICE_MODES = ["off", "some", "all"] as const;
const TRANSCRIBE_PROVIDERS = ["workersai", "openai", "stub"] as const;
const QUIET_HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TZ_CHARS = 64;
// Settings SPEC_V2 sections R and S add. Validated here even before DEFAULT_SETTINGS
// carries them: getSettings lays stored keys over the defaults, so they round-trip.
const V2_EXTRA_KEYS: readonly string[] = ["herFirstTextsPerDay", "herFirstQuietHours", "voiceProvider", "voiceMode", "elevenLabsVoiceId", "transcribeProvider"];

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

// A timezone is whatever Intl accepts (an IANA name such as America/New_York).
export function validTimezone(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > MAX_TZ_CHARS) throw invalid("timezone must be an IANA name");
  const tz = v.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw invalid("timezone is not a known IANA name");
  }
  return tz;
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
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) && !V2_EXTRA_KEYS.includes(key)) throw invalid("unknown setting: " + key);
  }
  const p: Record<string, unknown> = {};
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
  // v2: her timing, the drift check, her timezone (SPEC_V2 B, F, N)
  if (v.replyDelayMode !== undefined) p.replyDelayMode = oneOf(v.replyDelayMode, REPLY_DELAY_MODES, "replyDelayMode");
  if (v.realDelayMaxMinutes !== undefined) p.realDelayMaxMinutes = int(v.realDelayMaxMinutes, "realDelayMaxMinutes", 1, 120);
  if (v.driftCheckEnabled !== undefined) {
    const b = optBool(v, "driftCheckEnabled");
    if (b !== undefined) p.driftCheckEnabled = b;
  }
  if (v.timezone !== undefined) p.timezone = validTimezone(v.timezone);
  // v2: her first texts and the voices (SPEC_V2 R, S)
  if (v.herFirstTextsPerDay !== undefined) p.herFirstTextsPerDay = int(v.herFirstTextsPerDay, "herFirstTextsPerDay", 0, 10);
  if (v.herFirstQuietHours !== undefined) {
    const s = reqString(v, "herFirstQuietHours", 11).trim();
    if (!QUIET_HOURS_RE.test(s)) throw invalid("herFirstQuietHours must look like 23:30-08:30");
    p.herFirstQuietHours = s;
  }
  if (v.voiceProvider !== undefined) p.voiceProvider = oneOf(v.voiceProvider, VOICE_PROVIDERS, "voiceProvider");
  if (v.voiceMode !== undefined) p.voiceMode = oneOf(v.voiceMode, VOICE_MODES, "voiceMode");
  if (v.elevenLabsVoiceId !== undefined) {
    const s = optString(v, "elevenLabsVoiceId", 200);
    p.elevenLabsVoiceId = typeof s === "string" ? s.trim() : "";
  }
  if (v.transcribeProvider !== undefined) p.transcribeProvider = oneOf(v.transcribeProvider, TRANSCRIBE_PROVIDERS, "transcribeProvider");
  return p as Partial<Settings>;
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

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VOICE_BYTES = 4 * 1024 * 1024;
const FORM_SLACK = 64 * 1024;
const INBOX_PREFIX = "inbox/";
const VOICE_IN_PREFIX = "voice_in/";

// The one-time operator note for an opener (SPEC_V2 section Q). He never sees it.
const OPENER_NOTE =
  "Start the conversation yourself from your own day or something you remember. One or two bubbles. "
  + "Do not ask him to reply, do not mention how long it has been, do not say you missed him.";

// The throwaway conversations of the drift check never show in the list.
route("GET", "/api/conversations", async (c) => json((await listConversations(c.db)).filter((r) => r.status !== "drift")));

route("POST", "/api/conversations", async (c) => {
  const body = await readBody(c.request);
  const title = optString(body, "title", 200);
  const row = await createConversation(c.db, title && title.trim() ? title.trim() : null);
  await auditStmt(c.db, c.actor, "conversation.create", "conversation", row.id, null, row).run();
  return json(row, 201);
});

// Real-mode timing (SPEC_V2 section B): a reply whose deliver_at is still ahead is left
// out unless ?includePending=1 (the page asks for it and shows dots until the time).
route("GET", "/api/conversations/:id/messages", async (c) => {
  const id = idParam(c, "id");
  const conv = await getConversation(c.db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const raw = c.url.searchParams.get("channel");
  let channel: Channel | undefined;
  if (raw !== null && raw !== "") channel = oneOf(raw, ["story", "operator"] as const, "channel");
  const limit = intQuery(c.url, "limit", 500, 1, 2000);
  if (flagQuery(c.url, "includePending")) return json(await listMessages(c.db, id, channel, limit));
  return json(await listMessagesVisible(c.db, id, channel, new Date(), limit));
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

// His photos (SPEC_V2 section T): up to three jpeg, png or webp files, 8 MB each, judged
// by their bytes. They are stored under inbox/<id>/<n>.<ext> before the turn and listed on
// his message (images_json) once it is committed; a turn that stores nothing (a replay, a
// failed model call) leaves nothing behind.
async function multipartTurn(c: RouteCtx, id: string): Promise<Response> {
  const form = await readForm(c.request, MAX_IMAGES * MAX_IMAGE_BYTES + FORM_SLACK);
  const content = formString(form, "content", 20000, true);
  const idempotencyKey = formString(form, "idempotencyKey", 200, true);
  const files = formFiles(form, "image");
  if (files.length > MAX_IMAGES) throw invalid(`at most ${MAX_IMAGES} images`);
  for (const f of files) if (f.size > MAX_IMAGE_BYTES) throw tooLarge(MAX_IMAGE_BYTES);
  const conv = await getConversation(c.db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const settings = await loadSettings(c);

  const inboxId = newId("in");
  const stored: InboxImage[] = [];
  try {
    for (let n = 0; n < files.length; n++) {
      const bytes = new Uint8Array(await files[n]!.arrayBuffer());
      const sniff = sniffImage(bytes);
      if (!sniff) throw new ApiHttpError(415, "unsupported_media_type", "image must be jpeg, png or webp");
      const key = `${INBOX_PREFIX}${inboxId}/${n}.${extFor(sniff.mime)}`;
      await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: sniff.mime } });
      stored.push({ key, mime: sniff.mime, width: sniff.width, height: sniff.height, bytes: bytes.byteLength });
    }
  } catch (e) {
    await deleteKeys(c.env, stored.map((s) => s.key));
    throw e;
  }

  // The images ride on the options so the turn can show them to the model.
  const opts: TurnOptions & { images: InboxImage[] } = { images: stored };
  let r: TurnResponse;
  try {
    r = await runTurn(c.env, c.ctx, c.db, settings, id, content, idempotencyKey, c.actor, stored.length ? opts : undefined);
  } catch (e) {
    await deleteKeys(c.env, stored.map((s) => s.key));
    throw e;
  }
  let images: InboxImage[] = [];
  if (stored.length) {
    if (!r.replayed && r.userMessage) {
      try {
        await c.db.prepare("UPDATE messages SET images_json = ?1 WHERE id = ?2").bind(JSON.stringify(stored), r.userMessage.id).run();
        images = stored;
      } catch (e) {
        console.warn("images_json not written", safeErrorMessage(e, 120));
        await deleteKeys(c.env, stored.map((s) => s.key));
      }
    } else {
      await deleteKeys(c.env, stored.map((s) => s.key));
    }
  }
  return json({ ...r, images: images.map((i) => ({ mime: i.mime, width: i.width ?? null, height: i.height ?? null, bytes: i.bytes ?? null })) });
}

route("POST", "/api/conversations/:id/turn", async (c) => {
  const id = idParam(c, "id");
  if (isMultipart(c.request)) return multipartTurn(c, id);
  const body = await readBody(c.request);
  const content = reqString(body, "content", 20000);
  const idempotencyKey = reqString(body, "idempotencyKey", 200);
  const settings = await loadSettings(c);
  return json(await runTurn(c.env, c.ctx, c.db, settings, id, content, idempotencyKey, c.actor));
});

// She opens (SPEC_V2 section Q): a turn with no message of his and the one-time note.
// Refused while his last message is still unanswered (a failed send is retried, not
// talked over). No scheduling and no notification live here.
route("POST", "/api/conversations/:id/open", async (c) => {
  const id = idParam(c, "id");
  const conv = await getConversation(c.db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const last = await c.db
    .prepare("SELECT role FROM messages WHERE conversation_id = ?1 AND channel = 'story' ORDER BY seq DESC LIMIT 1")
    .bind(id)
    .first<{ role: string }>();
  if (last && last.role === "user") throw new ApiHttpError(409, "his_turn", "his last message has no reply yet");
  const settings = await loadSettings(c);
  return json(await runTurn(c.env, c.ctx, c.db, settings, id, "", "", c.actor, { openerNote: OPENER_NOTE }));
});

// A transcribed voice note as read from the provider: a string, or { text }.
function transcriptText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text.trim();
  return "";
}

// His voice (SPEC_V2 section S): the recording goes to R2, the words go through the
// normal turn, and his message keeps the recording's key.
route("POST", "/api/conversations/:id/voice", async (c) => {
  const id = idParam(c, "id");
  const form = await readForm(c.request, MAX_VOICE_BYTES + FORM_SLACK);
  const audio = formFiles(form, "audio")[0];
  if (!audio) throw invalid("audio is required");
  if (audio.size > MAX_VOICE_BYTES) throw tooLarge(MAX_VOICE_BYTES);
  if (!audio.size) throw invalid("audio is empty");
  const idempotencyKey = formString(form, "idempotencyKey", 200, true);
  let mime = (audio.type || "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) {
    const ext = (audio.name || "").split(".").pop()?.toLowerCase() ?? "";
    mime = ext === "m4a" || ext === "mp4" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : "audio/webm";
  }
  if (!VOICE_MIMES.has(mime)) throw new ApiHttpError(415, "unsupported_media_type", "audio must be webm, ogg, mp4, mpeg or wav");
  const conv = await getConversation(c.db, id);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const settings = await loadSettings(c);

  const bytes = await audio.arrayBuffer();
  const key = VOICE_IN_PREFIX + newId("vin") + "." + extFor(mime);
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });

  let transcript: string;
  try {
    transcript = transcriptText(await transcribe(c.env, settings, bytes, mime));
  } catch (e) {
    await deleteKeys(c.env, [key]);
    if (e instanceof ProviderError) throw providerToApi(e);
    throw e;
  }
  if (!transcript) {
    await deleteKeys(c.env, [key]);
    throw new ApiHttpError(422, "empty_transcript", "nothing was heard in the recording", true);
  }

  let r: TurnResponse;
  try {
    r = await runTurn(c.env, c.ctx, c.db, settings, id, transcript, idempotencyKey, c.actor);
  } catch (e) {
    await deleteKeys(c.env, [key]);
    throw e;
  }
  let audioKey: string | null = null;
  if (!r.replayed && r.userMessage) {
    try {
      await c.db.prepare("UPDATE messages SET audio_key = ?1 WHERE id = ?2").bind(key, r.userMessage.id).run();
      audioKey = key;
    } catch (e) {
      console.warn("audio_key not written", safeErrorMessage(e, 120));
      await deleteKeys(c.env, [key]);
    }
  } else {
    await deleteKeys(c.env, [key]);
  }
  return json({ ...r, transcript, audioKey });
});

route("GET", "/api/messages/:id", async (c) => {
  const row = await getMessage(c.db, idParam(c, "id"));
  if (!row) throw new ApiHttpError(404, "not_found", "message not found");
  return json(row);
});

// Why she said that (SPEC_V2 section L): the ids the turn was built from, nothing else.
route("GET", "/api/messages/:id/context", async (c) => {
  const id = idParam(c, "id");
  const ctx = await readContext(c.db, id);
  if (!ctx) throw new ApiHttpError(404, "not_found", "no context for this message");
  return json(ctx);
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

// ------------------------------------------------------------------ her life (SPEC_V2 section F)

const LIFE_KINDS = ["routine", "event", "person", "place", "arc"] as const;
const LIFE_STATUSES = ["active", "done", "dropped", "superseded"] as const;
const THREAD_STATUS_PATCH = ["active", "done"] as const;

route("GET", "/api/life", async (c) => {
  const raw = c.url.searchParams.get("status");
  const status = raw === null || raw === "" ? undefined : oneOf(raw, LIFE_STATUSES, "status");
  const limit = intQuery(c.url, "limit", 100, 1, 500);
  const [threads, log] = await Promise.all([listThreads(c.db, status), listLog(c.db, limit)]);
  return json({ threads, log });
});

route("POST", "/api/life/threads", async (c) => {
  const body = await readBody(c.request);
  const row = await createThread(c.db, {
    kind: oneOf(body.kind, LIFE_KINDS, "kind"),
    title: reqString(body, "title", 300),
    detail: optString(body, "detail") ?? null,
    schedule_json: optJsonString(body, "schedule_json") ?? null,
    relation: optString(body, "relation", 200) ?? null,
    source: optString(body, "source", 500) ?? null,
  }, c.actor);
  return json(row, 201);
});

route("PUT", "/api/life/threads/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: Parameters<typeof updateThread>[2] = {};
  const title = optString(body, "title", 300);
  if (title !== undefined) {
    if (title === null || !title.trim()) throw invalid("title cannot be empty");
    patch.title = title;
  }
  const detail = optString(body, "detail");
  if (detail !== undefined) patch.detail = detail;
  const schedule = optJsonString(body, "schedule_json");
  if (schedule !== undefined) patch.schedule_json = schedule;
  const relation = optString(body, "relation", 200);
  if (relation !== undefined) patch.relation = relation;
  if (body.status !== undefined && body.status !== null) patch.status = oneOf(body.status, THREAD_STATUS_PATCH, "status");
  return json(await updateThread(c.db, id, patch, c.actor));
});

route("DELETE", "/api/life/threads/:id", async (c) => {
  await dropThread(c.db, idParam(c, "id"), c.actor);
  return json({ ok: true });
});

route("POST", "/api/life/threads/:id/restore", async (c) => json(await restoreThread(c.db, idParam(c, "id"), c.actor)));

route("POST", "/api/life/log", async (c) => {
  const body = await readBody(c.request);
  const threadId = optString(body, "threadId", 120);
  const row = await logLife(
    c.db,
    threadId && threadId.trim() ? threadId.trim() : null,
    reqString(body, "occurred", 64),
    reqString(body, "note"),
    optString(body, "source", 500) ?? null,
    c.actor,
  );
  return json(row, 201);
});

// ------------------------------------------------------------------ proposals

const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "edited", "all"] as const;
const PROPOSAL_KINDS = [
  "avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown", "life",
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
  const beforeAny = before as unknown as Record<string, unknown>;
  const after = await putSettings(c.db, patch);
  const afterAny = after as unknown as Record<string, unknown>;
  const keys = Object.keys(patch);
  const beforeSlice: Record<string, unknown> = {};
  const afterSlice: Record<string, unknown> = {};
  for (const k of keys) {
    beforeSlice[k] = beforeAny[k];
    afterSlice[k] = afterAny[k];
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

// Reject this candidate and ask again with the same description (SPEC_V2 section O). The
// page holds the request open, as for any picture.
route("POST", "/api/images/:id/regenerate", async (c) => {
  const id = idParam(c, "id");
  const settings = await loadSettings(c);
  const asset = await regenerateImage(c.env, c.db, settings, id, c.actor);
  return json({ asset });
});

// ------------------------------------------------------------------ drift check (SPEC_V2 section N)

route("POST", "/api/drift/run", async (c) => {
  const settings = await loadSettings(c);
  const report = await runDrift(c.env, c.db, settings);
  return json({ report });
});

route("GET", "/api/drift", async (c) => json(await listDrift(c.db, intQuery(c.url, "limit", 4, 1, 52))));

// ------------------------------------------------------------------ her first texts (SPEC_V2 section R)

// One tick by hand: the same decision the 20-minute cron makes, with the same rules.
route("POST", "/api/herfirst/run", async (c) => {
  const settings = await loadSettings(c);
  const r: unknown = await maybeTextFirst(c.env, c.db, settings, new Date());
  return json(typeof r === "object" && r !== null ? r : { result: r ?? null });
});

// ------------------------------------------------------------------ push (SPEC_V2 section U)

type EnvSecrets = Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };

const MAX_ENDPOINT_CHARS = 2000;
const MAX_KEY_CHARS = 512;

function pushPublicKey(env: Env): string | null {
  const k = ((env as EnvSecrets).VAPID_PUBLIC_KEY ?? "").trim();
  return k || null;
}

function validEndpoint(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > MAX_ENDPOINT_CHARS) throw invalid("endpoint is required");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw invalid("endpoint must be a URL");
  }
  if (u.protocol !== "https:") throw invalid("endpoint must be https");
  return u.toString();
}

route("GET", "/api/push/public-key", async (c) => {
  const publicKey = pushPublicKey(c.env);
  return json({ publicKey, configured: publicKey !== null });
});

route("POST", "/api/push/subscribe", async (c) => {
  const body = await readBody(c.request);
  const endpoint = validEndpoint(body.endpoint);
  const keys = body.keys;
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) throw invalid("keys is required");
  const k = keys as Body;
  const p256dh = reqString(k, "p256dh", MAX_KEY_CHARS).trim();
  const auth = reqString(k, "auth", MAX_KEY_CHARS).trim();
  const expirationTime = typeof body.expirationTime === "number" && Number.isFinite(body.expirationTime) ? body.expirationTime : null;
  await pushSubscribe(c.db, { endpoint, expirationTime, keys: { p256dh, auth } });
  await auditStmt(c.db, c.actor, "push.subscribe", "push_subscription", null, null, { endpointHost: new URL(endpoint).host }).run();
  return json({ ok: true, configured: pushPublicKey(c.env) !== null });
});

route("DELETE", "/api/push/subscribe", async (c) => {
  const body = await readBody(c.request);
  const endpoint = validEndpoint(body.endpoint);
  await pushUnsubscribe(c.db, endpoint);
  await auditStmt(c.db, c.actor, "push.unsubscribe", "push_subscription", null, null, { endpointHost: new URL(endpoint).host }).run();
  return json({ ok: true });
});

// Her latest first text: the newest message of hers that answered nothing of his (an
// opener or a first text), once it has arrived. The service worker shows this line.
route("GET", "/api/push/latest", async (c) => {
  const row = await c.db
    .prepare("SELECT * FROM messages WHERE role = 'assistant' AND channel = 'story' AND reply_to_id IS NULL AND (deliver_at IS NULL OR deliver_at <= ?1) ORDER BY created_at DESC LIMIT 1")
    .bind(nowIso())
    .first<MessageRow>();
  if (!row) return json({ text: null, messageId: null, conversationId: null, createdAt: null });
  return json({ text: row.content, messageId: row.id, conversationId: row.conversation_id, createdAt: row.created_at });
});

// ------------------------------------------------------------------ the owner's media library (SPEC_V2 section V)

const MEDIA_KINDS = ["clip", "video", "image", "other"] as const;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const LIBRARY_PREFIX = "library/";
const MAX_LIBRARY_ROWS = 500;

interface MediaRow {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
  status: string;
  created_at: string;
}

function libraryMime(file: File): string {
  const declared = (file.type || "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared.startsWith("audio/") || declared.startsWith("video/") || declared.startsWith("image/")) return declared;
  throw new ApiHttpError(415, "unsupported_media_type", "file must be audio, video or an image");
}

route("POST", "/api/media", async (c) => {
  const form = await readForm(c.request, MAX_MEDIA_BYTES + FORM_SLACK);
  const file = formFiles(form, "file")[0];
  if (!file) throw invalid("file is required");
  if (!file.size) throw invalid("file is empty");
  if (file.size > MAX_MEDIA_BYTES) throw tooLarge(MAX_MEDIA_BYTES);
  const title = formString(form, "title", 200, true).trim();
  const description = formString(form, "description", 2000, false).trim();
  const kindRaw = formString(form, "kind", 20, false).trim();
  const kind = kindRaw ? oneOf(kindRaw, MEDIA_KINDS, "kind") : "other";
  let mime = libraryMime(file);
  const bytes = await file.arrayBuffer();
  // An image is judged by its bytes, like his photos.
  if (mime.startsWith("image/")) {
    const sniff = sniffImage(new Uint8Array(bytes));
    if (!sniff) throw new ApiHttpError(415, "unsupported_media_type", "image must be jpeg, png or webp");
    mime = sniff.mime;
  }
  const id = newId("md");
  const key = LIBRARY_PREFIX + id + "." + extFor(mime);
  const row: MediaRow = {
    id, kind, title, description: description || null, key, mime, bytes: bytes.byteLength, sha256: await sha256Hex(bytes), status: "active", created_at: nowIso(),
  };
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  try {
    await c.db.batch([
      c.db.prepare("INSERT INTO media_library (id, kind, title, description, key, mime, bytes, sha256, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
        .bind(row.id, row.kind, row.title, row.description, row.key, row.mime, row.bytes, row.sha256, row.status, row.created_at),
      auditStmt(c.db, c.actor, "media.upload", "media_library", id, null, row),
    ]);
  } catch (e) {
    await deleteKeys(c.env, [key]);
    throw e;
  }
  return json(row, 201);
});

route("GET", "/api/media", async (c) => {
  const r = await c.db.prepare("SELECT * FROM media_library WHERE status = 'active' ORDER BY created_at DESC LIMIT ?1").bind(MAX_LIBRARY_ROWS).all<MediaRow>();
  return json(r.results);
});

route("DELETE", "/api/media/:id", async (c) => {
  const id = idParam(c, "id");
  const row = await c.db.prepare("SELECT * FROM media_library WHERE id = ?1").bind(id).first<MediaRow>();
  if (!row || row.status === "deleted") throw new ApiHttpError(404, "not_found", "media not found");
  await deleteKeys(c.env, [row.key]);
  // The row stays (status deleted) so a message that sent it still knows what it was.
  await c.db.batch([
    c.db.prepare("UPDATE media_library SET status = 'deleted' WHERE id = ?1").bind(id),
    auditStmt(c.db, c.actor, "media.delete", "media_library", id, row, { ...row, status: "deleted" }),
  ]);
  return json({ ok: true });
});

// ------------------------------------------------------------------ timeline (SPEC_V2 section X)

route("GET", "/api/timeline", async (c) => {
  const beforeRaw = c.url.searchParams.get("before");
  const before = beforeRaw && beforeRaw.trim() ? beforeRaw.trim().slice(0, 64) : undefined;
  const limit = intQuery(c.url, "limit", 500, 1, 500);
  return json(await getTimeline(c.db, c.env, before !== undefined ? { before, limit } : { limit }));
});

// ------------------------------------------------------------------ voiceprint (SPEC_V2 section Y)

route("POST", "/api/voiceprint/run", async (c) => json({ voiceprint: await runVoiceprint(c.db, new Date()) }));

route("GET", "/api/voiceprint", async (c) => json(await listVoiceprints(c.db, intQuery(c.url, "limit", 8, 1, 104))));

// ------------------------------------------------------------------ export and import

route("GET", "/api/export", async (c) => json(await exportAll(c.db, c.env)));

route("GET", "/api/export/transcript/:conversationId", async (c) => {
  const text = await exportTranscript(c.db, idParam(c, "conversationId"));
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
});

// Her, as a package (SPEC_V2 section Z): JSON, or the readable character bible.
route("GET", "/api/export/character", async (c) => json(await exportCharacterJson(c.db, c.env)));

route("GET", "/api/export/character.md", async (c) => {
  const text = await exportCharacterMarkdown(c.db, c.env);
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": "inline; filename=\"avelie-character.md\"",
      "cache-control": "no-store",
    },
  });
});

route("POST", "/api/import", async (c) => {
  const body = await readBody(c.request);
  const result = await importAll(c.db, body, c.actor);
  return json({ ok: true, ...result });
});
