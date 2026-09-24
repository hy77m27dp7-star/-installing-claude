-- v2: her life (threads, log), provenance per assistant message, drift reports, and two
-- message columns (deliver_at for real-mode timing, song_json for a sent song).
-- Runs once through the migrations ledger. Existing rows are never touched: the new
-- columns default to NULL and the new tables start empty. Her life is empty at the fresh
-- start on purpose (SPEC_V2 section F: nothing seeded).

CREATE TABLE IF NOT EXISTS life_threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('routine', 'event', 'person', 'place', 'arc')),
  title TEXT NOT NULL,
  detail TEXT,
  schedule_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  relation TEXT,
  source TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_life_threads_status_kind ON life_threads(status, kind, created_at);

CREATE TABLE IF NOT EXISTS life_log (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  occurred TEXT NOT NULL,
  note TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_life_log_occurred ON life_log(occurred, created_at);

CREATE TABLE IF NOT EXISTS message_context (
  message_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_reports (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_reports_ran_at ON drift_reports(ran_at);

ALTER TABLE messages ADD COLUMN deliver_at TEXT;
ALTER TABLE messages ADD COLUMN song_json TEXT;
