// Her voice and his voice (SPEC_V2 section S).
//
// Out: when her message ends with [voice] (voice mode "some") or on every reply ("all"),
// synthesize() makes an mp3 after the response and attachVoiceNote() stores it in R2 as
// voice/<messageId>.mp3 with messages.audio_key pointing at it. Providers: Workers AI
// (no key), ElevenLabs (ELEVENLABS_API_KEY plus a voice id), a stub for tests (a tiny
// mp3, no call), or off. A failure leaves the text message exactly as it is.
//
// In: transcribe() turns his recording into words (Workers AI whisper, OpenAI, or the
// stub); the API route runs the normal turn with the transcript.
//
// The marker parser is pure. Nothing here ever prints a key.
//
// v4 (SPEC_V4 Amendment A2, lane L10): the ElevenLabs branch rides on
// providers/elevenlabs.ts (the same adapter the calls use), reads the model from the
// setting elevenLabsModel, and is priced: characters at elevenLabsTtsPricePer1kChars
// through assertBudget before the call, the cost on the run row and in usage_daily after
// it. A price of 0 refuses the note (a paid path never meters at nothing). Workers AI and
// the stub are unchanged.
import { assertBudget } from "./budget";
import { auditStmt, dayKey, insertModelRunStmt, newId, nowIso, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { ELEVENLABS_DEFAULT_MODEL, elevenLabsProviderFor, elevenLabsSettingsOf, elevenLabsVoiceConfigured, ttsEstimateUsd } from "./providers/elevenlabs";
import { redactSecrets, safeErrorMessage } from "./providers/types";
import { ProviderError } from "./types";
import type { Env, ModelRunRow, Settings } from "./types";
import { base64ToBytes, bytesToBase64 } from "./vision";

// Workers AI model ids, confirmed 2026-09-24 against the Cloudflare docs and the
// @cloudflare/workers-types 5.20260924 catalogue. One table so a change is one edit.
//   tts: MeloTTS, input { prompt, lang }, output mp3 (base64 in { audio } or raw bytes).
//   ttsAlternative: Deepgram Aura 1, input { text, speaker, encoding: "mp3" }, output bytes.
//   transcribe: Whisper large v3 turbo, input { audio: <base64> }, output { text }.
//   transcribeLegacy: the original Whisper, input { audio: number[] } (8-bit samples of
//     the file); still served, but a 4 MB recording becomes a 16 MB JSON array.
//   vision: Llama 3.2 11B Vision, chat messages with image_url data-URL content parts.
export const WORKERS_AI_MODELS = Object.freeze({
  tts: "@cf/myshell-ai/melotts",
  ttsAlternative: "@cf/deepgram/aura-1",
  transcribe: "@cf/openai/whisper-large-v3-turbo",
  transcribeLegacy: "@cf/openai/whisper",
  vision: "@cf/meta/llama-3.2-11b-vision-instruct",
} as const);

export const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
// The default ElevenLabs model (the setting elevenLabsModel overrides it per note).
export const ELEVENLABS_TTS_MODEL: string = ELEVENLABS_DEFAULT_MODEL;

export const VOICE_PREFIX = "voice/";
// More than she would ever say in one note; ElevenLabs stops at 5000.
export const MAX_SPEECH_CHARS = 2500;
const STT_TIMEOUT_MS = 90_000;

export interface SynthesisResult {
  mp3: ArrayBuffer;
  provider: string;
  model: string;
  // v4 A2: the characters an ElevenLabs note billed (absent on the other providers).
  chars?: number;
}

export interface Transcript {
  text: string;
  provider: string;
  model: string;
}

interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

// ------------------------------------------------------------------ the marker (pure)

const VOICE_RE = /\[\s*voice\s*\]/gi;
// What a line may be left with once its marker is gone and still count as empty.
const LEFTOVER_RE = /^[\s.,;:!?)]*$/;

// "[voice]" anywhere in the text (case-insensitive). Every occurrence is removed; a line
// that held only the marker (plus stray punctuation) disappears; a line that also carried
// prose keeps the prose. Same shape as the photo and song parsers in markers.ts.
export function parseVoiceMarker(text: string): { clean: string; voice: boolean } {
  let voice = false;
  const kept: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    let had = false;
    const stripped = line.replace(VOICE_RE, () => {
      had = true;
      return "";
    });
    if (!had) {
      kept.push(line);
      continue;
    }
    voice = true;
    if (LEFTOVER_RE.test(stripped)) continue;
    kept.push(stripped.replace(/[ \t]{2,}/g, " ").trimEnd());
  }
  return { clean: kept.join("\n").trimEnd(), voice };
}

// ------------------------------------------------------------------ settings

// Whether this reply gets audio: never with the provider off or the mode off; on every
// reply in mode "all"; in mode "some" only when she asked with the marker.
export function voiceWanted(settings: Settings, marker: boolean): boolean {
  if (settings.voiceProvider === "off") return false;
  const mode = settings.voiceMode;
  if (mode === "all") return true;
  if (mode === "some") return marker === true;
  return false;
}

function hasKey(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function voiceConfigured(env: Env, settings: Settings): boolean {
  switch (settings.voiceProvider) {
    case "stub":
    case "workersai":
      return true;
    case "elevenlabs":
      return elevenLabsVoiceConfigured(env, settings);
    default:
      return false;
  }
}

export function transcribeConfigured(env: Env, settings: Settings): boolean {
  switch (settings.transcribeProvider) {
    case "stub":
    case "workersai":
      return true;
    case "openai":
      return hasKey(env.OPENAI_API_KEY);
    default:
      return false;
  }
}

// ------------------------------------------------------------------ small helpers

function aiBinding(env: Env, provider: string): AiLike {
  const ai = env.AI as unknown as AiLike | undefined;
  if (!ai || typeof ai.run !== "function") throw new ProviderError(provider, "config", "AI binding not available", 503, false);
  return ai;
}

function mapAiError(e: unknown, provider: string): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = safeErrorMessage(e);
  if (/no such model|not found|does not exist|unsupported model|invalid input|decod/i.test(msg)) {
    return new ProviderError(provider, "bad_request", msg, 400, false);
  }
  if (/rate limit|too many requests|\b429\b/i.test(msg)) return new ProviderError(provider, "rate_limit", msg, 429, true);
  if (/unauthori|forbidden|\b401\b|\b403\b/i.test(msg)) return new ProviderError(provider, "auth", msg, 401, false);
  return new ProviderError(provider, "server", msg, 502, true);
}

function networkError(e: unknown, provider: string): ProviderError {
  const name = e instanceof Error ? e.name : "";
  const msg = name === "TimeoutError" || name === "AbortError" ? "request timed out" : safeErrorMessage(e);
  return new ProviderError(provider, "network", msg, 502, true);
}

// An HTTP failure as a ProviderError. The body is redacted and the key itself is cut
// out of it before any of it becomes a message.
async function httpError(res: Response, provider: string, secret: string): Promise<ProviderError> {
  let detail = "";
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const j = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
      const m = j.error ?? j.detail ?? j.message;
      if (typeof m === "string") detail = m;
      else if (typeof m === "object" && m !== null && typeof (m as { message?: unknown }).message === "string") detail = (m as { message: string }).message;
      else detail = text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  let msg = redactSecrets(detail).replace(/\s+/g, " ").trim();
  if (secret) msg = msg.split(secret).join("[redacted]");
  msg = msg.slice(0, 300);
  const s = res.status;
  if (s === 401) return new ProviderError(provider, "auth", "authentication failed", 401, false);
  if (s === 403) return new ProviderError(provider, "auth", "permission denied", 403, false);
  if (s === 429) return new ProviderError(provider, "rate_limit", msg || "rate limited", 429, true);
  if (s === 400 || s === 404 || s === 413 || s === 415 || s === 422) return new ProviderError(provider, "bad_request", msg || "bad request", s, false);
  if (s >= 500) return new ProviderError(provider, "server", msg || "server error", s, true);
  return new ProviderError(provider, "other", msg || "unexpected status " + s, s, false);
}

// A fresh ArrayBuffer holding exactly these bytes.
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

// The audio a Workers AI call handed back, whatever shape the runtime chose: raw bytes,
// a stream, a base64 string, or { audio: <base64> }.
async function audioBytes(out: unknown, provider: string): Promise<ArrayBuffer> {
  if (out instanceof ArrayBuffer) return out;
  if (out instanceof Uint8Array) return toArrayBuffer(out);
  if (out instanceof ReadableStream) return new Response(out).arrayBuffer();
  if (typeof out === "string") return toArrayBuffer(base64ToBytes(out));
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (typeof o.audio === "string") return toArrayBuffer(base64ToBytes(o.audio));
    if (o.audio instanceof ArrayBuffer) return o.audio;
    if (o.audio instanceof Uint8Array) return toArrayBuffer(o.audio);
  }
  throw new ProviderError(provider, "server", "no audio in the response", 502, true);
}

// The words a transcription call handed back: a string or { text }.
function transcriptText(out: unknown): string {
  if (typeof out === "string") return out.trim();
  if (out && typeof out === "object") {
    const t = (out as { text?: unknown }).text;
    if (typeof t === "string") return t.trim();
  }
  return "";
}

// ID3v2 header, one MPEG-1 Layer III frame header (128 kbps, 44.1 kHz) and an empty
// frame body: enough for any sniff and any player to call it an mp3. Tests only.
export function stubMp3(): ArrayBuffer {
  const id3 = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a];
  const padding = new Array<number>(10).fill(0);
  const frame = [0xff, 0xfb, 0x90, 0x00];
  const body = new Array<number>(413).fill(0);
  return toArrayBuffer(Uint8Array.from([...id3, ...padding, ...frame, ...body]));
}

function extForAudio(mime: string): string {
  const m = (mime || "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (m === "audio/mpeg") return "mp3";
  if (m === "audio/mp4" || m === "audio/x-m4a") return "m4a";
  if (m === "audio/aac") return "aac";
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  if (m === "audio/ogg") return "ogg";
  if (m === "audio/flac") return "flac";
  return "webm";
}

// ------------------------------------------------------------------ voice out

async function workersAiSpeech(env: Env, speech: string): Promise<SynthesisResult> {
  const ai = aiBinding(env, "workersai");
  const model: string = WORKERS_AI_MODELS.tts;
  const inputs: Record<string, unknown> = model.startsWith("@cf/deepgram/aura")
    ? { text: speech, encoding: "mp3" }
    : { prompt: speech, lang: "en" };
  let out: unknown;
  try {
    out = await ai.run(model, inputs);
  } catch (e) {
    throw mapAiError(e, "workersai");
  }
  const mp3 = await audioBytes(out, "workersai");
  if (!mp3.byteLength) throw new ProviderError("workersai", "server", "empty audio", 502, true);
  return { mp3, provider: "workersai", model };
}

// Her voice from ElevenLabs (v4 A2): the adapter in providers/elevenlabs.ts makes the
// call; the key and the voice id are checked there (503 config errors). The characters
// billed ride back on `chars` for the run row.
async function elevenLabsSpeech(env: Env, settings: Settings, speech: string): Promise<SynthesisResult> {
  const es = elevenLabsSettingsOf(settings);
  if (!es.voiceId) throw new ProviderError("elevenlabs", "config", "elevenLabsVoiceId not set", 503, false);
  const r = await elevenLabsProviderFor(env).textToSpeech(env, { voiceId: es.voiceId, text: speech, model: es.model });
  return { mp3: r.mp3, provider: "elevenlabs", model: r.model, chars: r.chars };
}

// The cost of an ElevenLabs note in micro-USD, from the characters sent.
export function elevenLabsNoteCostMicro(chars: number, pricePer1kChars: number): number {
  const c = Math.max(0, Math.floor(chars));
  const p = Math.max(0, pricePer1kChars);
  return Math.ceil((c / 1000) * p * 1_000_000);
}

// The paid gate on an ElevenLabs note (v4 A2), run before anything is spent: a price of
// 0 is refused (402 price_unknown, the same law as every other paid path), then the
// estimate must fit under the caps. Workers AI and the stub bill nothing here.
export async function assertVoiceBudget(db: D1Database, settings: Settings, text: string): Promise<{ estimateUsd: number; chars: number }> {
  const chars = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH_CHARS).length;
  if (settings.voiceProvider !== "elevenlabs") return { estimateUsd: 0, chars };
  const price = elevenLabsSettingsOf(settings).ttsPricePer1kChars;
  if (!(price > 0)) {
    throw new ApiHttpError(402, "price_unknown", "elevenLabsTtsPricePer1kChars is 0; set the price per 1k characters in the Voice section of the Model page before a note", false, "elevenlabs");
  }
  const estimateUsd = ttsEstimateUsd(chars, price);
  await assertBudget(db, settings, estimateUsd);
  return { estimateUsd, chars };
}

// Her words as audio. The text arrives already stripped of markers; it is flattened to
// one line and capped. Provider "off" and a missing key are config errors (503), so a
// caller can tell "not set up" from "failed".
export async function synthesize(env: Env, settings: Settings, text: string): Promise<SynthesisResult> {
  const speech = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH_CHARS);
  const provider = settings.voiceProvider;
  if (provider === "off") throw new ProviderError("voice", "config", "voice is off", 503, false);
  if (!speech) throw new ProviderError(provider, "bad_request", "nothing to say", 400, false);
  switch (provider) {
    case "stub":
      return { mp3: stubMp3(), provider: "stub", model: "stub-mp3" };
    case "workersai":
      return workersAiSpeech(env, speech);
    case "elevenlabs":
      return elevenLabsSpeech(env, settings, speech);
    default:
      throw new ProviderError(String(provider), "config", "unknown voice provider: " + String(provider), 503, false);
  }
}

export interface VoiceNoteArgs {
  messageId: string;
  conversationId: string | null;
  text: string;
  actor?: string;
}

// The whole after-the-response job: synthesize, store voice/<messageId>.mp3, point the
// message at it, record the run. Best effort: any failure is logged by class, written as
// a failed run, and the text message stands untouched. Returns the key or null.
export async function attachVoiceNote(env: Env, db: D1Database, settings: Settings, args: VoiceNoteArgs): Promise<{ key: string; bytes: number } | null> {
  const started = Date.now();
  const actor = args.actor ?? "system";
  const provider = settings.voiceProvider;
  let model = "";
  try {
    // v4 A2: the ElevenLabs note is priced before the call and metered after it.
    await assertVoiceBudget(db, settings, args.text);
    const r = await synthesize(env, settings, args.text);
    model = r.model;
    const chars = provider === "elevenlabs" && typeof r.chars === "number" ? r.chars : 0;
    const costMicro = provider === "elevenlabs" ? elevenLabsNoteCostMicro(chars, elevenLabsSettingsOf(settings).ttsPricePer1kChars) : 0;
    const key = VOICE_PREFIX + args.messageId + ".mp3";
    await env.MEDIA.put(key, r.mp3, { httpMetadata: { contentType: "audio/mpeg" } });
    // Only her message, and only once: a second note for the same message is dropped.
    const res = await db
      .prepare("UPDATE messages SET audio_key = ?1 WHERE id = ?2 AND role = 'assistant' AND audio_key IS NULL")
      .bind(key, args.messageId)
      .run();
    if (!res.meta.changes) {
      try {
        await env.MEDIA.delete(key);
      } catch {
        /* the object is orphaned at worst */
      }
      return null;
    }
    const run: ModelRunRow = {
      id: newId("r"),
      conversation_id: args.conversationId,
      kind: "voice",
      provider: r.provider,
      model: r.model,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd_micro: costMicro,
      latency_ms: Date.now() - started,
      status: "ok",
      error: null,
      flags_json: null,
      created_at: nowIso(),
    };
    const stmts: D1PreparedStatement[] = [
      insertModelRunStmt(db, run),
      auditStmt(db, actor, "voice.synthesize", "message", args.messageId, null, { key, bytes: r.mp3.byteLength, provider: r.provider, model: r.model, chars, cost_usd_micro: costMicro }),
    ];
    // The note is one request in the usage table, so the caps see it (v4 A2).
    if (provider === "elevenlabs") stmts.push(usageStmt(db, dayKey(), r.provider, r.model, 0, 0, costMicro, 1));
    await db.batch(stmts);
    return { key, bytes: r.mp3.byteLength };
  } catch (e) {
    const cls = e instanceof ProviderError ? e.kind : e instanceof ApiHttpError ? e.code : e instanceof Error ? e.name || "Error" : "error";
    console.warn("voice note failed", provider, cls, safeErrorMessage(e, 200));
    const failed: ModelRunRow = {
      id: newId("r"),
      conversation_id: args.conversationId,
      kind: "voice",
      provider,
      model: model || WORKERS_AI_MODELS.tts,
      prompt_version: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd_micro: 0,
      latency_ms: Date.now() - started,
      status: "failed",
      error: (cls + ": " + safeErrorMessage(e, 200)).slice(0, 300),
      flags_json: null,
      created_at: nowIso(),
    };
    try {
      await insertModelRunStmt(db, failed).run();
    } catch {
      /* the run row is best effort */
    }
    return null;
  }
}

// ------------------------------------------------------------------ voice in

async function workersAiTranscribe(env: Env, bytes: ArrayBuffer): Promise<Transcript> {
  const ai = aiBinding(env, "workersai");
  const model: string = WORKERS_AI_MODELS.transcribe;
  // The original whisper takes the file as 8-bit samples; every newer id takes base64.
  const inputs: Record<string, unknown> = model === WORKERS_AI_MODELS.transcribeLegacy || model.endsWith("whisper-tiny-en")
    ? { audio: Array.from(new Uint8Array(bytes)) }
    : { audio: bytesToBase64(bytes), task: "transcribe" };
  let out: unknown;
  try {
    out = await ai.run(model, inputs);
  } catch (e) {
    throw mapAiError(e, "workersai");
  }
  return { text: transcriptText(out), provider: "workersai", model };
}

async function openaiTranscribe(env: Env, bytes: ArrayBuffer, mime: string): Promise<Transcript> {
  const key = (env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new ProviderError("openai", "config", "OPENAI_API_KEY not set", 503, false);
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime || "audio/webm" }), "note." + extForAudio(mime));
  fd.append("model", OPENAI_TRANSCRIBE_MODEL);
  fd.append("response_format", "json");
  let res: Response;
  try {
    res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: fd,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e, "openai");
  }
  if (!res.ok) throw await httpError(res, "openai", key);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ProviderError("openai", "server", "unreadable response body", 502, true);
  }
  return { text: transcriptText(data), provider: "openai", model: OPENAI_TRANSCRIBE_MODEL };
}

// His recording as words. Empty audio is a bad request; an empty transcript comes back
// as "" and the caller decides (the API answers 422 empty_transcript).
export async function transcribe(env: Env, settings: Settings, bytes: ArrayBuffer, mime: string): Promise<Transcript> {
  if (!bytes || !bytes.byteLength) throw new ProviderError(settings.transcribeProvider, "bad_request", "audio is empty", 400, false);
  switch (settings.transcribeProvider) {
    case "stub":
      return { text: "this is a voice note", provider: "stub", model: "stub-transcribe" };
    case "workersai":
      return workersAiTranscribe(env, bytes);
    case "openai":
      return openaiTranscribe(env, bytes, mime);
    default:
      throw new ProviderError(String(settings.transcribeProvider), "config", "unknown transcribe provider", 503, false);
  }
}
