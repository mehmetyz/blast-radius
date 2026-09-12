import { config } from "./config.js";
import { db } from "./db.js";
import type { EvaluationVerdict } from "./types.js";

const statsSql = db.prepare(`
  SELECT count(*) AS n,
         coalesce(sum(cost_usd), 0) AS cost,
         coalesce(avg(latency_ms), 0) AS latency,
         coalesce(avg(error), 0) AS error_rate,
         coalesce(sum(error), 0) AS errors
    FROM telemetry WHERE sha = ? AND coalesce(kind, 'llm') = ?
`);
const allStatsSql = db.prepare(`
  SELECT count(*) AS n,
         coalesce(sum(cost_usd), 0) AS cost,
         coalesce(avg(latency_ms), 0) AS latency,
         coalesce(avg(error), 0) AS error_rate,
         coalesce(sum(error), 0) AS errors
    FROM telemetry WHERE sha = ?
`);
const latenciesSql = db.prepare(
  `SELECT latency_ms AS ms FROM telemetry
    WHERE sha = ? AND latency_ms IS NOT NULL
      AND (? IS NULL OR coalesce(kind, 'llm') = ?)`,
);
const byModelSql = db.prepare(`
  SELECT model,
         count(*) AS n,
         coalesce(sum(cost_usd), 0) AS cost,
         coalesce(avg(latency_ms), 0) AS latency,
         coalesce(avg(error), 0) AS error_rate
    FROM telemetry WHERE sha = ? AND coalesce(kind, 'llm') = 'llm'
    GROUP BY model
`);
const byNameSql = db.prepare(`
  SELECT coalesce(kind, 'llm') AS kind,
         coalesce(name, '(unnamed)') AS name,
         count(*) AS n,
         coalesce(avg(latency_ms), 0) AS latency,
         coalesce(avg(error), 0) AS error_rate,
         coalesce(sum(cost_usd), 0) AS cost
    FROM telemetry WHERE sha = ?
    GROUP BY coalesce(kind, 'llm'), coalesce(name, '(unnamed)')
`);
const errorRowsSql = db.prepare(`
  SELECT ts, coalesce(kind, 'llm') AS kind, name, model, request_id, error_message, latency_ms
    FROM telemetry
   WHERE sha = ? AND error = 1
   ORDER BY ts DESC LIMIT 15
`);
const getDeploy = db.prepare(`SELECT * FROM deploys WHERE sha = ?`);
const previousRelease = db.prepare(`
  SELECT * FROM deploys
  WHERE origin = 'release' AND sha != ? AND request_count >= ?
  ORDER BY deployed_at DESC LIMIT 1
`);
const releasesChrono = db.prepare(`
  SELECT sha FROM deploys
  WHERE origin = 'release' AND request_count >= ?
  ORDER BY deployed_at ASC
`);
const predictionFor = db.prepare(`
  SELECT * FROM predictions
  WHERE merged_sha = ? OR head_sha = ?
  ORDER BY id DESC LIMIT 1
`);
const upsertEval = db.prepare(`
  INSERT INTO evaluations (
    sha, baseline_sha, actual_cost_delta_pct, actual_latency_delta_pct, error_rate_delta,
    predicted_cost_delta_pct, prediction_error_pp, verdict, summary
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sha) DO UPDATE SET
    baseline_sha = excluded.baseline_sha,
    actual_cost_delta_pct = excluded.actual_cost_delta_pct,
    actual_latency_delta_pct = excluded.actual_latency_delta_pct,
    error_rate_delta = excluded.error_rate_delta,
    predicted_cost_delta_pct = excluded.predicted_cost_delta_pct,
    prediction_error_pp = excluded.prediction_error_pp,
    verdict = excluded.verdict,
    summary = excluded.summary
`);
const setStatus = db.prepare(`UPDATE deploys SET status = ? WHERE sha = ?`);

type Stats = { n: number; cost: number; latency: number; error_rate: number; errors: number };
export type NamedSpan = {
  kind: string;
  name: string;
  n: number;
  latency: number;
  error_rate: number;
  cost: number;
};

function stats(sha: string, kind?: string): Stats {
  if (kind) return statsSql.get(sha, kind) as Stats;
  return allStatsSql.get(sha) as Stats;
}

function pctDelta(now: number, then: number): number {
  if (then === 0) return now === 0 ? 0 : 100;
  return ((now - then) / then) * 100;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

function latencyKind(sha: string): "http" | "llm" | "all" {
  if ((stats(sha, "http").n ?? 0) > 0) return "http";
  if ((stats(sha, "llm").n ?? 0) > 0) return "llm";
  return "all";
}

export function summarizeTelemetry(sha: string) {
  const llm = stats(sha, "llm");
  const http = stats(sha, "http");
  const all = stats(sha);
  const lk = latencyKind(sha);
  const latSrc = lk === "all" ? all : stats(sha, lk);
  const per = llm.n ? llm.cost / llm.n : 0;
  const latKey = lk === "all" ? null : lk;
  const lats = (latenciesSql.all(sha, latKey, latKey) as { ms: number }[]).map((r) => r.ms);
  return {
    sha,
    n: http.n || llm.n || all.n,
    cost_usd: llm.cost,
    cost_per_req: per,
    latency_ms: latSrc.latency,
    latency_kind: lk,
    latency_p50_ms: percentile(lats, 50),
    latency_p95_ms: percentile(lats, 95),
    error_rate: all.error_rate,
    errors: all.errors,
    by_model: byModelSql.all(sha),
    by_name: byNameSql.all(sha) as NamedSpan[],
  };
}

export function listErrors(sha: string) {
  return errorRowsSql.all(sha);
}

export function errorOnset(sha: string): {
  started_after_sha: string | null;
  previous_ok_sha: string | null;
} {
  const rows = releasesChrono.all(config.minRequests) as { sha: string }[];
  let previousOk: string | null = null;
  let previousRate = 0;
  let startedAfter: string | null = null;
  for (const row of rows) {
    const s = stats(row.sha);
    const spiked = s.error_rate >= 0.05 && (previousOk ? s.error_rate >= previousRate * 2 : true);
    if (spiked && startedAfter == null) {
      startedAfter = row.sha;
      break;
    }
    if (!spiked) {
      previousOk = row.sha;
      previousRate = s.error_rate;
    }
  }
  return {
    started_after_sha: startedAfter ?? sha,
    previous_ok_sha: previousOk,
  };
}

function namedDeltas(current: NamedSpan[], baseline: NamedSpan[]) {
  const prev = new Map(baseline.map((s) => [`${s.kind}:${s.name}`, s]));
  const shared: { kind: string; name: string; latency_delta_pct: number; n: number }[] = [];
  const added: NamedSpan[] = [];
  for (const s of current) {
    const b = prev.get(`${s.kind}:${s.name}`);
    if (!b) {
      added.push(s);
      continue;
    }
    if (s.n >= 5 && b.n >= 5) {
      shared.push({
        kind: s.kind,
        name: s.name,
        latency_delta_pct: pctDelta(s.latency, b.latency),
        n: s.n,
      });
    }
  }
  return { shared, added };
}

export function evaluateDeploy(sha: string) {
  const deploy = getDeploy.get(sha) as { sha: string; origin: string; request_count: number; previous_sha: string | null } | undefined;
  if (!deploy || deploy.origin === "revert") return null;
  if (deploy.request_count < config.minRequests) return null;

  const currentSlice = summarizeTelemetry(sha);
  const baselineRow = previousRelease.get(sha, config.minRequests) as { sha: string } | undefined;
  if (!baselineRow) {
    setStatus.run("evaluated_ok", sha);
    upsertEval.run(sha, null, 0, 0, 0, null, null, "ok", "no baseline with enough traffic");
    return { sha, verdict: "ok" as EvaluationVerdict, skipped: true };
  }

  const baselineSlice = summarizeTelemetry(baselineRow.sha);
  const costDelta = pctDelta(currentSlice.cost_per_req, baselineSlice.cost_per_req);
  const latencyDelta = pctDelta(currentSlice.latency_ms, baselineSlice.latency_ms);
  const errorDelta = currentSlice.error_rate - baselineSlice.error_rate;
  const names = namedDeltas(currentSlice.by_name, baselineSlice.by_name);
  const hottest = names.shared.reduce<(typeof names.shared)[0] | null>(
    (acc, s) => (!acc || s.latency_delta_pct > acc.latency_delta_pct ? s : acc),
    null,
  );

  const pred = predictionFor.get(sha, sha) as { estimated_cost_delta_pct: number | null } | undefined;
  const predicted = pred?.estimated_cost_delta_pct ?? null;
  const predictionError = predicted == null ? null : costDelta - predicted;

  let verdict: EvaluationVerdict = "ok";
  if (currentSlice.error_rate >= 0.05 && currentSlice.error_rate >= baselineSlice.error_rate * 2) {
    verdict = "error_spike";
  } else if (costDelta >= config.costRegressionPct) verdict = "cost_regression";
  else if (
    latencyDelta >= config.latencyRegressionPct ||
    (hottest != null && hottest.latency_delta_pct >= config.latencyRegressionPct)
  ) {
    verdict = "latency_regression";
  }

  const onset = verdict === "error_spike" ? errorOnset(sha) : null;
  const summary =
    verdict === "error_spike"
      ? `errors ${(currentSlice.error_rate * 100).toFixed(1)}% started after ${(onset?.started_after_sha ?? sha).slice(0, 7)} vs ${baselineRow.sha.slice(0, 7)}`
      : `cost ${costDelta.toFixed(1)}% latency ${latencyDelta.toFixed(1)}% vs ${baselineRow.sha.slice(0, 7)}` +
        (predicted == null ? "" : ` predicted ${predicted}% actual ${costDelta.toFixed(1)}%`);

  upsertEval.run(sha, baselineRow.sha, costDelta, latencyDelta, errorDelta, predicted, predictionError, verdict, summary);
  if (verdict === "ok") setStatus.run("evaluated_ok", sha);
  return {
    sha,
    baseline_sha: baselineRow.sha,
    actual_cost_delta_pct: costDelta,
    actual_latency_delta_pct: latencyDelta,
    error_rate_delta: errorDelta,
    predicted_cost_delta_pct: predicted,
    prediction_error_pp: predictionError,
    verdict,
    summary,
    error_started_after_sha: onset?.started_after_sha ?? null,
    error_previous_ok_sha: onset?.previous_ok_sha ?? null,
    hottest_span: hottest,
    new_spans: names.added,
    current: currentSlice,
    baseline: baselineSlice,
  };
}

export function getEvaluation(sha: string) {
  return db.prepare(`SELECT * FROM evaluations WHERE sha = ?`).get(sha);
}
