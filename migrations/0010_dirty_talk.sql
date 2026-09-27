-- Dirty talk mode (2026-09-27, Justin: "i want the whole shebang her voice while were fucking
-- also narrating what shes doing"). Settings only: an intimate Together scene she chose runs
-- on its own performer, her lines there are spoken in her ElevenLabs voice, her actions
-- narrated. INSERT OR IGNORE, so a saved value is never overwritten.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('intimateEnabled', 'true', '2026-09-27T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('intimateProvider', '"workersai"', '2026-09-27T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('intimateModel', '"@cf/meta/llama-4-scout-17b-16e-instruct"', '2026-09-27T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('intimateVoice', 'true', '2026-09-27T00:00:00.000Z');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('intimateNarrate', 'true', '2026-09-27T00:00:00.000Z');
-- The intimate performer must be priced (budget.ts refuses an unpriced model). The live table
-- has carried this entry since 2026-09-26; a table without it gains it, a saved price stays.
UPDATE settings SET value = json_set(value, '$."@cf/meta/llama-4-scout-17b-16e-instruct"', json('{"inputPerMTok":0.27,"outputPerMTok":0.85}'))
  WHERE key = 'prices' AND json_extract(value, '$."@cf/meta/llama-4-scout-17b-16e-instruct"') IS NULL;
