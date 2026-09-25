// Route table for /api/*. Handlers throw ApiHttpError (or a Response) and the wrapper
// renders every failure in the one JSON error shape. No handler reads identity from the
// request: the actor arrives already verified from index.ts.
//
// v2 (SPEC_V2): her life (threads, log), provenance per message, she opens, real-mode
// timing on the message list, regenerate, drift check, her first texts, voice in, photos
// in (multipart turn), push, the owner's media library, timeline, voiceprint, character
// export, and the new settings.
//
// v3 (SPEC_V3): the voice bank and the corrections ledger (AA), memory weights and recalls
// (BB), wants and asks (CC), grounding, weather, geocoding and portraits (DD), phone calls
// (EE), video clips (FF), blind tastings on the turn route (HH), marks and the fine-tune
// export (II), and the settings validation for every v3 row. The v3 modules are imported by
// the names SPEC_V3 fixes; a name that drifted in a lane is the integrator's to settle.
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
import { FIRST_TEXT_NOTE, maybeTextFirst } from "./herfirst";
import { subscribe as pushSubscribe, unsubscribe as pushUnsubscribe } from "./push";
import { getTimeline } from "./timeline";
import { listVoiceprints, runVoiceprint } from "./voiceprint";
import { exportCharacterJson, exportCharacterMarkdown } from "./exportCharacter";
import { transcribe } from "./voice";
import { safeErrorMessage } from "./providers/types";
// v3 modules (SPEC_V3 Build lanes M1, M2, M4). Imported by path and by the export names the
// spec fixes; nothing here is defined by this file.
import { createLine, decideLine, decideMany, listLines, updateLine } from "./voicebank";
import { createCorrection, listCorrections, restoreCorrection, retireCorrection } from "./corrections";
import { listMemory, listRecalls, putWeight } from "./memory";
import { createAsk, createWant, listAsks, listWantLog, listWants, logWant, updateAsk, updateWant } from "./wants";
import { createGroundingRow, deleteGroundingRow, outfitNow, timeOfDay, todayRows } from "./grounding";
import { geocode, getWeather } from "./weather";
import { generatePortrait } from "./portraits";
import { localParts } from "./life";
import { endCall, getCall, listCallMessages, listCalls, startCall, tickCall } from "./calls";
import { pollClip, startClip } from "./video";
import {
  blindCandidates, expiresAtOf, getTasting, ledger as tastingLedger, listCandidates, pickTasting, promote as promoteTasting, reveal as revealTasting,
  runTastingTurn,
} from "./tastings";
import { exportSidecar, exportTrainingStream, finetuneStatus, revertTexter, useTexter } from "./finetune";
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
// v3 (SPEC_V3 "Settings added"). Validated here whether or not DEFAULT_SETTINGS carries them
// yet, for the same reason as the v2 list.
const WEATHER_PROVIDERS = ["openmeteo", "stub", "off"] as const;
const WEATHER_UNITS = ["fahrenheit", "celsius"] as const;
const CALL_PROVIDERS = ["openai", "elevenlabs", "stub", "off"] as const;
const SYSTEM_MODES = ["compact", "full"] as const;
const VIDEO_PROVIDERS = ["runway", "stub", "off"] as const;
const VIDEO_SECONDS = [5, 10] as const;
const VIDEO_RATIO_RE = /^\d{3,4}:\d{3,4}$/;
const CALL_PRICE_KEYS = ["audioInPerMTok", "audioOutPerMTok", "textInPerMTok", "textOutPerMTok"] as const;
const V3_EXTRA_KEYS: readonly string[] = [
  "exemplarsPerTurn", "exemplarCooldownTurns", "correctionsShown", "correctionRewriteToBank",
  "memoryDecayEnabled", "memoryFactsMax", "memoryHalfLifeLowDays", "memoryHalfLifeMidDays", "memoryHalfLifeHighDays", "provisionalRecallEvery",
  "wantsShown", "askLetGoDays", "moodDaysDefault",
  "herCity", "herLat", "herLon", "weatherProvider", "weatherUnits", "portraitCostUsd", "portraitSize",
  "callProvider", "callModel", "callVoice", "callTranscribeModel", "callSystemMode", "callMaxMinutes", "callPricePerMinute", "callPrices",
  "elevenLabsAgentId", "elevenLabsCallPricePerMinute",
  "videoProvider", "videoModel", "videoSeconds", "videoRatio", "videoCostUsd",
  "textureCuesEnabled", "typoCueShare",
  "tastingEnabled", "tastingProvider", "tastingModel", "tastingDailyCapUsd",
  "finetuneMinExamples", "finetuneSystemMode", "texterModel", "texterPrevious",
];

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

// The four realtime prices (SPEC_V3 EE): every key present, each 0..100000, nothing else.
function validateCallPrices(v: unknown): Record<(typeof CALL_PRICE_KEYS)[number], number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid("callPrices must be an object");
  const src = v as Record<string, unknown>;
  for (const k of Object.keys(src)) if (!(CALL_PRICE_KEYS as readonly string[]).includes(k)) throw invalid("callPrices has an unknown key: " + k);
  const out = {} as Record<(typeof CALL_PRICE_KEYS)[number], number>;
  for (const k of CALL_PRICE_KEYS) out[k] = num(src[k], "callPrices." + k, 0, 100000);
  return out;
}

// A number, or null to clear it (her latitude and longitude before a city is set).
function numOrNull(v: unknown, key: string, min: number, max: number): number | null {
  if (v === null) return null;
  return num(v, key, min, max);
}

// A string setting that may be empty (a city not yet chosen, a reserved agent id).
function emptyableString(b: Body, key: string, max: number): string {
  const s = optString(b, key, max);
  return typeof s === "string" ? s.trim() : "";
}

function boolSetting(b: Body, key: string, p: Record<string, unknown>): void {
  const v = optBool(b, key);
  if (v === undefined) throw invalid(`${key} must be a boolean`);
  p[key] = v;
}

// texterPrevious (SPEC_V3 II): null, or { provider, model } as /use stored it. The panel
// never edits it; the shape is checked so a hand-made PUT cannot break /revert.
function validateTexterPrevious(v: unknown): { provider: ProviderName; model: string } | null {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw invalid("texterPrevious must be null or { provider, model }");
  const o = v as Record<string, unknown>;
  const provider = oneOf(o.provider, PROVIDERS, "texterPrevious.provider");
  const model = reqString(o, "model", 200).trim();
  return { provider, model };
}

export function validateSettingsPatch(body: Body): Partial<Settings> {
  for (const key of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) && !V2_EXTRA_KEYS.includes(key) && !V3_EXTRA_KEYS.includes(key)) throw invalid("unknown setting: " + key);
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
  // v3 AA: the voice bank and the notes
  if (v.exemplarsPerTurn !== undefined) p.exemplarsPerTurn = int(v.exemplarsPerTurn, "exemplarsPerTurn", 0, 12);
  if (v.exemplarCooldownTurns !== undefined) p.exemplarCooldownTurns = int(v.exemplarCooldownTurns, "exemplarCooldownTurns", 0, 500);
  if (v.correctionsShown !== undefined) p.correctionsShown = int(v.correctionsShown, "correctionsShown", 0, 100);
  if (v.correctionRewriteToBank !== undefined) boolSetting(v, "correctionRewriteToBank", p);
  // v3 BB: memory
  if (v.memoryDecayEnabled !== undefined) boolSetting(v, "memoryDecayEnabled", p);
  if (v.memoryFactsMax !== undefined) p.memoryFactsMax = int(v.memoryFactsMax, "memoryFactsMax", 5, 200);
  if (v.memoryHalfLifeLowDays !== undefined) p.memoryHalfLifeLowDays = int(v.memoryHalfLifeLowDays, "memoryHalfLifeLowDays", 1, 365);
  if (v.memoryHalfLifeMidDays !== undefined) p.memoryHalfLifeMidDays = int(v.memoryHalfLifeMidDays, "memoryHalfLifeMidDays", 1, 3650);
  if (v.memoryHalfLifeHighDays !== undefined) p.memoryHalfLifeHighDays = int(v.memoryHalfLifeHighDays, "memoryHalfLifeHighDays", 1, 36500);
  if (v.provisionalRecallEvery !== undefined) p.provisionalRecallEvery = int(v.provisionalRecallEvery, "provisionalRecallEvery", 0, 50);
  // v3 CC: wants, asks, mood
  if (v.wantsShown !== undefined) p.wantsShown = int(v.wantsShown, "wantsShown", 0, 20);
  if (v.askLetGoDays !== undefined) p.askLetGoDays = int(v.askLetGoDays, "askLetGoDays", 1, 90);
  if (v.moodDaysDefault !== undefined) p.moodDaysDefault = int(v.moodDaysDefault, "moodDaysDefault", 1, 14);
  // v3 DD: her city, the weather, portraits
  if (v.herCity !== undefined) p.herCity = emptyableString(v, "herCity", 80);
  if (v.herLat !== undefined) p.herLat = numOrNull(v.herLat, "herLat", -90, 90);
  if (v.herLon !== undefined) p.herLon = numOrNull(v.herLon, "herLon", -180, 180);
  if (v.weatherProvider !== undefined) p.weatherProvider = oneOf(v.weatherProvider, WEATHER_PROVIDERS, "weatherProvider");
  if (v.weatherUnits !== undefined) p.weatherUnits = oneOf(v.weatherUnits, WEATHER_UNITS, "weatherUnits");
  if (v.portraitCostUsd !== undefined) p.portraitCostUsd = num(v.portraitCostUsd, "portraitCostUsd", 0, 100);
  if (v.portraitSize !== undefined) {
    const s = reqString(v, "portraitSize", 20).trim();
    if (!SIZE_RE.test(s)) throw invalid("portraitSize must look like 1024x1024 or auto");
    p.portraitSize = s;
  }
  // v3 EE: calls
  if (v.callProvider !== undefined) p.callProvider = oneOf(v.callProvider, CALL_PROVIDERS, "callProvider");
  if (v.callModel !== undefined) p.callModel = reqString(v, "callModel", 120).trim();
  if (v.callVoice !== undefined) p.callVoice = reqString(v, "callVoice", 40).trim();
  if (v.callTranscribeModel !== undefined) p.callTranscribeModel = reqString(v, "callTranscribeModel", 120).trim();
  if (v.callSystemMode !== undefined) p.callSystemMode = oneOf(v.callSystemMode, SYSTEM_MODES, "callSystemMode");
  if (v.callMaxMinutes !== undefined) p.callMaxMinutes = int(v.callMaxMinutes, "callMaxMinutes", 1, 60);
  if (v.callPricePerMinute !== undefined) p.callPricePerMinute = num(v.callPricePerMinute, "callPricePerMinute", 0, 100);
  if (v.callPrices !== undefined) p.callPrices = validateCallPrices(v.callPrices);
  if (v.elevenLabsAgentId !== undefined) p.elevenLabsAgentId = emptyableString(v, "elevenLabsAgentId", 120);
  if (v.elevenLabsCallPricePerMinute !== undefined) p.elevenLabsCallPricePerMinute = num(v.elevenLabsCallPricePerMinute, "elevenLabsCallPricePerMinute", 0, 100);
  // v3 FF: clips
  if (v.videoProvider !== undefined) p.videoProvider = oneOf(v.videoProvider, VIDEO_PROVIDERS, "videoProvider");
  if (v.videoModel !== undefined) p.videoModel = reqString(v, "videoModel", 60).trim();
  if (v.videoSeconds !== undefined) {
    const n = int(v.videoSeconds, "videoSeconds", 5, 10);
    if (!(VIDEO_SECONDS as readonly number[]).includes(n)) throw invalid("videoSeconds must be 5 or 10");
    p.videoSeconds = n;
  }
  if (v.videoRatio !== undefined) {
    const s = reqString(v, "videoRatio", 9).trim();
    if (!VIDEO_RATIO_RE.test(s)) throw invalid("videoRatio must look like 720:1280");
    p.videoRatio = s;
  }
  if (v.videoCostUsd !== undefined) p.videoCostUsd = num(v.videoCostUsd, "videoCostUsd", 0, 100);
  // v3 GG: texture
  if (v.textureCuesEnabled !== undefined) boolSetting(v, "textureCuesEnabled", p);
  if (v.typoCueShare !== undefined) p.typoCueShare = num(v.typoCueShare, "typoCueShare", 0, 0.3);
  // v3 HH: tastings
  if (v.tastingEnabled !== undefined) boolSetting(v, "tastingEnabled", p);
  if (v.tastingProvider !== undefined) p.tastingProvider = oneOf(v.tastingProvider, PROVIDERS, "tastingProvider");
  if (v.tastingModel !== undefined) p.tastingModel = reqString(v, "tastingModel", 200).trim();
  if (v.tastingDailyCapUsd !== undefined) p.tastingDailyCapUsd = num(v.tastingDailyCapUsd, "tastingDailyCapUsd", 0, 1000);
  // v3 II: the texter
  if (v.finetuneMinExamples !== undefined) p.finetuneMinExamples = int(v.finetuneMinExamples, "finetuneMinExamples", 10, 5000);
  if (v.finetuneSystemMode !== undefined) p.finetuneSystemMode = oneOf(v.finetuneSystemMode, SYSTEM_MODES, "finetuneSystemMode");
  if (v.texterModel !== undefined) p.texterModel = emptyableString(v, "texterModel", 200);
  if (v.texterPrevious !== undefined) p.texterPrevious = validateTexterPrevious(v.texterPrevious);
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
  // v3: the same law for the other paid pictures and for the second performer. A portrait
  // on a paid image provider and a clip on Runway must carry a price, and a tasting
  // performer must be priced before tastings are switched on (the tasting turn would
  // otherwise be refused 402 price_unknown on its first call).
  if ((touched("portraitCostUsd") || touched("imageProvider")) && typeof next.portraitCostUsd === "number") {
    if (!isKeylessImageProvider(next.imageProvider) && !(next.portraitCostUsd > 0)) {
      throw invalid(`portraitCostUsd must be above 0 for image provider ${String(next.imageProvider)}; only a keyless provider may run at 0`);
    }
  }
  if ((touched("videoCostUsd") || touched("videoProvider")) && typeof next.videoCostUsd === "number" && next.videoProvider === "runway" && !(next.videoCostUsd > 0)) {
    throw invalid("videoCostUsd must be above 0 for video provider runway; only the stub may run at 0");
  }
  // A paid call provider needs its per-minute floor: at 0 the meter would read $0 whenever
  // the page reports no usage, and no cap could trip (calls.ts refuses to start as well).
  if ((touched("callPricePerMinute") || touched("callProvider")) && next.callProvider === "openai" && typeof next.callPricePerMinute === "number" && !(next.callPricePerMinute > 0)) {
    throw invalid("callPricePerMinute must be above 0 for call provider openai; only the stub may run at 0");
  }
  if ((touched("tastingEnabled") || touched("tastingModel") || touched("prices")) && next.tastingEnabled === true) {
    const model = String(next.tastingModel ?? "").trim();
    const p = prices[model];
    if (!p || typeof p.inputPerMTok !== "number" || typeof p.outputPerMTok !== "number") {
      throw invalid(`tastingModel "${model}" has no entry in prices; add its price (USD per million tokens) in the Prices section of the Model page before enabling tastings`);
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

// The one-time operator note for an opener (SPEC_V2 section Q) is the first-text note
// (section R): one wording for both, so "never say you waited" and "never make it about
// him being gone" hold on Let her start as they do on the cron. He never sees it.
const OPENER_NOTE = FIRST_TEXT_NOTE;

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
  const rows = flagQuery(c.url, "includePending")
    ? await listMessages(c.db, id, channel, limit)
    : await listMessagesVisible(c.db, id, channel, new Date(), limit);
  return json(await withMarks(c.db, rows));
});

// v3 (II): her story rows carry their Keep / Drop mark so the page shows it after a reload.
// One read per 90 ids (D1's bound-parameter limit); a database behind 0005 answers no marks.
async function withMarks(db: D1Database, rows: MessageRow[]): Promise<Array<MessageRow & { mark?: "keep" | "drop" | null }>> {
  const ids = rows.filter((m) => m.role === "assistant" && m.channel === "story").map((m) => m.id);
  const marks = new Map<string, "keep" | "drop">();
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const placeholders = chunk.map((_, k) => "?" + (k + 1)).join(", ");
      const r = await db.prepare(`SELECT message_id, mark FROM message_marks WHERE message_id IN (${placeholders})`).bind(...chunk).all<{ message_id: string; mark: "keep" | "drop" }>();
      for (const row of r.results) marks.set(row.message_id, row.mark);
    }
  } catch {
    return rows;
  }
  if (marks.size === 0) return rows;
  return rows.map((m) => (marks.has(m.id) ? { ...m, mark: marks.get(m.id) ?? null } : m));
}

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

// v3 (SPEC_V3 section HH): `tasting: true` in the JSON body runs the same turn on two
// performers and answers with the blind pair (or a normal TurnResponse when one side
// failed and the tasting voided itself). Every turn shape answers 409 tasting_pending
// while a tasting is pending in the conversation; that gate lives in the pipeline.
route("POST", "/api/conversations/:id/turn", async (c) => {
  const id = idParam(c, "id");
  if (isMultipart(c.request)) return multipartTurn(c, id);
  const body = await readBody(c.request);
  const content = reqString(body, "content", 20000);
  const idempotencyKey = reqString(body, "idempotencyKey", 200);
  const tasting = optBool(body, "tasting") === true;
  const settings = await loadSettings(c);
  if (tasting) return json(await runTastingTurn(c.env, c.ctx, c.db, settings, id, content, idempotencyKey, c.actor));
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
    // v3: approved clips (FF) and faces (DD); their candidates sit in `candidates` with the
    // photos, and the ones still being made in `generating` (a clip only moves forward
    // when the page polls it, so a reload must find it again).
    videos: rows.filter((a) => a.role === "video" && a.approval_status === "approved"),
    portraits: rows.filter((a) => a.role === "portrait" && a.approval_status === "approved"),
    generating: rows.filter((a) => a.approval_status === "generating"),
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

// ================================================================== v3 (SPEC_V3)

// ------------------------------------------------------------------ small v3 helpers

const VOICE_STATUSES = ["unapproved", "approved", "rejected"] as const;
// The fixed tag vocabulary of SPEC_V3 section AA. The build script and voicebank.ts hold
// the same list; the router validates a tag filter against it and hands it to the page.
export const VOICE_TAGS = [
  "stranger", "familiar", "banter", "dry", "warm", "flirt", "annoyed", "after_friction", "repair", "tired", "sad", "excited",
  "morning", "day", "evening", "late", "apart", "together", "answering", "decline", "no", "own_day", "ask", "photo_ask",
  "photo_send", "song_send", "one_word", "fragment", "lowercase", "typo_fix",
] as const;
const CORRECTION_KINDS = ["ai", "clever", "not_her", "too_long", "too_nice", "too_polished", "other"] as const;
const CORRECTION_STATUSES = ["active", "retired"] as const;
const MEMORY_ENTITIES = ["fact", "history", "thread", "log", "want"] as const;
const WANT_STATUSES = ["active", "paused", "done", "dropped"] as const;
const WANT_LOG_KINDS = ["progress", "setback", "note"] as const;
const ASK_STATUSES = ["open", "granted", "declined", "let_go"] as const;
const ASK_PATCH_STATUSES = ["granted", "declined", "let_go", "open"] as const;
const GROUNDING_KINDS = ["meal", "outfit", "errand", "misc"] as const;
const MARKS = ["keep", "drop"] as const;
const PICKS = ["left", "right", "neither"] as const;
const CALL_SPEAKERS = ["him", "her"] as const;
const MAX_VOICE_LINE_CHARS = 160;
const MAX_VOICE_TAGS = 4;
const MAX_DECIDE_IDS = 500;
const MAX_CALL_SEGMENTS = 2000;
const MAX_CALL_SEGMENT_CHARS = 4000;
const MAX_TICK_SECONDS = 3600;
const MAX_ID_CHARS = 120;
const MAX_LIST = 2000;

// An ISO 8601 time, normalised; anything else is a validation error.
function isoOrThrow(v: unknown, key: string): string {
  if (typeof v !== "string" || !v.trim()) throw invalid(`${key} must be an ISO 8601 time`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw invalid(`${key} must be an ISO 8601 time`);
  return new Date(t).toISOString();
}

function optIso(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null || v === "") return undefined;
  return isoOrThrow(v, key);
}

function optInt(b: Body, key: string, min: number, max: number): number | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  return int(v, key, min, max);
}

function optNum(b: Body, key: string, min: number, max: number): number | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  return num(v, key, min, max);
}

// A list of voice-bank tags: one to four, each from the vocabulary, no repeats.
function voiceTags(v: unknown, required: boolean): string[] | undefined {
  if (v === undefined) {
    if (required) throw invalid("tags is required");
    return undefined;
  }
  if (!Array.isArray(v) || !v.length) throw invalid("tags must be a non-empty array");
  if (v.length > MAX_VOICE_TAGS) throw invalid(`at most ${MAX_VOICE_TAGS} tags`);
  const out: string[] = [];
  for (const t of v) {
    const tag = oneOf(t, VOICE_TAGS, "tags");
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

// A list of ids for a batch decision: strings, each at most 120 characters, at most 500.
function idList(v: unknown, key: string, max = MAX_DECIDE_IDS): string[] {
  if (!Array.isArray(v) || !v.length) throw invalid(`${key} must be a non-empty array`);
  if (v.length > max) throw invalid(`${key} has more than ${max} entries`);
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== "string" || !id.trim() || id.length > MAX_ID_CHARS) throw invalid(`${key} contains an invalid id`);
    const t = id.trim();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// Local hour in her timezone, for the time-of-day word.
function localHour(now: Date, tz: string): number {
  try {
    return localParts(now, tz).hour;
  } catch {
    return now.getUTCHours();
  }
}

// Settings as stored, never the local .dev.vars overlay: the texter routes and the
// fine-tune status report what production would use, and /use must remember the real
// stored performer in texterPrevious.
async function storedSettings(c: RouteCtx): Promise<Settings> {
  return getSettings(c.db);
}

// ------------------------------------------------------------------ voice bank (SPEC_V3 section AA)

interface VoiceCountRow { status: string; n: number }

route("GET", "/api/voicebank", async (c) => {
  const raw = c.url.searchParams.get("status");
  const status = raw === null || raw === "" || raw === "all" ? undefined : oneOf(raw, VOICE_STATUSES, "status");
  const tagRaw = (c.url.searchParams.get("tag") ?? "").trim();
  const tag = tagRaw ? oneOf(tagRaw, VOICE_TAGS, "tag") : undefined;
  const limit = intQuery(c.url, "limit", 500, 1, MAX_LIST);
  const [lines, countRows] = await Promise.all([
    listLines(c.db, status, tag, limit),
    c.db.prepare("SELECT status, COUNT(*) AS n FROM voice_lines GROUP BY status").all<VoiceCountRow>(),
  ]);
  const counts: Record<(typeof VOICE_STATUSES)[number], number> = { unapproved: 0, approved: 0, rejected: 0 };
  for (const r of countRows.results) {
    if ((VOICE_STATUSES as readonly string[]).includes(r.status)) counts[r.status as (typeof VOICE_STATUSES)[number]] = Number(r.n) || 0;
  }
  return json({ lines, counts, tags: VOICE_TAGS });
});

// His own line: approved on creation, origin owner.
route("POST", "/api/voicebank", async (c) => {
  const body = await readBody(c.request);
  const text = reqString(body, "text", MAX_VOICE_LINE_CHARS).trim();
  const tags = voiceTags(body.tags, true) ?? [];
  const source = optString(body, "source", 200);
  const line = await createLine(c.db, { text, tags, ...(source ? { source } : {}), origin: "owner" }, c.actor);
  return json(line, 201);
});

route("PUT", "/api/voicebank/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: { text?: string; tags?: string[] } = {};
  const text = optString(body, "text", MAX_VOICE_LINE_CHARS);
  if (text !== undefined) {
    if (text === null || !text.trim()) throw invalid("text cannot be empty");
    patch.text = text.trim();
  }
  const tags = voiceTags(body.tags, false);
  if (tags !== undefined) patch.tags = tags;
  if (patch.text === undefined && patch.tags === undefined) throw invalid("nothing to change");
  return json(await updateLine(c.db, id, patch, c.actor));
});

// Registered before the per-line decide so the literal segment is the one that matches.
route("POST", "/api/voicebank/decide", async (c) => {
  const body = await readBody(c.request);
  const ids = idList(body.ids, "ids");
  const decision = oneOf(body.decision, ["approve", "reject"] as const, "decision");
  const changed = await decideMany(c.db, ids, decision, c.actor);
  return json({ changed });
});

route("POST", "/api/voicebank/:id/decide", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const decision = oneOf(body.decision, ["approve", "reject"] as const, "decision");
  return json(await decideLine(c.db, id, decision, c.actor));
});

// ------------------------------------------------------------------ corrections (SPEC_V3 section AA)

route("GET", "/api/corrections", async (c) => {
  const raw = c.url.searchParams.get("status");
  const status = raw === null || raw === "" || raw === "all" ? undefined : oneOf(raw, CORRECTION_STATUSES, "status");
  const limit = intQuery(c.url, "limit", 200, 1, MAX_LIST);
  return json(await listCorrections(c.db, status, limit));
});

route("POST", "/api/corrections", async (c) => {
  const body = await readBody(c.request);
  const messageId = reqString(body, "messageId", MAX_ID_CHARS).trim();
  const kind = oneOf(body.kind, CORRECTION_KINDS, "kind");
  const note = optString(body, "note", 1000);
  const rewrite = optString(body, "rewrite", 1000);
  const toBank = optBool(body, "toBank");
  const row = await createCorrection(c.db, {
    messageId,
    kind,
    ...(note && note.trim() ? { note: note.trim() } : {}),
    ...(rewrite && rewrite.trim() ? { rewrite: rewrite.trim() } : {}),
    ...(toBank !== undefined ? { toBank } : {}),
  }, c.actor);
  return json(row, 201);
});

route("POST", "/api/corrections/:id/retire", async (c) => json(await retireCorrection(c.db, idParam(c, "id"), c.actor)));

route("POST", "/api/corrections/:id/restore", async (c) => json(await restoreCorrection(c.db, idParam(c, "id"), c.actor)));

// ------------------------------------------------------------------ memory (SPEC_V3 section BB)

route("GET", "/api/memory", async (c) => {
  const raw = (c.url.searchParams.get("entity") ?? "").trim();
  const entity = raw ? oneOf(raw, MEMORY_ENTITIES, "entity") : "fact";
  const limit = intQuery(c.url, "limit", 200, 1, MAX_LIST);
  const settings = await loadSettings(c);
  return json(await listMemory(c.db, entity, limit, settings, new Date()));
});

// Registered before the two-parameter PUT so the literal path wins for GET.
route("GET", "/api/memory/recalls", async (c) => json(await listRecalls(c.db, intQuery(c.url, "limit", 50, 1, 500))));

route("PUT", "/api/memory/:entity/:id", async (c) => {
  const entity = oneOf(c.params.entity, MEMORY_ENTITIES, "entity");
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: { weight?: number; lastTouched?: string } = {};
  const weight = optNum(body, "weight", 0, 1);
  if (weight !== undefined) patch.weight = weight;
  const lastTouched = optIso(body, "lastTouched");
  if (lastTouched !== undefined) patch.lastTouched = lastTouched;
  if (patch.weight === undefined && patch.lastTouched === undefined) throw invalid("weight or lastTouched is required");
  return json(await putWeight(c.db, entity, id, patch, c.actor));
});

// ------------------------------------------------------------------ wants and asks (SPEC_V3 section CC)

interface WantLike { id: string; [k: string]: unknown }
interface WantLogLike { occurred?: string; created_at?: string; [k: string]: unknown }

// The newest log row of a want, by when it happened.
function newestLog(rows: WantLogLike[]): WantLogLike | null {
  let best: WantLogLike | null = null;
  let bestT = -Infinity;
  for (const r of rows) {
    const t = Date.parse(String(r.occurred ?? r.created_at ?? ""));
    const v = Number.isFinite(t) ? t : 0;
    if (v >= bestT) { bestT = v; best = r; }
  }
  return best;
}

route("GET", "/api/wants", async (c) => {
  const raw = (c.url.searchParams.get("status") ?? "").trim();
  const status = raw && raw !== "all" ? oneOf(raw, WANT_STATUSES, "status") : undefined;
  const askRaw = (c.url.searchParams.get("askStatus") ?? "").trim();
  const askStatus = askRaw && askRaw !== "all" ? oneOf(askRaw, ASK_STATUSES, "askStatus") : undefined;
  const [wantsRaw, asks] = await Promise.all([listWants(c.db, status), listAsks(c.db, askStatus)]);
  const wants = wantsRaw as unknown as WantLike[];
  const logs = await Promise.all(wants.slice(0, 50).map((w) => listWantLog(c.db, w.id).catch((): WantLogLike[] => [])));
  const out = wants.map((w, i) => ({ ...w, lastLog: i < logs.length ? newestLog((logs[i] ?? []) as WantLogLike[]) : null }));
  return json({ wants: out, asks });
});

route("POST", "/api/wants", async (c) => {
  const body = await readBody(c.request);
  const input: Record<string, unknown> = { title: reqString(body, "title", 300).trim() };
  for (const key of ["why", "stakes", "next_step"] as const) {
    const v = optString(body, key, 2000);
    if (v !== undefined) input[key] = v && v.trim() ? v.trim() : null;
  }
  const progress = optInt(body, "progress", 0, 100);
  if (progress !== undefined) input.progress = progress;
  const horizon = optInt(body, "horizon_days", 1, 3650);
  if (horizon !== undefined) input.horizon_days = horizon;
  const source = optString(body, "source", 500);
  if (source !== undefined) input.source = source;
  const row = await createWant(c.db, input as Parameters<typeof createWant>[1], c.actor);
  return json(row, 201);
});

route("PUT", "/api/wants/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const patch: Record<string, unknown> = {};
  const title = optString(body, "title", 300);
  if (title !== undefined) {
    if (title === null || !title.trim()) throw invalid("title cannot be empty");
    patch.title = title.trim();
  }
  for (const key of ["why", "stakes", "next_step"] as const) {
    const v = optString(body, key, 2000);
    if (v !== undefined) patch[key] = v && v.trim() ? v.trim() : null;
  }
  const progress = optInt(body, "progress", 0, 100);
  if (progress !== undefined) patch.progress = progress;
  const horizon = optInt(body, "horizon_days", 1, 3650);
  if (horizon !== undefined) patch.horizon_days = horizon;
  if (body.status !== undefined && body.status !== null) patch.status = oneOf(body.status, WANT_STATUSES, "status");
  if (!Object.keys(patch).length) throw invalid("nothing to change");
  return json(await updateWant(c.db, id, patch as Parameters<typeof updateWant>[2], c.actor));
});

route("POST", "/api/wants/:id/log", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const kind = oneOf(body.kind, WANT_LOG_KINDS, "kind");
  const note = reqString(body, "note", 2000).trim();
  const delta = optInt(body, "delta", -100, 100);
  const occurred = optIso(body, "occurred");
  const source = optString(body, "source", 500);
  const r = await logWant(c.db, id, {
    kind,
    note,
    ...(delta !== undefined ? { delta } : {}),
    ...(occurred !== undefined ? { occurred } : {}),
    ...(source ? { source } : {}),
  }, c.actor);
  // The log row on top (the spec's shape) and the want as it stands after the move.
  return json({ ...r.log, want: r.want }, 201);
});

route("GET", "/api/wants/:id/log", async (c) => json(await listWantLog(c.db, idParam(c, "id"))));

route("POST", "/api/asks", async (c) => {
  const body = await readBody(c.request);
  const text = reqString(body, "text", 500).trim();
  const wantId = optString(body, "wantId", MAX_ID_CHARS);
  const source = optString(body, "source", 500);
  // askedAt lets the owner record an ask from an earlier day; absent = now.
  const askedAt = optIso(body, "askedAt");
  const row = await createAsk(c.db, {
    text,
    ...(wantId && wantId.trim() ? { wantId: wantId.trim() } : {}),
    ...(source ? { source } : {}),
    ...(askedAt !== undefined ? { askedAt } : {}),
  }, c.actor);
  return json(row, 201);
});

route("PUT", "/api/asks/:id", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const status = oneOf(body.status, ASK_PATCH_STATUSES, "status");
  const note = optString(body, "note", 1000);
  return json(await updateAsk(c.db, id, { status, ...(note && note.trim() ? { note: note.trim() } : {}) }, c.actor));
});

// ------------------------------------------------------------------ grounding (SPEC_V3 section DD)

const MAX_GEOCODE_RESULTS = 5;
const MAX_CITY_QUERY = 80;

// The only route that calls out on his behalf: up to five candidates for a city name,
// `[]` when nothing matches. PUT /api/settings never calls out.
route("POST", "/api/grounding/geocode", async (c) => {
  const body = await readBody(c.request);
  const name = reqString(body, "name", MAX_CITY_QUERY).trim();
  const settings = await loadSettings(c);
  const results: unknown = await geocode(c.env, settings, name);
  return json({ results: Array.isArray(results) ? results.slice(0, MAX_GEOCODE_RESULTS) : [] });
});

route("GET", "/api/grounding", async (c) => {
  const settings = await loadSettings(c);
  const now = new Date();
  const tz = settings.timezone;
  const [weather, today, assets] = await Promise.all([
    getWeather(c.env, c.db, settings, now).catch((e: unknown) => {
      console.warn("weather skipped", e instanceof Error ? e.name : "error");
      return null;
    }),
    todayRows(c.db, now, tz),
    listAssets(c.db, "approved"),
  ]);
  const outfit = outfitNow(assets, today, now, tz);
  return json({
    city: settings.herCity && settings.herCity.trim() ? settings.herCity.trim() : null,
    weather,
    timeOfDay: timeOfDay(localHour(now, tz)),
    outfit,
    today,
  });
});

route("POST", "/api/grounding/log", async (c) => {
  const body = await readBody(c.request);
  const kind = oneOf(body.kind, GROUNDING_KINDS, "kind");
  const note = reqString(body, "note", 500).trim();
  const occurred = optIso(body, "occurred");
  const row = await createGroundingRow(c.db, { kind, note, ...(occurred !== undefined ? { occurred } : {}), source: "owner" }, c.actor);
  return json(row, 201);
});

route("DELETE", "/api/grounding/log/:id", async (c) => {
  await deleteGroundingRow(c.db, idParam(c, "id"), c.actor);
  return json({ ok: true });
});

// A face for a person in her life, owner-triggered only (SPEC_V3 section DD): held open
// like a photo; 404 for an unknown thread, 409 while another request holds it, 422 when
// the bytes are blacklisted, 402 / 502 / 503 as for a photo.
route("POST", "/api/life/threads/:id/portrait", async (c) => {
  const threadId = idParam(c, "id");
  const body = await readBody(c.request);
  const description = reqString(body, "description", 2000).trim();
  const settings = await loadSettings(c);
  const asset = await generatePortrait(c.env, c.db, settings, { threadId, description, actor: c.actor });
  return json({ asset });
});

// ------------------------------------------------------------------ calls (SPEC_V3 section EE)

interface CallUsageBody { audioIn: number; audioOut: number; textIn: number; textOut: number }
interface CallSegmentBody { who: "him" | "her"; text: string; at: string }

// Cumulative token counts as the page accumulates them; every field a non-negative integer.
function callUsage(v: unknown): CallUsageBody | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw invalid("usage must be an object");
  const o = v as Record<string, unknown>;
  const field = (k: keyof CallUsageBody): number => {
    const n = o[k] ?? 0;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw invalid(`usage.${k} must be a non-negative integer`);
    return n;
  };
  return { audioIn: field("audioIn"), audioOut: field("audioOut"), textIn: field("textIn"), textOut: field("textOut") };
}

function callSegments(v: unknown): CallSegmentBody[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid("segments must be an array");
  if (v.length > MAX_CALL_SEGMENTS) throw invalid(`segments has more than ${MAX_CALL_SEGMENTS} entries`);
  const out: CallSegmentBody[] = [];
  for (const s of v) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) throw invalid("each segment must be an object");
    const seg = s as Record<string, unknown>;
    const who = oneOf(seg.who, CALL_SPEAKERS, "segments[].who");
    const text = seg.text;
    if (typeof text !== "string") throw invalid("segments[].text must be a string");
    if (text.length > MAX_CALL_SEGMENT_CHARS) throw invalid(`segments[].text exceeds ${MAX_CALL_SEGMENT_CHARS} characters`);
    const at = seg.at === undefined || seg.at === null ? nowIso() : isoOrThrow(seg.at, "segments[].at");
    out.push({ who, text, at });
  }
  return out;
}

// The start response is the only place the client secret ever appears. The router never
// logs a response body, and the call row the module stores carries no secret.
route("POST", "/api/calls/start", async (c) => {
  const body = await readBody(c.request);
  const conversationId = reqString(body, "conversationId", MAX_ID_CHARS).trim();
  const conv = await getConversation(c.db, conversationId);
  if (!conv) throw new ApiHttpError(404, "not_found", "conversation not found");
  const settings = await loadSettings(c);
  const started = await startCall(c.env, c.db, settings, { conversationId, actor: c.actor }, c.ctx);
  return json(started, 201);
});

route("POST", "/api/calls/:id/tick", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const seconds = int(body.seconds, "seconds", 0, MAX_TICK_SECONDS);
  const usage = callUsage(body.usage);
  const settings = await loadSettings(c);
  const r = await tickCall(c.db, settings, id, { seconds, ...(usage ? { usage } : {}) });
  return json({ ok: true, ...r });
});

route("POST", "/api/calls/:id/end", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const reasonRaw = optString(body, "reason", 40);
  const reason = reasonRaw && reasonRaw.trim() ? reasonRaw.trim() : "ended";
  const segments = callSegments(body.segments);
  const usage = callUsage(body.usage);
  // The seconds the page counted (optional); calls.ts bounds it by the ticks plus one.
  const seconds = body.seconds === undefined || body.seconds === null ? undefined : int(body.seconds, "seconds", 0, 24 * 60 * 60);
  const settings = await loadSettings(c);
  const r = await endCall(c.env, c.db, settings, id, { reason, segments, ...(usage ? { usage } : {}), ...(seconds !== undefined ? { seconds } : {}) }, c.actor, c.ctx);
  return json(r);
});

route("GET", "/api/calls", async (c) => {
  const raw = (c.url.searchParams.get("conversationId") ?? "").trim();
  const conversationId = raw ? raw.slice(0, MAX_ID_CHARS) : undefined;
  const limit = intQuery(c.url, "limit", 50, 1, 500);
  return json(await listCalls(c.db, conversationId, limit));
});

route("GET", "/api/calls/:id", async (c) => {
  const id = idParam(c, "id");
  const call = await getCall(c.db, id);
  if (!call) throw new ApiHttpError(404, "not_found", "call not found");
  return json({ call, messages: await listCallMessages(c.db, id) });
});

// ------------------------------------------------------------------ clips (SPEC_V3 section FF)

route("POST", "/api/video/generate", async (c) => {
  const body = await readBody(c.request);
  const sourceAssetId = reqString(body, "sourceAssetId", MAX_ID_CHARS).trim();
  const description = reqString(body, "description", 1000).trim();
  const settings = await loadSettings(c);
  const asset = await startClip(c.env, c.db, settings, { sourceAssetId, description, actor: c.actor });
  return json({ asset }, 202);
});

route("POST", "/api/video/:id/poll", async (c) => {
  const id = idParam(c, "id");
  const settings = await loadSettings(c);
  return json(await pollClip(c.env, c.db, settings, id, c.actor));
});

// ------------------------------------------------------------------ tastings (SPEC_V3 section HH)

// Registered before /api/tastings/:id so the literal path wins.
route("GET", "/api/tastings/ledger", async (c) => json(await tastingLedger(c.db)));

route("POST", "/api/tastings/promote", async (c) => {
  const body = await readBody(c.request);
  const provider = oneOf(body.provider, PROVIDERS, "provider");
  const model = reqString(body, "model", 200).trim();
  const settings = await storedSettings(c);
  return json(await promoteTasting(c.db, settings, c.env, { provider, model }, c.actor));
});

// One tasting as the page reads it: blind while pending (Left and Right, no performer
// names), the mapping revealed once it is picked, void or expired.
route("GET", "/api/tastings/:id", async (c) => {
  const id = idParam(c, "id");
  const row = await getTasting(c.db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "tasting not found");
  const candidates = blindCandidates(row, await listCandidates(c.db, id));
  if (row.status === "pending") {
    return json({
      id: row.id, conversationId: row.conversation_id, userMessageId: row.user_message_id, status: row.status, createdAt: row.created_at,
      expiresAt: expiresAtOf(row), candidates,
    });
  }
  return json({ ...revealTasting(row), expiresAt: expiresAtOf(row), candidates });
});

route("POST", "/api/tastings/:id/pick", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const pick = oneOf(body.pick, PICKS, "pick");
  const settings = await loadSettings(c);
  return json(await pickTasting(c.env, c.ctx, c.db, settings, id, pick, c.actor));
});

// ------------------------------------------------------------------ marks (SPEC_V3 section II)

interface MarkRow { message_id: string; mark: "keep" | "drop"; note: string | null; actor: string; created_at: string }

async function herStoryMessage(db: D1Database, id: string): Promise<MessageRow> {
  const row = await getMessage(db, id);
  if (!row) throw new ApiHttpError(404, "not_found", "message not found");
  if (row.role !== "assistant" || row.channel !== "story") throw invalid("only her story messages can be marked");
  return row;
}

route("POST", "/api/messages/:id/mark", async (c) => {
  const id = idParam(c, "id");
  const body = await readBody(c.request);
  const mark = oneOf(body.mark, MARKS, "mark");
  const noteRaw = optString(body, "note", 500);
  const note = noteRaw && noteRaw.trim() ? noteRaw.trim() : null;
  await herStoryMessage(c.db, id);
  const before = await c.db.prepare("SELECT * FROM message_marks WHERE message_id = ?1").bind(id).first<MarkRow>();
  const row: MarkRow = { message_id: id, mark, note, actor: c.actor, created_at: nowIso() };
  await c.db.batch([
    c.db.prepare("INSERT INTO message_marks (message_id, mark, note, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(message_id) DO UPDATE SET mark = excluded.mark, note = excluded.note, actor = excluded.actor, created_at = excluded.created_at")
      .bind(row.message_id, row.mark, row.note, row.actor, row.created_at),
    auditStmt(c.db, c.actor, "message.mark", "message", id, before, row),
  ]);
  return json({ mark: row.mark, note: row.note, messageId: id, createdAt: row.created_at });
});

route("DELETE", "/api/messages/:id/mark", async (c) => {
  const id = idParam(c, "id");
  const before = await c.db.prepare("SELECT * FROM message_marks WHERE message_id = ?1").bind(id).first<MarkRow>();
  if (!before) throw new ApiHttpError(404, "not_found", "no mark on this message");
  await c.db.batch([
    c.db.prepare("DELETE FROM message_marks WHERE message_id = ?1").bind(id),
    auditStmt(c.db, c.actor, "message.unmark", "message", id, before, null),
  ]);
  return json({ ok: true });
});

// ------------------------------------------------------------------ fine-tune (SPEC_V3 section II)

const TEXTER_MODEL_RE = /^(ft:)?[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// The export options: `stripHim` removes what she knows about him from the state part
// (absent = 1: his answer of 2026-09-24 is "on by default", and it holds for a bare GET
// from a script or a bookmark, not only for the panel's checkbox; `stripHim=0` opts out);
// `includeExplicit` keeps exchanges the explicit detector would leave out (absent = left
// out, his answer to open question 2; a Drop mark leaves one out by hand either way).
function exportOptions(url: URL): { stripHim: boolean; includeExplicit: boolean } {
  return {
    stripHim: url.searchParams.has("stripHim") ? flagQuery(url, "stripHim") : true,
    includeExplicit: flagQuery(url, "includeExplicit"),
  };
}

route("GET", "/api/finetune/status", async (c) => json(await finetuneStatus(c.db, await storedSettings(c))));

route("GET", "/api/finetune/export.jsonl", async (c) => {
  const settings = await storedSettings(c);
  const stream = await exportTrainingStream(c.db, settings, exportOptions(c.url));
  const day = nowIso().slice(0, 10);
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="avelie-train-${day}.jsonl"`,
      "cache-control": "no-store",
    },
  });
});

route("GET", "/api/finetune/export.json", async (c) => json(await exportSidecar(c.db, await storedSettings(c), exportOptions(c.url))));

route("POST", "/api/finetune/use", async (c) => {
  const body = await readBody(c.request);
  const model = reqString(body, "model", 200).trim();
  if (!TEXTER_MODEL_RE.test(model)) throw invalid("model must be a fine-tuned id (ft:...) or a plain OpenAI model id");
  const inputPerMTok = optNum(body, "inputPerMTok", 0, 100000);
  const outputPerMTok = optNum(body, "outputPerMTok", 0, 100000);
  if ((inputPerMTok === undefined) !== (outputPerMTok === undefined)) throw invalid("inputPerMTok and outputPerMTok go together");
  const settings = await storedSettings(c);
  const after = await useTexter(c.env, c.db, settings, {
    model,
    ...(inputPerMTok !== undefined ? { inputPerMTok } : {}),
    ...(outputPerMTok !== undefined ? { outputPerMTok } : {}),
  }, c.actor);
  return json(after);
});

route("POST", "/api/finetune/revert", async (c) => json(await revertTexter(c.env, c.db, await storedSettings(c), c.actor)));
