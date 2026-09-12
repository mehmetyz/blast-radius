import OpenAI from "openai";
import { config } from "./config.js";
import { db } from "./db.js";
import { commentOnPr, listPrFiles } from "./github.js";

const insertPrediction = db.prepare(`
  INSERT INTO predictions (
    pr_number, head_sha, merged_sha, estimated_cost_delta_pct,
    estimated_latency_delta_pct, rationale, suspect_hints
  ) VALUES (?, ?, NULL, ?, ?, ?, ?)
`);

const markMerged = db.prepare(
  `UPDATE predictions SET merged_sha = ? WHERE pr_number = ? AND (merged_sha IS NULL OR merged_sha = '')`,
);

type Estimate = {
  estimated_cost_delta_pct: number;
  estimated_latency_delta_pct: number;
  rationale: string;
  suspect_hints: unknown;
};

export function markPredictionMerged(prNumber: number, mergedSha: string) {
  markMerged.run(mergedSha, prNumber);
}

export async function runInsight(prNumber: number, headSha: string) {
  const files = await listPrFiles(prNumber);
  const diff = files
    .map((f) => `--- ${f.filename} (${f.status})\n${f.patch ?? ""}`)
    .join("\n\n")
    .slice(0, 24_000);

  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");

  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl || undefined,
    timeout: 30_000,
  });

  const completion = await client.chat.completions.create({
    model: config.llmModel,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You estimate production LLM cost and latency impact of a git diff.
Return JSON only:
{"estimated_cost_delta_pct": number, "estimated_latency_delta_pct": number, "rationale": string, "suspect_hints": {"files": string[], "models": string[], "params": string[]}}
Focus on gen_ai changes: model swaps, max_tokens, temperature, extra round-trips, larger prompts.
If the diff does not touch LLM calls, return zeros and say so. Percent is vs current production (negative means cheaper/faster).`,
      },
      { role: "user", content: diff || "(empty diff)" },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Estimate;
  const cost = Number(parsed.estimated_cost_delta_pct) || 0;
  const latency = Number(parsed.estimated_latency_delta_pct) || 0;
  const rationale = String(parsed.rationale ?? "").slice(0, 4000);
  const hints = JSON.stringify(parsed.suspect_hints ?? {});

  insertPrediction.run(prNumber, headSha, cost, latency, rationale, hints);

  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const body = `## Blast Radius INSIGHT

Predicted cost: **${sign(cost)}%**
Predicted latency: **${sign(latency)}%**

${rationale}

This estimate will be scored against real telemetry after deploy (\`predicted X, actual Y\`).
`;
  await commentOnPr(prNumber, body);
  console.log(`insight: PR #${prNumber} cost ${sign(cost)}% latency ${sign(latency)}%`);
}
