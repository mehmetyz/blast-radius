import { loadAlertContext } from "./alertFormat.js";
import {
  appendSheetValues,
  createDocument,
  getSheetRange,
  renameDocument,
  updateDocument,
  updateSheetValues,
} from "./ambiguous.js";
import { config } from "./config.js";
import {
  LEDGER_HEADER,
  LEDGER_TITLE,
  formatLedgerRow,
  formatPostmortem,
  postmortemTitle,
  type CopyInput,
} from "./copy.js";
import { db } from "./db.js";

const getAction = db.prepare(`SELECT * FROM actions WHERE sha = ?`);
const setSheet = db.prepare(`UPDATE actions SET sheet_appended = 1 WHERE sha = ?`);
const setDoc = db.prepare(`UPDATE actions SET doc_id = ? WHERE sha = ?`);
const ledgerActions = db.prepare(`
  SELECT a.sha, a.rollback_executed, a.doc_id
    FROM actions a
   WHERE a.sheet_appended = 1 OR a.sha = ?
`);

async function story(sha: string): Promise<CopyInput | null> {
  return loadAlertContext(sha);
}

export async function rewriteLedger(currentSha?: string, currentOutcome?: string) {
  if (!config.ambiguousSheetId) return;
  const rows: string[][] = [LEDGER_HEADER];
  const seen = new Set<string>();
  const list = currentSha
    ? (ledgerActions.all(currentSha) as { sha: string; rollback_executed: number; doc_id: string | null }[])
    : (ledgerActions.all("") as { sha: string; rollback_executed: number; doc_id: string | null }[]);
  for (const row of list) {
    if (seen.has(row.sha)) continue;
    seen.add(row.sha);
    const input = await story(row.sha);
    if (!input) continue;
    const outcome =
      row.sha === currentSha && currentOutcome
        ? currentOutcome
        : row.rollback_executed
          ? "rollback"
          : "keep";
    rows.push(formatLedgerRow({ ...input, outcome }));
  }
  if (currentSha && currentOutcome && !seen.has(currentSha)) {
    const input = await story(currentSha);
    if (input) rows.push(formatLedgerRow({ ...input, outcome: currentOutcome }));
  }
  try {
    await updateSheetValues(config.ambiguousSheetId, rows, "A1");
    await renameDocument(config.ambiguousSheetId, LEDGER_TITLE);
  } catch (err) {
    console.error("ledger rewrite", err);
    try {
      const existing = await getSheetRange(config.ambiguousSheetId, "A1:G1");
      const header = (existing[0] ?? []).join("|");
      if (!header.includes("What happened")) {
        await appendSheetValues(config.ambiguousSheetId, [LEDGER_HEADER], "A1");
      }
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function appendLedgerRow(sha: string, outcome: string) {
  if (!config.ambiguousSheetId) return;
  const row = getAction.get(sha) as { sheet_appended: number } | undefined;
  try {
    await rewriteLedger(sha, outcome);
    setSheet.run(sha);
  } catch (err) {
    console.error(`ledger append ${sha.slice(0, 7)}`, err);
    if (row?.sheet_appended) return;
    const input = await story(sha);
    if (!input) return;
    try {
      await appendSheetValues(config.ambiguousSheetId, [formatLedgerRow({ ...input, outcome })], "A1");
      setSheet.run(sha);
    } catch (again) {
      console.error(`ledger append fallback ${sha.slice(0, 7)}`, again);
    }
  }
}

export async function writePostmortem(sha: string, outcome: string): Promise<string | null> {
  const existing = getAction.get(sha) as { doc_id: string | null } | undefined;
  const input = await story(sha);
  const sha7 = sha.slice(0, 7);
  const markdown = input
    ? formatPostmortem({ ...input, outcome })
    : `Deploy \`${sha7}\`\n\n${outcome}\n`;
  const title = postmortemTitle(input?.deployedAt);
  if (existing?.doc_id) {
    try {
      await updateDocument(existing.doc_id, markdown, title);
      return existing.doc_id;
    } catch (err) {
      console.error(`postmortem update ${sha7}`, err);
    }
  }
  const doc = await createDocument(title, markdown);
  setDoc.run(doc.id, sha);
  return doc.id;
}
