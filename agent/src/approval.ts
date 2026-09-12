import { config } from "./config.js";
import { db } from "./db.js";
import { createTask, listMessages } from "./ambiguous.js";
import { deliverySeen, markDelivery } from "./deploys.js";
import { executeRollback, followUp } from "./rollback.js";
import { appendLedgerRow, writePostmortem } from "./ledger.js";
import { matchesSha, parseCmd } from "./cmd.js";
import { formatKeepReply, formatStatusReply } from "./copy.js";
import { loadAlertContext } from "./alertFormat.js";

const getAction = db.prepare(`SELECT * FROM actions WHERE sha = ?`);
const setAwaiting = db.prepare(
  `UPDATE actions SET awaiting_at = COALESCE(awaiting_at, ?) WHERE sha = ?`,
);
const setTask = db.prepare(`UPDATE actions SET task_id = ? WHERE sha = ?`);
const setStatus = db.prepare(`UPDATE deploys SET status = ? WHERE sha = ?`);
const awaiting = db.prepare(`
  SELECT d.sha, a.awaiting_at
    FROM deploys d
    JOIN actions a ON a.sha = d.sha
   WHERE d.status IN ('alerted', 'awaiting_approval') AND a.rollback_executed = 0
`);

export async function openApproval(sha: string) {
  setAwaiting.run(new Date().toISOString(), sha);
  setStatus.run("awaiting_approval", sha);
}

export async function watchApprovals() {
  const open = awaiting.all() as { sha: string; awaiting_at: string | null }[];
  if (!open.length) return;

  const msgs = await listMessages(80);
  for (const msg of msgs) {
    if (msg.deleted_at || deliverySeen(msg.id)) continue;
    const parsed = parseCmd(msg.content ?? "");
    if (!parsed) continue;
    if (parsed.op === "active" || parsed.op === "insight" || parsed.op === "rootcause") continue;

    const hit = open.find((row) => matchesSha(parsed.extra, row.sha));
    if (!hit) continue;
    markDelivery(msg.id, "ambiguous");
    try {
      await handleCommand(hit.sha, parsed.op, parsed.extra);
    } catch (err) {
      console.error(`command ${parsed.op} ${hit.sha.slice(0, 7)}`, err);
    }
  }

  for (const row of open) {
    const since = row.awaiting_at ? new Date(row.awaiting_at).getTime() : 0;
    if (!since) continue;
    if (Date.now() < since + config.pollMinutes * 60_000) continue;
    const action = getAction.get(row.sha) as { rollback_executed: number; task_id: string | null } | undefined;
    if (action?.rollback_executed || action?.task_id) continue;
    try {
      await keepWatching(row.sha, "timeout");
    } catch (err) {
      console.error(`command timeout ${row.sha.slice(0, 7)}`, err);
    }
  }
}

async function handleCommand(sha: string, op: string, _extra: string) {
  if (op === "rollback") {
    const out = await executeRollback(sha, { command: "rollback" });
    if (out.ok) console.log(`rolled back ${sha.slice(0, 7)}`);
    else console.error(`rollback skipped ${sha.slice(0, 7)} ${out.detail}`);
    return;
  }
  if (op === "keep" || op === "watch") {
    await keepWatching(sha, op);
    return;
  }
  if (op === "status") {
    const input = await loadAlertContext(sha);
    await followUp(sha, formatStatusReply(sha, input, "no evaluation yet"));
  }
}

async function keepWatching(sha: string, why: string) {
  const existing = getAction.get(sha) as { task_id: string | null } | undefined;
  if (existing?.task_id) return;

  const sha7 = sha.slice(0, 7);
  const due = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const task = await createTask({
    title: `Watch ${sha7} — no rollback`,
    description: `Keeping \`${sha7}\` after ${why}. Rollback is not automatic.`,
    priority: "high",
    due_date: due,
  });
  setTask.run(task.id, sha);
  setStatus.run("monitoring", sha);
  const outcome = why === "timeout" ? "timeout" : "keep";
  try {
    await writePostmortem(sha, outcome);
  } catch (err) {
    console.error(`postmortem ${sha7}`, err);
  }
  try {
    await appendLedgerRow(sha, outcome);
  } catch (err) {
    console.error(`ledger ${sha7}`, err);
  }
  const people = ((await loadAlertContext(sha))?.authors ?? []).filter(Boolean);
  await followUp(
    sha,
    formatKeepReply(sha, { why, minutes: config.pollMinutes, people }),
  );
  console.log(`monitoring ${sha7} task=${task.id}`);
}
