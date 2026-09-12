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
