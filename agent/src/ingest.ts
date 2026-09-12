import type { Request, Response } from "express";
import { config } from "./config.js";
import { db } from "./db.js";
import { costUsd } from "./pricing.js";

const insertTelemetry = db.prepare(`
  INSERT INTO telemetry (sha, ts, model, input_tokens, output_tokens, latency_ms, error, cost_usd, request_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const bumpDeploy = db.prepare(`
  UPDATE deploys SET request_count = request_count + 1 WHERE sha = ?
`);

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

export function ingest(req: Request, res: Response) {
  const token =
    req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.get("x-ingest-token") ?? "";
  if (!config.ingestToken || token !== config.ingestToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const a = asRecord(req.body);
  const sha = String(a["service.version"] ?? "").trim();
  const model = String(a["gen_ai.request.model"] ?? "").trim();
  const inputTokens = num(a["gen_ai.usage.input_tokens"]);
  const outputTokens = num(a["gen_ai.usage.output_tokens"]);
  const latencyMs = num(a["latency_ms"]);
  const requestId = a["request_id"] != null ? String(a["request_id"]) : null;
  const errRaw = a["error"];
  const error = errRaw === true || errRaw === 1 || errRaw === "1" ? 1 : 0;

  if (!sha || !model || inputTokens === null || outputTokens === null || inputTokens < 0 || outputTokens < 0) {
    res.status(400).json({
      error: "bad payload",
      need: ["service.version", "gen_ai.request.model", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"],
    });
    return;
  }

  const cost = costUsd(model, inputTokens, outputTokens);
  insertTelemetry.run(
    sha,
    new Date().toISOString(),
    model,
    inputTokens,
    outputTokens,
    latencyMs,
    error,
    cost,
    requestId,
  );
  bumpDeploy.run(sha);

  res.json({ ok: true, sha, cost_usd: cost });
}
