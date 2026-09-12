import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { deliverySeen, markDelivery, recordDeploy } from "../deploys.js";
import { markPredictionMerged, runInsight } from "../insight.js";

const upsertPr = db.prepare(`
  INSERT INTO pull_requests (number, head_sha, title, author_login, merged_sha, state, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(number) DO UPDATE SET
    head_sha = excluded.head_sha,
    title = excluded.title,
    author_login = excluded.author_login,
    merged_sha = excluded.merged_sha,
    state = excluded.state,
    updated_at = excluded.updated_at
`);

function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const got = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(got, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

type GithubPayload = {
  action?: string;
  ref?: string;
  after?: string;
  head_commit?: { id?: string; message?: string };
  deployment_status?: { state?: string };
  deployment?: { sha?: string };
  pull_request?: {
    number: number;
    title: string;
    state: string;
    merged?: boolean;
    merge_commit_sha?: string | null;
    head?: { sha: string };
    user?: { login: string };
  };
};

function handleGithubEvent(event: string, payload: GithubPayload): Record<string, unknown> {
  if (event === "pull_request" && payload.pull_request) {
    const pr = payload.pull_request;
    const mergedSha = pr.merged && pr.merge_commit_sha ? pr.merge_commit_sha : null;
    upsertPr.run(
      pr.number,
      pr.head?.sha ?? null,
      pr.title,
      pr.user?.login ?? null,
      mergedSha,
      pr.merged ? "merged" : pr.state,
      new Date().toISOString(),
    );
    if (mergedSha) markPredictionMerged(pr.number, mergedSha);
    const insightActions = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
    if (insightActions.has(payload.action ?? "") && pr.head?.sha) {
      void runInsight(pr.number, pr.head.sha).catch((err) => {
        console.error("insight failed", err);
      });
    }
    return { ok: true, pr: pr.number, action: payload.action };
  }

  if (event === "push" && payload.ref && /\/(main|master)$/.test(payload.ref)) {
    const sha = payload.after || payload.head_commit?.id || "";
    if (sha && sha !== "0000000000000000000000000000000000000000") {
      const recorded = recordDeploy({
        sha,
        commitMessage: payload.head_commit?.message,
        source: "github",
      });
      return { ok: true, push: recorded };
    }
  }

  if (event === "deployment_status" && payload.deployment_status?.state === "success") {
    const sha = payload.deployment?.sha ?? "";
    if (sha) {
      const recorded = recordDeploy({ sha, source: "github" });
      return { ok: true, deployment: recorded };
    }
  }

  return { ok: true, ignored: event };
}

export function githubWebhook(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifySignature(raw, req.get("x-hub-signature-256"), config.githubWebhookSecret)) {
    res.status(401).json({ error: "bad signature" });
    return;
  }

  const delivery = req.get("x-github-delivery") ?? "";
  if (!delivery) {
    res.status(400).json({ error: "missing x-github-delivery" });
    return;
  }
  if (deliverySeen(delivery)) {
    res.json({ ok: true, duplicate: true });
    return;
  }

  try {
    const event = req.get("x-github-event") ?? "";
    const payload = JSON.parse(raw.toString("utf8")) as GithubPayload;
    const result = handleGithubEvent(event, payload);
    markDelivery(delivery, "github");
    res.json(result);
  } catch (err) {
    console.error("github webhook", err);
    res.status(500).json({ error: "github handler failed" });
  }
}
