export type DeployOrigin = "release" | "revert";

export type DeployStatus =
  | "collecting"
  | "evaluated_ok"
  | "alerted"
  | "awaiting_approval"
  | "rolled_back"
  | "monitoring"
  | "insufficient_data"
  | "skipped_revert";

export type EvaluationVerdict =
  | "ok"
  | "cost_regression"
  | "latency_regression"
  | "error_spike";
