import { config } from "./config.js";
import { db } from "./db.js";
import { createTask, listMessages, postMessage, replyInMessageThread, type ChannelMessage } from "./ambiguous.js";
import { deliverySeen, markDelivery } from "./deploys.js";
import { followUp } from "./rollback.js";
import { enqueueRollback } from "./rollbackQueue.js";
import { appendLedgerRow, writePostmortem } from "./ledger.js";
import { matchesSha, parseCmd } from "./cmd.js";
import { formatEvalHistory, formatKeepReply, formatStatusReply, type EvalHistoryRow } from "./copy.js";
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
const commitsForDeploy = db.prepare(
  `SELECT sha FROM commit_analysis WHERE deploy_sha = ? ORDER BY rowid ASC`,
);
const baselineFor = db.prepare(`SELECT baseline_sha FROM evaluations WHERE sha = ?`);

// Reply in the command's own thread when the API supports it; fall back to the
// alert thread (or a top-level message) when the command message is not a thread root.
async function replyCommand(msg: ChannelMessage, sha: string | null, content: string) {
  try {
    await replyInMessageThread(msg, content);
  } catch (err) {
    console.error(`thread reply fallback ${sha?.slice(0, 7) ?? "?"}`, err instanceof Error ? err.message : err);
    if (sha) await followUp(sha, content);
    else await postMessage(content, null, false);
  }
}

export async function openApproval(sha: string) {
  setAwaiting.run(new Date().toISOString(), sha);
  setStatus.run("awaiting_approval", sha);
}

export async function watchApprovals() {
  const open = awaiting.all() as { sha: string; awaiting_at: string | null }[];
  const msgs = await listMessages(80);
  for (const msg of msgs) {
    if (msg.deleted_at || deliverySeen(msg.id)) continue;
    const parsed = parseCmd(msg.content ?? "");
    if (!parsed) continue;
    if (parsed.op === "active" || parsed.op === "insight" || parsed.op === "rootcause") continue;

    if (!parsed.extra) continue;
    // keep/watch/status target a DEPLOY sha; rollback targets a COMMIT sha from
    // the suspicious-commits table (production reverts to just before it).
    const hit = parsed.op === "rollback" ? undefined : open.find((row) => matchesSha(parsed.extra, row.sha));
    let resolved: { deploySha: string; targetSha: string | null } | null = null;
    if (!hit) {
      if (parsed.op === "rollback") {
        for (const row of open) {
          const commits = commitsForDeploy.all(row.sha) as { sha: string }[];
          const idx = commits.findIndex((c) => matchesSha(parsed.extra, c.sha));
          if (idx < 0) continue;
          const base = baselineFor.get(row.sha) as { baseline_sha: string | null } | undefined;
          resolved = {
            deploySha: row.sha,
            targetSha: idx > 0 ? commits[idx - 1]!.sha : (base?.baseline_sha ?? null),
          };
          break;
        }
      } else if (parsed.op === "status") {
        // status works for ANY known deploy — closed deploys too.
        const allDeploys = db.prepare(`SELECT sha, status FROM deploys`).all() as { sha: string; status: string }[];
        const deploy = allDeploys.find((r) => matchesSha(parsed.extra, r.sha));
        if (deploy) resolved = { deploySha: deploy.sha, targetSha: null };
      }
    }
    if (!hit && !resolved) {
      if (parsed.op === "rollback" || parsed.op === "keep" || parsed.op === "watch" || parsed.op === "status") {
        markDelivery(msg.id, "ambiguous");
        try {
          const what = parsed.op === "rollback" ? "commit" : "deploy";
          const openList = open.map((r) => `\`${r.sha.slice(0, 7)}\``).join(", ") || "none";
          await replyCommand(
            msg,
            null,
            `Can't \`${parsed.op} ${parsed.extra}\` — no ${what} matches that SHA. Currently awaiting: ${openList}.`,
          );
        } catch (err) {
          console.error(`unknown-sha reply ${parsed.extra}`, err);
        }
      }
      continue;
    }
    markDelivery(msg.id, "ambiguous");
    try {
      await handleCommand(
        hit?.sha ?? resolved!.deploySha,
        parsed.op,
        parsed.extra,
        msg,
        resolved?.targetSha ?? null,
      );
    } catch (err) {
      console.error(`command ${parsed.op} ${hit?.sha.slice(0, 7)}`, err);
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

async function handleCommand(
  sha: string,
  op: string,
  extra: string,
  msg: ChannelMessage,
  targetSha: string | null,
) {
  if (op === "rollback") {
    const enqueued = enqueueRollback(sha, msg.id, targetSha ?? undefined, msg.thread_id ?? msg.id);
    if (enqueued) {
      console.log(`rollback queued ${sha.slice(0, 7)} target=${targetSha?.slice(0, 7) ?? "previous release"}`);
      const ack = targetSha
        ? `⏳ Rollback queued for \`${sha.slice(0, 7)}\` — reverting to just before \`${extra.slice(0, 7)}\`.`
        : `⏳ Rollback queued for \`${sha.slice(0, 7)}\` — executing now.`;
      await replyCommand(msg, sha, ack);
    } else {
      console.log(`rollback duplicate ignored ${sha.slice(0, 7)} (msg ${msg.id.slice(0, 8)})`);
    }
    return;
  }
  if (op === "keep" || op === "watch") {
    await keepWatching(sha, op, msg);
    return;
  }
  if (op === "status") {
    const input = await loadAlertContext(sha);
    let reply = formatStatusReply(sha, input, "no evaluation yet");
    const deploy = db.prepare(`SELECT status FROM deploys WHERE sha = ?`).get(sha) as
      | { status: string }
      | undefined;
    if (deploy && !["collecting", "alerted", "awaiting_approval"].includes(deploy.status)) {
      reply += `\nDeploy state: ${deploy.status}.`;
    }
    // Earlier evaluations of the same deploy (e.g. cost regression before an
    // error spike) — the latest verdict is above, history completes the story.
    const history = db
      .prepare(
        `SELECT verdict, actual_cost_delta_pct, actual_latency_delta_pct, error_rate_delta, created_at
           FROM evaluation_history WHERE sha = ? ORDER BY id DESC LIMIT 6`,
      )
      .all(sha) as EvalHistoryRow[];
    if (history.length > 1) {
      reply += `\n\n${formatEvalHistory(history.slice(1))}`;
    }
    await replyCommand(msg, sha, reply);
  }
}

async function keepWatching(sha: string, why: string, msg?: ChannelMessage) {
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
  db.prepare(`UPDATE actions SET outcome = ? WHERE sha = ?`).run(outcome, sha);
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
  const content = formatKeepReply(sha, { why, minutes: config.pollMinutes, people });
  if (msg) await replyCommand(msg, sha, content);
  else await followUp(sha, content);
  console.log(`monitoring ${sha7} task=${task.id}`);
}
