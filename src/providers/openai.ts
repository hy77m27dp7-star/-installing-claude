// OpenAI adapters over fetch: chat completions for text, images/edits for photos.
// Error bodies are redacted before they become messages (a 401 body echoes a masked key).
import { ProviderError } from "../types";
import type {
  Env, GenerateRequest, GenerateResult, ImageGenerateRequest, ImageGenerateResult, ImageProvider, TextProvider,
} from "../types";
import { redactSecrets, safeErrorMessage } from "./types";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const TEXT_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 180_000;

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

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ""));
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
      messages: [{ role: "system", content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
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

export const openaiImageProvider: ImageProvider = {
  name: "openai",
  async generate(env: Env, req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    const key = requireKey(env);
    if (!req.references.length) throw new ProviderError("openai", "bad_request", "no reference images", 400, false);

    const fd = new FormData();
    fd.append("model", req.model);
    fd.append("prompt", req.identityPrompt + " Scene: " + req.prompt);
    fd.append("size", req.size);
    fd.append("quality", req.quality);
    fd.append("n", "1");
    for (const r of req.references) {
      fd.append("image[]", new Blob([r.bytes], { type: "image/png" }), r.name);
    }

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
    const b64 = data.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64.length) {
      throw new ProviderError("openai", "server", "image response carried no image data", 502, true);
    }
    return { png: base64ToArrayBuffer(b64), model: req.model, provider: "openai" };
  },
};
