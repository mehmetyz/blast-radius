import { config } from "./config.js";
import { db } from "./db.js";
import { runActiveAgent } from "./agent.js";
import { evaluateDeploy } from "./evaluator.js";
import { watchApprovals } from "./approval.js";
import { processRollbackQueue } from "./rollbackQueue.js";

const due = db.prepare(`
  SELECT sha FROM deploys
  WHERE origin = 'release' AND status = 'collecting' AND request_count >= ?
`);
const stale = db.prepare(`
  SELECT d.sha FROM deploys d
  WHERE d.origin = 'release' AND d.status = 'collecting' AND d.request_count < ?
    AND EXISTS (
      SELECT 1 FROM deploys n
      WHERE n.origin = 'release' AND n.sha != d.sha AND n.deployed_at > d.deployed_at
        AND n.request_count >= ?
    )
`);
const recover = db.prepare(`
  UPDATE deploys SET status = 'collecting'
   WHERE origin = 'release' AND status = 'insufficient_data' AND request_count >= ?
`);
const claim = db.prepare(
  `INSERT OR IGNORE INTO actions (sha, poll_id, sheet_appended, task_id, doc_id, rollback_executed) VALUES (?, NULL, 0, NULL, NULL, 0)`,
);
const setStatus = db.prepare(`UPDATE deploys SET status = ? WHERE sha = ?`);
const getStatus = db.prepare(`SELECT status FROM deploys WHERE sha = ?`);

let ticking = false;

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const recovered = recover.run(config.minRequests);
    if (Number(recovered.changes) > 0) {
      console.log(`recovered ${recovered.changes} insufficient_data deploy(s) with enough traffic`);
    }
    for (const { sha } of stale.all(config.minRequests, config.minRequests) as { sha: string }[]) {
      setStatus.run("insufficient_data", sha);
      console.log(`insufficient_data ${sha.slice(0, 7)}`);
    }
    const rows = due.all(config.minRequests) as { sha: string }[];
    for (const { sha } of rows) {
      const result = evaluateDeploy(sha);
      if (!result || result.verdict === "ok") continue;
      const info = claim.run(sha);
      if (Number(info.changes) === 0) continue;
      try {
        await runActiveAgent(sha);
      } catch (err) {
        console.error(`alert failed ${sha}`, err);
      }
      const row = getStatus.get(sha) as { status: string } | undefined;
      if (row?.status === "collecting") setStatus.run("alerted", sha);
      const after = getStatus.get(sha) as { status: string } | undefined;
      console.log(`${after?.status ?? "alerted"} ${sha.slice(0, 7)} ${result.verdict}`);
    }
    await watchApprovals();
    await processRollbackQueue();
  } finally {
    ticking = false;
  }
}

export function startWorker() {
  const loop = () => {
    void tick().catch((err) => console.error("worker", err));
  };
  loop();
  setInterval(loop, 15_000);
}
