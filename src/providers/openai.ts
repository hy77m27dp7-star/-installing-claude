// OpenAI adapters over fetch: chat completions for text, images/edits for photos,
// images/generations for portraits (v3, no references), and the realtime client-secret
// mint for calls (v3). Error bodies are redacted before they become messages (a 401 body
// echoes a masked key; a realtime body could echo the ephemeral token).
import { ProviderError } from "../types";
import type {
  Env, GenerateRequest, GenerateResult, ImageGenerateRequest, ImageGenerateResult, TextProvider,
} from "../types";
import { redactSecrets, safeErrorMessage } from "./types";
import type { ImageFromTextRequest, ImageProviderV3, RealtimeSecret, RealtimeSecretRequest } from "./types";
import { dataUrl, imagesOf, loadInboxImages } from "../vision";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const IMAGE_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
// GA realtime (SPEC_V3 EE): the Worker mints a client secret; the page posts its SDP offer
// to the calls endpoint with that secret. The Worker never touches audio.
const REALTIME_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";
const TEXT_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 180_000;
const REALTIME_TIMEOUT_MS = 20_000;
// Server VAD: half a second of silence ends his turn; his speech interrupts hers.
const VAD_SILENCE_MS = 500;
// The API's default validity for a client secret when expires_after is unset.
const DEFAULT_SECRET_TTL_S = 600;

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

interface ClientSecretResponse {
  value?: unknown;
  expires_at?: unknown;
  session?: { model?: unknown } | null;
}

function requireKey(env: Env): string {
  const key = env.OPENAI_API_KEY;
  if (!key || !key.trim()) throw new ProviderError("openai", "config", "OPENAI_API_KEY not set", 503, false);
  return key;
}

function networkError(e: unknown): ProviderError {
  const name = e instanceof Error ? e.name : "";
  const msg = name === "TimeoutError" || name === "AbortError" ? "request timed out" : safeErrorMessage(e);
  return new ProviderError("openai", "network", msg, 502, true);
}

// Maps an HTTP failure to a ProviderError. Never touches request headers.
async function errorFromResponse(res: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const j = JSON.parse(text) as { error?: { message?: unknown } };
      const m = j.error?.message;
      detail = typeof m === "string" ? m : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  const msg = redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, 300);
  const s = res.status;
  if (s === 401) return new ProviderError("openai", "auth", "authentication failed", 401, false);
  if (s === 403) return new ProviderError("openai", "auth", "permission denied", 403, false);
  if (s === 429) return new ProviderError("openai", "rate_limit", msg || "rate limited", 429, true);
  if (s === 400 || s === 404 || s === 413 || s === 415 || s === 422) {
    return new ProviderError("openai", "bad_request", msg || "bad request", s, false);
  }
  if (s >= 500) return new ProviderError("openai", "server", msg || "server error", s, true);
  return new ProviderError("openai", "other", msg || "unexpected status " + s, s, false);
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderError("openai", "server", "unreadable response body", 502, true);
  }
}

type Base64Static = { fromBase64?: (s: string) => Uint8Array };

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatParam = { role: string; content: string | ChatPart[] };

// His photos go as image_url data URLs before the text of the message they came with
// (SPEC_V2 section T). A picture that cannot be loaded is simply not sent.
async function toParams(env: Env, messages: GenerateRequest["messages"]): Promise<ChatParam[]> {
  const out: ChatParam[] = [];
  for (const m of messages) {
    const refs = m.role === "user" ? imagesOf(m) : [];
    if (!refs.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = await loadInboxImages(env, refs);
    if (!blocks.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: ChatPart[] = blocks.map((b) => ({ type: "image_url", image_url: { url: dataUrl(b) } }));
    parts.push({ type: "text", text: m.content });
    out.push({ role: "user", content: parts });
  }
  return out;
}

// A multi-megabyte image comes back base64. The native decoder is used where the
// runtime has it (it costs no CPU to speak of); the byte loop is the fallback.
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s+/g, "");
  const native = (Uint8Array as unknown as Base64Static).fromBase64;
  if (typeof native === "function") {
    const view = native.call(Uint8Array, clean);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  const bin = atob(clean);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

export const openaiProvider: TextProvider = {
  name: "openai",
  async generate(env: Env, req: GenerateRequest): Promise<GenerateResult> {
    const key = requireKey(env);
    const body = {
      model: req.model,
      messages: [{ role: "system", content: req.system }, ...(await toParams(env, req.messages))],
      temperature: req.temperature,
      max_completion_tokens: req.maxTokens,
    };

    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw await errorFromResponse(res);

    const data = await readJson<ChatCompletion>(res);
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content : "";
    const finish = choice?.finish_reason ?? null;
    const refused = finish === "content_filter" || (typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0);
    const stopReason: GenerateResult["stopReason"] = refused ? "refusal" : finish === "length" ? "max_tokens" : "end";

    return {
      text: refused ? "" : text,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      stopReason,
      model: req.model,
      provider: "openai",
    };
  },
};

// The image bytes an images response carries, or a server error when it carries none.
function imageBytes(data: ImagesResponse): ArrayBuffer {
  const b64 = data.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64.length) {
    throw new ProviderError("openai", "server", "image response carried no image data", 502, true);
  }
  return base64ToArrayBuffer(b64);
}

// v4 (SPEC_V4 section 3): the man in the picture, when the request carries him
// (ImageGenerateRequest.him; the type is the pipeline lane's, so the field is read through
// a local shape). His photo is one more image[] part after hers, named in the prompt.
interface HimImageRef { name: string; bytes: ArrayBuffer; look: string }

function himOf(req: ImageGenerateRequest): HimImageRef | null {
  const h = (req as ImageGenerateRequest & { him?: HimImageRef | null }).him;
  if (!h || typeof h !== "object" || !(h.bytes instanceof ArrayBuffer) || !h.bytes.byteLength) return null;
  return { name: typeof h.name === "string" && h.name ? h.name : "him", bytes: h.bytes, look: typeof h.look === "string" ? h.look : "" };
}

// His reference was sniffed on upload; its key's extension is the truth (hisFace.ts mimeOfKey).
function mimeOfName(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/png";
}

export function himPromptLine(look: string): string {
  const words = look.replace(/\s+/g, " ").trim();
  return " The last reference image is the man who is in the picture with her; show him as that image shows him" + (words ? ": " + words : "") + ".";
}

export const openaiImageProvider: ImageProviderV3 = {
  name: "openai",
  async generate(env: Env, req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    const key = requireKey(env);
    if (!req.references.length) throw new ProviderError("openai", "bad_request", "no reference images", 400, false);
    const him = himOf(req);

    const fd = new FormData();
    fd.append("model", req.model);
    fd.append("prompt", req.identityPrompt + " Scene: " + req.prompt + (him ? himPromptLine(him.look) : ""));
    fd.append("size", req.size);
    fd.append("quality", req.quality);
    // High input fidelity: preserve her face and body from the references instead of a loose likeness.
    fd.append("input_fidelity", "high");
    fd.append("n", "1");
    for (const r of req.references) {
      fd.append("image[]", new Blob([r.bytes], { type: "image/png" }), r.name);
    }
    if (him) fd.append("image[]", new Blob([him.bytes], { type: mimeOfName(him.name) }), him.name);

    let res: Response;
    try {
      res = await fetch(IMAGE_EDITS_URL, {
        method: "POST",
        headers: { authorization: "Bearer " + key },
        body: fd,
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw await errorFromResponse(res);

    const data = await readJson<ImagesResponse>(res);
    return { png: imageBytes(data), model: req.model, provider: "openai" };
  },

  // v3, SPEC_V3 DD: a portrait of someone in her life. Text to image, no references
  // (it is not her), same model and quality settings as her photos, the portrait size.
  async generateFromText(env: Env, req: ImageFromTextRequest): Promise<ImageGenerateResult> {
    const key = requireKey(env);
    if (!req.prompt.trim()) throw new ProviderError("openai", "bad_request", "empty prompt", 400, false);
    let res: Response;
    try {
      res = await fetch(IMAGE_GENERATIONS_URL, {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: req.model, prompt: req.prompt, size: req.size, quality: req.quality, n: 1 }),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw await errorFromResponse(res);
    const data = await readJson<ImagesResponse>(res);
    return { png: imageBytes(data), model: req.model, provider: "openai" };
  },
};

// ------------------------------------------------------------------ v3: realtime client secret (SPEC_V3 EE)

// The GA session shape. Truncation "auto" so a long call trims its oldest audio turns
// instead of failing when the window fills; server VAD with interruption so he can cut in.
export function realtimeSessionBody(args: RealtimeSecretRequest): Record<string, unknown> {
  return {
    session: {
      type: "realtime",
      model: args.model,
      instructions: args.instructions,
      truncation: "auto",
      audio: {
        input: {
          transcription: { model: args.transcribeModel },
          turn_detection: { type: "server_vad", silence_duration_ms: VAD_SILENCE_MS, interrupt_response: true },
        },
        output: { voice: args.voice },
      },
    },
  };
}

// Mints the short-lived client secret for one call. The value is returned to the caller
// and nowhere else: not logged, not stored, not in any error message (redactSecrets
// covers the "ek_" form). Validity is the API's default (ten minutes), enough for one SDP
// exchange; the secret is never reused.
export async function mintRealtimeSecret(env: Env, args: RealtimeSecretRequest): Promise<RealtimeSecret> {
  const key = requireKey(env);
  let res: Response;
  try {
    res = await fetch(REALTIME_SECRETS_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(realtimeSessionBody(args)),
      signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await errorFromResponse(res);
  const data = await readJson<ClientSecretResponse>(res);
  const value = typeof data.value === "string" ? data.value : "";
  if (!value) throw new ProviderError("openai", "server", "client secret response carried no value", 502, true);
  const expiresAt = typeof data.expires_at === "number" && Number.isFinite(data.expires_at)
    ? data.expires_at
    : Math.floor(Date.now() / 1000) + DEFAULT_SECRET_TTL_S;
  const served = data.session && typeof data.session.model === "string" && data.session.model.trim() ? data.session.model : args.model;
  return { value, expiresAt, model: served };
}
