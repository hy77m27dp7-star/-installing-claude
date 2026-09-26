// ElevenLabs over fetch (SPEC_V4 Amendment A2, lane L10): her own voice, the same on a
// phone call and in a voice note.
//
// Two calls, both from the Worker with the API key, never from the page:
//   mintSession   GET /v1/convai/conversation/token?agent_id=...   (the WebRTC transport;
//                 answers { token, conversation_id }), falling back once to
//                 GET /v1/convai/conversation/get-signed-url?agent_id=... (the WebSocket
//                 transport; answers { signed_url }) when the token endpoint is not served
//                 for the account (404, or a 403 / 422 that is not an authentication
//                 failure). Confirmed against the ElevenLabs API reference on 2026-09-26:
//                 both endpoints exist and take xi-api-key; the signed URL is good for 15
//                 minutes and the conversation must start inside that window; the token's
//                 validity is not stated, so both are treated as fifteen-minute, one-use
//                 credentials. Which one a call used is in the start response (`transport`)
//                 and the call's audit row.
//   textToSpeech  POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128 with
//                 xi-api-key, body { text, model_id }; answers audio/mpeg bytes. Confirmed
//                 against the API reference the same day: model_id defaults to
//                 eleven_multilingual_v2; eleven_flash_v2_5, eleven_turbo_v2_5 and eleven_v3
//                 are the other current ids.
//
// The credential a mint answers is returned to calls.startCall and nowhere else: never
// stored, never logged, never audited (redactSecrets covers xi-api-key headers and
// bearer forms; the key itself is cut out of any error body here). The stub
// (providers/stub.ts stubElevenLabsFetch, the [[ELEVEN]] stub) answers the same three
// URLs with { token: "stub-token" }, a wss://...invalid signed URL and 64 bytes of a fixed
// pattern as audio/mpeg; the Worker reaches it through ELEVENLABS_STUB=1 while ACCESS_AUD
// is empty (local only, the way SPOTIFY_STUB works), and the unit tests hand it in through
// the deps argument.
import { ProviderError } from "../types";
import type { Env, Settings } from "../types";
import { redactSecrets, safeErrorMessage } from "./types";
import { stubElevenLabsFetch } from "./stub";

export const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io";
export const ELEVENLABS_TOKEN_URL = ELEVENLABS_ORIGIN + "/v1/convai/conversation/token";
export const ELEVENLABS_SIGNED_URL_URL = ELEVENLABS_ORIGIN + "/v1/convai/conversation/get-signed-url";
export const ELEVENLABS_TTS_URL = ELEVENLABS_ORIGIN + "/v1/text-to-speech/";
// The WebRTC transport: the vendored client joins a LiveKit room on this host with the
// minted token (DEFAULT_LIVEKIT_WS_URL in @elevenlabs/client 1.25.0; livekit-client also
// probes the same host over https when a join fails). The page's connect-src needs the
// four origins below; the media itself is WebRTC (UDP or TURN), which no CSP directive
// in use here governs.
export const ELEVENLABS_LIVEKIT_HOST = "livekit.rtc.elevenlabs.io";
export const ELEVENLABS_CONNECT_ORIGINS: readonly string[] = Object.freeze([
  "https://api.elevenlabs.io",
  "wss://api.elevenlabs.io",
  "wss://" + ELEVENLABS_LIVEKIT_HOST,
  "https://" + ELEVENLABS_LIVEKIT_HOST,
]);

export const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_TTS_MODELS: readonly string[] = Object.freeze(["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3"]);
export const ELEVENLABS_TTS_OUTPUT = "mp3_44100_128";
// The two defaults the settings table carries (elevenLabsTtsPricePer1kChars is a v4 key,
// elevenLabsCallPricePerMinute a v3 one; a stored table without a key reads its default).
export const ELEVENLABS_TTS_PRICE_PER_1K_CHARS = 0.3;
export const ELEVENLABS_CALL_PRICE_PER_MINUTE = 0.1;
// Fifteen minutes: the documented life of a signed URL; the token is treated the same.
export const ELEVENLABS_CREDENTIAL_TTL_S = 15 * 60;
export const MAX_MODEL_ID_CHARS = 60;
const MINT_TIMEOUT_MS = 20_000;
const TTS_TIMEOUT_MS = 60_000;
// ElevenLabs refuses longer texts; voice.ts caps a note far under this.
export const ELEVENLABS_MAX_TTS_CHARS = 5000;

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export type ElevenTransport = "webrtc" | "websocket";

export interface ElevenSession {
  transport: ElevenTransport;
  // The conversation token (webrtc) or the signed URL (websocket). Returned once.
  credential: string;
  // Unix seconds.
  expiresAt: number;
  // The conversation id the token endpoint names, when it does.
  conversationId: string | null;
  agentId: string;
}

export interface ElevenMintRequest {
  agentId: string;
}

export interface ElevenTtsRequest {
  voiceId: string;
  text: string;
  model: string;
}

export interface ElevenTtsResult {
  mp3: ArrayBuffer;
  model: string;
  // The characters billed (the text as sent).
  chars: number;
}

export interface ElevenLabsProvider {
  name: "elevenlabs";
  mintSession(env: Env, req: ElevenMintRequest): Promise<ElevenSession>;
  textToSpeech(env: Env, req: ElevenTtsRequest): Promise<ElevenTtsResult>;
}

// The agent overrides the page passes at session start (the SDK's `overrides` option, the
// shape of @elevenlabs/client 1.25.0 BaseSessionConfig.overrides): her instructions as
// the system prompt, an empty first message (she picks up and waits or says hi, her
// choice), her voice. The agent must have the system prompt, first message and voice
// overrides enabled in its Security tab (docs/ELEVENLABS.md), or the session refuses.
export interface ElevenOverrides {
  agent: { prompt: { prompt: string }; firstMessage: string };
  tts: { voiceId: string };
}

export interface ElevenSettings {
  voiceId: string;
  agentId: string;
  model: string;
  ttsPricePer1kChars: number;
  callPricePerMinute: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ElevenLabsDeps {
  fetch?: FetchLike;
  now?: () => number;
}

// ------------------------------------------------------------------ settings

// The two v4 keys are declared by the pipeline lane (types.ts, db.ts, the seed, api.ts);
// this module reads them by name with the spec's defaults so a table without them still
// prices the path.
type ElevenSettingKeys = { elevenLabsModel?: unknown; elevenLabsTtsPricePer1kChars?: unknown };

function str(v: unknown, fallback: string, max: number): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function elevenLabsSettingsOf(settings: Settings): ElevenSettings {
  const s = settings as Settings & ElevenSettingKeys;
  return {
    voiceId: str(s.elevenLabsVoiceId, "", 120),
    agentId: str(s.elevenLabsAgentId, "", 120),
    model: str(s.elevenLabsModel, ELEVENLABS_DEFAULT_MODEL, MAX_MODEL_ID_CHARS),
    ttsPricePer1kChars: num(s.elevenLabsTtsPricePer1kChars, ELEVENLABS_TTS_PRICE_PER_1K_CHARS, 0, 100),
    callPricePerMinute: num(s.elevenLabsCallPricePerMinute, ELEVENLABS_CALL_PRICE_PER_MINUTE, 0, 100),
  };
}

export function isElevenId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

function hasKey(env: Env): boolean {
  return typeof env.ELEVENLABS_API_KEY === "string" && env.ELEVENLABS_API_KEY.trim().length > 0;
}

// Voice notes need the key and a voice id; calls need the key and an agent id (the voice
// rides as an override and is optional there: without one the agent's own voice speaks).
export function elevenLabsVoiceConfigured(env: Env, settings: Settings): boolean {
  return hasKey(env) && isElevenId(elevenLabsSettingsOf(settings).voiceId);
}

export function elevenLabsCallConfigured(env: Env, settings: Settings): boolean {
  return hasKey(env) && isElevenId(elevenLabsSettingsOf(settings).agentId);
}

// The pre-call estimate of a note, in USD: characters at the per-1k price, rounded up to
// the cent so a short note is never estimated at nothing. A price of 0 is refused by the
// caller (assertBudget takes 0 as free, and a paid path may never meter at nothing).
export function ttsEstimateUsd(chars: number, pricePer1kChars: number): number {
  const c = Math.max(0, Math.floor(chars));
  const p = Math.max(0, pricePer1kChars);
  if (!c || !p) return 0;
  return Math.ceil((c / 1000) * p * 100) / 100;
}

export function elevenLabsOverrides(args: { instructions: string; voiceId: string }): ElevenOverrides {
  return {
    agent: { prompt: { prompt: args.instructions }, firstMessage: "" },
    tts: { voiceId: args.voiceId },
  };
}

// ------------------------------------------------------------------ errors

function requireKey(env: Env): string {
  const key = env.ELEVENLABS_API_KEY;
  if (!key || !key.trim()) throw new ProviderError("elevenlabs", "config", "ELEVENLABS_API_KEY not set", 503, false);
  return key.trim();
}

function networkError(e: unknown): ProviderError {
  const name = e instanceof Error ? e.name : "";
  const msg = name === "TimeoutError" || name === "AbortError" ? "request timed out" : safeErrorMessage(e);
  return new ProviderError("elevenlabs", "network", msg, 502, true);
}

// An HTTP failure as a ProviderError. The body is redacted and the key itself is cut out
// of it before any of it becomes a message; a 401 or 403 says only that authentication
// failed (an ElevenLabs body can echo the key's prefix).
async function httpError(res: Response, key: string): Promise<ProviderError> {
  let detail = "";
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const j = JSON.parse(text) as { detail?: unknown; error?: unknown; message?: unknown };
      const m = j.detail ?? j.error ?? j.message;
      if (typeof m === "string") detail = m;
      else if (m && typeof m === "object") {
        const inner = (m as { message?: unknown; status?: unknown }).message ?? (m as { status?: unknown }).status;
        detail = typeof inner === "string" ? inner : text;
      } else detail = text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  let msg = redactSecrets(detail).replace(/\s+/g, " ").trim();
  if (key) msg = msg.split(key).join("[redacted]");
  msg = msg.slice(0, 300);
  const s = res.status;
  if (s === 401) return new ProviderError("elevenlabs", "auth", "authentication failed", 401, false);
  if (s === 403) return new ProviderError("elevenlabs", "auth", "permission denied" + (msg ? ": " + msg : ""), 403, false);
  if (s === 429) return new ProviderError("elevenlabs", "rate_limit", msg || "rate limited", 429, true);
  if (s === 400 || s === 404 || s === 413 || s === 415 || s === 422) return new ProviderError("elevenlabs", "bad_request", msg || "bad request", s, false);
  if (s >= 500) return new ProviderError("elevenlabs", "server", msg || "server error", s, true);
  return new ProviderError("elevenlabs", "other", msg || "unexpected status " + s, s, false);
}

// The token endpoint answers 404 on an account it is not served for; a 403 or 422 that
// is not an authentication failure reads the same way. A 401 never falls back.
function tokenEndpointUnavailable(e: ProviderError): boolean {
  if (e.kind === "auth") return e.status === 403 && !/api key|unauthori|authentication/i.test(e.message);
  return e.kind === "bad_request" && (e.status === 404 || e.status === 422);
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderError("elevenlabs", "server", "unreadable response body", 502, true);
  }
}

// ------------------------------------------------------------------ the adapter

export function makeElevenLabsProvider(deps: ElevenLabsDeps = {}): ElevenLabsProvider {
  const f: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());

  const get = async (url: string, key: string): Promise<Response> => {
    try {
      return await f(url, { method: "GET", headers: { "xi-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(MINT_TIMEOUT_MS) });
    } catch (e) {
      throw networkError(e);
    }
  };

  const mintToken = async (key: string, agentId: string): Promise<ElevenSession> => {
    const res = await get(ELEVENLABS_TOKEN_URL + "?agent_id=" + encodeURIComponent(agentId), key);
    if (!res.ok) throw await httpError(res, key);
    const data = await readJson<{ token?: unknown; conversation_id?: unknown }>(res);
    const token = typeof data.token === "string" ? data.token.trim() : "";
    if (!token) throw new ProviderError("elevenlabs", "server", "token response carried no token", 502, true);
    const conversationId = typeof data.conversation_id === "string" && data.conversation_id.trim() ? data.conversation_id.trim() : null;
    return { transport: "webrtc", credential: token, expiresAt: Math.floor(now() / 1000) + ELEVENLABS_CREDENTIAL_TTL_S, conversationId, agentId };
  };

  const mintSignedUrl = async (key: string, agentId: string): Promise<ElevenSession> => {
    const res = await get(ELEVENLABS_SIGNED_URL_URL + "?agent_id=" + encodeURIComponent(agentId), key);
    if (!res.ok) throw await httpError(res, key);
    const data = await readJson<{ signed_url?: unknown }>(res);
    const url = typeof data.signed_url === "string" ? data.signed_url.trim() : "";
    if (!/^wss:\/\//.test(url)) throw new ProviderError("elevenlabs", "server", "signed url response carried no wss url", 502, true);
    return { transport: "websocket", credential: url, expiresAt: Math.floor(now() / 1000) + ELEVENLABS_CREDENTIAL_TTL_S, conversationId: null, agentId };
  };

  return {
    name: "elevenlabs",

    async mintSession(env, req) {
      const key = requireKey(env);
      const agentId = (req.agentId ?? "").trim();
      if (!isElevenId(agentId)) throw new ProviderError("elevenlabs", "config", "elevenLabsAgentId is not an agent id", 503, false);
      try {
        return await mintToken(key, agentId);
      } catch (e) {
        if (!(e instanceof ProviderError) || !tokenEndpointUnavailable(e)) throw e;
        console.warn("elevenlabs token endpoint unavailable; falling back to a signed url", e.kind, e.status);
        return mintSignedUrl(key, agentId);
      }
    },

    async textToSpeech(env, req) {
      const key = requireKey(env);
      const voiceId = (req.voiceId ?? "").trim();
      if (!isElevenId(voiceId)) throw new ProviderError("elevenlabs", "config", "elevenLabsVoiceId is not a voice id", 503, false);
      const text = (req.text ?? "").replace(/\s+/g, " ").trim().slice(0, ELEVENLABS_MAX_TTS_CHARS);
      if (!text) throw new ProviderError("elevenlabs", "bad_request", "nothing to say", 400, false);
      const model = str(req.model, ELEVENLABS_DEFAULT_MODEL, MAX_MODEL_ID_CHARS);
      let res: Response;
      try {
        res = await f(ELEVENLABS_TTS_URL + encodeURIComponent(voiceId) + "?output_format=" + ELEVENLABS_TTS_OUTPUT, {
          method: "POST",
          headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: model }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
      } catch (e) {
        throw networkError(e);
      }
      if (!res.ok) throw await httpError(res, key);
      const mp3 = await res.arrayBuffer();
      if (!mp3.byteLength) throw new ProviderError("elevenlabs", "server", "empty audio", 502, true);
      return { mp3, model, chars: text.length };
    },
  };
}

export const elevenLabsProvider: ElevenLabsProvider = makeElevenLabsProvider();

// Local only: ELEVENLABS_STUB=1 while ACCESS_AUD is empty routes every call to the stub
// fetch (the way SPOTIFY_STUB does). Production never has it set, and with ACCESS_AUD
// set the flag is ignored.
export function elevenLabsStubMode(env: Env): boolean {
  const flag = (env as Env & { ELEVENLABS_STUB?: unknown }).ELEVENLABS_STUB;
  return flag === "1" && !(env.ACCESS_AUD ?? "").trim();
}

export function elevenLabsProviderFor(env: Env): ElevenLabsProvider {
  return elevenLabsStubMode(env) ? makeElevenLabsProvider({ fetch: stubElevenLabsFetch().fetch }) : elevenLabsProvider;
}
