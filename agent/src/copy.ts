import { config } from "./config.js";
import { cmd } from "./cmd.js";

export const LEDGER_TITLE = "Blast Radius — Deploy Ledger";
export const LEDGER_TITLES = [
  LEDGER_TITLE,
  "Blast Radius Ledger",
  "Blast Radius ledger",
  "/blast-radius ledger",
];

export const LEDGER_HEADER = [
  "Deploy",
  "Time",
  "PR",
  "Author",
  "Model",
  "Requests",
  "Cost/req",
  "Δ Cost",
  "P95 latency",
  "Δ Latency",
  "Error rate",
  "Verdict",
  "Predicted",
  "Error (pp)",
  "Outcome",
  "Baseline",
];

export type CopySlice = {
  sha: string;
  n: number;
  cost_usd: number;
  cost_per_req: number;
  latency_ms: number;
  latency_p95_ms?: number | null;
  error_rate: number;
  latency_kind?: string;
  by_name?: { kind: string; name: string; n: number; latency: number }[];
  by_model?: { model?: string; n?: number; cost?: number }[];
};

export type CopyPatch = {
  filename: string;
  line?: number;
  added?: string;
  rawPatch?: string;
};

export function parsePatch(filename: string, patch?: string): CopyPatch {
  if (!patch) return { filename };
  let newLine = 0;
  let firstAdded: { line: number; text: string } | undefined;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") && !firstAdded) {
      firstAdded = { line: newLine, text: line.slice(1).trim() };
    }
    if (line.startsWith("-")) continue;
    newLine += 1;
  }
  return {
    filename,
    line: firstAdded?.line,
    added: firstAdded?.text,
    rawPatch: patch,
  };
}

export function trimDiff(patch: string, maxLines = 20): string {
  const lines = patch.split("\n").filter((l) => !l.startsWith("@@"));
  if (lines.length <= maxLines) return lines.join("\n").trim();
  return lines.slice(0, maxLines).join("\n").trim() + `\n... (${lines.length - maxLines} more lines)`;
}

export type CopySuspect = {
  rank: number;
  pr_number?: number | null;
  author_login?: string | null;
  confidence: number;
  reason: string;
};

export type CopyCommit = {
  sha: string;
  message: string;
  author: string;
};

export type CopyChange = {
  pr_number: number;
  title: string;
  author: string;
  head: string;
  base: string;
  url?: string;
};

export type CopyInput = {
  sha: string;
  baseline_sha?: string;
  verdict: string;
  actual_cost_delta_pct: number;
  actual_latency_delta_pct: number;
  predicted_cost_delta_pct: number | null;
  predicted_latency_delta_pct?: number | null;
  current: CopySlice;
  baseline: CopySlice;
  suspects: CopySuspect[];
  authors?: string[];
  note?: string;
  startedAfter?: string | null;
  rootCause?: string | null;
  fix?: string | null;
  hottestSpan?: { kind: string; name: string; latency_delta_pct: number } | null;
  newSpans?: { kind: string; name: string }[];
  outcome?: string;
  errorRiskFlags?: string[];
  commits?: CopyCommit[];
  changes?: CopyChange[];
  files?: string[];
  patches?: CopyPatch[];
  compareUrl?: string | null;
  deployedAt?: string | null;
  previousSha?: string | null;
  awaitingAt?: string | null;
  resolvedAt?: string | null;
  revertSha?: string | null;
  predictionErrorPp?: number | null;
};

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function pct(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  const body = abs >= 100 || Math.abs(abs - Math.round(abs)) < 0.05 ? Math.round(abs).toString() : abs.toFixed(1);
  return `${sign}${body}%`;
}

export function usd(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(4)}`;
  const raw = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `$${raw}`;
}

export function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

export function errPct(n: number): string {
  return `${(n * 100).toFixed(n >= 0.01 ? 1 : 0)}%`;
}

function asDate(input?: string | Date | null): Date {
  if (input instanceof Date) return input;
  if (input) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function whenStamp(d?: string | Date | null): string {
  return utcStamp(d, false);
}

export function utcStamp(d?: string | Date | null, seconds = false): string {
  const iso = asDate(d).toISOString();
  return seconds ? iso.slice(0, 19).replace("T", " ") : iso.slice(0, 16).replace("T", " ");
}

export function utcDate(d?: string | Date | null): string {
  return asDate(d).toISOString().slice(0, 10);
}

export function verdictSlug(verdict: string): string {
  if (verdict === "error_spike") return "error spike";
  if (verdict === "latency_regression") return "latency regression";
  if (verdict === "cost_regression") return "cost regression";
  if (verdict === "skipped_revert") return "skipped revert";
  if (verdict === "insufficient_data") return "insufficient data";
  return verdict.replace(/_/g, " ");
}

export function postmortemTitle(input: {
  sha: string;
  verdict?: string;
  deployedAt?: string | Date | null;
  outcome?: string;
}): string {
  const sha7 = shortSha(input.sha);
  const verdict = verdictSlug(input.verdict || input.outcome || "deploy");
  return `Postmortem — ${sha7} · ${verdict} · ${utcDate(input.deployedAt)}`;
}

function ratio(now: number, then: number): number | null {
  if (!(then > 0) || !Number.isFinite(now / then) || now / then <= 0) return null;
  return now / then;
}

function ratioLabel(r: number): string {
  return `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
}

function sentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function subject(message: string): string {
  return message.split("\n")[0]?.replace(/\s+/g, " ").trim().slice(0, 120) || "(no commit message)";
}

function fileFrom(reason: string): string | null {
  const file = reason.match(/[\w./-]+\.(ts|tsx|js|jsx|json)/);
  return file?.[0] ?? null;
}

function collapseSuspects(suspects: CopySuspect[]): CopySuspect[] {
  const byKey = new Map<string, CopySuspect>();
  const score = (s: CopySuspect) => {
    const file = fileFrom(s.reason) ? 2 : 0;
    const conf = s.confidence <= 1 ? s.confidence * 100 : s.confidence;
    return file * 1000 + conf;
  };
  for (const s of suspects) {
    const key = `${s.pr_number ?? ""}:${(s.author_login ?? "").toLowerCase() || s.reason}`;
    const prev = byKey.get(key);
    if (!prev || score(s) > score(prev)) byKey.set(key, s);
  }
  return [...byKey.values()].sort((a, b) => a.rank - b.rank);
}

function prLink(n: number, title?: string): string {
  const label = title ? `#${n} ${title}` : `#${n}`;
  if (!config.githubRepo) return label;
  return `[${label}](${prHref(n)})`;
}

export function prHref(n: number): string {
  if (!config.githubRepo) return `#${n}`;
  return `https://github.com/${config.githubRepo}/pull/${n}`;
}

function at(login?: string | null): string {
  if (!login) return "unknown";
  return `@${login.replace(/^@/, "")}`;
}

function modelsOf(slice: CopySlice): string[] {
  return [...new Set((slice.by_model ?? []).map((m) => m.model).filter((m): m is string => Boolean(m)))];
}

function modelShift(input: CopyInput): string | null {
  const from = modelsOf(input.baseline);
  const to = modelsOf(input.current);
  if (!from.length && !to.length) return null;
  if (from.join("|") === to.join("|")) return null;
  return `\`${from.join(", ") || "unknown"}\` → \`${to.join(", ") || "unknown"}\``;
}

function primaryChange(input: CopyInput): CopyChange | undefined {
  const suspects = collapseSuspects(input.suspects);
  const prn = suspects[0]?.pr_number ?? input.changes?.[0]?.pr_number;
  if (prn != null) return input.changes?.find((c) => c.pr_number === prn) ?? input.changes?.[0];
  return input.changes?.[0];
}

function primaryCommit(input: CopyInput): CopyCommit | undefined {
  return input.commits?.[input.commits.length - 1] ?? input.commits?.[0];
}

export function verdictLabel(verdict: string): string {
  if (verdict === "error_spike") return "Error spike";
  if (verdict === "latency_regression") return "Latency regression";
  if (verdict === "cost_regression") return "Cost regression";
  return verdict.replace(/_/g, " ");
}

export function whatHappened(input: Pick<
  CopyInput,
  "verdict" | "sha" | "baseline_sha" | "actual_cost_delta_pct" | "actual_latency_delta_pct" | "current" | "baseline" | "startedAfter"
>): string {
  const base7 = input.baseline_sha ? shortSha(input.baseline_sha) : "the last release";
  if (input.verdict === "error_spike") {
    const after = input.startedAfter ? shortSha(input.startedAfter) : base7;
    return `Errors started after ${after} (${errPct(input.current.error_rate)} of requests)`;
  }
  const r = ratio(input.current.cost_per_req, input.baseline.cost_per_req);
  if (input.verdict !== "latency_regression" && r != null && r >= 1.2) {
    return `${ratioLabel(r)} more expensive than ${base7}`;
  }
  if (r != null && r > 0 && r <= 0.8) {
    return `${Math.round((1 - r) * 100)}% cheaper than ${base7}`;
  }
  if (input.verdict === "latency_regression") {
    return `Latency ${pct(input.actual_latency_delta_pct)} vs ${base7}`;
  }
  return `Cost ${pct(input.actual_cost_delta_pct)} vs ${base7}`;
}

export function predictedVsLive(input: Pick<
  CopyInput,
  "predicted_cost_delta_pct" | "predicted_latency_delta_pct" | "actual_cost_delta_pct" | "actual_latency_delta_pct"
>): string {
  const bits: string[] = [];
  if (input.predicted_cost_delta_pct != null) {
    bits.push(`cost predicted ${pct(input.predicted_cost_delta_pct)}, live ${pct(input.actual_cost_delta_pct)}`);
  } else {
    bits.push(`cost ${pct(input.actual_cost_delta_pct)}`);
  }
  if (input.predicted_latency_delta_pct != null) {
    bits.push(`latency predicted ${pct(input.predicted_latency_delta_pct)}, live ${pct(input.actual_latency_delta_pct)}`);
  } else {
    bits.push(`latency ${pct(input.actual_latency_delta_pct)}`);
  }
  return bits.join("; ");
}

export function whoCompact(input: Pick<CopyInput, "authors" | "suspects" | "changes">): string {
  const people = new Set<string>();
  for (const a of input.authors ?? []) if (a) people.add(at(a));
  for (const s of input.suspects) if (s.author_login) people.add(at(s.author_login));
  for (const c of input.changes ?? []) if (c.author) people.add(at(c.author));
  return [...people].join(" ");
}

function tidy(lines: string[]): string {
  return `${lines
    .filter((line, i, arr) => !(line === "" && (i === 0 || arr[i - 1] === "")))
    .join("\n")
    .trim()}\n`;
}

export function alertMark(verdict: string): string {
  if (verdict === "error_spike") return "🚨";
  if (verdict === "latency_regression") return "🟡";
  return "🔴";
}

function alertImpactLines(input: CopyInput): string[] {
  const n = input.current.n;
  const base7 = input.baseline_sha ? `\`${shortSha(input.baseline_sha)}\`` : "the last release";
  if (input.verdict === "error_spike") {
    const failed = Math.round(input.current.error_rate * n);
    const costDrop = pct(input.actual_cost_delta_pct);
    const latDrop = pct(input.actual_latency_delta_pct);
    return [
      `**Errors ${errPct(input.baseline.error_rate)} → ${errPct(input.current.error_rate)}** (${failed} of ${n} requests failed)`,
      `Cost **${costDrop}** · latency **${latDrop}** · baseline ${base7}`,
      "",
      "Failed requests short-circuit before reaching the LLM — that's why cost and latency dropped.",
    ];
  }
  if (input.verdict === "latency_regression") {
    return [
      `**${ms(input.baseline.latency_ms)} → ${ms(input.current.latency_ms)} per request** (${pct(input.actual_latency_delta_pct)})`,
      `Cost ${pct(input.actual_cost_delta_pct)} · errors ${errPct(input.current.error_rate)} · ${n} requests · baseline ${base7}`,
    ];
  }
  const r = ratio(input.current.cost_per_req, input.baseline.cost_per_req);
  const mult = r && r >= 1.2 ? ` (${ratioLabel(r)} more expensive)` : ` (${pct(input.actual_cost_delta_pct)})`;
  return [
    `**${usd(input.baseline.cost_per_req)} → ${usd(input.current.cost_per_req)} per request**${mult}`,
    `Latency **${pct(input.actual_latency_delta_pct)}** · errors ${errPct(input.current.error_rate)} · ${n} requests · baseline ${base7}`,
  ];
}

function changesBlock(input: CopyInput): string[] {
  const patch = pickPatch(input);
  if (!patch) return [];
  const lines: string[] = [`**Changes** — \`${patch.filename}\``];
  if (patch.rawPatch) {
    lines.push("```diff", trimDiff(patch.rawPatch, 18), "```");
  } else if (patch.added) {
    lines.push("```diff", `+ ${patch.added.slice(0, 200)}`, "```");
  }
  const morePatches = (input.patches ?? []).filter((p) => p !== patch && (p.added || p.rawPatch));
  if (morePatches.length) {
    const summary = morePatches
      .slice(0, 3)
      .map((p) => {
        const loc = p.line != null ? `${p.filename}:${p.line}` : p.filename;
        const snippet = p.added ? ` — \`${p.added.slice(0, 80)}\`` : "";
        return `\`${loc}\`${snippet}`;
      })
      .join("; ");
    lines.push(`Also changed: ${summary}.`);
  }
  return lines;
}

function suspectsBlock(input: CopyInput): string[] {
  const change = primaryChange(input);
  const commit = primaryCommit(input);
  const lines: string[] = ["**Suspects**", ""];
  if (change) {
    const author = at(change.author);
    const commitBit = commit ? ` · commit \`${shortSha(commit.sha)}\`` : "";
    lines.push(`**${prLink(change.pr_number, change.title)}** by ${author}${commitBit}`);
    if (commit?.message) lines.push(`> ${subject(commit.message)}`);
  } else if (commit) {
    lines.push(`Commit \`${shortSha(commit.sha)}\` by ${at(commit.author)}`);
    if (commit.message) lines.push(`> ${subject(commit.message)}`);
  } else {
    const people = whoCompact(input);
    lines.push(people || "No PR or commit yet — compare still loading.");
  }
  const chg = changesBlock(input);
  if (chg.length) {
    lines.push("");
    lines.push(...chg);
  }
  return lines;
}

function awaitingHumanBlock(sha: string, previousSha?: string | null): string[] {
  const sha7 = shortSha(sha);
  const prev = previousSha ? `\`${shortSha(previousSha)}\`` : "the previous release";
  return [
    "**Reply in this channel:**",
    `- \`${cmd("rollback", sha7)}\` — revert to ${prev}`,
    `- \`${cmd("keep", sha7)}\` — accept and keep watching`,
    `- \`${cmd("status", sha7)}\` — fresh numbers`,
    "",
    "Nothing rolls back until you say so.",
  ];
}

export function formatRegressionAlert(input: CopyInput): string {
  const sha7 = shortSha(input.sha);
  const lines = [
    `${alertMark(input.verdict)} **${verdictLabel(input.verdict)}** · \`${sha7}\``,
    "",
    ...alertImpactLines(input),
    "",
    ...suspectsBlock(input),
    "",
    ...awaitingHumanBlock(input.sha, input.baseline_sha ?? input.previousSha),
  ];
  return tidy(lines);
}

export function formatPostmortem(input: CopyInput & { outcome: string }): string {
  const sha7 = shortSha(input.sha);
  const change = primaryChange(input);
  const detected = utcStamp(input.awaitingAt ?? input.deployedAt, true);
  const resolvedDate = asDate(input.resolvedAt ?? new Date());
  const detectedDate = asDate(input.awaitingAt ?? input.deployedAt);
  const resolved =
    resolvedDate.toISOString().slice(0, 10) === detectedDate.toISOString().slice(0, 10)
      ? `${resolvedDate.toISOString().slice(11, 16)} UTC`
      : `${utcStamp(resolvedDate, false)} UTC`;
  const pr = change ? `#${change.pr_number}` : "—";
  const author = change?.author ? at(change.author) : whoCompact(input) || "unknown";

  const lines = [
    `# Postmortem — ${verdictSlug(input.verdict)} · \`${sha7}\``,
    "",
    `**Deploy:** \`${sha7}\` · **PR:** ${pr} · **Author:** ${author}`,
    `**Detected:** ${detected} UTC · **Resolved:** ${resolved}`,
    `**Impact:** ${impactLine(input)}`,
    "",
    "## Summary",
    postmortemSummary(input),
    "",
    "## Timeline",
    "| Time | Event |",
    "|---|---|",
    ...timelineRows(input),
    "",
    "## Root cause",
    rootCauseLine(input),
    "",
    "## Detection",
    detectionLine(input),
    "",
    "## Resolution",
    resolutionLine(input),
    "",
    "## Prediction accuracy",
    predictionAccuracyLine(input),
    "",
    "## Action items",
    ...actionItems(input),
  ];
  return tidy(lines);
}

export type LedgerFacts = {
  sha: string;
  deployedAt?: string | null;
  pr?: string;
  author?: string;
  model?: string;
  requests?: number;
  costPerReq?: number | null;
  deltaCost?: number | null;
  p95?: number | null;
  deltaLatency?: number | null;
  errorRate?: number | null;
  verdict: string;
  predicted?: number | null;
  errorPp?: number | null;
  outcome: string;
  baseline?: string | null;
};

function costCell(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export function dominantModel(slice?: CopySlice): string {
  const models = [...(slice?.by_model ?? [])].sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  const raw = models[0]?.model ?? "";
  return raw.replace(/^openai\//, "");
}

export function ledgerOutcome(outcome: string): string {
  const o = outcome.toLowerCase();
  if (o.includes("rollback") && !o.includes("no")) return "rolled_back";
  if (o === "keep" || o.includes("monitor")) return "kept";
  if (o === "timeout") return "timeout";
  if (o === "ok" || o === "evaluated_ok") return "ok";
  if (o.includes("skip")) return "skipped_revert";
  if (o.includes("insufficient")) return "insufficient_data";
  if (o === "awaiting" || o === "open" || o === "alerted") return "awaiting";
  return o.replace(/\s+/g, "_");
}

export function formatLedgerFacts(f: LedgerFacts): string[] {
  return [
    shortSha(f.sha),
    f.deployedAt ? utcStamp(f.deployedAt, false) : "",
    f.pr ?? "",
    f.author ?? "",
    f.model ?? "",
    f.requests != null ? String(f.requests) : "",
    f.costPerReq != null && Number.isFinite(f.costPerReq) ? costCell(f.costPerReq) : "",
    f.deltaCost != null && Number.isFinite(f.deltaCost) ? pct(f.deltaCost) : "",
    f.p95 != null && Number.isFinite(f.p95) ? String(Math.round(f.p95)) : "",
    f.deltaLatency != null && Number.isFinite(f.deltaLatency) ? pct(f.deltaLatency) : "",
    f.errorRate != null && Number.isFinite(f.errorRate) ? errPct(f.errorRate) : "",
    f.verdict || "",
    f.predicted != null && Number.isFinite(f.predicted) ? pct(f.predicted) : "",
    f.errorPp != null && Number.isFinite(f.errorPp) ? String(Math.round(f.errorPp)) : "",
    ledgerOutcome(f.outcome),
    f.baseline ? shortSha(f.baseline) : "",
  ];
}

export function formatLedgerRow(input: CopyInput & { outcome: string }): string[] {
  const change = primaryChange(input);
  const login = change?.author || input.authors?.[0] || "";
  const predicted = input.predicted_cost_delta_pct;
  const errorPp =
    input.predictionErrorPp ??
    (predicted != null ? input.actual_cost_delta_pct - predicted : null);
  return formatLedgerFacts({
    sha: input.sha,
    deployedAt: input.deployedAt,
    pr: change ? prHref(change.pr_number) : "",
    author: login ? at(login) : "",
    model: dominantModel(input.current),
    requests: input.current.n,
    costPerReq: input.current.cost_per_req,
    deltaCost: input.actual_cost_delta_pct,
    p95: input.current.latency_p95_ms ?? input.current.latency_ms,
    deltaLatency: input.actual_latency_delta_pct,
    errorRate: input.current.error_rate,
    verdict: input.verdict,
    predicted,
    errorPp,
    outcome: input.outcome,
    baseline: input.baseline_sha ?? input.previousSha,
  });
}

function predictionAccuracyLine(input: CopyInput): string {
  const predicted = input.predicted_cost_delta_pct;
  if (input.verdict === "error_spike") {
    const flags = (input.errorRiskFlags ?? []).filter(Boolean);
    const actual = errPct(input.current.error_rate);
    if (flags.length) {
      const flagLine = flags.map((f) => `\`${f.slice(0, 80)}\``).join("; ");
      return `INSIGHT flagged error-handling risk: ${flagLine}. Actual error rate: ${actual}.`;
    }
    return `INSIGHT did not flag error risk on the PR. Actual error rate: ${actual}.`;
  }
  if (input.verdict === "latency_regression") {
    const predL = input.predicted_latency_delta_pct;
    const actualL = pct(input.actual_latency_delta_pct);
    return predL != null
      ? `Predicted latency ${pct(predL)} · Actual ${actualL}.`
      : `No latency prediction for this SHA. Actual latency ${actualL}.`;
  }
  if (predicted == null) return "No INSIGHT prediction for this SHA.";
  const errorPp =
    input.predictionErrorPp ??
    input.actual_cost_delta_pct - predicted;
  return `Predicted ${pct(predicted)} · Actual ${pct(input.actual_cost_delta_pct)} · Error ${Math.round(errorPp)}pp`;
}

function impactLine(input: CopyInput): string {
  const n = input.current.n;
  const over = `over ${n} request${n === 1 ? "" : "s"}`;
  if (input.verdict === "error_spike") {
    return `error rate ${errPct(input.baseline.error_rate)} → ${errPct(input.current.error_rate)} ${over}`;
  }
  if (input.verdict === "latency_regression") {
    const from = input.baseline.latency_p95_ms ?? input.baseline.latency_ms;
    const to = input.current.latency_p95_ms ?? input.current.latency_ms;
    return `p95 ${ms(from)} → ${ms(to)} (${pct(input.actual_latency_delta_pct)}) ${over}`;
  }
  return `cost/request ${usd(input.baseline.cost_per_req)} → ${usd(input.current.cost_per_req)} (${pct(input.actual_cost_delta_pct)}) ${over}`;
}

function postmortemSummary(input: CopyInput & { outcome: string }): string {
  const sha7 = shortSha(input.sha);
  const change = primaryChange(input);
  const pr = change ? ` (PR #${change.pr_number})` : "";
  const base = input.baseline_sha ? `\`${shortSha(input.baseline_sha)}\`` : "the previous release";
  const end = decisionLine(input.outcome, sha7, input);
  return `Deploy \`${sha7}\`${pr} was a ${verdictSlug(input.verdict)} vs ${base}. ${impactLine(input)}. ${end}`;
}

function timelineRows(input: CopyInput & { outcome: string }): string[] {
  const sha7 = shortSha(input.sha);
  const change = primaryChange(input);
  const deployT = utcStamp(input.deployedAt, false);
  const detectT = utcStamp(input.awaitingAt ?? input.deployedAt, false);
  const resolveT = utcStamp(input.resolvedAt ?? new Date(), false);
  const pred =
    input.predicted_cost_delta_pct != null ? ` (INSIGHT predicted ${pct(input.predicted_cost_delta_pct)})` : "";
  const rows = [
    `| ${deployT} | ${change ? `PR #${change.pr_number} merged${pred}` : `Deploy \`${sha7}\` recorded${pred}`} |`,
    `| ${deployT} | Deploy \`${sha7}\` live |`,
    `| ${detectT} | Threshold breached after ${input.current.n} requests |`,
    `| ${detectT} | Alert posted, approval requested |`,
  ];
  const o = input.outcome.toLowerCase();
  if (o.includes("rollback") && !o.includes("no")) {
    const who = change?.author ? at(change.author) : "human";
    rows.push(`| ${resolveT} | Rollback approved by ${who} |`);
    const revert = input.revertSha ? `\`${shortSha(input.revertSha)}\`` : "revert commit";
    rows.push(`| ${resolveT} | Revert ${revert} deployed |`);
  } else if (o === "timeout") {
    rows.push(`| ${resolveT} | No approval in time — kept watching, no rollback |`);
  } else {
    rows.push(`| ${resolveT} | Keep command — no rollback |`);
  }
  return rows;
}

function rootCauseLine(input: CopyInput): string {
  const patch = pickPatch(input);
  const model = modelShift(input);
  const commit = primaryCommit(input);
  const bits: string[] = [];
  if (patch?.line != null) {
    bits.push(`\`${patch.filename}:${patch.line}\`${patch.added ? ` \`${patch.added.slice(0, 120)}\`` : ""}`);
  } else if (patch) {
    bits.push(`\`${patch.filename}\``);
  } else if (input.files?.[0]) {
    bits.push(`\`${input.files[0]}\``);
  }
  if (model) bits.push(`model ${model}`);
  if (commit) bits.push(`\`${shortSha(commit.sha)}\` ${subject(commit.message)}`);
  if (input.rootCause) bits.push(sentence(input.rootCause));
  return bits.join(" — ") || "No single file stood out in the compare.";
}

function pickPatch(input: CopyInput): CopyPatch | undefined {
  const patches = input.patches ?? [];
  const scored = [...patches].sort((a, b) => scorePatch(b) - scorePatch(a));
  return scored[0];
}

function scorePatch(p: CopyPatch): number {
  const f = p.filename.toLowerCase();
  let n = 0;
  if (f.includes("chat") || f.includes("route")) n += 5;
  if (p.added?.toLowerCase().includes("gpt") || p.added?.toLowerCase().includes("model")) n += 4;
  if (p.line != null) n += 1;
  return n;
}

function detectionLine(input: CopyInput): string {
  const n = input.current.n;
  const min = config.minRequests;
  const base = input.baseline_sha ? `\`${shortSha(input.baseline_sha)}\`` : "baseline";
  if (input.verdict === "error_spike") {
    return `Error rate ${errPct(input.current.error_rate)} vs ${base} after ${n} requests (threshold 5% and 2× baseline, min ${min} requests).`;
  }
  if (input.verdict === "latency_regression") {
    return `Latency ${pct(input.actual_latency_delta_pct)} vs ${base} after ${n} requests (threshold ${pct(config.latencyRegressionPct)}, min ${min} requests).`;
  }
  return `Cost/request ${pct(input.actual_cost_delta_pct)} vs ${base} after ${n} requests (threshold ${pct(config.costRegressionPct)}, min ${min} requests).`;
}

function resolutionLine(input: CopyInput & { outcome: string }): string {
  const sha7 = shortSha(input.sha);
  const o = input.outcome.toLowerCase();
  if (o.includes("rollback") && !o.includes("no")) {
    const prev = input.previousSha ? `\`${shortSha(input.previousSha)}\`` : "the previous release";
    const revert = input.revertSha ? ` Revert \`${shortSha(input.revertSha)}\`.` : "";
    return `Human posted \`${cmd("rollback", sha7)}\`. Rolled back to ${prev}.${revert} Rollback is never automatic.`;
  }
  if (o === "timeout") {
    return `No command in ${config.pollMinutes} min. I did not roll back. Still watching \`${sha7}\`.`;
  }
  return `Human posted \`${cmd("keep", sha7)}\`. No rollback. Still watching \`${sha7}\`.`;
}

function actionItems(input: CopyInput): string[] {
  const owner = primaryChange(input)?.author
    ? at(primaryChange(input)!.author)
    : input.authors?.[0]
      ? at(input.authors[0])
      : "@owner";
  if (input.verdict === "error_spike") {
    return [`- [ ] Fail closed on 5xx before full traffic — ${owner}`];
  }
  if (input.verdict === "latency_regression") {
    return [`- [ ] Cap max_tokens and extra completion passes on /api/chat — ${owner}`];
  }
  return [`- [ ] Block unreviewed production model bumps — ${owner}`];
}

export type InsightCommentInput = {
  prNumber: number;
  sha: string;
  costPct: number;
  latencyPct: number;
  costWhy?: string;
  endpointRisks?: string[];
  errorRisks?: string[];
  promptRisks?: string[];
  errorRisk?: string;
  touches: string[];
  authors: string[];
  rationale: string;
  title?: string;
  head?: string;
  base?: string;
  primaryPatch?: { filename: string; rawPatch?: string };
};

function riskEmoji(magnitude: "high" | "medium" | "low" | "none"): string {
  if (magnitude === "high") return "🔴";
  if (magnitude === "medium") return "🟡";
  if (magnitude === "low") return "🟢";
  return "⚪";
}

function costRisk(pctVal: number): "high" | "medium" | "low" {
  const abs = Math.abs(pctVal);
  if (abs >= 100) return "high";
  if (abs >= 20) return "medium";
  return "low";
}

function latencyRisk(pctVal: number): "high" | "medium" | "low" {
  const abs = Math.abs(pctVal);
  if (abs >= 50) return "high";
  if (abs >= 15) return "medium";
  return "low";
}

export function formatInsightComment(input: InsightCommentInput): string {
  const sha7 = shortSha(input.sha);
  const branch =
    input.head && input.base ? ` \`${input.head}\` → \`${input.base}\`` : input.head ? ` \`${input.head}\`` : "";
  const errors = input.errorRisks?.length
    ? input.errorRisks
    : input.errorRisk
      ? [input.errorRisk.replace(/^error risk\s+/i, "")]
      : [];
  const endpoints = input.endpointRisks ?? [];
  const prompts = input.promptRisks ?? [];

  const errorMag = errors.length ? "high" : "low";
  const promptMag = prompts.length ? "medium" : "low";

  const lines: string[] = [
    `🔍 **INSIGHT** · pre-merge analysis of \`${sha7}\` · ${prLink(input.prNumber, input.title)}${branch}`,
    "",
    `**Expected cost:** **${pct(input.costPct)}** per request (deterministic, from price table)`,
    `**Expected latency:** ${pct(input.latencyPct)} (LLM class estimate)`,
    `**Expected errors:** ${errors.length ? "increase likely — see below" : "unchanged"}`,
  ];

  if (input.primaryPatch?.rawPatch) {
    lines.push(
      "",
      `**Changes** — \`${input.primaryPatch.filename}\``,
      "```diff",
      trimDiff(input.primaryPatch.rawPatch, 18),
      "```",
    );
  }

  lines.push("", "**Risk flags**");
  lines.push(
    `- ${riskEmoji(costRisk(input.costPct))} **Cost** — ${input.costWhy ? sentence(input.costWhy) : `${pct(input.costPct)} per request from price table.`}`,
  );
  lines.push(
    `- ${riskEmoji(latencyRisk(input.latencyPct))} **Latency** — ${
      endpoints.length ? endpoints.map((r) => sentence(r)).join(" ") : `${pct(input.latencyPct)} estimated.`
    }`,
  );
  lines.push(
    `- ${riskEmoji(errorMag)} **Errors** — ${errors.length ? errors.map((r) => sentence(r)).join(" ") : "no new failure paths detected."}`,
  );
  if (prompts.length) {
    lines.push(`- ${riskEmoji(promptMag)} **Prompt** — ${prompts.map((r) => sentence(r)).join(" ")}`);
  }

  if (input.touches.length) lines.push("", `Touches ${input.touches.join(", ")}.`);
  if (input.authors.length) lines.push(input.authors.map((a) => at(a)).join("  "));
  if (input.rationale.trim()) lines.push("", input.rationale.trim());
  lines.push("", "I'll score this prediction against live traffic after merge.");
  return tidy(lines);
}

export function formatInsightChannel(input: {
  prNumber: number;
  sha: string;
  costPct: number;
  latencyPct: number;
  title?: string;
  errorRisks?: string[];
  endpointRisks?: string[];
}): string {
  const sha7 = shortSha(input.sha);
  const risk = input.errorRisks?.[0] || input.endpointRisks?.[0];
  return tidy([
    `🔍 **INSIGHT** · \`${sha7}\` · ${prLink(input.prNumber, input.title)}`,
    `Deterministic cost **${pct(input.costPct)}**. Latency estimate **${pct(input.latencyPct)}**.`,
    risk ? sentence(risk) : "",
    "PR comment has the three-tier breakdown. I will score cost against live traffic after merge.",
  ]);
}

export function decisionLine(outcome: string, sha7: string, input?: CopyInput): string {
  const o = outcome.toLowerCase();
  const prev = input?.previousSha ? `\`${shortSha(input.previousSha)}\`` : "the previous release";
  if (o === "awaiting" || o === "open") {
    return `Waiting on a human. Type \`${cmd("rollback", sha7)}\` or \`${cmd("keep", sha7)}\`. I will not roll back on my own.`;
  }
  if (o.includes("rollback") && !o.includes("no rollback")) {
    return `↩️ Rolled back \`${sha7}\` → ${prev}. The revert itself is not evaluated.`;
  }
  if (o === "timeout") {
    return `⏱️ No approval in time. I did not roll back. Still watching \`${sha7}\`.`;
  }
  if (o === "keep" || o.includes("no rollback") || o.includes("monitoring")) {
    return `👀 Kept \`${sha7}\`. No rollback. Still watching.`;
  }
  if (o.includes("skip")) return sentence(outcome);
  return sentence(outcome);
}

export function formatKeepReply(
  sha: string,
  opts: { why: string; minutes?: number; people?: string[] } = { why: "keep" },
): string {
  const sha7 = shortSha(sha);
  const who = (opts.people ?? []).filter(Boolean).map(at).join(" ");
  if (opts.why === "timeout") {
    const mins = opts.minutes ?? 15;
    return tidy([
      `⏱️ No approval in ${mins} min. **I did not roll back.**`,
      `Still watching \`${sha7}\`${who ? ` · task for ${who}` : " · task created"}.`,
    ]);
  }
  return tidy([
    `👀 **Keeping it** — no rollback.`,
    `Still watching \`${sha7}\`${who ? ` · ${who}` : ""}.`,
  ]);
}

export function formatRollbackReply(
  sha: string,
  opts: { ok: boolean; previousSha?: string | null; revertSha?: string | null; detail?: string; approvedBy?: string | null },
): string {
  const sha7 = shortSha(sha);
  if (opts.ok) {
    const to = opts.previousSha ? `\`${shortSha(opts.previousSha)}\`` : "the previous release";
    const who = opts.approvedBy ? ` — approved by ${opts.approvedBy}` : "";
    return tidy([
      `↩️ **Rolled back**${who}`,
      `\`${sha7}\` → ${to}. That revert is not evaluated.`,
    ]);
  }
  return tidy([
    `↩️ **Rollback skipped**`,
    sentence(opts.detail || "I did not touch production."),
    `You can still \`${cmd("keep", sha7)}\` if you want to keep watching.`,
  ]);
}

export function formatStatusReply(sha: string, input: CopyInput | null, fallback: string): string {
  if (!input) return tidy([sentence(fallback)]);
  const sha7 = shortSha(sha);
  return tidy([
    `${alertMark(input.verdict)} **${verdictLabel(input.verdict)}** · \`${sha7}\``,
    "",
    ...alertImpactLines(input),
  ]);
}
