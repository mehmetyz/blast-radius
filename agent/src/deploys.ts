import type { Request, Response } from "express";
import { db } from "./db.js";
import { result } from "./cmd.js";

const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO processed_events (delivery_id, source, received_at) VALUES (?, ?, ?)`,
);
const getEvent = db.prepare(`SELECT delivery_id FROM processed_events WHERE delivery_id = ?`);
const getDeploy = db.prepare(`SELECT * FROM deploys WHERE sha = ?`);
const lastRelease = db.prepare(
  `SELECT sha FROM deploys
    WHERE origin = 'release'
      AND status NOT IN ('rolled_back', 'skipped_revert')
    ORDER BY deployed_at DESC LIMIT 1`,
);
const pendingFor = db.prepare(
  `SELECT id, rolled_back_sha FROM pending_reverts WHERE consumed_at IS NULL ORDER BY id DESC LIMIT 1`,
);
const consumePending = db.prepare(
  `UPDATE pending_reverts SET consumed_at = ? WHERE id = ?`,
);
const insertDeploy = db.prepare(`
  INSERT INTO deploys (sha, previous_sha, deployed_at, origin, reverts_sha, status, request_count, vercel_deployment_id, github_compare_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const telemetryCount = db.prepare(`
  SELECT
    (SELECT count(DISTINCT request_id) FROM telemetry
      WHERE sha = ? AND request_id IS NOT NULL AND coalesce(kind, 'llm') != 'function')
    +
    (SELECT count(*) FROM telemetry
      WHERE sha = ? AND request_id IS NULL AND coalesce(kind, 'llm') != 'function')
    AS n
`);

export type RecordDeployInput = {
  sha: string;
  vercelDeploymentId?: string | null;
  commitMessage?: string | null;
  deliveryId?: string | null;
  source?: "github" | "vercel" | "ingest";
};

export function deliverySeen(deliveryId: string): boolean {
  return Boolean(getEvent.get(deliveryId));
}

export function markDelivery(deliveryId: string, source: string) {
  insertEvent.run(deliveryId, source, new Date().toISOString());
}

export function alreadyProcessed(deliveryId: string, source: string): boolean {
  if (deliverySeen(deliveryId)) return true;
  markDelivery(deliveryId, source);
  return false;
}

export function recordDeploy(input: RecordDeployInput) {
  const sha = input.sha.trim();
  if (!sha) throw new Error("sha required");

  const existing = getDeploy.get(sha) as { sha: string } | undefined;
  if (existing) {
    return { sha, skipped: true as const, reason: "already recorded" };
  }

  const msg = (input.commitMessage ?? "").trim();
  const pending = pendingFor.get() as { id: number; rolled_back_sha: string } | undefined;
  const isRevert = /^Revert\b/i.test(msg) || Boolean(pending);
  const origin = isRevert ? "revert" : "release";
  const revertsSha = isRevert ? (pending?.rolled_back_sha ?? null) : null;
  const status = isRevert ? "skipped_revert" : "collecting";
  const prev = lastRelease.get() as { sha: string } | undefined;
  const previousSha = prev && prev.sha !== sha ? prev.sha : null;
  const n = (telemetryCount.get(sha, sha) as { n: number }).n;
  const now = new Date().toISOString();

  insertDeploy.run(
    sha,
    previousSha,
    now,
    origin,
    revertsSha,
    status,
    n,
    input.vercelDeploymentId ?? null,
    previousSha ? `https://github.com/${process.env.GITHUB_REPO ?? ""}/compare/${previousSha}...${sha}` : null,
  );

  if (pending && isRevert) consumePending.run(now, pending.id);

  if (input.deliveryId) alreadyProcessed(input.deliveryId, input.source ?? "vercel");

  if (isRevert && revertsSha) {
    void import("./rollback.js")
      .then(({ followUp }) =>
        followUp(
          revertsSha,
          result("skip", sha.slice(0, 7), "ok — revert deploy recorded. not evaluated."),
        ),
      )
      .catch((err) => console.error("revert follow-up", err));
    void import("./ledger.js")
      .then(({ appendLedgerRow }) => appendLedgerRow(sha, "skipped_revert"))
      .catch((err) => console.error("ledger revert", err));
  }

  return { sha, skipped: false as const, origin, previous_sha: previousSha, status, request_count: n };
}

export function postDeploy(req: Request, res: Response) {
  const token =
    req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.get("x-ingest-token") ?? "";
  const expected = process.env.INGEST_TOKEN ?? "";
  if (!expected || token !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const sha = String((req.body as { sha?: unknown })?.sha ?? "").trim();
  if (!sha) {
    res.status(400).json({ error: "sha required" });
    return;
  }
  const body = req.body as {
    vercel_deployment_id?: string;
    commit_message?: string;
  };
  res.json(
    recordDeploy({
      sha,
      vercelDeploymentId: body.vercel_deployment_id,
      commitMessage: body.commit_message,
      source: "vercel",
    }),
  );
}

export function getDeployBySha(req: Request, res: Response) {
  const row = getDeploy.get(req.params.sha);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
}

export function vercelWebhook(req: Request, res: Response) {
  const token = String(req.query.token ?? "");
  const expected = process.env.INGEST_TOKEN ?? "";
  if (!expected || token !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const payload = req.body as {
    id?: string;
    type?: string;
    payload?: {
      deployment?: {
        id?: string;
        meta?: { githubCommitSha?: string; githubCommitMessage?: string };
      };
    };
  };

  const type = payload.type ?? "";
  if (type && type !== "deployment.succeeded") {
    res.json({ ok: true, ignored: type });
    return;
  }

  const sha = payload.payload?.deployment?.meta?.githubCommitSha ?? "";
  if (!sha) {
    res.status(400).json({ error: "no githubCommitSha" });
    return;
  }

  const deliveryId = payload.id ?? `vercel:${sha}:${payload.payload?.deployment?.id ?? ""}`;
  if (alreadyProcessed(deliveryId, "vercel")) {
    res.json({ ok: true, duplicate: true });
    return;
  }

  res.json(
    recordDeploy({
      sha,
      vercelDeploymentId: payload.payload?.deployment?.id,
      commitMessage: payload.payload?.deployment?.meta?.githubCommitMessage,
      deliveryId,
      source: "vercel",
    }),
  );
}
