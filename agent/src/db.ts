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
