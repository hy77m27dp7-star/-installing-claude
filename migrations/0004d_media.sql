-- v2, SPEC_V2 sections S, T and V: the owner's media library and three message columns
-- (audio_key: her voice note or his recording; images_json: the photos he sent; media_id:
-- the library item she sent). Runs once through the migrations ledger. Existing rows are
-- never touched: the columns default to NULL and the table starts empty.
--
-- SPEC_V2 called this migration 0003; 0003 is the live seq-unique migration, so v2 files
-- are 0004*. If 0004b_push.sql also adds any of these three columns, keep exactly one
-- copy: SQLite has no ADD COLUMN IF NOT EXISTS and a second ALTER fails the file.

CREATE TABLE IF NOT EXISTS media_library (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('clip', 'video', 'image', 'other')),
  title TEXT NOT NULL,
  description TEXT,
  key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_library_status ON media_library(status, created_at);

ALTER TABLE messages ADD COLUMN audio_key TEXT;
ALTER TABLE messages ADD COLUMN images_json TEXT;
ALTER TABLE messages ADD COLUMN media_id TEXT;
