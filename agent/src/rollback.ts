import { db } from "./db.js";
import { revertDeploy } from "./github.js";
import { findMessageByThreadKey, postMessage, replyInThread } from "./ambiguous.js";
import { appendLedgerRow, writePostmortem } from "./ledger.js";
import { formatRollbackReply } from "./copy.js";

const getAction = db.prepare(`SELECT * FROM actions WHERE sha = ?`);
const getDeploy = db.prepare(`SELECT * FROM deploys WHERE sha = ?`);
const setRollback = db.prepare(`UPDATE actions SET rollback_executed = 1 WHERE sha = ?`);
const setStatus = db.prepare(`UPDATE deploys SET status = ? WHERE sha = ?`);
const insertPending = db.prepare(
  `INSERT INTO pending_reverts (rolled_back_sha, created_at) VALUES (?, ?)`,
);
const dropPending = db.prepare(
  `DELETE FROM pending_reverts WHERE rolled_back_sha = ? AND consumed_at IS NULL`,
);

export async function executeRollback(
  sha: string,
  proof: { command: "rollback" },
): Promise<{ ok: boolean; detail: string }> {
  if (proof.command !== "rollback") return { ok: false, detail: "not a rollback command" };

  const action = getAction.get(sha) as { rollback_executed: number } | undefined;
  if (!action) return { ok: false, detail: "no action for this SHA" };
  if (action.rollback_executed) return { ok: true, detail: "already rolled back" };

  const deploy = getDeploy.get(sha) as { previous_sha: string | null; status: string } | undefined;
  if (!deploy?.previous_sha) return { ok: false, detail: "no previous SHA" };
  if (deploy.status !== "awaiting_approval" && deploy.status !== "alerted") {
    return { ok: false, detail: "deploy is not awaiting a command" };
  }

  const sha7 = sha.slice(0, 7);
  insertPending.run(sha, new Date().toISOString());
  try {
    const revertSha = await revertDeploy(sha, deploy.previous_sha);
    setRollback.run(sha);
    setStatus.run("rolled_back", sha);
    try {
      await writePostmortem(sha, "rollback", { revertSha });
    } catch (err) {
      console.error(`postmortem ${sha7}`, err);
    }
    try {
      await appendLedgerRow(sha, "rollback");
    } catch (err) {
      console.error(`ledger ${sha7}`, err);
    }
    await followUp(
      sha,
      formatRollbackReply(sha, {
        ok: true,
        previousSha: deploy.previous_sha,
        revertSha,
      }),
    );
    return { ok: true, detail: revertSha };
  } catch (err) {
    dropPending.run(sha);
    const detail = err instanceof Error ? err.message : String(err);
    await followUp(sha, formatRollbackReply(sha, { ok: false, detail }));
    return { ok: false, detail };
  }
}

export async function followUp(sha: string, content: string) {
  const msg = await findMessageByThreadKey(sha);
  const threadId = msg?.thread_id ?? msg?.id;
  if (threadId) {
    await replyInThread(threadId, content);
    return;
  }
  await postMessage(content, null, false);
}
