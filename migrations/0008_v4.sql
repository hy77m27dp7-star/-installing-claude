-- v4 (SPEC_V4, 2026-09-26): her places and their pictures, the one Spotify row, the
-- panel cache; him in a picture, a song's status, a delayed reply's notification stamp;
-- the thirteen new settings rows (the nine of the spec table and amendment A's four).
-- Additive: no existing row is touched, no table dropped.
-- Apply REMOTELY BEFORE the deploy that carries it, as two commands with a check between.
CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, title TEXT NOT NULL, title_norm TEXT NOT NULL, detail TEXT, lat REAL, lon REAL, geocoded_by TEXT CHECK (geocoded_by IN ('owner','openmeteo','map')), picture_key TEXT, picture_sha256 TEXT, picture_bytes INTEGER, picture_light TEXT CHECK (picture_light IN ('day','night')), picture_season TEXT, picture_prompt TEXT, picture_provider TEXT, picture_model TEXT, picture_made_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_places_title_norm ON places(title_norm);
CREATE TABLE IF NOT EXISTS spotify_auth (id TEXT PRIMARY KEY CHECK (id = 'owner'), status TEXT NOT NULL CHECK (status IN ('pending','connected')), state TEXT, refresh_token TEXT, access_token TEXT, access_expires_at TEXT, scope TEXT, spotify_user_id TEXT, display_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS panel_cache (k TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
ALTER TABLE visual_assets ADD COLUMN with_him INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN spotify_status TEXT;
ALTER TABLE messages ADD COLUMN pushed_at TEXT;
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('avatarAssetId', '"master-05"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('callFaceProvider', '"clips"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('callFaceSourceAssetId', '"master-00"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('hisFaceInPhotos', 'true', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('spotifyEnabled', 'false', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('spotifyPlaylistId', '""', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('spotifyPlaylistName', '"songs from avelie"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('placeCostUsd', '0.08', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('listeningLineEnabled', 'true', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('spotifyPlayer', '"sdk"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('elevenLabsModel', '"eleven_multilingual_v2"', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('elevenLabsTtsPricePer1kChars', '0.3', '2026-09-26T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('videoMarkerEnabled', 'true', '2026-09-26T00:00:00.000Z');
