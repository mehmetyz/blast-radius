import { db } from "./db.js";
import { findMessageByThreadKey, listMessages, postMessage, updateMessage } from "./ambiguous.js";
import { evaluateDeploy, listErrors } from "./evaluator.js";
import { getPull, githubCompare, pullsForCommit, type LinkedPr } from "./github.js";
import { analyzeDeployCommits, loadCommitAnalysis, type CommitClassification } from "./commitAnalysis.js";
import {
  formatRegressionAlert,
  parsePatch,
  relevantCategories,
  verdictLabel,
  type CopyChange,
  type CopyCommit,
  type CopyInput,
  type CopySuspect,
} from "./copy.js";

export type AlertSuspect = CopySuspect;

const suspectsFor = db.prepare(
  `SELECT rank, pr_number, commit_sha, author_login, confidence, reason FROM suspects WHERE sha = ? ORDER BY rank, id`,
);
const predFor = db.prepare(
  `SELECT estimated_cost_delta_pct, estimated_latency_delta_pct, suspect_hints
     FROM predictions
    WHERE merged_sha = ? OR head_sha = ?
    ORDER BY id DESC LIMIT 1`,
);
const predForPr = db.prepare(
  `SELECT estimated_cost_delta_pct, estimated_latency_delta_pct, suspect_hints
     FROM predictions
    WHERE pr_number = ?
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

  let suspects = suspectsFor.all(sha) as AlertSuspect[];
  let pred = predFor.get(sha, sha) as
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
      commits = cmp.commits
        .filter((c) => !/^(Merge( pull request)? |Revert )/i.test(c.commit.message))
        .map((c) => ({
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
  // Direct-push deploys have no PR on the deploy sha — also look up PRs of the
  // compare commits so a deploy of PR commits is linked to its PR.
  for (const c of (commits ?? []).slice(0, 4)) {
    try {
      const linked = await pullsForCommit(c.sha);
      for (const p of linked) changesByNumber.set(p.number, toChange(p));
    } catch {
      // PR lookup for a compare commit failed — not fatal
    }
  }
  // Same for the INSIGHT prediction: direct-push deploys have no prediction on
  // the sha itself, but the PR's prediction still belongs to this deploy.
  if (!pred && changesByNumber.size) {
    const firstPr = [...changesByNumber.keys()].sort((a, b) => a - b)[0];
    if (firstPr != null) pred = predForPr.get(firstPr) as typeof pred | undefined;
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

  if (evaln.baseline_sha) {
    try {
      await analyzeDeployCommits(sha, evaln.baseline_sha);
    } catch (err) {
      console.error(`commit analysis ${sha.slice(0, 7)}`, err);
    }
  }
  const commitAnalysis: CommitClassification[] = loadCommitAnalysis(sha);

  // Error evidence: aggregate the actual failure messages for the alert,
  // counting distinct requests (an http + llm span pair is one failed request).
  let errorLog: { message: string; count: number }[] = [];
  if (evaln.verdict === "error_spike") {
    const reqsByMsg = new Map<string, Set<string>>();
    for (const row of listErrors(sha) as { error_message: string | null; request_id: string | null }[]) {
      const msg = (row.error_message ?? "unknown error").slice(0, 140);
      const set = reqsByMsg.get(msg) ?? new Set<string>();
      set.add(row.request_id ?? `anon-${set.size}`);
      reqsByMsg.set(msg, set);
    }
    errorLog = [...reqsByMsg.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 5)
      .map(([message, set]) => ({ message, count: set.size }));
  }

  // Deterministic blame: for EVERY distinct error message, the commit whose
  // message or DIFF matches it leads the suspect list — the LLM's ranking must
  // not override the evidence. Diff matching catches vague messages like
  // "handle special orders" whose diff adds the failing code.
  if (evaln.verdict === "error_spike" && errorLog.length) {
    const prepend: AlertSuspect[] = [];
    const seen = new Set<string>();
    for (const entry of errorLog.slice(0, 3)) {
      const matched = matchCommitToError(commitAnalysis, entry.message);
      if (!matched) continue;
      const key = matched.sha.slice(0, 7);
      if (seen.has(key)) continue;
      seen.add(key);
      const llmMatch = suspects.find(
        (s) => s.commit_sha && s.commit_sha.slice(0, 7) === key,
      );
      prepend.push({
        rank: 0,
        pr_number: null,
        commit_sha: matched.sha,
        author_login: matched.author_login,
        confidence: 0.95,
        reason: llmMatch?.reason ?? `${matched.message} — matches the error log`,
      });
    }
    if (prepend.length) {
      const prependKeys = new Set(prepend.map((p) => p.commit_sha!.slice(0, 7)));
      suspects = [
        ...prepend,
        ...suspects.filter((s) => !s.commit_sha || !prependKeys.has(s.commit_sha.slice(0, 7))),
      ];
    }
  }

  // Error log ↔ commit pairs for the alert table (each log row carries its
  // matched commit — diff-based when the message is vague).
  const errorPairs =
    evaln.verdict === "error_spike"
      ? errorLog.map((entry) => {
          const matched = matchCommitToError(commitAnalysis, entry.message);
          return {
            error: entry.message,
            commit_sha: matched?.sha ?? null,
            message: matched?.message ?? "",
            author: matched?.author_login ?? null,
          };
        })
      : [];

  // Keep only genuinely suspicious commits: drop docs/refactor filler and commits
  // whose category cannot explain this verdict. Dedupe by commit.
  {
    const relevant = relevantCategories(evaln.verdict);
    const catBySha = new Map(commitAnalysis.map((c) => [c.sha.slice(0, 7), c.category]));
    const seenSha = new Set<string>();
    const filtered: AlertSuspect[] = [];
    for (const s of suspects) {
      const key = s.commit_sha ? s.commit_sha.slice(0, 7) : "";
      if (key && seenSha.has(key)) continue;
      if (s.rank === 0) {
        // Deterministic evidence-backed blame — never filtered by category.
        seenSha.add(key);
        filtered.push(s);
        continue;
      }
      const cat = key ? catBySha.get(key) : undefined;
      if (cat && !relevant.includes(cat)) continue;
      if (!cat && (!s.commit_sha || s.confidence < 0.7)) continue;
      seenSha.add(key);
      filtered.push(s);
      if (filtered.length >= 4) break;
    }
    suspects = filtered;
  }

  return {
    sha: evaln.sha,
    baseline_sha: evaln.baseline_sha,
    verdict: evaln.verdict,
    actual_cost_delta_pct: evaln.actual_cost_delta_pct,
    actual_latency_delta_pct: evaln.actual_latency_delta_pct,
    predicted_cost_delta_pct: evaln.predicted_cost_delta_pct ?? pred?.estimated_cost_delta_pct ?? null,
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
    errorLog,
    errorPairs,
    commitAnalysis,
  };
}

const STOP_WORDS = new Set(["order", "orders", "request", "requests", "failed", "error", "the", "and", "for"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOP_WORDS.has(t));
}

function matchCommitToError(
  analysis: CommitClassification[],
  message: string,
): CommitClassification | undefined {
  // The error may match the commit MESSAGE or — when the message is vague — the
  // commit DIFF (the bug lives in the diff, not in the message).
  const tokens = tokenize(message);
  let best: CommitClassification | undefined;
  let bestScore = 0;
  for (const c of analysis) {
    const messageTokens = new Set(tokenize(c.message));
    const diffTokens = new Set(tokenize(c.diff_blob ?? ""));
    let score = 0;
    for (const t of tokens) {
      if (diffTokens.has(t)) score += 2;
      else if (messageTokens.has(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 2 ? best : undefined;
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
  if (existing) {
    // Same verdict → update in place. Different verdict (re-evaluation) →
    // preserve the previous alert and use the verdict's own thread block.
    const sameVerdict = (existing.content ?? "").includes(verdictLabel(input.verdict));
    if (sameVerdict) return updateMessage(existing.id, content);
    const verdictKey = `${sha}-${input.verdict}`;
    const verdictMsg = (await listMessages(100)).find((m) => m.thread_key === verdictKey);
    if (verdictMsg) return updateMessage(verdictMsg.id, content);
    try {
      return await postMessage(content, verdictKey, opts.startsNewBlock ?? true);
    } catch {
      return postMessage(content, null, opts.startsNewBlock ?? true);
    }
  }
  try {
    return await postMessage(content, sha, opts.startsNewBlock ?? true);
  } catch {
    return postMessage(content, null, opts.startsNewBlock ?? true);
  }
}
