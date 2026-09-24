-- v3 (SPEC_V3, the Migration section): the whole v3 schema in one file, hand-written,
-- consolidated from sections AA (voice bank, corrections), BB (memory weights, recalls),
-- CC (wants, want log, asks), DD (grounding log, weather cache, life_threads.portrait_asset_id),
-- EE (calls, messages.call_id), HH (tastings, candidates) and II (message marks,
-- message_context.state_text). Runs once through the migrations ledger after 0004c.
-- Every table is CREATE TABLE IF NOT EXISTS, every index IF NOT EXISTS; the three
-- ALTER TABLE ... ADD COLUMN lines run once (D1 has no IF NOT EXISTS for columns, and the
-- ledger guarantees a single run). No existing row is read or written. New tables start
-- empty except the voice bank, which 0005b_voicebank_seed.sql (generated) fills.
-- 0001 to 0004c are live and frozen. The seed file is 150 single-row INSERT OR IGNORE
-- statements; every statement here is well under the 100 KB statement limit.

CREATE TABLE IF NOT EXISTS voice_lines (id TEXT PRIMARY KEY, text TEXT NOT NULL, text_norm TEXT NOT NULL UNIQUE, tags_json TEXT NOT NULL, source TEXT, origin TEXT NOT NULL CHECK (origin IN ('seed','owner','correction')), status TEXT NOT NULL DEFAULT 'unapproved' CHECK (status IN ('unapproved','approved','rejected')), uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT);
CREATE INDEX IF NOT EXISTS idx_voice_lines_status ON voice_lines(status, created_at);
CREATE TABLE IF NOT EXISTS voice_line_uses (id TEXT PRIMARY KEY, line_id TEXT NOT NULL, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_voice_line_uses_conv ON voice_line_uses(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, conversation_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('ai','clever','not_her','too_long','too_nice','too_polished','other')), note TEXT, original TEXT NOT NULL, rewrite TEXT, voice_line_id TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')), created_at TEXT NOT NULL, retired_at TEXT);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections(status, created_at);
CREATE TABLE IF NOT EXISTS memory_weights (entity TEXT NOT NULL CHECK (entity IN ('fact','history','thread','log','want')), entity_id TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1), last_touched TEXT NOT NULL, touches INTEGER NOT NULL DEFAULT 0, source TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (entity, entity_id));
CREATE TABLE IF NOT EXISTS memory_recalls (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('provisional')), score REAL NOT NULL, text_shown TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('unknown','confirmed','corrected')), outcome_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_memory_recalls_conv ON memory_recalls(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS wants (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT, stakes TEXT, next_step TEXT, progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','dropped')), horizon_days INTEGER NOT NULL DEFAULT 42, last_moved TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS want_log (id TEXT PRIMARY KEY, want_id TEXT NOT NULL, occurred TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('progress','setback','note')), delta INTEGER, note TEXT NOT NULL, source TEXT, message_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_want_log_want ON want_log(want_id, occurred);
CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, want_id TEXT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','granted','declined','let_go')), asked_message_id TEXT, asked_at TEXT NOT NULL, brought_up INTEGER NOT NULL DEFAULT 0, resolved_at TEXT, resolution_note TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_asks_status ON asks(status, asked_at);
CREATE TABLE IF NOT EXISTS grounding_log (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('meal','outfit','errand','misc')), note TEXT NOT NULL, occurred TEXT NOT NULL, source TEXT, message_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_grounding_log_occurred ON grounding_log(occurred);
CREATE TABLE IF NOT EXISTS weather_cache (k TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, voice TEXT, status TEXT NOT NULL CHECK (status IN ('starting','live','ended','failed','expired')), started_at TEXT NOT NULL, last_tick_at TEXT, ended_at TEXT, seconds INTEGER NOT NULL DEFAULT 0, cost_usd_micro INTEGER NOT NULL DEFAULT 0, usage_json TEXT, transcript_rows INTEGER NOT NULL DEFAULT 0, end_reason TEXT, prompt_version TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status, started_at);
CREATE TABLE IF NOT EXISTS tastings (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_message_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, left_side TEXT NOT NULL CHECK (left_side IN ('A','B')), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','void','expired')), a_provider TEXT NOT NULL, a_model TEXT NOT NULL, b_provider TEXT NOT NULL, b_model TEXT NOT NULL, pick TEXT CHECK (pick IN ('left','right','neither')), winner_side TEXT CHECK (winner_side IN ('A','B')), cost_usd_micro INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, decided_at TEXT);
CREATE INDEX IF NOT EXISTS idx_tastings_conv_status ON tastings(conversation_id, status);
CREATE TABLE IF NOT EXISTS tasting_candidates (id TEXT PRIMARY KEY, tasting_id TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('A','B')), text TEXT NOT NULL, photo TEXT, song_json TEXT, clip TEXT, flags_json TEXT, run_id TEXT NOT NULL, retried INTEGER NOT NULL DEFAULT 0, cost_usd_micro INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasting_candidates_tasting ON tasting_candidates(tasting_id, side);
CREATE TABLE IF NOT EXISTS message_marks (message_id TEXT PRIMARY KEY, mark TEXT NOT NULL CHECK (mark IN ('keep','drop')), note TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE life_threads ADD COLUMN portrait_asset_id TEXT;
ALTER TABLE messages ADD COLUMN call_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_call ON messages(call_id);
ALTER TABLE message_context ADD COLUMN state_text TEXT;

-- Her city (Justin's decision 2026-09-24, SPEC_V3 open question 1): one approved fact about
-- her, scope avelie, subject home, undisclosed until a conversation earns it, the way the
-- other seed facts about her are. Same id scheme as 0002_seed.sql (seed- plus the hash of
-- scope, subject and text); INSERT OR IGNORE, so a re-run changes nothing.
INSERT OR IGNORE INTO facts (id, scope, subject, fact, source, status, disclosed, provisional, version, supersedes_id, created_at, updated_at) VALUES ('seed-24508f6ad9752e12', 'avelie', 'home', 'Lives in Portland, Maine', 'Justin''s decision 2026-09-24', 'approved', 0, 0, 1, NULL, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
