import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const db = (() => {
  const dir = path.dirname(path.resolve(config.databasePath));
  fs.mkdirSync(dir, { recursive: true });
  const instance = new DatabaseSync(config.databasePath);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  const telemetryCols = instance.prepare(`PRAGMA table_info(telemetry)`).all() as { name: string }[];
  const names = new Set(telemetryCols.map((c) => c.name));
  if (!names.has("error_message")) instance.exec(`ALTER TABLE telemetry ADD COLUMN error_message TEXT`);
  if (!names.has("kind")) instance.exec(`ALTER TABLE telemetry ADD COLUMN kind TEXT NOT NULL DEFAULT 'llm'`);
  if (!names.has("name")) instance.exec(`ALTER TABLE telemetry ADD COLUMN name TEXT`);
  const actionCols = instance.prepare(`PRAGMA table_info(actions)`).all() as { name: string }[];
  const actionColNames = new Set(actionCols.map((c) => c.name));
  if (!actionColNames.has("awaiting_at")) {
    instance.exec(`ALTER TABLE actions ADD COLUMN awaiting_at TEXT`);
  }
  if (!actionColNames.has("doc_hash")) {
    instance.exec(`ALTER TABLE actions ADD COLUMN doc_hash TEXT`);
  }
  if (!actionColNames.has("doc_title")) {
    instance.exec(`ALTER TABLE actions ADD COLUMN doc_title TEXT`);
  }
  if (!actionColNames.has("resolved_at")) {
    instance.exec(`ALTER TABLE actions ADD COLUMN resolved_at TEXT`);
  }
  const rollbackTable = instance
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rollback_intents'`)
    .get();
  if (!rollbackTable) {
    instance.exec(`
      CREATE TABLE rollback_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha TEXT NOT NULL,
        filter TEXT,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_at TEXT,
        finished_at TEXT,
        detail TEXT,
        UNIQUE(sha, requested_by)
      );
      CREATE INDEX rollback_intents_pending ON rollback_intents(status, requested_at);
    `);
  }
  const commitAnalysisTable = instance
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='commit_analysis'`)
    .get();
  if (!commitAnalysisTable) {
    instance.exec(`
      CREATE TABLE commit_analysis (
        sha TEXT PRIMARY KEY,
        deploy_sha TEXT NOT NULL,
        baseline_sha TEXT,
        author_login TEXT,
        message TEXT,
        category TEXT,
        severity TEXT,
        summary TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX commit_analysis_deploy ON commit_analysis(deploy_sha);
    `);
  }
  const commitCols = instance
    .prepare(`SELECT name FROM pragma_table_info('commit_analysis') WHERE name = 'baseline_sha'`)
    .all();
  if (!commitCols.length) {
    instance.exec(`ALTER TABLE commit_analysis ADD COLUMN baseline_sha TEXT`);
  }
  const suspectCols = instance
    .prepare(`SELECT name FROM pragma_table_info('suspects') WHERE name = 'commit_sha'`)
    .all();
  if (!suspectCols.length) {
    instance.exec(`ALTER TABLE suspects ADD COLUMN commit_sha TEXT`);
  }
  const actionOutcomeCols = instance
    .prepare(`SELECT name FROM pragma_table_info('actions') WHERE name = 'outcome'`)
    .all();
  if (!actionOutcomeCols.length) {
    instance.exec(`ALTER TABLE actions ADD COLUMN outcome TEXT`);
  }
  const diffBlobCols = instance
    .prepare(`SELECT name FROM pragma_table_info('commit_analysis') WHERE name = 'diff_blob'`)
    .all();
  if (!diffBlobCols.length) {
    instance.exec(`ALTER TABLE commit_analysis ADD COLUMN diff_blob TEXT`);
  }
  const replyThreadCols = instance
    .prepare(`SELECT name FROM pragma_table_info('rollback_intents') WHERE name = 'reply_thread'`)
    .all();
  if (!replyThreadCols.length) {
    instance.exec(`ALTER TABLE rollback_intents ADD COLUMN reply_thread TEXT`);
  }
  const chosenShaCols = instance
    .prepare(`SELECT name FROM pragma_table_info('rollback_intents') WHERE name = 'chosen_sha'`)
    .all();
  if (!chosenShaCols.length) {
    instance.exec(`ALTER TABLE rollback_intents ADD COLUMN chosen_sha TEXT`);
  }
  const evalHistoryTable = instance
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_history'`)
    .get();
  if (!evalHistoryTable) {
    instance.exec(`
      CREATE TABLE evaluation_history (
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
      CREATE INDEX evaluation_history_sha ON evaluation_history(sha, id);
    `);
  }
  const snapCols = instance
    .prepare(`SELECT name FROM pragma_table_info('evaluation_history') WHERE name = 'doc_id'`)
    .all();
  if (!snapCols.length) {
    instance.exec(`ALTER TABLE evaluation_history ADD COLUMN cost_per_req REAL`);
    instance.exec(`ALTER TABLE evaluation_history ADD COLUMN latency_ms REAL`);
    instance.exec(`ALTER TABLE evaluation_history ADD COLUMN error_rate REAL`);
    instance.exec(`ALTER TABLE evaluation_history ADD COLUMN n INTEGER`);
    instance.exec(`ALTER TABLE evaluation_history ADD COLUMN doc_id TEXT`);
  }
  return instance;
})();

export function dbHealth(): "up" | "down" {
  try {
    db.prepare("SELECT 1").get();
    return "up";
  } catch {
    return "down";
  }
}
