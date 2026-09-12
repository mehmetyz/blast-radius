import { config } from "./config.js";
import { db } from "./db.js";
import { runActiveAgent } from "./agent.js";
import { evaluateDeploy } from "./evaluator.js";

const due = db.prepare(`
  SELECT sha FROM deploys
  WHERE origin = 'release' AND status = 'collecting' AND request_count >= ?
`);
const claim = db.prepare(
  `INSERT OR IGNORE INTO actions (sha, poll_id, sheet_appended, task_id, doc_id, rollback_executed) VALUES (?, NULL, 0, NULL, NULL, 0)`,
);
const setStatus = db.prepare(`UPDATE deploys SET status = ? WHERE sha = ?`);

export async function tick() {
  const rows = due.all(config.minRequests) as { sha: string }[];
  for (const { sha } of rows) {
    const result = evaluateDeploy(sha);
    if (!result || result.verdict === "ok") continue;
    const info = claim.run(sha);
    if (Number(info.changes) === 0) continue;
    try {
      await runActiveAgent(sha);
      setStatus.run("alerted", sha);
      console.log(`alerted ${sha.slice(0, 7)} ${result.verdict}`);
    } catch (err) {
      console.error(`alert failed ${sha}`, err);
    }
  }
}

export function startWorker() {
  const loop = () => {
    void tick().catch((err) => console.error("worker", err));
  };
  loop();
  setInterval(loop, 15_000);
}
