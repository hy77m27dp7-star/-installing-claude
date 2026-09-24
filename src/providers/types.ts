// Provider-facing types and small shared helpers. The real shapes live in ../types;
// adapters import from here so the provider layer has one door.
import type { ChatMessage, ImageProvider, ImageProviderName, ProviderName, TextProvider } from "../types";

export type {
  ChatMessage,
  Effort,
  Env,
  GenerateRequest,
  GenerateResult,
  ImageGenerateRequest,
  ImageGenerateResult,
  ImageProvider,
  ImageProviderName,
  ProviderErrorKind,
  ProviderName,
  TextProvider,
} from "../types";
export { ProviderError } from "../types";

export const TEXT_PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "workersai", "stub"];
export const IMAGE_PROVIDER_NAMES: readonly ImageProviderName[] = ["openai", "stub"];

export function isProviderName(x: unknown): x is ProviderName {
  return typeof x === "string" && (TEXT_PROVIDER_NAMES as readonly string[]).includes(x);
}

export function isImageProviderName(x: unknown): x is ImageProviderName {
  return typeof x === "string" && (IMAGE_PROVIDER_NAMES as readonly string[]).includes(x);
}

// The full table of adapters, keyed by name. index.ts builds the one instance.
export interface ProviderRegistry {
  text: Record<ProviderName, TextProvider>;
  image: Record<ImageProviderName, ImageProvider>;
}

// Content of the last user message, or "" when there is none.
export function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

// Rough token estimate for providers that report nothing: four characters per token.
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Provider error bodies sometimes echo a masked key ("Incorrect API key provided: sk-abc***").
// Nothing that looks like key material leaves this layer in a message.
const KEY_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_*.-]{4,}/g,
  /Bearer\s+[A-Za-z0-9_.*-]{4,}/gi,
  /x-api-key\s*[:=]\s*\S+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of KEY_PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

// A short, redacted, single-line message for storage in model_runs.error or an API body.
export function safeErrorMessage(e: unknown, max = 300): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
  const clean = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}
