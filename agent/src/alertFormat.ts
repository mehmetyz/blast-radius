import { db } from "./db.js";
import { findMessageByThreadKey, postMessage, updateMessage } from "./ambiguous.js";
import { evaluateDeploy } from "./evaluator.js";
import { getPull, githubCompare, pullsForCommit, type LinkedPr } from "./github.js";
import {
  formatRegressionAlert,
  parsePatch,
  type CopyChange,
  type CopyCommit,
  type CopyInput,
  type CopySuspect,
} from "./copy.js";

export type AlertSuspect = CopySuspect;

const suspectsFor = db.prepare(
  `SELECT rank, pr_number, author_login, confidence, reason FROM suspects WHERE sha = ? ORDER BY rank, id`,
);
const predFor = db.prepare(
  `SELECT estimated_cost_delta_pct, estimated_latency_delta_pct, suspect_hints
     FROM predictions
    WHERE merged_sha = ? OR head_sha = ?
    ORDER BY id DESC LIMIT 1`,
);
const prsForSha = db.prepare(
  `SELECT number, title, author_login FROM pull_requests WHERE head_sha = ? OR merged_sha = ?`,
);
const fixFor = db.prepare(
  `SELECT started_after_sha, root_cause, fix FROM remediations WHERE sha = ?`,
);
const deployFor = db.prepare(
  `SELECT previous_sha, deployed_at, github_compare_url FROM deploys WHERE sha = ?`,
);
const awaitingFor = db.prepare(`SELECT awaiting_at FROM actions WHERE sha = ?`);

export async function loadAlertContext(sha: string, note?: string): Promise<CopyInput | null> {
  const evaln = evaluateDeploy(sha);
  if (!evaln || !("current" in evaln) || !evaln.current || !evaln.baseline) return null;

  const suspects = suspectsFor.all(sha) as AlertSuspect[];
  const pred = predFor.get(sha, sha) as
    | {
        estimated_cost_delta_pct: number | null;
        estimated_latency_delta_pct: number | null;
        suspect_hints: string | null;
      }
    | undefined;
  const fix = fixFor.get(sha) as
    | { started_after_sha: string | null; root_cause: string; fix: string }
    | undefined;
  const deploy = deployFor.get(sha) as
    | { previous_sha: string | null; deployed_at: string; github_compare_url: string | null }
    | undefined;
  const startedAfter =
    (evaln as { error_started_after_sha?: string | null }).error_started_after_sha ??
    fix?.started_after_sha ??
    null;

  const authors = new Set<string>();
  for (const s of suspects) if (s.author_login) authors.add(s.author_login);
  const dbPrs = prsForSha.all(sha, sha) as { number: number; title: string | null; author_login: string | null }[];
  for (const row of dbPrs) if (row.author_login) authors.add(row.author_login);
  if (startedAfter) {
    for (const row of prsForSha.all(startedAfter, startedAfter) as { author_login: string | null }[]) {
      if (row.author_login) authors.add(row.author_login);
    }
  }
  let errorRiskFlags: string[] = [];
  try {
    const hints = pred?.suspect_hints
      ? (JSON.parse(pred.suspect_hints) as { authors?: string[]; error_risks?: string[] })
      : null;
    for (const a of hints?.authors ?? []) authors.add(a);
    errorRiskFlags = (hints?.error_risks ?? []).map((s) => String(s)).filter(Boolean);
  } catch {
    // ignore bad JSON
  }

  let commits: CopyCommit[] = [];
  let files: string[] = [];
  let patches: CopyInput["patches"] = [];
  let compareUrl: string | null = deploy?.github_compare_url ?? null;
  const changesByNumber = new Map<number, CopyChange>();

  if (evaln.baseline_sha) {
    try {
      const cmp = await githubCompare(evaln.baseline_sha, sha);
      compareUrl = cmp.html_url ?? compareUrl;
      commits = cmp.commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.author?.login ?? c.commit.author.name,
      }));
      files = (cmp.files ?? []).map((f) => f.filename);
      patches = (cmp.files ?? []).map((f) => parsePatch(f.filename, f.patch));
      for (const c of commits) if (c.author) authors.add(c.author);
    } catch (err) {
      console.error(`compare ${sha.slice(0, 7)}`, err);
    }
  }

  try {
    const linked = await pullsForCommit(sha);
    for (const p of linked) changesByNumber.set(p.number, toChange(p));
  } catch (err) {
    console.error(`pulls ${sha.slice(0, 7)}`, err);
  }
  for (const row of dbPrs) {
    if (changesByNumber.has(row.number)) continue;
    try {
      changesByNumber.set(row.number, toChange(await getPull(row.number)));
    } catch {
      changesByNumber.set(row.number, {
        pr_number: row.number,
        title: row.title ?? `PR #${row.number}`,
        author: row.author_login ?? "unknown",
        head: "",
        base: "",
      });
    }
  }
  for (const s of suspects) {
    if (s.pr_number == null || changesByNumber.has(s.pr_number)) continue;
    try {
      changesByNumber.set(s.pr_number, toChange(await getPull(s.pr_number)));
    } catch {
      // leave it
    }
  }

  const hottest = (evaln as { hottest_span?: { kind: string; name: string; latency_delta_pct: number } | null })
    .hottest_span;
  const newSpans = (evaln as { new_spans?: { kind: string; name: string }[] }).new_spans ?? [];

  const awaiting = awaitingFor.get(sha) as { awaiting_at: string | null } | undefined;

  return {
    sha: evaln.sha,
    baseline_sha: evaln.baseline_sha,
    verdict: evaln.verdict,
    actual_cost_delta_pct: evaln.actual_cost_delta_pct,
    actual_latency_delta_pct: evaln.actual_latency_delta_pct,
    predicted_cost_delta_pct: evaln.predicted_cost_delta_pct,
    predicted_latency_delta_pct: pred?.estimated_latency_delta_pct ?? null,
    current: evaln.current as CopyInput["current"],
    baseline: evaln.baseline as CopyInput["baseline"],
    suspects,
    authors: [...authors],
    note,
    startedAfter,
    rootCause: fix?.root_cause ?? null,
    fix: fix?.fix ?? null,
    hottestSpan: hottest ?? null,
    newSpans,
    commits,
    changes: [...changesByNumber.values()],
    files,
    patches,
    compareUrl,
    deployedAt: deploy?.deployed_at ?? null,
    previousSha: deploy?.previous_sha ?? evaln.baseline_sha ?? null,
    awaitingAt: awaiting?.awaiting_at ?? null,
    predictionErrorPp: evaln.prediction_error_pp ?? null,
    errorRiskFlags,
  };
}

function toChange(p: LinkedPr): CopyChange {
  return {
    pr_number: p.number,
    title: p.title,
    author: p.author,
    head: p.head,
    base: p.base,
    url: p.html_url,
  };
}

export { formatRegressionAlert };

export async function postFormattedAlert(
  sha: string,
  opts: { startsNewBlock?: boolean; note?: string } = {},
) {
  const input = await loadAlertContext(sha, opts.note);
  if (!input) throw new Error(`cannot format alert for ${sha}`);
  const content = formatRegressionAlert(input);
  const existing = await findMessageByThreadKey(sha);
  if (existing) return updateMessage(existing.id, content);
  try {
    return await postMessage(content, sha, opts.startsNewBlock ?? true);
  } catch {
    return postMessage(content, null, opts.startsNewBlock ?? true);
  }
}
