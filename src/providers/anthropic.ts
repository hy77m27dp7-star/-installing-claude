// Anthropic adapter. The whole system prompt is sent as one text block with a cache
// breakpoint (the constitution prefix is byte-stable, so repeat turns hit the cache).
// Sampling parameters are never sent: current models reject temperature and top_p.
// Thinking is left at the model default; effort is the only depth control.
import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../types";
import type { Env, GenerateRequest, GenerateResult, TextProvider } from "../types";
import { safeErrorMessage } from "./types";
import { imageMime, imagesOf, loadInboxImages } from "../vision";

const REQUEST_TIMEOUT_MS = 120_000;

// His photos go as base64 image blocks before the text of the message they came with
// (SPEC_V2 section T). A picture that cannot be loaded is simply not sent.
async function toParams(env: Env, messages: GenerateRequest["messages"]): Promise<Anthropic.MessageParam[]> {
  const out: Anthropic.MessageParam[] = [];
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
    const content: Anthropic.ContentBlockParam[] = blocks.map((b) => ({
      type: "image",
      source: { type: "base64", media_type: imageMime(b.mime), data: b.base64 },
    }));
    content.push({ type: "text", text: m.content });
    out.push({ role: "user", content });
  }
  return out;
}

function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  // Most specific first. Connection errors extend APIError, so they go before the catch-all.
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError("anthropic", "auth", "authentication failed", 401, false);
  if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError("anthropic", "auth", "permission denied", 403, false);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("anthropic", "rate_limit", "rate limited", 429, true);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError("anthropic", "bad_request", safeErrorMessage(e), 400, false);
  if (e instanceof Anthropic.NotFoundError) return new ProviderError("anthropic", "bad_request", safeErrorMessage(e), 404, false);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError("anthropic", "network", "connection failed", 502, true);
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : 502;
    return new ProviderError("anthropic", "server", safeErrorMessage(e), status, true);
  }
  return new ProviderError("anthropic", "other", safeErrorMessage(e), 502, true);
}

export const anthropicProvider: TextProvider = {
  name: "anthropic",
  async generate(env: Env, req: GenerateRequest): Promise<GenerateResult> {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ProviderError("anthropic", "config", "ANTHROPIC_API_KEY not set", 503, false);

    // A key made outside any workspace is refused (400) unless the request names a workspace.
    const workspace = (env.ANTHROPIC_WORKSPACE_ID ?? "").trim();
    const client = new Anthropic({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
    });

    const systemBlock: Anthropic.TextBlockParam = req.cacheable
      ? { type: "text", text: req.system, cache_control: { type: "ephemeral" } }
      : { type: "text", text: req.system };

    const messages = await toParams(env, req.messages);
    let res: Anthropic.Message;
    try {
      res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        ...(req.system.trim().length ? { system: [systemBlock] } : {}),
        messages,
        output_config: { effort: req.effort },
      });
    } catch (e) {
      throw mapError(e);
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const stopReason: GenerateResult["stopReason"] =
      res.stop_reason === "refusal" ? "refusal" : res.stop_reason === "max_tokens" ? "max_tokens" : "end";

    const u = res.usage;
    const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

    return {
      text,
      inputTokens,
      outputTokens: u.output_tokens ?? 0,
      stopReason,
      // The requested id, not the served alias, so the price table lookup stays stable.
      model: req.model,
      provider: "anthropic",
    };
  },
};
