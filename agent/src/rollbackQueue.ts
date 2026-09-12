import { db } from "./db.js";
import { executeRollback, followUp } from "./rollback.js";
import { replyInThread } from "./ambiguous.js";
import { formatRollbackReply } from "./copy.js";

const rollbackDone = db.prepare(
  `SELECT rollback_executed FROM actions WHERE sha = ?`,
);

const enqueue = db.prepare(`
  INSERT OR IGNORE INTO rollback_intents (sha, filter, requested_by, requested_at, reply_thread, chosen_sha, status)
  VALUES (?, ?, ?, ?, ?, ?, 'pending')
`);

const claimNext = db.prepare(`
  UPDATE rollback_intents
     SET status = 'in_progress', claim_at = ?
   WHERE id = (
     SELECT id FROM rollback_intents
      WHERE status = 'pending'
      ORDER BY requested_at ASC LIMIT 1
   )
     AND status = 'pending'
  RETURNING id, sha, filter, requested_by, reply_thread, chosen_sha
`);

const finish = db.prepare(`
  UPDATE rollback_intents
     SET status = ?, finished_at = ?, detail = ?
   WHERE id = ?
`);

const staleInProgress = db.prepare(`
  SELECT id, sha, claim_at FROM rollback_intents
   WHERE status = 'in_progress'
     AND (claim_at IS NULL OR claim_at < ?)
`);

const resetToPending = db.prepare(`
  UPDATE rollback_intents SET status = 'pending', claim_at = NULL WHERE id = ?
`);

export type RollbackIntent = {
  id: number;
  sha: string;
  filter: string | null;
  requested_by: string;
  reply_thread?: string | null;
  chosen_sha?: string | null;
};

export function enqueueRollback(
  sha: string,
  requestedBy: string,
  filter?: string | null,
  replyThread?: string | null,
  chosenSha?: string | null,
): boolean {
  const now = new Date().toISOString();
  const info = enqueue.run(sha, filter ?? null, requestedBy, now, replyThread ?? null, chosenSha ?? null);
  return Number(info.changes) > 0;
}

export function claimNextRollback(): RollbackIntent | null {
  const now = new Date().toISOString();
  const row = claimNext.get(now) as RollbackIntent | undefined;
  return row ?? null;
}

export function finishRollback(id: number, status: "done" | "failed", detail: string) {
  finish.run(status, new Date().toISOString(), detail.slice(0, 500), id);
}

export async function recoverStaleIntents() {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const stale = staleInProgress.all(cutoff) as { id: number; sha: string; claim_at: string | null }[];
  for (const row of stale) {
    const action = rollbackDone.get(row.sha) as { rollback_executed: number } | undefined;
    if (action?.rollback_executed) {
      finish.run("done", new Date().toISOString(), "resumed: rollback already executed before restart", row.id);
      console.log(`rollback queue: resumed ${row.sha.slice(0, 7)} — already done`);
    } else {
      resetToPending.run(row.id);
      console.log(`rollback queue: re-queued ${row.sha.slice(0, 7)} — retry after restart`);
    }
  }
}

// Replies go to the thread of the human's command message; fall back to the
// alert thread when the command thread is unknown or not a thread root.
async function replyForIntent(intent: RollbackIntent, content: string) {
  if (intent.reply_thread) {
    try {
      await replyInThread(intent.reply_thread, content);
      return;
    } catch (err) {
      console.error(`rollback thread fallback ${intent.sha.slice(0, 7)}`, err instanceof Error ? err.message : err);
    }
  }
  await followUp(intent.sha, content);
}

export async function processRollbackQueue(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const intent = claimNextRollback();
    if (!intent) return;
    const sha7 = intent.sha.slice(0, 7);
    try {
      const out = await executeRollback(intent.sha, { command: "rollback" }, intent.filter || undefined);
      if (out.ok) {
        finishRollback(intent.id, "done", out.detail);
        console.log(`rollback queue: done ${sha7} · ${out.detail}`);
        if (out.detail === "already rolled back") {
          await replyForIntent(intent, `↩️ \`${sha7}\` was already rolled back — no action needed.`);
        } else {
          await replyForIntent(
            intent,
            intent.chosen_sha
              ? `↩️ **Rolled back** \`${sha7}\` to just before \`${intent.chosen_sha.slice(0, 7)}\` — that commit and everything after it are reverted. The revert is not evaluated.`
              : formatRollbackReply(intent.sha, {
                  ok: true,
                  previousSha: out.previousSha,
                  revertSha: out.revertSha,
                }),
          );
        }
      } else {
        finishRollback(intent.id, "failed", out.detail);
        console.log(`rollback queue: failed ${sha7} · ${out.detail}`);
        await replyForIntent(intent, formatRollbackReply(intent.sha, { ok: false, detail: out.detail }));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      finishRollback(intent.id, "failed", detail);
      console.error(`rollback queue exec ${sha7}`, err);
      await replyForIntent(intent, formatRollbackReply(intent.sha, { ok: false, detail }));
    }
  }
}
