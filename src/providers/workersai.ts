// Workers AI adapter over the AI binding. Key-free; the model is whatever settings name.
// The binding's type keys models to a fixed catalog, so the call goes through a narrow
// structural view that accepts any model string.
import { ProviderError } from "../types";
import type { Env, GenerateRequest, GenerateResult, TextProvider } from "../types";
import { approxTokens, safeErrorMessage } from "./types";
import { dataUrl, imagesOf, isVisionModel, loadInboxImages, withoutImages } from "../vision";

interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatParam = { role: string; content: string | ChatPart[] };

// His photos (SPEC_V2 section T): a vision model gets them as image_url data-URL content
// parts; any other model gets the text plus one plain line saying he sent a photo she
// could not open, so she never pretends to have seen it.
async function toParams(env: Env, model: string, messages: GenerateRequest["messages"]): Promise<ChatParam[]> {
  const vision = isVisionModel(model);
  const out: ChatParam[] = [];
  for (const m of messages) {
    const refs = m.role === "user" ? imagesOf(m) : [];
    if (!refs.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!vision) {
      out.push({ role: m.role, content: withoutImages(m).content });
      continue;
    }
    const blocks = await loadInboxImages(env, refs);
    if (!blocks.length) {
      out.push({ role: m.role, content: withoutImages(m).content });
      continue;
    }
    const parts: ChatPart[] = [{ type: "text", text: m.content }];
    for (const b of blocks) parts.push({ type: "image_url", image_url: { url: dataUrl(b) } });
    out.push({ role: "user", content: parts });
  }
  return out;
}

interface ReadResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Tolerates the shapes the runtime returns: a bare string, { response }, or an
// OpenAI-style { choices: [{ message: { content } }] }. Tokens are 0 when unreported.
function readResult(out: unknown): ReadResult {
  if (typeof out === "string") return { text: out, inputTokens: 0, outputTokens: 0 };
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    let text = "";
    if (typeof o.response === "string") text = o.response;
    else if (Array.isArray(o.choices)) {
      const first = o.choices[0] as { message?: { content?: unknown } } | undefined;
      const c = first?.message?.content;
      if (typeof c === "string") text = c;
    }
    const usage = (o.usage && typeof o.usage === "object" ? o.usage : {}) as Record<string, unknown>;
    return { text, inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens) };
  }
  return { text: "", inputTokens: 0, outputTokens: 0 };
}

function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const msg = safeErrorMessage(e);
  if (/no such model|not found|does not exist|unsupported model/i.test(msg)) {
    return new ProviderError("workersai", "bad_request", msg, 400, false);
  }
  if (/rate limit|too many requests|\b429\b/i.test(msg)) return new ProviderError("workersai", "rate_limit", msg, 429, true);
  if (/unauthori|forbidden|\b401\b|\b403\b/i.test(msg)) return new ProviderError("workersai", "auth", msg, 401, false);
  return new ProviderError("workersai", "server", msg, 502, true);
}

export const workersAiProvider: TextProvider = {
  name: "workersai",
  async generate(env: Env, req: GenerateRequest): Promise<GenerateResult> {
    const ai = env.AI as unknown as AiLike | undefined;
    if (!ai || typeof ai.run !== "function") {
      throw new ProviderError("workersai", "config", "AI binding not available", 503, false);
    }

    const messages: ChatParam[] = [{ role: "system", content: req.system }, ...(await toParams(env, req.model, req.messages))];

    let out: unknown;
    try {
      out = await ai.run(req.model, { messages, max_tokens: req.maxTokens, temperature: req.temperature });
    } catch (e) {
      throw mapError(e);
    }

    const r = readResult(out);
    const inputTokens = r.inputTokens || approxTokens(req.system + req.messages.map((m) => m.content).join(""));
    const outputTokens = r.outputTokens || approxTokens(r.text);

    return {
      text: r.text,
      inputTokens: r.inputTokens ? r.inputTokens : inputTokens,
      outputTokens: r.outputTokens ? r.outputTokens : outputTokens,
      stopReason: "end",
      model: req.model,
      provider: "workersai",
    };
  },
};
