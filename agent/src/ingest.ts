import type { Request, Response } from "express";
import { config } from "./config.js";
import { db } from "./db.js";
import { costUsd } from "./pricing.js";
import { recordDeploy } from "./deploys.js";

const insertTelemetry = db.prepare(`
  INSERT INTO telemetry (sha, ts, kind, name, model, input_tokens, output_tokens, latency_ms, error, error_message, cost_usd, request_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const bumpDeploy = db.prepare(`UPDATE deploys SET request_count = request_count + 1 WHERE sha = ?`);
const hasRequest = db.prepare(
  `SELECT 1 AS ok FROM telemetry WHERE sha = ? AND request_id = ? AND coalesce(kind, 'llm') != 'function' LIMIT 1`,
);

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const obj = body as Record<string, unknown>;
  if (typeof obj.attributes === "object" && obj.attributes !== null) {
    return { ...obj, ...(obj.attributes as Record<string, unknown>) };
  }
  return obj;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function spanKind(a: Record<string, unknown>, hasModel: boolean): "llm" | "http" | "function" {
  const raw = String(a.kind ?? a["span.kind"] ?? "").toLowerCase();
  if (raw === "http" || raw === "function" || raw === "llm") return raw;
  if (a["http.route"] || a["http.method"]) return "http";
  if (a["code.function"]) return "function";
  return hasModel ? "llm" : "http";
}

export function ingest(req: Request, res: Response) {
  const token =
    req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.get("x-ingest-token") ?? "";
  if (!config.ingestToken || token !== config.ingestToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const a = asRecord(req.body);
  const sha = String(a["service.version"] ?? "").trim();
  const model = String(a["gen_ai.request.model"] ?? a.model ?? "").trim();
  const inputTokens = num(a["gen_ai.usage.input_tokens"]);
  const outputTokens = num(a["gen_ai.usage.output_tokens"]);
  const latencyMs = num(a["latency_ms"]);
  const requestId = a["request_id"] != null ? String(a["request_id"]) : null;
  const errRaw = a["error"];
  const error = errRaw === true || errRaw === 1 || errRaw === "1" ? 1 : 0;
  const errorMessage = a["error_message"] != null ? String(a["error_message"]).slice(0, 500) : null;
  const kind = spanKind(a, Boolean(model));
  const name = String(a.name ?? a["http.route"] ?? a["code.function"] ?? model ?? kind).trim();

  if (!sha) {
    res.status(400).json({ error: "bad payload", need: ["service.version"] });
    return;
  }

  if (kind === "llm") {
    if (!model || inputTokens === null || outputTokens === null || inputTokens < 0 || outputTokens < 0) {
      res.status(400).json({
        error: "bad payload",
        need: ["gen_ai.request.model", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"],
      });
      return;
    }
  } else if (!name || latencyMs === null || latencyMs < 0) {
    res.status(400).json({ error: "bad payload", need: ["name or http.route", "latency_ms"] });
    return;
  }

  const bump =
    kind !== "function" &&
    (!requestId || !hasRequest.get(sha, requestId));

  const cost = kind === "llm" ? costUsd(model, inputTokens ?? 0, outputTokens ?? 0) : 0;
  insertTelemetry.run(
    sha,
    new Date().toISOString(),
    kind,
    name || null,
    model || null,
    inputTokens,
    outputTokens,
    latencyMs,
    error,
    error ? errorMessage : null,
    cost,
    requestId,
  );
  const created = recordDeploy({ sha, source: "ingest" });
  if (created.skipped && bump) bumpDeploy.run(sha);

  res.json({ ok: true, sha, kind, name, cost_usd: cost });
}
