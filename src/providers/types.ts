// Provider-facing types and small shared helpers. The real shapes live in ../types;
// adapters import from here so the provider layer has one door.
//
// v3 (SPEC_V3 DD, EE, FF): the image provider grows a text-to-image call (portraits, no
// master references), the realtime token mint rides on the OpenAI adapter, and a video
// provider (Runway image-to-video, plus the stub) joins the registry. The v1 ImageProvider
// shape in ../types is left as is; the v3 interface extends it here.
import type {
  CallProviderName, ChatMessage, Env, ImageGenerateResult, ImageProvider, ImageProviderName, ProviderName, TextProvider, VideoProviderName,
} from "../types";

export type {
  CallPrices,
  CallProviderName,
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
  VideoProviderName,
} from "../types";
export { ProviderError } from "../types";

export const TEXT_PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "workersai", "stub"];
export const IMAGE_PROVIDER_NAMES: readonly ImageProviderName[] = ["openai", "stub"];

// v3, SPEC_V3 FF. "off" is a setting value, not a provider: the registry holds the two
// adapters that can be called.
export type VideoAdapterName = Exclude<VideoProviderName, "off">;
export const VIDEO_PROVIDER_NAMES: readonly VideoProviderName[] = ["runway", "stub", "off"];
export const VIDEO_ADAPTER_NAMES: readonly VideoAdapterName[] = ["runway", "stub"];

// v3, SPEC_V3 EE. "elevenlabs" is reserved (503 reserved_v3_1) and "off" is off; the
// Worker mints a token only for openai and answers the stub secret for stub.
export const CALL_PROVIDER_NAMES: readonly CallProviderName[] = ["openai", "elevenlabs", "stub", "off"];

export function isProviderName(x: unknown): x is ProviderName {
  return typeof x === "string" && (TEXT_PROVIDER_NAMES as readonly string[]).includes(x);
}

export function isImageProviderName(x: unknown): x is ImageProviderName {
  return typeof x === "string" && (IMAGE_PROVIDER_NAMES as readonly string[]).includes(x);
}

export function isVideoProviderName(x: unknown): x is VideoProviderName {
  return typeof x === "string" && (VIDEO_PROVIDER_NAMES as readonly string[]).includes(x);
}

export function isVideoAdapterName(x: unknown): x is VideoAdapterName {
  return typeof x === "string" && (VIDEO_ADAPTER_NAMES as readonly string[]).includes(x);
}

export function isCallProviderName(x: unknown): x is CallProviderName {
  return typeof x === "string" && (CALL_PROVIDER_NAMES as readonly string[]).includes(x);
}

// ------------------------------------------------------------------ v3: text-to-image (portraits)

// A face for a person in her life (SPEC_V3 DD): no reference images, plain generation.
export interface ImageFromTextRequest {
  prompt: string;
  model: string;
  quality: "low" | "medium" | "high";
  size: string;
}

export interface ImageProviderV3 extends ImageProvider {
  generateFromText(env: Env, req: ImageFromTextRequest): Promise<ImageGenerateResult>;
}

// ------------------------------------------------------------------ v3: video (clips)

export interface VideoStartRequest {
  model: string;
  // A data URI (our media sits behind Access, so never a URL of ours) or an https URL.
  promptImage: string;
  promptText: string;
  ratio: string;
  duration: number;
}

export type VideoTaskState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "THROTTLED";

export interface VideoTaskStatus {
  status: VideoTaskState;
  output?: string[];
  failure?: string | null;
  failureCode?: string | null;
}

export interface VideoProvider {
  name: VideoAdapterName;
  startImageToVideo(env: Env, req: VideoStartRequest): Promise<{ id: string }>;
  taskStatus(env: Env, id: string): Promise<VideoTaskStatus>;
  fetchOutput(env: Env, url: string): Promise<ArrayBuffer>;
}

// ------------------------------------------------------------------ v3: realtime (calls)

export interface RealtimeSecretRequest {
  model: string;
  voice: string;
  instructions: string;
  transcribeModel: string;
}

// The provider's own short-lived client token. Returned to the page once by
// calls.startCall and never stored, logged or audited (SPEC_V3 EE).
export interface RealtimeSecret {
  value: string;
  // Unix seconds.
  expiresAt: number;
  // The model id the session reports (the panel shows it), or the requested one.
  model: string;
}

// The full table of adapters, keyed by name. index.ts builds the one instance.
export interface ProviderRegistry {
  text: Record<ProviderName, TextProvider>;
  image: Record<ImageProviderName, ImageProviderV3>;
  video: Record<VideoAdapterName, VideoProvider>;
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
// Nothing that looks like key material leaves this layer in a message. The realtime
// client secret ("ek_...") is covered too, so a failed SDP exchange can never echo it.
const KEY_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_*-]{4,}/g,
  /ek_[A-Za-z0-9_*-]{4,}/g,
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
