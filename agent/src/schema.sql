CREATE TABLE IF NOT EXISTS pull_requests (
  number INTEGER PRIMARY KEY,
  head_sha TEXT,
  title TEXT,
  author_login TEXT,
  merged_sha TEXT,
  state TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  delivery_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deploys (
  sha TEXT PRIMARY KEY,
  previous_sha TEXT,
  deployed_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'release',
  reverts_sha TEXT,
  status TEXT NOT NULL DEFAULT 'collecting',
  request_count INTEGER NOT NULL DEFAULT 0,
  vercel_deployment_id TEXT,
  github_compare_url TEXT
);

CREATE TABLE IF NOT EXISTS pending_reverts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rolled_back_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'llm',
  name TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  error INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  cost_usd REAL,
  request_id TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL,
  head_sha TEXT,
  merged_sha TEXT,
  estimated_cost_delta_pct REAL,
  estimated_latency_delta_pct REAL,
  rationale TEXT,
  suspect_hints TEXT
);

CREATE TABLE IF NOT EXISTS evaluations (
  sha TEXT PRIMARY KEY,
  baseline_sha TEXT,
  actual_cost_delta_pct REAL,
  actual_latency_delta_pct REAL,
  error_rate_delta REAL,
  predicted_cost_delta_pct REAL,
  prediction_error_pp REAL,
  verdict TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha TEXT NOT NULL,
  baseline_sha TEXT,
  verdict TEXT,
  actual_cost_delta_pct REAL,
  actual_latency_delta_pct REAL,
  error_rate_delta REAL,
  predicted_cost_delta_pct REAL,
  prediction_error_pp REAL,
  summary TEXT,
  cost_per_req REAL,
  latency_ms REAL,
  error_rate REAL,
  n INTEGER,
  doc_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evaluation_history_sha ON evaluation_history(sha, id);

CREATE TABLE IF NOT EXISTS suspects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha TEXT NOT NULL,
  rank INTEGER NOT NULL,
  pr_number INTEGER,
  commit_sha TEXT,
  author_login TEXT,
  confidence REAL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  sha TEXT PRIMARY KEY,
  poll_id TEXT,
  sheet_appended INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  doc_id TEXT,
  rollback_executed INTEGER NOT NULL DEFAULT 0,
  awaiting_at TEXT,
  doc_hash TEXT,
  doc_title TEXT,
  resolved_at TEXT,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS remediations (
  sha TEXT PRIMARY KEY,
  started_after_sha TEXT,
  root_cause TEXT NOT NULL,
  fix TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rollback_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha TEXT NOT NULL,
  filter TEXT,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reply_thread TEXT,
  chosen_sha TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_at TEXT,
  finished_at TEXT,
  detail TEXT,
  UNIQUE(sha, requested_by)
);

CREATE INDEX IF NOT EXISTS rollback_intents_pending
  ON rollback_intents(status, requested_at);

CREATE TABLE IF NOT EXISTS commit_analysis (
  sha TEXT PRIMARY KEY,
  deploy_sha TEXT NOT NULL,
  baseline_sha TEXT,
  author_login TEXT,
  message TEXT,
  category TEXT,
  severity TEXT,
  summary TEXT,
  diff_blob TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS commit_analysis_deploy
  ON commit_analysis(deploy_sha);
