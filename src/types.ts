// Shared types for the Avelie runtime. Every module codes against these.
import type { LifeLog, LifeThread } from "./life";
// v3: type-only imports of the section renderers, used in `typeof` positions to name the
// row shapes their modules own (SPEC_V3 sections BB, CC, DD).
import type { halfRememberSection } from "./memory";
import type { wantsSection } from "./wants";
import type { groundingSection } from "./grounding";
import type { WeatherNow } from "./weather";
import type { GroundingRow } from "./grounding";
import type { VoiceLine } from "./voicebank";
import type { Correction } from "./corrections";
import type { ShapeCue } from "./imperfection";

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
  // Optional (SPEC_V3 section FF): clips through Runway, and since 2026-09-25 her photos
  // when imageProvider is runway. Absent = video is off and a Runway photo fails as a
  // config error (503 provider_not_configured) until the secret exists.
  RUNWAY_API_KEY?: string;
}

export type Channel = "story" | "operator";
export type Role = "user" | "assistant";
export type ProviderName = "anthropic" | "openai" | "workersai" | "stub";
// runway (2026-09-25): Gen-4 Image with tagged character references, the photo provider;
// openai stays selectable as the fallback.
export type ImageProviderName = "openai" | "runway" | "stub";
export type Effort = "low" | "medium" | "high";
// instant: her reply lands as soon as it exists. real: it lands when a person with her
// day would have answered (SPEC_V2 section B); the row carries deliver_at until then.
export type ReplyDelayMode = "instant" | "real";
// SPEC_V2 section S. off: no voice notes. some: only when she ends a message with [voice].
// all: every reply also gets audio. The stub provider is for tests (a tiny mp3, no call).
export type VoiceProviderName = "elevenlabs" | "workersai" | "stub" | "off";
export type VoiceMode = "off" | "some" | "all";
export type TranscribeProviderName = "workersai" | "openai" | "stub";
// v3 (SPEC_V3). Weather (DD), calls (EE; elevenlabs is reserved and answers 503), clips (FF).
export type WeatherProviderName = "openmeteo" | "stub" | "off";
export type WeatherUnits = "fahrenheit" | "celsius";
export type CallProviderName = "openai" | "elevenlabs" | "stub" | "off";
export type VideoProviderName = "runway" | "stub" | "off";
// compact: ALWAYS_ON + OVERLAY as the prefix (calls, the fine-tune export); full: the whole stable prefix.
export type SystemMode = "compact" | "full";
// What a realtime session bills, priced per million tokens (EE).
export interface CallPrices {
  audioInPerMTok: number;
  audioOutPerMTok: number;
  textInPerMTok: number;
  textOutPerMTok: number;
}

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
  // v3, SPEC_V3 section AA: the voice bank and the corrections ledger.
  exemplarsPerTurn: number;
  exemplarCooldownTurns: number;
  correctionsShown: number;
  correctionRewriteToBank: boolean;
  // v3, section BB: human memory (weights, decay, the half-remember switch; 0 = off).
  memoryDecayEnabled: boolean;
  memoryFactsMax: number;
  memoryHalfLifeLowDays: number;
  memoryHalfLifeMidDays: number;
  memoryHalfLifeHighDays: number;
  provisionalRecallEvery: number;
  // v3, section CC: wants, asks and the mood clock.
  wantsShown: number;
  askLetGoDays: number;
  moodDaysDefault: number;
  // v3, section DD: her city, the weather and portraits.
  herCity: string;
  herLat: number | null;
  herLon: number | null;
  weatherProvider: WeatherProviderName;
  weatherUnits: WeatherUnits;
  portraitCostUsd: number;
  portraitSize: string;
  // v3, section EE: phone calls (the two ElevenLabs fields are reserved for v3.1).
  callProvider: CallProviderName;
  callModel: string;
  callVoice: string;
  callTranscribeModel: string;
  callSystemMode: SystemMode;
  callMaxMinutes: number;
  callPricePerMinute: number;
  callPrices: CallPrices;
  elevenLabsAgentId: string;
  elevenLabsCallPricePerMinute: number;
  // v3, section FF: clips.
  videoProvider: VideoProviderName;
  videoModel: string;
  videoSeconds: number;
  videoRatio: string;
  videoCostUsd: number;
  // v3, section GG: the imperfection engine (the typo cue ships at 0; his switch).
  textureCuesEnabled: boolean;
  typoCueShare: number;
  // v3, section HH: blind tastings.
  tastingEnabled: boolean;
  tastingProvider: ProviderName;
  tastingModel: string;
  tastingDailyCapUsd: number;
  // v3, section II: the fine-tune pipeline and the texter.
  finetuneMinExamples: number;
  finetuneSystemMode: SystemMode;
  texterModel: string;
  texterPrevious: { provider: ProviderName; model: string } | null;
  // v3.1, section JJ: what he looks like. The description in words (max 600 chars), how
  // many reference photos of him ride along (1..3), whether they ride on every Together
  // turn, and every how many Apart turns (0 = only the first turn of a conversation).
  hisLookText: string;
  hisFaceMax: number;
  hisFaceInTogether: boolean;
  hisFaceApartEvery: number;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  last_message_at: string | null;
  status: string;
  // v3.1 (migration 0007): the seq of her reply on the last turn his reference photos rode
  // along, so the Apart cadence can count turns since. Null = never in this conversation.
  his_face_seq?: number | null;
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
  // v3 (migration 0005): the call a transcript row belongs to (SPEC_V3 section EE).
  call_id?: string | null;
}

export interface ModelRunRow {
  id: string;
  conversation_id: string | null;
  kind: "turn" | "retry" | "proposal" | "operator" | "image" | "drift" | "voice" | "transcribe"
    // v3: a phone call (EE), a clip (FF), a tasting draft (HH), a portrait (DD).
    | "call" | "video" | "tasting" | "portrait"
    // v3.1 (JJ): the owner's "Describe from photo" call on his reference photos.
    | "describe";
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
  // v3 (SPEC_V3 section CC): when the mood was set and how many days it lasts (1..14).
  // The prompt renders the mood by its phase (fresh, fading, faint) and nothing once it is gone.
  mood_set_at?: string;
  mood_days?: number;
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
  | "life"
  // v3 (SPEC_V3 sections CC and DD): a goal of hers, a step on one, a small thing she asks
  // him for, his answer to it; what she ate, wore or ran out to do; news about a thread.
  | "want"
  | "want_update"
  | "ask"
  | "ask_update"
  | "grounding"
  | "life_update";

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
  role: "master" | "scene" | "candidate" | "legacy_archive" | "blacklisted" | "missing"
    // v3: a person's face (DD) and a clip of her (FF); both walk the photo's approval states.
    | "portrait" | "video"
    // v3.1 (JJ): a reference photo of him, owner-uploaded, approved at upload, never
    // generated, never listed with her pictures, never exported.
    | "him";
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
  // v3: the same system text in two parts, so an adapter that supports prompt caching can
  // put the breakpoint after the byte-stable prefix and leave the per-turn state out of
  // the cache. `system` stays the joined string for every other adapter; when both are
  // present, prefix + SYSTEM_SEPARATOR + state equals system.
  systemParts?: { prefix: string; state: string };
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
  // v3 (SPEC_V3). The bank lines offered this turn (exemplar_verbatim, AA); the open asks
  // with how often she has raised each (ask_nag, CC); the shape signatures of her last two
  // replies (shape_uniform, GG).
  exemplars?: string[];
  openAsks?: Array<{ text: string; broughtUp: number }>;
  recentSignatures?: string[];
  // v3 fix pass: an opener or first text (an open ask may not lead it: ask_nag on any open
  // ask), and his pending text (an ask he raised himself this turn is answered, never nagged).
  opener?: boolean;
  hisText?: string;
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

// v3 (SPEC_V3). The rows the per-turn sections are built from, typed off the modules that
// own them so the names never drift: a bank line (AA), a standing note (AA), the picked
// half-remembered detail (BB), a want, its log rows and an ask (CC), the weather and the
// grounding log (DD), the shape cue (GG).
export type { VoiceLine } from "./voicebank";
export type { Correction } from "./corrections";
export type { ShapeCue } from "./imperfection";
export type { WeatherNow } from "./weather";
export type { GroundingRow } from "./grounding";
export type RecallPick = NonNullable<Parameters<typeof halfRememberSection>[0]>;
export type WantRow = Parameters<typeof wantsSection>[0][number];
export type WantLogRow = Parameters<typeof wantsSection>[1][number];
export type AskRow = Parameters<typeof wantsSection>[2][number];
export type OutfitNow = Parameters<typeof groundingSection>[0]["outfit"];
export type MoodPhase = "fresh" | "fading" | "faint" | "gone";

// What she knows about right now (SPEC_V3 section DD): her city, the weather when it came
// back in time, what she is wearing today, today's grounding rows. Any of it may be empty.
export interface PromptGrounding {
  city: string;
  weather: WeatherNow | null;
  outfit: OutfitNow;
  today: GroundingRow[];
}

// What she knows of his face (v3.1, section JJ): the words on file, the reference photos
// of him (newest first, at most hisFaceMax), and how many of them ride on this turn's
// call (0 = none; the section then carries no attached-photos line).
export interface HisLook {
  text: string;
  photos: Array<{ id: string; key: string; mime: string }>;
  attached: number;
}

export interface PromptState {
  hasSharedHistory: boolean;
  fixedFacts: FactRow[];
  avelieFacts: FactRow[];
  // v3: the facts about him that are firm this turn (ranked by weight, decay and relevance,
  // SPEC_V3 section BB); the faded ones are counted in fadedFactCount and not shown.
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
  // v3. Every field is optional so a v1 or v2 state (the unit fixtures, the drift runner)
  // still renders; a missing field means "no section".
  // AA: the bank lines offered this turn, the standing notes, the tags the turn matched.
  exemplars?: VoiceLine[];
  corrections?: Correction[];
  turnTags?: string[];
  // BB: the one half-remembered detail (null or absent = no section) and the count of facts
  // about him that faded out of the prompt this turn.
  recall?: RecallPick | null;
  fadedFactCount?: number;
  // CC: her wants with their last log rows and the open asks.
  wants?: WantRow[];
  wantLog?: WantLogRow[];
  asks?: AskRow[];
  // DD: the RIGHT NOW section's inputs.
  grounding?: PromptGrounding;
  // GG: the shape cue for this message (null = no THIS MESSAGE section) and the signatures
  // of her last two replies it was rolled against.
  shapeCue?: ShapeCue | null;
  recentSignatures?: string[];
  // The turn's own key and shape (the header's Seeds paragraph); an opener has no message of his.
  turnKey?: string;
  opener?: boolean;
  // The state version's created_at: the mood clock's fallback when mood_set_at is absent.
  relationshipSince?: string;
  // The numbers the sections render with (settings; the defaults when absent).
  moodDaysDefault?: number;
  wantsShown?: number;
  correctionsShown?: number;
  // v3.1 (JJ): his face. Absent or null, or empty text with no photo, renders no section.
  hisLook?: HisLook | null;
  // v3.2: what was said in the open conversation and is not yet approved into memory (the
  // pending justin_fact and avelie_fact proposals of this conversation), and how many story
  // rows the conversation holds. Absent or empty renders nothing extra.
  saidHere?: SaidHere | null;
  storyRows?: number;
}

// v3.2: the lines said in the open conversation, his and hers, deduplicated, not yet in memory.
export interface SaidHere {
  him: string[];
  her: string[];
}

export interface AssembledContext {
  state: PromptState;
  system: string;
  // v3: the same text in two parts (prefix + SYSTEM_SEPARATOR + state === system).
  systemParts: { prefix: string; state: string };
  promptVersion: string;
  messages: ChatMessage[];
  recentAssistantTexts: string[];
  // v3: the pending user row id on a resume, else "s" + the next seq; every per-turn seeded
  // choice (exemplars, the shape cue) keys on it, so a retry rolls the same.
  turnKey: string;
  opener: boolean;
  // v3.1 (JJ): how many of his reference photos were prepended to the final user turn for
  // the provider call (0 = none rode along this turn).
  hisFaceShown: number;
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
