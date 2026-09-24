-- v2: her first texts (SPEC_V2 section R) and Web Push subscriptions (section U).
-- Runs once through the migrations ledger, after 0004_life.sql. Two new tables, both
-- empty at the start; no existing row or table is touched.
--
-- first_texts_daily: one row per local day (her timezone), the number of first texts she
-- sent that day; the cap in settings (herFirstTextsPerDay) is read against it.
-- push_subscriptions: one row per browser endpoint the owner subscribed from the Model
-- page. keys_json holds the subscription's p256dh and auth values; they never leave
-- through the export and never appear in the audit log.

CREATE TABLE IF NOT EXISTS first_texts_daily (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
