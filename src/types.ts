// Shared types for the Avelie runtime. Every module codes against these.
import type { LifeLog, LifeThread } from "./life";

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
  // Optional: an org-level key that is not scoped to a workspace must name one per request.
  ANTHROPIC_WORKSPACE_ID?: string;
  OPENAI_API_KEY?: string;
  // Optional (SPEC_V2 section S): her voice through ElevenLabs. Absent = that provider is off.
  ELEVENLABS_API_KEY?: string;
}

export type Channel = "story" | "operator";
export type Role = "user" | "assistant";
export type ProviderName = "anthropic" | "openai" | "workersai" | "stub";
export type ImageProviderName = "openai" | "stub";
export type Effort = "low" | "medium" | "high";
// instant: her reply lands as soon as it exists. real: it lands when a person with her
// day would have answered (SPEC_V2 section B); the row carries deliver_at until then.
export type ReplyDelayMode = "instant" | "real";
// SPEC_V2 section S. off: no voice notes. some: only when she ends a message with [voice].
// all: every reply also gets audio. The stub provider is for tests (a tiny mp3, no call).
export type VoiceProviderName = "elevenlabs" | "workersai" | "stub" | "off";
export type VoiceMode = "off" | "some" | "all";
export type TranscribeProviderName = "workersai" | "openai" | "stub";

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
  // v2
  replyDelayMode: ReplyDelayMode;
  realDelayMaxMinutes: number;
  driftCheckEnabled: boolean;
  // Her timezone (IANA name). Her day, her schedule and every "right now" line are read in it.
  timezone: string;
  // v2, SPEC_V2 section R: she texts first (0 = off, at most 10 a day) outside quiet hours
  // ("HH:MM-HH:MM" in her timezone).
  herFirstTextsPerDay: number;
  herFirstQuietHours: string;
  // v2, SPEC_V2 section S: her voice out and his voice in.
  voiceProvider: VoiceProviderName;
  voiceMode: VoiceMode;
  elevenLabsVoiceId: string;
  transcribeProvider: TranscribeProviderName;
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
  // v2 (migration 0004). Optional in the type so v1 writers (the operator channel) keep
  // compiling; a row read from D1 always carries both, null when unset.
  // When set and in the future, the reply exists but has not "arrived" yet (real-mode timing).
  deliver_at?: string | null;
  // JSON of SongRef ({ artist, title, searchUrl }) when her message carried a [song: ...] marker.
  song_json?: string | null;
  // v2 (migration 0004d). R2 key of a voice note: hers (voice/<id>.mp3) or his recording
  // (voice_in/<id>.<ext>); the photos he sent (JSON list of { key, mime, width, height,
  // bytes }); the library item she sent ([media: title], SPEC_V2 section V).
  audio_key?: string | null;
  images_json?: string | null;
  media_id?: string | null;
}

export interface ModelRunRow {
  id: string;
  conversation_id: string | null;
  kind: "turn" | "retry" | "proposal" | "operator" | "image" | "drift" | "voice" | "transcribe";
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
  // v2 (SPEC_V2 section J). Free text ("fine", "annoyed at him", "cooling off") and, while
  // a friction is still being cooled off, the ISO time it runs to. No automatic decay:
  // the owner clears it, or she thaws in conversation and the extractor proposes it.
  mood?: string;
  cooling_off_until?: string | null;
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
  | "unknown"
  // v2: a statement by her about her own days (a routine, an event, a person, a place, an arc).
  | "life";

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

// The owner's media library (SPEC_V2 section V): things on her phone she could send.
export interface MediaRow {
  id: string;
  kind: "clip" | "video" | "image" | "other";
  title: string;
  description: string | null;
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
  status: "active" | "deleted";
  created_at: string;
}

// ------------------------------------------------------------------ providers

export interface ChatMessage {
  role: Role;
  content: string;
  // SPEC_V2 section T: the photos he attached to this message, as R2 keys. Only the last
  // six of his messages carry them into a call (context.ts); adapters load the bytes.
  images?: Array<{ key: string; mime: string }>;
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

// together: they are in the same place right now (scene status "together").
// apart: she is texting from wherever her day has her (every other scene status).
export type SceneMode = "together" | "apart";

// Her life as the prompt sees it: the threads and log rows plus the moment they are read at.
export interface PromptLife {
  threads: LifeThread[];
  log: LifeLog[];
  now: Date;
  tz: string;
}

// One thing she could bring up on her own (SPEC_V2 section K); at most two per turn.
export interface PromptCallback {
  text: string;
  ageDays: number;
  sourceId: string;
}

export interface PromptState {
  hasSharedHistory: boolean;
  fixedFacts: FactRow[];
  avelieFacts: FactRow[];
  justinFacts: FactRow[];
  history: HistoryRow[];
  unknowns: UnknownRow[];
  relationship: RelationshipState;
  scene: SceneState;
  // v2
  mode: SceneMode;
  life: PromptLife;
  callbacks: PromptCallback[];
  // The library titles she may send (SPEC_V2 section V); absent or empty = no section.
  media?: MediaRow[];
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
  // null when she opened the conversation herself (no message of his was stored).
  userMessage: MessageRow | null;
  assistantMessage: MessageRow;
  // ISO time her reply arrives (real-mode timing); null when it is already there.
  deliverAt: string | null;
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
