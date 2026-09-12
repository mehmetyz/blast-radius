import { config } from "./config.js";
import { cmd } from "./cmd.js";

export const LEDGER_TITLE = "Blast Radius Ledger";
export const LEDGER_TITLES = [LEDGER_TITLE, "Blast Radius ledger", "/blast-radius ledger"];

export const LEDGER_HEADER = [
  "When",
  "SHA",
  "What happened",
  "Predicted vs live",
  "Who",
  "Action",
  "Doc",
];

export type CopySlice = {
  sha: string;
  n: number;
  cost_usd: number;
  cost_per_req: number;
  latency_ms: number;
  error_rate: number;
  latency_kind?: string;
  by_name?: { kind: string; name: string; n: number; latency: number }[];
  by_model?: { model?: string; n?: number; cost?: number }[];
};

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
  commits?: CopyCommit[];
  changes?: CopyChange[];
  files?: string[];
  compareUrl?: string | null;
  deployedAt?: string | null;
  previousSha?: string | null;
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
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
  const t = asDate(d);
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

export function postmortemTitle(d?: string | Date | null): string {
  const t = asDate(d);
  return `Post Mortem - ${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
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

function confWords(n: number): string {
  const c = n <= 1 ? n * 100 : n;
  if (c >= 70) return "high confidence";
  if (c >= 40) return "medium confidence";
  return "low confidence";
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
  return `[${label}](https://github.com/${config.githubRepo}/pull/${n})`;
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

function verdictMark(verdict: string): string {
  if (verdict === "error_spike") return "🚨";
  if (verdict === "latency_regression") return "🟡";
  return "🔴";
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

function headline(input: CopyInput): string {
  const sha7 = shortSha(input.sha);
  const change = primaryChange(input);
  const pr = change ? ` · ${prLink(change.pr_number)}` : "";
  return `${verdictMark(input.verdict)} **${verdictLabel(input.verdict)}** · \`${sha7}\`${pr}`;
}

function moneyLine(input: CopyInput): string {
  if (input.verdict === "error_spike") {
    return `**${errPct(input.baseline.error_rate)} → ${errPct(input.current.error_rate)} errors**`;
  }
  if (input.verdict === "latency_regression") {
    return `**${ms(input.baseline.latency_ms)} → ${ms(input.current.latency_ms)}** (${pct(input.actual_latency_delta_pct)})`;
  }
  const r = ratio(input.current.cost_per_req, input.baseline.cost_per_req);
  const extra = r && r >= 1.2 ? ` (${ratioLabel(r)})` : ` (${pct(input.actual_cost_delta_pct)})`;
  return `**${usd(input.baseline.cost_per_req)} → ${usd(input.current.cost_per_req)} per request**${extra}`;
}

function predictedParagraph(input: CopyInput): string[] {
  if (input.verdict === "error_spike") return [];
  const lines: string[] = [];
  if (input.predicted_cost_delta_pct != null) {
    const miss = Math.abs(input.actual_cost_delta_pct - input.predicted_cost_delta_pct);
    const close = miss <= 20 ? " Close." : "";
    lines.push(
      `I predicted ${pct(input.predicted_cost_delta_pct)} cost on the PR. Actual: ${pct(input.actual_cost_delta_pct)}.${close}`,
    );
  }
  if (input.predicted_latency_delta_pct != null) {
    const faster = input.actual_latency_delta_pct < 0 ? " (faster)" : "";
    lines.push(
      `I predicted ${pct(input.predicted_latency_delta_pct)} latency. Actual: ${pct(input.actual_latency_delta_pct)}${faster}.`,
    );
  }
  return lines;
}

function causeBlock(input: CopyInput): string[] {
  const change = primaryChange(input);
  const commit = primaryCommit(input);
  const suspects = collapseSuspects(input.suspects);
  const top = suspects[0];
  const file = top ? fileFrom(top.reason) : input.files?.[0];
  const model = modelShift(input);
  const lines: string[] = ["**Most likely cause**"];
  if (file) lines.push(`\`${file}\`${model ? ` — model ${model}` : ""}`);
  else if (model) lines.push(`Model ${model}`);
  if (change) {
    const branch =
      change.head && change.base ? ` \`${change.head}\` → \`${change.base}\`` : change.head ? ` \`${change.head}\`` : "";
    lines.push(`${prLink(change.pr_number, change.title)} by ${at(change.author)}${branch}`);
  }
  if (commit) lines.push(`\`${shortSha(commit.sha)}\` ${subject(commit.message)}`);
  if (input.rootCause) lines.push(sentence(input.rootCause));
  if (input.fix) lines.push(`Fix: ${sentence(input.fix)}`);
  if (lines.length === 1) {
    const people = whoCompact(input);
    if (people) lines.push(people);
  }
  return lines;
}

function otherDetails(input: CopyInput): string[] {
  const change = primaryChange(input);
  const primarySha = primaryCommit(input)?.sha;
  const extraCommits = (input.commits ?? []).filter((c) => c.sha !== primarySha);
  const extraChanges = (input.changes ?? []).filter((c) => c.pr_number !== change?.pr_number);
  const extraSuspects = collapseSuspects(input.suspects).slice(1);
  if (!extraCommits.length && !extraChanges.length && !extraSuspects.length) return [];

  const items: string[] = [];
  for (const c of extraChanges) {
    items.push(
      `- ${prLink(c.pr_number, c.title)} by ${at(c.author)}${c.head ? ` (\`${c.head}\`)` : ""}`,
    );
  }
  for (const s of extraSuspects) {
    const file = fileFrom(s.reason);
    const pr = s.pr_number != null ? `#${s.pr_number}` : "";
    items.push(`- ${[pr, at(s.author_login), file ? `\`${file}\`` : "", `(${confWords(s.confidence)})`].filter(Boolean).join(" ")}`);
  }
  for (const c of extraCommits.slice(0, 8)) {
    items.push(`- \`${shortSha(c.sha)}\` ${subject(c.message)} — ${at(c.author)}`);
  }
  if (!items.length) return [];
  return [
    "<details>",
    "<summary>Other changes in this deploy</summary>",
    "",
    ...items,
    "",
    "</details>",
  ];
}

function trafficFooter(input: CopyInput): string {
  const base7 = input.baseline_sha ? `\`${shortSha(input.baseline_sha)}\`` : "the last release";
  const n = input.current.n;
  return `Based on ${n} request${n === 1 ? "" : "s"} since deploy · baseline ${base7}`;
}

function actionCommands(sha: string): string[] {
  const sha7 = shortSha(sha);
  return [cmd("rollback", sha7), cmd("keep", sha7)];
}

export function formatRegressionAlert(input: CopyInput): string {
  const lines = [
    headline(input),
    "",
    moneyLine(input),
    ...predictedParagraph(input),
    input.note ? sentence(input.note) : "",
    "",
    ...causeBlock(input),
    "",
    ...otherDetails(input),
    "",
    trafficFooter(input),
    "",
    ...actionCommands(input.sha),
  ];
  return tidy(lines);
}

export function formatPostmortem(input: CopyInput & { outcome: string }): string {
  const sha7 = shortSha(input.sha);
  const change = primaryChange(input);
  const commit = primaryCommit(input);
  const lines = [
    headline(input),
    "",
    moneyLine(input),
    "",
    ...predictedParagraph(input),
    "",
    "## What shipped",
  ];
  if (change) {
    const branch =
      change.head && change.base
        ? `\`${change.head}\` into \`${change.base}\``
        : change.head
          ? `\`${change.head}\``
          : "";
    lines.push(`${prLink(change.pr_number, change.title)} by ${at(change.author)}${branch ? ` · ${branch}` : ""}`);
  }
  if (commit) {
    lines.push(`Head commit \`${shortSha(commit.sha)}\` — ${subject(commit.message)} (${at(commit.author)})`);
  } else {
    lines.push(`Deploy \`${sha7}\``);
  }
  if (input.commits?.length) {
    lines.push("", "Commits:");
    for (const c of input.commits) {
      lines.push(`- \`${shortSha(c.sha)}\` ${subject(c.message)} — ${at(c.author)}`);
    }
  }
  if (input.files?.length) {
    lines.push("", "Files:");
    for (const f of input.files.slice(0, 12)) lines.push(`- \`${f}\``);
  }
  if (input.compareUrl) lines.push("", `[Diff vs baseline](${input.compareUrl})`);

  lines.push("", "## Traffic", "");
  const base7 = input.baseline_sha ? shortSha(input.baseline_sha) : "baseline";
  lines.push(
    `\`${base7}\` — ${input.baseline.n} requests, ${usd(input.baseline.cost_per_req)}/req, ${ms(input.baseline.latency_ms)}, ${errPct(input.baseline.error_rate)} errors`,
    "",
    `\`${sha7}\` — ${input.current.n} requests, ${usd(input.current.cost_per_req)}/req, ${ms(input.current.latency_ms)}, ${errPct(input.current.error_rate)} errors`,
  );

  lines.push("", "## Cause", "");
  lines.push(...causeBlock(input).filter((l) => l !== "**Most likely cause**"));
  const extras = collapseSuspects(input.suspects).slice(1);
  if (extras.length) {
    lines.push("", "Also involved:");
    for (const s of extras) {
      const file = fileFrom(s.reason);
      const pr = s.pr_number != null ? `#${s.pr_number}` : "";
      lines.push(`- ${[pr, at(s.author_login), file ? `\`${file}\`` : ""].filter(Boolean).join(" ")}`);
    }
  }

  lines.push("", "## Decision", "", decisionLine(input.outcome, sha7, input));
  return tidy(lines);
}

export function formatLedgerRow(input: CopyInput & { outcome: string }): string[] {
  const change = primaryChange(input);
  const commit = primaryCommit(input);
  const what = commit
    ? `${whatHappened(input)} — ${subject(commit.message)}`
    : whatHappened(input);
  return [
    whenStamp(input.deployedAt),
    shortSha(input.sha),
    what,
    predictedVsLive(input),
    whoCompact(input) || "unknown",
    ledgerAction(input.outcome),
    change ? `#${change.pr_number}` : postmortemTitle(input.deployedAt),
  ];
}

function ledgerAction(outcome: string): string {
  const o = outcome.toLowerCase();
  if (o === "awaiting" || o === "open") return "waiting";
  if (o.includes("rollback") && !o.includes("no")) return "rolled back";
  if (o === "timeout") return "no approval";
  if (o === "keep" || o.includes("monitor")) return "kept";
  return outcome;
}

export function formatInsightComment(input: {
  prNumber: number;
  sha: string;
  costPct: number;
  latencyPct: number;
  errorRisk?: string;
  touches: string[];
  authors: string[];
  rationale: string;
  title?: string;
  head?: string;
  base?: string;
}): string {
  const sha7 = shortSha(input.sha);
  const branch =
    input.head && input.base ? ` \`${input.head}\` → \`${input.base}\`` : input.head ? ` \`${input.head}\`` : "";
  const lines = [
    `🔍 **Cost estimate** · \`${sha7}\` · ${prLink(input.prNumber, input.title)}${branch}`,
    "",
    `I think this PR is **${pct(input.costPct)} cost** and **${pct(input.latencyPct)} latency** vs production.`,
  ];
  if (input.errorRisk) lines.push(sentence(input.errorRisk.replace(/^error risk\s+/i, "")));
  if (input.touches.length) lines.push(`Touches ${input.touches.join(", ")}.`);
  if (input.authors.length) lines.push(input.authors.map((a) => at(a)).join("  "));
  if (input.rationale.trim()) lines.push("", input.rationale.trim());
  lines.push("", "After merge I will score this prediction against live traffic.");
  return tidy(lines);
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
  return tidy([headline(input), moneyLine(input), ...predictedParagraph(input), trafficFooter(input)]);
}
