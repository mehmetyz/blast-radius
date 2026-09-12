import { config } from "./config.js";
import { db } from "./db.js";
import type { EvaluationVerdict } from "./types.js";

const statsSql = db.prepare(`
  SELECT count(*) AS n,
         coalesce(sum(cost_usd), 0) AS cost,
         coalesce(avg(latency_ms), 0) AS latency,
         coalesce(avg(error), 0) AS error_rate
  FROM telemetry WHERE sha = ?
`);

const getDeploy = db.prepare(`SELECT * FROM deploys WHERE sha = ?`);
const previousRelease = db.prepare(`
  SELECT * FROM deploys
  WHERE origin = 'release' AND sha != ? AND request_count >= ?
  ORDER BY deployed_at DESC LIMIT 1
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

type Stats = { n: number; cost: number; latency: number; error_rate: number };

function stats(sha: string): Stats {
  return statsSql.get(sha) as Stats;
}

function pctDelta(now: number, then: number): number {
  if (then === 0) return now === 0 ? 0 : 100;
  return ((now - then) / then) * 100;
}

export function summarizeTelemetry(sha: string) {
  const s = stats(sha);
  const per = s.n ? s.cost / s.n : 0;
  return { sha, n: s.n, cost_usd: s.cost, cost_per_req: per, latency_ms: s.latency, error_rate: s.error_rate };
}

export function evaluateDeploy(sha: string) {
  const deploy = getDeploy.get(sha) as { sha: string; origin: string; request_count: number; previous_sha: string | null } | undefined;
  if (!deploy || deploy.origin === "revert") return null;
  if (deploy.request_count < config.minRequests) return null;

  const current = stats(sha);
  const baselineRow = previousRelease.get(sha, config.minRequests) as { sha: string } | undefined;
  if (!baselineRow) {
    setStatus.run("evaluated_ok", sha);
    upsertEval.run(sha, null, 0, 0, 0, null, null, "ok", "no baseline with enough traffic");
    return { sha, verdict: "ok" as EvaluationVerdict, skipped: true };
  }

  const base = stats(baselineRow.sha);
  const curPer = current.n ? current.cost / current.n : 0;
  const basePer = base.n ? base.cost / base.n : 0;
  const costDelta = pctDelta(curPer, basePer);
  const latencyDelta = pctDelta(current.latency, base.latency);
  const errorDelta = current.error_rate - base.error_rate;

  const pred = predictionFor.get(sha, sha) as { estimated_cost_delta_pct: number | null } | undefined;
  const predicted = pred?.estimated_cost_delta_pct ?? null;
  const predictionError = predicted == null ? null : costDelta - predicted;

  let verdict: EvaluationVerdict = "ok";
  if (current.error_rate >= 0.05 && current.error_rate >= base.error_rate * 2) verdict = "error_spike";
  else if (costDelta >= config.costRegressionPct) verdict = "cost_regression";
  else if (latencyDelta >= config.latencyRegressionPct) verdict = "latency_regression";

  const summary = `cost ${costDelta.toFixed(1)}% latency ${latencyDelta.toFixed(1)}% vs ${baselineRow.sha.slice(0, 7)}` +
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
    current: summarizeTelemetry(sha),
    baseline: summarizeTelemetry(baselineRow.sha),
  };
}

export function getEvaluation(sha: string) {
  return db.prepare(`SELECT * FROM evaluations WHERE sha = ?`).get(sha);
}
