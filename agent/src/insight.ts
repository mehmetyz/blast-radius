import OpenAI from "openai";
import { config } from "./config.js";
import { db } from "./db.js";
import { commentOnPr, getPull, listPrAuthors, listPrFiles } from "./github.js";
import { formatInsightComment } from "./copy.js";

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
  suspect_hints: {
    files?: string[];
    models?: string[];
    params?: string[];
    endpoints?: string[];
    functions?: string[];
    error_risk?: string;
  };
};

export function markPredictionMerged(prNumber: number, mergedSha: string) {
  markMerged.run(mergedSha, prNumber);
}

export async function runInsight(prNumber: number, headSha: string) {
  const [files, authors] = await Promise.all([listPrFiles(prNumber), listPrAuthors(prNumber)]);
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

  const ask = () =>
    client.chat.completions.create({
      model: config.llmModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You estimate production impact of a git diff: LLM cost, endpoint/function latency, and error risk.
Return JSON only:
{"estimated_cost_delta_pct": number, "estimated_latency_delta_pct": number, "rationale": string, "suspect_hints": {"files": string[], "models": string[], "params": string[], "endpoints": string[], "functions": string[], "error_risk": string}}
Look at: model/token/prompt changes; new or heavier HTTP routes; new or hotter functions; retries; missing env; breaking API changes.
If there is error risk, put a short sentence in error_risk. If the diff is a no-op for runtime, return zeros and say so.
Percent is vs current production (negative = cheaper/faster).`,
        },
        { role: "user", content: diff || "(empty diff)" },
      ],
    });

  let parsed: Estimate;
  try {
    parsed = JSON.parse((await ask()).choices[0]?.message?.content ?? "{}") as Estimate;
  } catch (first) {
    console.error("insight llm retry", first);
    parsed = JSON.parse((await ask()).choices[0]?.message?.content ?? "{}") as Estimate;
  }
  const cost = Number(parsed.estimated_cost_delta_pct) || 0;
  const latency = Number(parsed.estimated_latency_delta_pct) || 0;
  const rationale = String(parsed.rationale ?? "").slice(0, 4000);
  const hints = {
    ...(typeof parsed.suspect_hints === "object" && parsed.suspect_hints ? parsed.suspect_hints : {}),
    authors,
  };
  insertPrediction.run(prNumber, headSha, cost, latency, rationale, JSON.stringify(hints));

  const endpoints = hints.endpoints?.filter(Boolean) ?? [];
  const functions = hints.functions?.filter(Boolean) ?? [];
  const touches = [...endpoints, ...functions.map((f) => `\`${f}\``)];
  let title: string | undefined;
  let head: string | undefined;
  let base: string | undefined;
  try {
    const pr = await getPull(prNumber);
    title = pr.title;
    head = pr.head;
    base = pr.base;
  } catch {
    // comment still works without branch names
  }
  const body = formatInsightComment({
    prNumber,
    sha: headSha,
    costPct: cost,
    latencyPct: latency,
    errorRisk: hints.error_risk,
    touches,
    authors,
    rationale,
    title,
    head,
    base,
  });
  await commentOnPr(prNumber, body);
  console.log(`insight: PR #${prNumber} cost ${cost}% latency ${latency}% authors=${authors.length}`);
}
