import { db } from "./db.js";
import { githubCompare } from "./github.js";
import { postMessage } from "./ambiguous.js";
import { evaluateDeploy, getEvaluation, summarizeTelemetry } from "./evaluator.js";

const getDeploy = db.prepare(`SELECT * FROM deploys WHERE sha = ?`);
const getPrs = db.prepare(`SELECT * FROM pull_requests ORDER BY updated_at DESC LIMIT 20`);
const getPreds = db.prepare(`SELECT * FROM predictions WHERE head_sha = ? OR merged_sha = ?`);
const insertSuspect = db.prepare(
  `INSERT INTO suspects (sha, rank, pr_number, author_login, confidence, reason) VALUES (?, ?, ?, ?, ?, ?)`,
);

export const toolSpecs = [
  {
    type: "function" as const,
    function: {
      name: "get_deploy_context",
      description: "Deploy row, linked PRs, predictions",
      parameters: { type: "object", properties: { sha: { type: "string" } }, required: ["sha"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "summarize_telemetry",
      description: "n, cost, latency, error_rate for a SHA",
      parameters: { type: "object", properties: { sha: { type: "string" } }, required: ["sha"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "compare_to_baseline",
      description: "Evaluation vs previous release, including predicted vs actual",
      parameters: { type: "object", properties: { sha: { type: "string" } }, required: ["sha"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "github_compare",
      description: "Commits and files between two SHAs",
      parameters: {
        type: "object",
        properties: { base: { type: "string" }, head: { type: "string" } },
        required: ["base", "head"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "record_suspects",
      description: "Ranked suspect list. Never a single culprit.",
      parameters: {
        type: "object",
        properties: {
          sha: { type: "string" },
          suspects: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rank: { type: "number" },
                pr_number: { type: "number" },
                author_login: { type: "string" },
                confidence: { type: "number" },
                reason: { type: "string" },
              },
              required: ["rank", "confidence", "reason"],
            },
          },
        },
        required: ["sha", "suspects"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "post_message",
      description: "Post Markdown to an existing Ambiguous thread. thread_key must be the deploy SHA. Follow-ups: starts_new_block false. First regression alert is posted by code, not this tool.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          thread_key: { type: "string" },
          starts_new_block: { type: "boolean" },
        },
        required: ["content", "thread_key"],
      },
    },
  },
];

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "get_deploy_context": {
      const sha = String(args.sha);
      return JSON.stringify({
        deploy: getDeploy.get(sha),
        prs: getPrs.all(),
        predictions: getPreds.all(sha, sha),
      });
    }
    case "summarize_telemetry":
      return JSON.stringify(summarizeTelemetry(String(args.sha)));
    case "compare_to_baseline": {
      const sha = String(args.sha);
      return JSON.stringify(getEvaluation(sha) ?? evaluateDeploy(sha));
    }
    case "github_compare": {
      const data = await githubCompare(String(args.base), String(args.head));
      return JSON.stringify({
        html_url: data.html_url,
        commits: data.commits.slice(0, 20).map((c) => ({
          sha: c.sha,
          message: c.commit.message.split("\n")[0],
          author: c.author?.login ?? c.commit.author.name,
        })),
        files: data.files.map((f) => f.filename),
      });
    }
    case "record_suspects": {
      const sha = String(args.sha);
      const suspects = (args.suspects as Array<{
        rank: number;
        pr_number?: number;
        author_login?: string;
        confidence: number;
        reason: string;
      }>) ?? [];
      for (const s of suspects) {
        insertSuspect.run(sha, s.rank, s.pr_number ?? null, s.author_login ?? null, s.confidence, s.reason);
      }
      return JSON.stringify({ ok: true, n: suspects.length });
    }
    case "post_message": {
      const out = await postMessage(
        String(args.content),
        String(args.thread_key),
        Boolean(args.starts_new_block),
      );
      return JSON.stringify({ ok: true, id: out.id ?? null });
    }
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}
