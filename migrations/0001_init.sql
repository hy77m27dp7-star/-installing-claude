-- Avelie runtime schema. Mutable story state lives here; immutable rules live in code.
-- Every durable change to canon is versioned (supersedes_id / version) and audited.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  last_message_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'story',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  reply_to_id TEXT,
  model_run_id TEXT,
  flags_json TEXT,
  image_id TEXT,
  image_status TEXT
);
CREATE INDEX idx_messages_conv_seq ON messages(conversation_id, seq);
CREATE INDEX idx_messages_conv_channel ON messages(conversation_id, channel, seq);

CREATE TABLE model_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micro INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  flags_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_model_runs_created ON model_runs(created_at);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject TEXT,
  fact TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  disclosed INTEGER NOT NULL DEFAULT 1,
  provisional INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_facts_scope_status ON facts(scope, status);

CREATE TABLE history (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  occurred TEXT,
  body TEXT NOT NULL,
  what_changed TEXT,
  keep_consistent TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_history_status_seq ON history(status, seq);

CREATE TABLE unknowns (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE state_versions (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  source TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_state_entity_version ON state_versions(entity, version);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL,
  proposal TEXT NOT NULL,
  evidence TEXT,
  confidence TEXT,
  scope TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  promoted_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micro INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events(created_at);

CREATE TABLE visual_assets (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  role TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER,
  approval_status TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  prompt TEXT,
  provider TEXT,
  model TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_visual_status ON visual_assets(approval_status, role);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  reason TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
