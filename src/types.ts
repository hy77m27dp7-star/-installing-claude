// Shared types for the Avelie runtime. Every module codes against these.

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  APP_ENV: string;
  // Local-only (from .dev.vars). Production never has these two set.
  DEV_ACTOR_EMAIL?: string;
  DEFAULT_PROVIDER?: string;
  DEFAULT_IMAGE_PROVIDER?: string;
  // Secrets (wrangler secret put ...)
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

export type Channel = "story" | "operator";
export type Role = "user" | "assistant";
export type ProviderName = "anthropic" | "openai" | "workersai" | "stub";
export type ImageProviderName = "openai" | "stub";
export type Effort = "low" | "medium" | "high";

export interface Settings {
  provider: ProviderName;
  model: string;
  effort: Effort;
  temperature: number;
  maxTokens: number;
  proposalsEnabled: boolean;
  proposalProvider: ProviderName;
  proposalModel: string;
  imageProvider: ImageProviderName;
  imageModel: string;
  imageQuality: "low" | "medium" | "high";
  imageSize: string;
  imageCostUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  contextRecentMessages: number;
  contextMaxChars: number;
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  last_message_at: string | null;
  status: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  channel: Channel;
  role: Role;
  content: string;
  created_at: string;
  seq: number;
  idempotency_key: string | null;
  reply_to_id: string | null;
  model_run_id: string | null;
  flags_json: string | null;
  image_id: string | null;
  image_status: string | null;
}

export interface ModelRunRow {
  id: string;
  conversation_id: string | null;
  kind: "turn" | "retry" | "proposal" | "operator" | "image";
  provider: string;
  model: string;
  prompt_version: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micro: number;
  latency_ms: number | null;
  status: "ok" | "failed" | "refused";
  error: string | null;
  flags_json: string | null;
  created_at: string;
}

export type FactScope = "fixed" | "avelie" | "justin" | "shared";

export interface FactRow {
  id: string;
  scope: FactScope;
  subject: string | null;
  fact: string;
  source: string | null;
  status: "approved" | "superseded" | "rejected";
  disclosed: number;
  provisional: number;
  version: number;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface HistoryRow {
  id: string;
  seq: number;
  title: string;
  occurred: string | null;
  body: string;
  what_changed: string | null;
  keep_consistent: string | null;
  source: string | null;
  status: "approved" | "superseded" | "rejected";
  version: number;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnknownRow {
  id: string;
  topic: string;
  note: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationshipState {
  status: string;
  summary: string;
  trust: string;
  affection: string;
  attraction: string;
  friction: string;
  private_language: string;
  his_name: string | null;
  nicknames: string;
  frontier: string;
  [k: string]: unknown;
}

export interface SceneState {
  status: string;
  summary: string;
  location: string | null;
  time: string | null;
  present: string[];
  last_beat: string | null;
  [k: string]: unknown;
}

export interface StateVersionRow {
  id: string;
  entity: "relationship" | "scene";
  version: number;
  state_json: string;
  source: string | null;
  note: string | null;
  created_at: string;
}

export type ProposalKind =
  | "avelie_fact"
  | "justin_fact"
  | "relationship"
  | "scene"
  | "history"
  | "private_language"
  | "opinion_change"
  | "unknown";

export interface ProposalRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  kind: ProposalKind;
  proposal: string;
  evidence: string | null;
  confidence: "low" | "medium" | "high" | null;
  scope: string | null;
  payload_json: string | null;
  status: "pending" | "approved" | "rejected" | "edited";
  decision_note: string | null;
  promoted_id: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface VisualAssetRow {
  id: string;
  file: string;
  role: "master" | "scene" | "candidate" | "legacy_archive" | "blacklisted" | "missing";
  sha256: string | null;
  bytes: number | null;
  // pending / generating / failed: a requested photo before any bytes exist (role candidate).
  // The browser drives the generation because a Worker's background work is cut off 30s
  // after the response, and an image call takes longer than that.
  approval_status: "approved" | "candidate" | "rejected" | "archive" | "missing" | "pending" | "generating" | "failed";
  conversation_id: string | null;
  message_id: string | null;
  prompt: string | null;
  provider: string | null;
  model: string | null;
  notes: string | null;
  created_at: string;
  decided_at: string | null;
}

// ------------------------------------------------------------------ providers

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
  temperature: number;
  effort: Effort;
  // Stable prefix hint for providers that support prompt caching.
  cacheable: boolean;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: "end" | "max_tokens" | "refusal" | "other";
  model: string;
  provider: ProviderName;
}

export type ProviderErrorKind = "auth" | "rate_limit" | "refusal" | "server" | "network" | "config" | "bad_request" | "other";

export class ProviderError extends Error {
  status: number;
  retryable: boolean;
  kind: ProviderErrorKind;
  provider: string;
  constructor(provider: string, kind: ProviderErrorKind, message: string, status = 502, retryable = true) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface TextProvider {
  name: ProviderName;
  generate(env: Env, req: GenerateRequest): Promise<GenerateResult>;
}

export interface ImageGenerateRequest {
  prompt: string;
  identityPrompt: string;
  references: Array<{ name: string; bytes: ArrayBuffer }>;
  model: string;
  quality: "low" | "medium" | "high";
  size: string;
}

export interface ImageGenerateResult {
  png: ArrayBuffer;
  model: string;
  provider: ImageProviderName;
}

export interface ImageProvider {
  name: ImageProviderName;
  generate(env: Env, req: ImageGenerateRequest): Promise<ImageGenerateResult>;
}

// ------------------------------------------------------------------ checks

export type FlagSeverity = "block" | "retry" | "flag";

export interface Flag {
  code: string;
  severity: FlagSeverity;
  detail: string;
}

export interface CheckContext {
  hasSharedHistory: boolean;
  knownName: string | null;
  recentAssistantTexts: string[];
  openUnknownTopics: string[];
  channel: Channel;
}

export interface CheckResult {
  flags: Flag[];
  // accept: store as is. retry: ask the model once more with a corrective note.
  // repair: mechanical cleanup applied (repaired holds the text) and flagged.
  action: "accept" | "retry" | "repair";
  repaired?: string;
}

// ------------------------------------------------------------------ prompt

export interface PromptState {
  hasSharedHistory: boolean;
  fixedFacts: FactRow[];
  avelieFacts: FactRow[];
  justinFacts: FactRow[];
  history: HistoryRow[];
  unknowns: UnknownRow[];
  relationship: RelationshipState;
  scene: SceneState;
}

export interface AssembledContext {
  state: PromptState;
  system: string;
  promptVersion: string;
  messages: ChatMessage[];
  recentAssistantTexts: string[];
}

// ------------------------------------------------------------------ API shapes

export interface TurnResponse {
  conversationId: string;
  userMessage: MessageRow;
  assistantMessage: MessageRow;
  run: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    promptVersion: string;
  };
  flags: Flag[];
  imagePending: boolean;
  replayed: boolean;
}

export interface ApiError {
  error: string;
  code: string;
  retryable?: boolean;
  detail?: string;
}
