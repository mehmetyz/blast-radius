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
const getRevertFor = db.prepare(`SELECT sha FROM deploys WHERE reverts_sha = ? LIMIT 1`);
const getActionFlags = db.prepare(`
  SELECT rollback_executed, sheet_appended, doc_id FROM actions WHERE sha = ?
`);

const TERMINAL = new Set(["rolled_back", "skipped_revert", "monitoring"]);

function outcomeForStatus(status: string, rollbackExecuted: number): string {
  if (rollbackExecuted) return "rollback";
  if (status === "skipped_revert") return "skipped_revert";
  if (status === "rolled_back") return "rollback";
  if (status === "monitoring") return "keep";
  if (status === "insufficient_data") return "insufficient_data";
  if (status === "evaluated_ok") return "ok";
  return status;
}

function factsForSha(sha: string, outcome: string): LedgerFacts {
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
  const pr = getPr.get(sha, sha) as { number: number; author_login: string | null } | undefined;
  const pred = getPred.get(sha, sha) as { estimated_cost_delta_pct: number | null } | undefined;
  const slice = summarizeTelemetry(sha);
  const skipped = deploy?.origin === "revert" || deploy?.status === "skipped_revert" || outcome.includes("skip");
  const verdict = skipped ? "skipped_revert" : (evaln?.verdict ?? (outcome.includes("insufficient") ? "insufficient_data" : ""));
  const predicted = evaln?.predicted_cost_delta_pct ?? pred?.estimated_cost_delta_pct ?? null;
  const errorPp =
    evaln?.prediction_error_pp ??
    (predicted != null && evaln?.actual_cost_delta_pct != null ? evaln.actual_cost_delta_pct - predicted : null);
  return {
    sha,
    deployedAt: deploy?.deployed_at ?? null,
    pr: pr ? prHref(pr.number) : "",
    author: pr?.author_login ? `@${pr.author_login.replace(/^@/, "")}` : "",
    model: dominantModel(slice),
    requests: slice.n || deploy?.request_count || 0,
    costPerReq: skipped || !slice.n ? null : slice.cost_per_req,
    deltaCost: skipped ? null : (evaln?.actual_cost_delta_pct ?? null),
    p95: skipped || !slice.n ? null : (slice.latency_p95_ms ?? slice.latency_ms),
    deltaLatency: skipped ? null : (evaln?.actual_latency_delta_pct ?? null),
    errorRate: skipped || !slice.n ? null : slice.error_rate,
    verdict: verdict || ledgerOutcome(outcome),
    predicted: skipped ? null : predicted,
    errorPp: skipped ? null : errorPp,
    outcome: skipped ? "skipped_revert" : outcome,
    baseline: evaln?.baseline_sha ?? deploy?.previous_sha ?? deploy?.reverts_sha ?? null,
  };
}

function headerLooksRight(row: string[] | undefined): boolean {
  return (row?.[0] ?? "") === "Deploy" && (row?.[12] ?? "") === "Predicted";
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
  const rows: string[][] = [LEDGER_HEADER];
  const listed = allDeploys.all() as {
    sha: string;
    status: string;
    origin: string;
  }[];
  for (const row of listed) {
    if (row.origin === "revert" || row.status === "skipped_revert") {
      rows.push(formatLedgerFacts(factsForSha(row.sha, "skipped_revert")));
      ensureAction.run(row.sha);
      setSheet.run(row.sha);
      continue;
    }
    if (!TERMINAL.has(row.status)) continue;
    const flags = getActionFlags.get(row.sha) as { rollback_executed: number } | undefined;
    const outcome = outcomeForStatus(row.status, flags?.rollback_executed ?? 0);
    rows.push(formatLedgerFacts(factsForSha(row.sha, outcome)));
    ensureAction.run(row.sha);
    setSheet.run(row.sha);
  }
  try {
    await patchSheetCells(config.ambiguousSheetId, cellsForGrid(rows));
    console.log(`ledger migrated ${rows.length - 1} rows`);
  } catch (err) {
    console.error("ledger migrate", err);
    try {
      await appendSheetValues(config.ambiguousSheetId, [LEDGER_HEADER], "A1");
    } catch {
      // ignore
    }
  }
}

export async function refreshPostmortems() {
  const docs = db.prepare(`SELECT sha FROM actions WHERE doc_id IS NOT NULL`).all() as { sha: string }[];
  for (const { sha } of docs) {
    const flags = getActionFlags.get(sha) as { rollback_executed: number } | undefined;
    const deploy = getDeploy.get(sha) as { status: string } | undefined;
    const outcome = outcomeForStatus(deploy?.status ?? "", flags?.rollback_executed ?? 0);
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
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < width; c++) {
      cells.push({
        row: r,
        column: String.fromCharCode(65 + c),
        value: values[r][c] ?? "",
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
  const values = [formatLedgerFacts(factsForSha(sha, outcome))];
  try {
    await appendSheetValues(config.ambiguousSheetId, values, "A1");
    setSheet.run(sha);
  } catch (err) {
    console.error(`ledger append ${sha.slice(0, 7)}`, err);
  }
}

export async function writePostmortem(
  sha: string,
  outcome: string,
  extras: { revertSha?: string | null; resolvedAt?: string } = {},
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
  const markdown = formatPostmortem({
    ...input,
    outcome,
    revertSha: extras.revertSha ?? revertRow?.sha ?? input.revertSha ?? null,
    resolvedAt,
  });
  const title = postmortemTitle({
    sha,
    verdict: input.verdict,
    deployedAt: input.deployedAt,
    outcome,
  });
  const hash = createHash("sha1").update(markdown).digest("hex");
  if (existing?.doc_id) {
    if (existing.doc_hash === hash && existing.doc_title === title) {
      return existing.doc_id;
    }
    try {
      await updateDocument(existing.doc_id, markdown, title);
      setDocMeta.run(hash, title, sha);
      return existing.doc_id;
    } catch (err) {
      console.error(`postmortem update ${sha7}`, err);
    }
  }
  const doc = await createDocument(title, markdown);
  setDoc.run(doc.id, sha);
  setDocMeta.run(hash, title, sha);
  return doc.id;
}