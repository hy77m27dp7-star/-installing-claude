-- v2 (SPEC_V2 section Y): her voiceprint, one row per weekly run over her story-channel
-- messages (count, lengths, question share, top words, bubbles, first texts, flags per
-- code). Runs once through the migrations ledger; the table starts empty and nothing
-- existing is touched. 0001 to 0003 are live and frozen; this is the third 0004 file.

CREATE TABLE IF NOT EXISTS voiceprints (
  id TEXT PRIMARY KEY,
  week TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voiceprints_created ON voiceprints(created_at);
