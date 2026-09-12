import { createHash } from "node:crypto";
import { loadAlertContext } from "./alertFormat.js";
import {
  appendSheetValues,
  getSheetRange,
  patchSheetCells,
  renameDocument,
  updateDocument,
  createDocument,
} from "./ambiguous.js";
import { config } from "./config.js";
import {
  LEDGER_HEADER,
  LEDGER_TITLE,
  dominantModel,
  formatLedgerFacts,
  formatPostmortem,
  ledgerOutcome,
  postmortemTitle,
  prHref,
  type LedgerFacts,
} from "./copy.js";
import { db } from "./db.js";
import { summarizeTelemetry } from "./evaluator.js";

const getAction = db.prepare(`SELECT * FROM actions WHERE sha = ?`);
const setSheet = db.prepare(`UPDATE actions SET sheet_appended = 1 WHERE sha = ?`);
const setDoc = db.prepare(`UPDATE actions SET doc_id = ? WHERE sha = ?`);
const setDocMeta = db.prepare(
  `UPDATE actions SET doc_hash = ?, doc_title = ? WHERE sha = ?`,
);
const setResolvedAt = db.prepare(
  `UPDATE actions SET resolved_at = COALESCE(resolved_at, ?) WHERE sha = ?`,
);
const ensureAction = db.prepare(`
  INSERT OR IGNORE INTO actions (sha, poll_id, sheet_appended, task_id, doc_id, rollback_executed)
  VALUES (?, NULL, 0, NULL, NULL, 0)
`);
const allDeploys = db.prepare(`
  SELECT sha, previous_sha, deployed_at, origin, reverts_sha, status, request_count
    FROM deploys
   ORDER BY deployed_at ASC
`);
const getDeploy = db.prepare(`
  SELECT sha, previous_sha, deployed_at, origin, reverts_sha, status, request_count
    FROM deploys WHERE sha = ?
`);
const getEval = db.prepare(`
  SELECT sha, baseline_sha, actual_cost_delta_pct, actual_latency_delta_pct,
         predicted_cost_delta_pct, prediction_error_pp, verdict
    FROM evaluations WHERE sha = ?
`);
const getPr = db.prepare(`
  SELECT number, author_login FROM pull_requests
   WHERE head_sha = ? OR merged_sha = ?
   ORDER BY updated_at DESC LIMIT 1
`);
const getPred = db.prepare(`
  SELECT estimated_cost_delta_pct FROM predictions
   WHERE merged_sha = ? OR head_sha = ?
   ORDER BY id DESC LIMIT 1
`);
const getPredByPr = db.prepare(`
  SELECT estimated_cost_delta_pct FROM predictions
   WHERE pr_number = ?
   ORDER BY id DESC LIMIT 1
`);
const getRevertFor = db.prepare(`SELECT sha FROM deploys WHERE reverts_sha = ? LIMIT 1`);

export type EvalSnap = {
  id: number;
  sha: string;
  baseline_sha: string | null;
  verdict: string;
  actual_cost_delta_pct: number | null;
  actual_latency_delta_pct: number | null;
  error_rate_delta: number | null;
  predicted_cost_delta_pct: number | null;
  prediction_error_pp: number | null;
  summary: string | null;
  cost_per_req: number | null;
  latency_ms: number | null;
  error_rate: number | null;
  n: number | null;
  doc_id: string | null;
  created_at: string;
};

const getHistoryRows = db.prepare(`
  SELECT * FROM evaluation_history WHERE sha = ? ORDER BY id ASC
`);
const setDocOnHistory = db.prepare(`UPDATE evaluation_history SET doc_id = ? WHERE id = ?`);
const getActionFlags = db.prepare(`
  SELECT rollback_executed, sheet_appended, doc_id, outcome FROM actions WHERE sha = ?
`);

const TERMINAL = new Set(["rolled_back", "skipped_revert", "monitoring"]);

function outcomeForStatus(status: string, flags: { rollback_executed: number; outcome?: string | null } | undefined): string {
  // A stored outcome (timeout vs keep, rollback) is more precise than status-derived.
  if (flags?.outcome) return flags.outcome;
  if (flags?.rollback_executed) return "rollback";
  if (status === "skipped_revert") return "skipped_revert";
  if (status === "rolled_back") return "rollback";
  if (status === "monitoring") return "keep";
  if (status === "insufficient_data") return "insufficient_data";
  if (status === "evaluated_ok") return "ok";
  return status;
}

async function factsForSha(sha: string, outcome: string, snap?: EvalSnap): Promise<LedgerFacts> {
  const deploy = getDeploy.get(sha) as
    | {
        sha: string;
        previous_sha: string | null;
        deployed_at: string;
        origin: string;
        reverts_sha: string | null;
        status: string;
        request_count: number;
      }
    | undefined;
  const evaln = getEval.get(sha) as
    | {
        baseline_sha: string | null;
        actual_cost_delta_pct: number | null;
        actual_latency_delta_pct: number | null;
        predicted_cost_delta_pct: number | null;
        prediction_error_pp: number | null;
        verdict: string;
      }
    | undefined;
  let pr = getPr.get(sha, sha) as { number: number; author_login: string | null } | undefined;
  // Direct-push deploys have no PR on the deploy sha itself — look through the
  // compare commits so a deploy of PR commits is linked to its PR.
  if (!pr) {
    const base = evaln?.baseline_sha ?? deploy?.previous_sha ?? null;
    if (base) {
      try {
        const { githubCompare } = await import("./github.js");
        const cmp = await githubCompare(base, sha);
        for (const c of (cmp.commits ?? []).slice(0, 10)) {
          const found = getPr.get(c.sha, c.sha) as { number: number; author_login: string | null } | undefined;
          if (found) {
            pr = found;
            break;
          }
        }
      } catch {
        // no PR link — leave empty
      }
    }
  }
  const pred =
    (getPred.get(sha, sha) as { estimated_cost_delta_pct: number | null } | undefined) ??
    (pr ? (getPredByPr.get(pr.number) as { estimated_cost_delta_pct: number | null } | undefined) : undefined);
  const slice = summarizeTelemetry(sha);
  const skipped = deploy?.origin === "revert" || deploy?.status === "skipped_revert" || outcome.includes("skip");
  const verdict = skipped ? "skipped_revert" : (snap?.verdict ?? evaln?.verdict ?? (outcome.includes("insufficient") ? "insufficient_data" : ""));
  const predicted = snap?.predicted_cost_delta_pct ?? evaln?.predicted_cost_delta_pct ?? pred?.estimated_cost_delta_pct ?? null;
  const errorPp =
    snap?.prediction_error_pp ??
    evaln?.prediction_error_pp ??
    (predicted != null && evaln?.actual_cost_delta_pct != null ? evaln.actual_cost_delta_pct - predicted : null);
  return {
    sha,
    deployedAt: snap?.created_at ?? deploy?.deployed_at ?? null,
    pr: pr ? prHref(pr.number) : "",
    author: pr?.author_login ? `@${pr.author_login.replace(/^@/, "")}` : "",
    model: dominantModel(slice),
    requests: snap?.n ?? slice.n ?? deploy?.request_count ?? 0,
    costPerReq: skipped || !slice.n ? null : (snap?.cost_per_req ?? slice.cost_per_req),
    deltaCost: skipped ? null : (snap?.actual_cost_delta_pct ?? evaln?.actual_cost_delta_pct ?? null),
    p95: skipped || !slice.n ? null : (slice.latency_p95_ms ?? slice.latency_ms),
    deltaLatency: skipped ? null : (snap?.actual_latency_delta_pct ?? evaln?.actual_latency_delta_pct ?? null),
    errorRate: skipped || !slice.n ? null : (snap?.error_rate ?? slice.error_rate),
    verdict: verdict || ledgerOutcome(outcome),
    predicted: skipped ? null : predicted,
    errorPp: skipped ? null : errorPp,
    outcome: skipped ? "skipped_revert" : outcome,
    baseline: snap?.baseline_sha ?? evaln?.baseline_sha ?? deploy?.previous_sha ?? deploy?.reverts_sha ?? null,
  };
}

function headerLooksRight(row: string[] | undefined): boolean {
  return (row?.[0] ?? "") === "Deploy" && (row?.[12] ?? "") === "Predicted";
}

// Every terminal deploy in chronological order — the ledger is always rebuilt
// from this, so rows can never be appended out of order.
async function ledgerGrid(): Promise<string[][]> {
  const rows: string[][] = [LEDGER_HEADER];
  const listed = allDeploys.all() as {
    sha: string;
    status: string;
    origin: string;
  }[];
  for (const row of listed) {
    if (row.origin === "revert" || row.status === "skipped_revert") {
      rows.push(formatLedgerFacts(await factsForSha(row.sha, "skipped_revert")));
      ensureAction.run(row.sha);
      setSheet.run(row.sha);
      continue;
    }
    if (!TERMINAL.has(row.status)) continue;
    const flags = getActionFlags.get(row.sha) as { rollback_executed: number; outcome?: string | null } | undefined;
    const outcome = outcomeForStatus(row.status, flags);
    // One ledger row per evaluation — cost regression and error spike are
    // decoupled, each with its own snapshot numbers.
    const snaps = getHistoryRows.all(row.sha) as EvalSnap[];
    if (snaps.length) {
      for (const snap of snaps) {
        rows.push(formatLedgerFacts(await factsForSha(row.sha, outcome, snap)));
      }
    } else {
      rows.push(formatLedgerFacts(await factsForSha(row.sha, outcome)));
    }
    ensureAction.run(row.sha);
    setSheet.run(row.sha);
  }
  return rows;
}

async function writeLedgerGrid(rows: string[][]) {
  try {
    await patchSheetCells(config.ambiguousSheetId, cellsForGrid(rows));
    console.log(`ledger written ${rows.length - 1} rows`);
  } catch (err) {
    console.error("ledger write", err);
    try {
      await appendSheetValues(config.ambiguousSheetId, [LEDGER_HEADER], "A1");
    } catch {
      // ignore
    }
  }
}

export async function rebuildLedger() {
  if (!config.ambiguousSheetId) return;
  await writeLedgerGrid(await ledgerGrid());
}

export async function ensureLedgerSurface() {
  if (!config.ambiguousSheetId) return;
  try {
    await renameDocument(config.ambiguousSheetId, LEDGER_TITLE);
  } catch (err) {
    console.error("ledger rename", err);
  }
  let existing: string[][] = [];
  try {
    existing = await getSheetRange(config.ambiguousSheetId, "A1:P80");
  } catch (err) {
    console.error("ledger read", err);
  }
  if (headerLooksRight(existing[0])) return;
  await writeLedgerGrid(await ledgerGrid());
}

export async function refreshPostmortems() {
  const docs = db.prepare(`SELECT sha FROM actions WHERE doc_id IS NOT NULL`).all() as { sha: string }[];
  for (const { sha } of docs) {
    const flags = getActionFlags.get(sha) as { rollback_executed: number; outcome?: string | null } | undefined;
    const deploy = getDeploy.get(sha) as { status: string } | undefined;
    const outcome = outcomeForStatus(deploy?.status ?? "", flags);
    const sha7 = sha.slice(0, 7);
    try {
      console.log(`postmortem refresh ${sha7}`);
      await writePostmortem(sha, outcome);
      console.log(`postmortem ok ${sha7}`);
    } catch (err) {
      console.error(`postmortem refresh ${sha7}`, err);
    }
  }
}

function cellsForGrid(values: string[][]) {
  const cells: { row: number; column: string; value: string }[] = [];
  const width = Math.max(LEDGER_HEADER.length, ...values.map((r) => r.length));
  // Pad with blank rows so stale cells from previous (larger) grids are cleared.
  const height = values.length + 5;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      cells.push({
        row: r,
        column: String.fromCharCode(65 + c),
        value: values[r]?.[c] ?? "",
      });
    }
  }
  return cells;
}

export async function appendLedgerRow(sha: string, outcome: string) {
  if (!config.ambiguousSheetId) return;
  ensureAction.run(sha);
  const row = getAction.get(sha) as { sheet_appended: number } | undefined;
  if (row?.sheet_appended) return;
  await ensureLedgerSurface();
  const already = getAction.get(sha) as { sheet_appended: number } | undefined;
  if (already?.sheet_appended) return;
  setSheet.run(sha);
  await writeLedgerGrid(await ledgerGrid());
}

export async function writePostmortem(
  sha: string,
  outcome: string,
  extras: { revertSha?: string | null; resolvedAt?: string; rollbackTarget?: string | null } = {},
): Promise<string | null> {
  const existing = getAction.get(sha) as
    | {
        doc_id: string | null;
        doc_hash: string | null;
        doc_title: string | null;
        resolved_at: string | null;
      }
    | undefined;
  const input = await loadAlertContext(sha);
  const sha7 = sha.slice(0, 7);
  if (!input) {
    if (existing?.doc_id) return existing.doc_id;
    return null;
  }
  const nowIso = new Date().toISOString();
  const resolvedAt = extras.resolvedAt ?? existing?.resolved_at ?? nowIso;
  setResolvedAt.run(resolvedAt, sha);
  const revertRow = getRevertFor.get(sha) as { sha: string } | undefined;

  // One postmortem doc PER EVALUATION — cost regression and error spike are
  // decoupled, each with its own snapshot numbers and title.
  const snaps = getHistoryRows.all(sha) as EvalSnap[];
  if (!snaps.length) {
    snaps.push({
      id: -1,
      sha,
      baseline_sha: input.baseline_sha ?? null,
      verdict: input.verdict,
      actual_cost_delta_pct: input.actual_cost_delta_pct,
      actual_latency_delta_pct: input.actual_latency_delta_pct,
      error_rate_delta: null,
      predicted_cost_delta_pct: input.predicted_cost_delta_pct,
      prediction_error_pp: input.predictionErrorPp ?? null,
      summary: null,
      cost_per_req: input.current.cost_per_req,
      latency_ms: input.current.latency_ms,
      error_rate: input.current.error_rate,
      n: input.current.n,
      doc_id: existing?.doc_id ?? null,
      created_at: input.deployedAt ?? nowIso,
    });
  }
  let latestDoc: string | null = null;
  for (const snap of snaps) {
    const docInput = {
      ...input,
      verdict: snap.verdict,
      baseline_sha: snap.baseline_sha ?? undefined,
      actual_cost_delta_pct: snap.actual_cost_delta_pct ?? 0,
      actual_latency_delta_pct: snap.actual_latency_delta_pct ?? 0,
      predicted_cost_delta_pct: snap.predicted_cost_delta_pct,
      predictionErrorPp: snap.prediction_error_pp ?? null,
      deployedAt: snap.created_at,
      current: {
        ...input.current,
        n: snap.n ?? input.current.n,
        cost_per_req: snap.cost_per_req ?? input.current.cost_per_req,
        latency_ms: snap.latency_ms ?? input.current.latency_ms,
        error_rate: snap.error_rate ?? input.current.error_rate,
      },
    };
    // The surgical rollback target persists in the intent's filter — refreshes
    // must show the real target, not the evaluation baseline.
    const intentTarget = db
      .prepare(`SELECT filter, chosen_sha FROM rollback_intents WHERE sha = ? AND status = 'done' ORDER BY id DESC LIMIT 1`)
      .get(sha) as { filter: string | null; chosen_sha: string | null } | undefined;
    const markdown = formatPostmortem({
      ...docInput,
      outcome,
      revertSha: extras.revertSha ?? revertRow?.sha ?? input.revertSha ?? null,
      rollbackTarget: extras.rollbackTarget ?? intentTarget?.filter ?? input.rollbackTarget ?? null,
      rollbackChosen: intentTarget?.chosen_sha ?? null,
      resolvedAt,
    });
    const title = postmortemTitle({ sha, verdict: snap.verdict, deployedAt: snap.created_at });
    const docId =
      snap.doc_id ?? (snap.verdict === input.verdict ? existing?.doc_id ?? null : null);
    if (docId) {
      try {
        await updateDocument(docId, markdown, title);
        if (snap.id >= 0) setDocOnHistory.run(docId, snap.id);
        latestDoc = docId;
      } catch (err) {
        console.error(`postmortem update ${sha7}`, err);
      }
      continue;
    }
    try {
      const doc = await createDocument(title, markdown);
      if (snap.id >= 0) setDocOnHistory.run(doc.id, snap.id);
      latestDoc = doc.id;
    } catch (err) {
      console.error(`postmortem create ${sha7}`, err);
    }
  }
  if (latestDoc) setDoc.run(latestDoc, sha);
  return latestDoc ?? existing?.doc_id ?? null;
}

