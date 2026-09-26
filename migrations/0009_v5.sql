-- v5 (SPEC_V5, 2026-09-26): her clock (held spans of a together scene), the nightly story
-- pass's day ledger, dated beats on her wants and their runs, her read of him, the people of
-- her life and the fixed facts of her people and places, the artists he knows; a guess flag
-- on facts, the missing-song notice stamp on messages, one index for the clock's reads; the
-- two canon people (her mother, active; Mason, done: her past) when the record has neither; the
-- twenty new settings.
-- Additive: no table dropped, no existing row changed. Apply REMOTELY BEFORE the deploy that
-- carries it, as two commands with a check between.
CREATE TABLE IF NOT EXISTS story_clock (id TEXT PRIMARY KEY, opened_version INTEGER NOT NULL UNIQUE, frozen_at TEXT NOT NULL, closed_version INTEGER, resumed_at TEXT, location TEXT, weather_json TEXT, outfit_json TEXT, today_json TEXT, prior_time TEXT, beats_shifted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_story_clock_resumed ON story_clock(resumed_at);
CREATE TABLE IF NOT EXISTS nightly_runs (day TEXT NOT NULL, step TEXT NOT NULL CHECK (step IN ('her_day','arcs','views','hygiene')), ran_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('done','skipped','failed')), result_json TEXT, PRIMARY KEY (day, step));
CREATE TABLE IF NOT EXISTS arc_beats (id TEXT PRIMARY KEY, want_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('step','event')), due_on TEXT NOT NULL, due_time TEXT, due_at TEXT NOT NULL, variants_json TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')), source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_arc_beats_want ON arc_beats(want_id, due_at);
CREATE TABLE IF NOT EXISTS beat_runs (id TEXT PRIMARY KEY, beat_id TEXT NOT NULL, reader TEXT NOT NULL DEFAULT 'owner', status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','proposed','resolved','skipped')), due_at TEXT NOT NULL, outcome TEXT CHECK (outcome IN ('did_it','missed','went','went_well','went_badly','chickened_out','postponed')), variant_id TEXT, outcome_note TEXT, his_part TEXT CHECK (his_part IN ('encouraged','asked','came','forgot','none')), his_note TEXT, evidence_json TEXT, proposal_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, shifted_ms INTEGER NOT NULL DEFAULT 0, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (beat_id, reader));
CREATE INDEX IF NOT EXISTS idx_beat_runs_status ON beat_runs(status, due_at);
CREATE TABLE IF NOT EXISTS her_views (id TEXT PRIMARY KEY, subject TEXT NOT NULL, subject_norm TEXT NOT NULL, view TEXT NOT NULL, confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1), evidence_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','proven_wrong','retired')), version INTEGER NOT NULL DEFAULT 1, supersedes_id TEXT, source TEXT, wrong_note TEXT, wrong_evidence_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_her_views_status ON her_views(status, subject_norm);
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE, relation TEXT, relation_norm TEXT, named INTEGER NOT NULL DEFAULT 1, locked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS world_facts (id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL CHECK (entity_kind IN ('person','place')), entity_id TEXT NOT NULL, fact TEXT NOT NULL, fact_norm TEXT NOT NULL, source TEXT, status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','retired')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_facts_live ON world_facts(entity_kind, entity_id, fact_norm) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_world_facts_entity ON world_facts(entity_kind, entity_id, status);
CREATE TABLE IF NOT EXISTS known_artists (id TEXT PRIMARY KEY, artist TEXT NOT NULL, artist_norm TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('known','disliked')), source TEXT NOT NULL CHECK (source IN ('button','proposal','owner')), message_id TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE facts ADD COLUMN inferred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN song_told_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel, created_at);
INSERT INTO life_threads (id, kind, title, detail, schedule_json, status, relation, source, version, supersedes_id, created_at, updated_at)
  SELECT 'lt_v5_canon_mother', 'person', 'her mother', 'Close; very alike, which is why they can drive each other insane. Probably still has the prom crown stored away.', NULL, 'active', 'mother', 'canon: file 07 continuity ledger (v5 seed)', 1, NULL, '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z'
  WHERE NOT EXISTS (SELECT 1 FROM life_threads WHERE id = 'lt_v5_canon_mother' OR (kind = 'person' AND status = 'active' AND lower(COALESCE(relation, '')) IN ('mother', 'mom', 'mum', 'mama', 'her mother', 'her mom')));
INSERT INTO life_threads (id, kind, title, detail, schedule_json, status, relation, source, version, supersedes_id, created_at, updated_at)
  SELECT 'lt_v5_canon_mason', 'person', 'Mason', 'A drummer she dated at seventeen, about four months. He kissed another girl after a show and blamed the energy getting weird.', NULL, 'done', 'ex', 'canon: file 07 continuity ledger (v5 seed)', 1, NULL, '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z'
  WHERE NOT EXISTS (SELECT 1 FROM life_threads WHERE id = 'lt_v5_canon_mason' OR (kind = 'person' AND lower(trim(title)) = 'mason'));
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('storyClockEnabled', 'true', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('gapLineMinMinutes', '120', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('nightlyStoryEnabled', 'true', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('nightlyProvider', '"anthropic"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('nightlyModel', '"claude-sonnet-5"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('hygieneModel', '"claude-haiku-4-5"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('nightlyBudgetUsd', '0.25', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('herDayItemsMax', '2', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('nightlyBeatsMax', '3', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('beatHorizonDays', '7', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('arcMemoryDays', '7', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('viewsShown', '6', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('viewMinConfidence', '0.4', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('viewsPerNight', '3', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('frictionDaysDefault', '4', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('sentShown', '12', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('sentWindowDays', '7', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('hygieneEnabled', 'true', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('worldShown', '6', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('knownArtistsShown', '40', '2026-09-26T00:00:00.000Z');
