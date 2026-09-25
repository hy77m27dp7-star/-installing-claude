// Typed D1 access. Every write that must be atomic goes through batch().
import type {
  ConversationRow, FactRow, FactScope, HistoryRow, MessageRow, ModelRunRow, ProposalRow,
  RelationshipState, SceneState, Settings, StateVersionRow, UnknownRow, VisualAssetRow, Channel,
} from "./types";

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const dayKey = (d = new Date()): string => d.toISOString().slice(0, 10);
export const monthKey = (d = new Date()): string => d.toISOString().slice(0, 7);

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-5",
  effort: "medium",
  temperature: 0.9,
  maxTokens: 700,
  proposalsEnabled: true,
  proposalsAutoApprove: false,
  proposalProvider: "anthropic",
  proposalModel: "claude-sonnet-5",
  imageProvider: "openai",
  imageModel: "gpt-image-1",
  imageQuality: "medium",
  imageSize: "1024x1536",
  imageCostUsd: 0.06,
  dailyCapUsd: 3,
  monthlyCapUsd: 30,
  contextRecentMessages: 40,
  contextMaxChars: 24000,
  // USD per million tokens. A model that is not priced here or in the stored table cannot
  // be selected or called (budget.ts), so every model the app can be pointed at is metered.
  prices: {
    "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
    "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
    "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
    "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
    "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
    // Workers AI fallback (DEPLOY.md section 8). Cloudflare list price, to confirm on the
    // Workers AI pricing page; nominal until then.
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputPerMTok: 0.29, outputPerMTok: 2.25 },
    // v3 (SPEC_V3 section HH and II): the tasting performer and the fine-tunable bases.
    // List prices as of 2026-09-24; confirm on the OpenAI pricing page.
    "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
    "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
    "gpt-4.1-mini-2025-04-14": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  },
  // v2
  replyDelayMode: "instant",
  realDelayMaxMinutes: 6,
  driftCheckEnabled: false,
  timezone: "America/New_York",
  // v2, SPEC_V2 section R. His word was opt-in (HANDOFF): off until he sets a number on the
  // Model page (1 to 10 a day); the spec's seed number 10 is the ceiling, not the default.
  herFirstTextsPerDay: 0,
  herFirstQuietHours: "23:30-08:30",
  // v2, SPEC_V2 section S. Workers AI needs no key; ElevenLabs needs its key and a voice id.
  voiceProvider: "workersai",
  voiceMode: "some",
  elevenLabsVoiceId: "",
  transcribeProvider: "workersai",
  // v3, SPEC_V3 section AA: the voice bank and the corrections ledger.
  exemplarsPerTurn: 6,
  exemplarCooldownTurns: 30,
  correctionsShown: 25,
  correctionRewriteToBank: true,
  // v3, section BB: human memory. The recall ships off (0); his switch (Open question 7).
  memoryDecayEnabled: true,
  memoryFactsMax: 40,
  memoryHalfLifeLowDays: 10,
  memoryHalfLifeMidDays: 45,
  memoryHalfLifeHighDays: 400,
  provisionalRecallEvery: 0,
  // v3, section CC: wants and the mood clock.
  wantsShown: 5,
  askLetGoDays: 14,
  moodDaysDefault: 3,
  // v3, section DD: her city is Portland, Maine (Justin's decision 2026-09-24), weather on.
  herCity: "Portland, Maine",
  herLat: 43.6591,
  herLon: -70.2568,
  weatherProvider: "openmeteo",
  weatherUnits: "fahrenheit",
  portraitCostUsd: 0.04,
  portraitSize: "1024x1024",
  // v3, section EE: calls on OpenAI Realtime; the ElevenLabs path is reserved (v3.1).
  callProvider: "openai",
  callModel: "gpt-realtime",
  callVoice: "marin",
  callTranscribeModel: "gpt-4o-mini-transcribe",
  callSystemMode: "compact",
  callMaxMinutes: 20,
  callPricePerMinute: 0.3,
  callPrices: { audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 },
  elevenLabsAgentId: "",
  elevenLabsCallPricePerMinute: 0.1,
  // v3, section FF: clips. No Runway key exists (Open question 4): the provider name stays
  // runway so the code path is complete, and without the secret every video control is off.
  videoProvider: "runway",
  videoModel: "gen4_turbo",
  videoSeconds: 5,
  videoRatio: "720:1280",
  videoCostUsd: 0.25,
  // v3, section GG: the texture cues; the scheduled typo ships at 0 (his switch).
  textureCuesEnabled: true,
  typoCueShare: 0,
  // v3, section HH: tastings, off until he turns them on.
  tastingEnabled: false,
  tastingProvider: "openai",
  tastingModel: "gpt-4.1",
  tastingDailyCapUsd: 1,
  // v3, section II: the texter (gpt-4.1-mini is the base the script defaults to; Open question 3).
  finetuneMinExamples: 200,
  finetuneSystemMode: "compact",
  texterModel: "",
  texterPrevious: null,
  // v3.1, section JJ: what he looks like. No words on file until he writes or describes
  // them; up to three reference photos ride on every Together turn and every 8th Apart turn.
  hisLookText: "",
  hisFaceMax: 3,
  hisFaceInTogether: true,
  hisFaceApartEvery: 8,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The stored price table over the built-in one: a stored price always wins, and a model
// priced in the defaults stays priced on a database seeded before that entry existed.
export function mergedPrices(stored: unknown): Settings["prices"] {
  const out: Settings["prices"] = { ...DEFAULT_SETTINGS.prices };
  if (!isRecord(stored)) return out;
  for (const [model, p] of Object.entries(stored)) {
    if (isRecord(p) && typeof p.inputPerMTok === "number" && typeof p.outputPerMTok === "number") {
      out[model] = { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok };
    }
  }
  return out;
}

// ------------------------------------------------------------------ settings

export async function getSettings(db: D1Database): Promise<Settings> {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows.results) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  out.prices = mergedPrices(out.prices);
  return out as unknown as Settings;
}

export async function putSettings(db: D1Database, patch: Partial<Settings>): Promise<Settings> {
  const t = nowIso();
  const stmts = Object.entries(patch).map(([k, v]) =>
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(k, JSON.stringify(v), t));
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

// ------------------------------------------------------------------ state

export async function getCurrentState<T extends RelationshipState | SceneState>(db: D1Database, entity: "relationship" | "scene"): Promise<{ version: number; state: T; row: StateVersionRow }> {
  const row = await db.prepare("SELECT * FROM state_versions WHERE entity = ?1 ORDER BY version DESC LIMIT 1").bind(entity).first<StateVersionRow>();
  if (!row) throw new Error(`no state rows for ${entity}; run migrations`);
  return { version: row.version, state: JSON.parse(row.state_json) as T, row };
}

export function appendStateStmt(db: D1Database, entity: "relationship" | "scene", version: number, state: unknown, source: string, note: string | null): D1PreparedStatement {
  return db.prepare("INSERT INTO state_versions (id, entity, version, state_json, source, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(newId("st"), entity, version, JSON.stringify(state), source, note, nowIso());
}

export async function listStateVersions(db: D1Database, entity: "relationship" | "scene", limit = 50): Promise<StateVersionRow[]> {
  const r = await db.prepare("SELECT * FROM state_versions WHERE entity = ?1 ORDER BY version DESC LIMIT ?2").bind(entity, limit).all<StateVersionRow>();
  return r.results;
}

// ------------------------------------------------------------------ facts, history, unknowns

export async function listFacts(db: D1Database, scope?: FactScope, status: FactRow["status"] = "approved"): Promise<FactRow[]> {
  const r = scope
    ? await db.prepare("SELECT * FROM facts WHERE scope = ?1 AND status = ?2 ORDER BY created_at, id").bind(scope, status).all<FactRow>()
    : await db.prepare("SELECT * FROM facts WHERE status = ?1 ORDER BY scope, created_at, id").bind(status).all<FactRow>();
  return r.results;
}

export async function getFact(db: D1Database, id: string): Promise<FactRow | null> {
  return db.prepare("SELECT * FROM facts WHERE id = ?1").bind(id).first<FactRow>();
}

export async function listHistory(db: D1Database, status: HistoryRow["status"] = "approved"): Promise<HistoryRow[]> {
  const r = await db.prepare("SELECT * FROM history WHERE status = ?1 ORDER BY seq, created_at").bind(status).all<HistoryRow>();
  return r.results;
}

export async function getHistory(db: D1Database, id: string): Promise<HistoryRow | null> {
  return db.prepare("SELECT * FROM history WHERE id = ?1").bind(id).first<HistoryRow>();
}

export async function listUnknowns(db: D1Database, status?: UnknownRow["status"]): Promise<UnknownRow[]> {
  const r = status
    ? await db.prepare("SELECT * FROM unknowns WHERE status = ?1 ORDER BY created_at").bind(status).all<UnknownRow>()
    : await db.prepare("SELECT * FROM unknowns ORDER BY created_at").all<UnknownRow>();
  return r.results;
}

// ------------------------------------------------------------------ conversations and messages

export async function listConversations(db: D1Database): Promise<ConversationRow[]> {
  const r = await db.prepare("SELECT * FROM conversations WHERE status != 'deleted' ORDER BY COALESCE(last_message_at, created_at) DESC").all<ConversationRow>();
  return r.results;
}

export async function getConversation(db: D1Database, id: string): Promise<ConversationRow | null> {
  return db.prepare("SELECT * FROM conversations WHERE id = ?1 AND status != 'deleted'").bind(id).first<ConversationRow>();
}

export async function createConversation(db: D1Database, title: string | null): Promise<ConversationRow> {
  const row: ConversationRow = { id: newId("c"), title, created_at: nowIso(), last_message_at: null, status: "active" };
  await db.prepare("INSERT INTO conversations (id, title, created_at, last_message_at, status) VALUES (?1, ?2, ?3, NULL, 'active')").bind(row.id, row.title, row.created_at).run();
  return row;
}

// The newest `limit` messages, returned oldest first. (Oldest-first with a cap would hide
// everything after the cap in a long conversation.)
export async function listMessages(db: D1Database, conversationId: string, channel?: Channel, limit = 500): Promise<MessageRow[]> {
  const r = channel
    ? await db.prepare("SELECT * FROM messages WHERE conversation_id = ?1 AND channel = ?2 ORDER BY seq DESC LIMIT ?3").bind(conversationId, channel, limit).all<MessageRow>()
    : await db.prepare("SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT ?2").bind(conversationId, limit).all<MessageRow>();
  return r.results.reverse();
}

// The thread as the page may show it: a reply whose deliver_at is still in the future has
// not arrived yet (real-mode timing, SPEC_V2 section B) and is left out. Same window and
// order as listMessages. `now` is compared as ISO text, the form deliver_at is stored in.
export async function listMessagesVisible(
  db: D1Database,
  conversationId: string,
  channel: Channel | undefined,
  now: Date | string = new Date(),
  limit = 500,
): Promise<MessageRow[]> {
  const at = typeof now === "string" ? now : now.toISOString();
  const r = channel
    ? await db.prepare("SELECT * FROM messages WHERE conversation_id = ?1 AND channel = ?2 AND (deliver_at IS NULL OR deliver_at <= ?3) ORDER BY seq DESC LIMIT ?4")
      .bind(conversationId, channel, at, limit).all<MessageRow>()
    : await db.prepare("SELECT * FROM messages WHERE conversation_id = ?1 AND (deliver_at IS NULL OR deliver_at <= ?2) ORDER BY seq DESC LIMIT ?3")
      .bind(conversationId, at, limit).all<MessageRow>();
  return r.results.reverse();
}

export async function listRecentStoryMessages(db: D1Database, conversationId: string, limit: number): Promise<MessageRow[]> {
  const r = await db.prepare("SELECT * FROM messages WHERE conversation_id = ?1 AND channel = 'story' ORDER BY seq DESC LIMIT ?2").bind(conversationId, limit).all<MessageRow>();
  return r.results.reverse();
}

// v3: the newest `limit` of her story replies, oldest first (the signature and cooldown
// windows read these).
export async function listRecentAssistantMessages(db: D1Database, conversationId: string, limit: number): Promise<MessageRow[]> {
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 1;
  const r = await db.prepare("SELECT * FROM messages WHERE conversation_id = ?1 AND channel = 'story' AND role = 'assistant' ORDER BY seq DESC LIMIT ?2").bind(conversationId, n).all<MessageRow>();
  return r.results.reverse();
}

export async function getMessage(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE id = ?1").bind(id).first<MessageRow>();
}

export async function findByIdempotencyKey(db: D1Database, key: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE idempotency_key = ?1").bind(key).first<MessageRow>();
}

export async function nextSeq(db: D1Database, conversationId: string): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE conversation_id = ?1").bind(conversationId).first<{ m: number }>();
  return (r?.m ?? 0) + 1;
}

// A call transcript row (SPEC_V3 section EE) names its call; the column exists from
// migration 0005, so it is written only when set and every other insert keeps the v2 shape.
export function insertMessageStmt(db: D1Database, m: MessageRow): D1PreparedStatement {
  if (typeof m.call_id === "string" && m.call_id) {
    return db.prepare("INSERT INTO messages (id, conversation_id, channel, role, content, created_at, seq, idempotency_key, reply_to_id, model_run_id, flags_json, image_id, image_status, deliver_at, song_json, audio_key, images_json, media_id, call_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)")
      .bind(m.id, m.conversation_id, m.channel, m.role, m.content, m.created_at, m.seq, m.idempotency_key, m.reply_to_id, m.model_run_id, m.flags_json, m.image_id, m.image_status, m.deliver_at ?? null, m.song_json ?? null, m.audio_key ?? null, m.images_json ?? null, m.media_id ?? null, m.call_id);
  }
  return db.prepare("INSERT INTO messages (id, conversation_id, channel, role, content, created_at, seq, idempotency_key, reply_to_id, model_run_id, flags_json, image_id, image_status, deliver_at, song_json, audio_key, images_json, media_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)")
    .bind(m.id, m.conversation_id, m.channel, m.role, m.content, m.created_at, m.seq, m.idempotency_key, m.reply_to_id, m.model_run_id, m.flags_json, m.image_id, m.image_status, m.deliver_at ?? null, m.song_json ?? null, m.audio_key ?? null, m.images_json ?? null, m.media_id ?? null);
}

export function insertModelRunStmt(db: D1Database, r: ModelRunRow): D1PreparedStatement {
  return db.prepare("INSERT INTO model_runs (id, conversation_id, kind, provider, model, prompt_version, input_tokens, output_tokens, cost_usd_micro, latency_ms, status, error, flags_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)")
    .bind(r.id, r.conversation_id, r.kind, r.provider, r.model, r.prompt_version, r.input_tokens, r.output_tokens, r.cost_usd_micro, r.latency_ms, r.status, r.error, r.flags_json, r.created_at);
}

export function touchConversationStmt(db: D1Database, conversationId: string, at: string): D1PreparedStatement {
  return db.prepare("UPDATE conversations SET last_message_at = ?2 WHERE id = ?1").bind(conversationId, at);
}

// One request by default; a call's 30-second ticks pass 0 and its end passes 1, so a call
// reads as one request in the usage table however many ticks metered it.
export function usageStmt(db: D1Database, day: string, provider: string, model: string, inputTokens: number, outputTokens: number, costMicro: number, requests = 1): D1PreparedStatement {
  return db.prepare("INSERT INTO usage_daily (day, provider, model, requests, input_tokens, output_tokens, cost_usd_micro) VALUES (?1, ?2, ?3, ?7, ?4, ?5, ?6) ON CONFLICT(day, provider, model) DO UPDATE SET requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_usd_micro = cost_usd_micro + excluded.cost_usd_micro")
    .bind(day, provider, model, inputTokens, outputTokens, costMicro, Math.max(0, Math.trunc(requests)));
}

export function auditStmt(db: D1Database, actor: string, action: string, entity: string | null, entityId: string | null, before: unknown, after: unknown): D1PreparedStatement {
  return db.prepare("INSERT INTO audit_events (id, actor, action, entity, entity_id, before_json, after_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(newId("a"), actor, action, entity, entityId, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), nowIso());
}

// ------------------------------------------------------------------ proposals and assets

export async function listProposals(db: D1Database, status?: ProposalRow["status"], limit = 200): Promise<ProposalRow[]> {
  const r = status
    ? await db.prepare("SELECT * FROM proposals WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2").bind(status, limit).all<ProposalRow>()
    : await db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?1").bind(limit).all<ProposalRow>();
  return r.results;
}

export async function getProposal(db: D1Database, id: string): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposals WHERE id = ?1").bind(id).first<ProposalRow>();
}

export function insertProposalStmt(db: D1Database, p: ProposalRow): D1PreparedStatement {
  return db.prepare("INSERT INTO proposals (id, conversation_id, message_id, kind, proposal, evidence, confidence, scope, payload_json, status, decision_note, promoted_id, created_at, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)")
    .bind(p.id, p.conversation_id, p.message_id, p.kind, p.proposal, p.evidence, p.confidence, p.scope, p.payload_json, p.status, p.decision_note, p.promoted_id, p.created_at, p.decided_at);
}

export async function listAssets(db: D1Database, status?: VisualAssetRow["approval_status"]): Promise<VisualAssetRow[]> {
  const r = status
    ? await db.prepare("SELECT * FROM visual_assets WHERE approval_status = ?1 ORDER BY created_at").bind(status).all<VisualAssetRow>()
    : await db.prepare("SELECT * FROM visual_assets ORDER BY created_at").all<VisualAssetRow>();
  return r.results;
}

export async function getAsset(db: D1Database, id: string): Promise<VisualAssetRow | null> {
  return db.prepare("SELECT * FROM visual_assets WHERE id = ?1").bind(id).first<VisualAssetRow>();
}

export function insertAssetStmt(db: D1Database, a: VisualAssetRow): D1PreparedStatement {
  return db.prepare("INSERT INTO visual_assets (id, file, role, sha256, bytes, approval_status, conversation_id, message_id, prompt, provider, model, notes, created_at, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)")
    .bind(a.id, a.file, a.role, a.sha256, a.bytes, a.approval_status, a.conversation_id, a.message_id, a.prompt, a.provider, a.model, a.notes, a.created_at, a.decided_at);
}

// ------------------------------------------------------------------ usage

export async function spendMicro(db: D1Database, since: string): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(cost_usd_micro), 0) AS s FROM usage_daily WHERE day >= ?1").bind(since).first<{ s: number }>();
  return r?.s ?? 0;
}

export async function usageByDay(db: D1Database, days = 31): Promise<Array<{ day: string; provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; cost_usd_micro: number }>> {
  const r = await db.prepare("SELECT * FROM usage_daily ORDER BY day DESC LIMIT ?1").bind(days * 6).all<{ day: string; provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; cost_usd_micro: number }>();
  return r.results;
}
