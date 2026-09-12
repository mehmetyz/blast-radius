import OpenAI from "openai";
import { config } from "./config.js";
import { db } from "./db.js";
import { commentOnPr, getPull, listPrAuthors, listPrFiles } from "./github.js";
import { findMessageByThreadKey, postMessage, updateMessage } from "./ambiguous.js";
import { formatInsightChannel, formatInsightComment } from "./copy.js";
import { costDeltaPct, costDriversFromFiles, describeCostDrivers } from "./insightCost.js";

const insertPrediction = db.prepare(`
  INSERT INTO predictions (
    pr_number, head_sha, merged_sha, estimated_cost_delta_pct,
    estimated_latency_delta_pct, rationale, suspect_hints
  ) VALUES (?, ?, NULL, ?, ?, ?, ?)
`);

const markMerged = db.prepare(
  `UPDATE predictions SET merged_sha = ? WHERE pr_number = ? AND (merged_sha IS NULL OR merged_sha = '')`,
);

type LlmInsight = {
  estimated_latency_delta_pct: number;
  rationale: string;
  endpoint_risks?: string[];
  error_risks?: string[];
  prompt_risks?: string[];
  suspect_hints?: {
    files?: string[];
    models?: string[];
    params?: string[];
    endpoints?: string[];
    functions?: string[];
  };
};

export function markPredictionMerged(prNumber: number, mergedSha: string) {
  markMerged.run(mergedSha, prNumber);
}

export async function runInsight(prNumber: number, headSha: string) {
  const [files, authors] = await Promise.all([listPrFiles(prNumber), listPrAuthors(prNumber)]);
  const drivers = costDriversFromFiles(files, config.llmModel);
  const cost = Math.round(costDeltaPct(drivers));
  const costWhy = describeCostDrivers(drivers);

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
          content: `You are INSIGHT, a pre-merge production-impact reviewer for LLM-serving code. Do NOT estimate LLM cost or invent cost percentages — cost is computed deterministically elsewhere.
Return JSON only:
{"estimated_latency_delta_pct": number, "rationale": string, "endpoint_risks": string[], "error_risks": string[], "prompt_risks": string[], "suspect_hints": {"files": string[], "models": string[], "params": string[], "endpoints": string[], "functions": string[]}}

Your job is to inspect the diff for FOUR categories of production risk. Each category has its own array of short qualitative flags (no numbers, one specific finding per string, at most 5 per category, empty array if nothing).

1. estimated_latency_delta_pct (number, percent, vs current production, negative = faster): LLM latency only — model class, output budget (max_tokens), extra sequential LLM calls.

2. endpoint_risks — anything that adds real wall-clock time to the HTTP request path OUTSIDE the LLM call itself:
   - new sequential await in the handler
   - new DB query in a loop
   - new network/fetch call on the request path
   - removed cache or memoization
   - new dependency without a timeout
   - increased max_tokens or temperature that expands output
   - example flag: "new sequential fetch to inventory service before LLM call"

3. error_risks — anything that increases the chance of a 4xx/5xx or unhandled throw:
   - new intentional throw / fail-closed branch (new condition that raises or returns 5xx)
   - removed try/catch
   - unchecked null on external data
   - changed retry/backoff to be less resilient
   - silent error swallow added or removed
   - example flag: "502 on any prompt containing 'refund'"
   If the diff adds or broadens ANY condition that makes the handler throw or return 5xx (new .includes(), new % modulo, new length guard, new throw), you MUST list that exact condition here — this is our highest-signal flag.

4. prompt_risks — anything that changes what we send to the model in a way that raises cost, latency, or output-quality risk WITHOUT swapping models:
   - system prompt got longer (more input tokens per request)
   - system prompt got instructions likely to make the model verbose or repeat itself
   - user prompt template concatenates untrusted data
   - added few-shot examples that inflate every request
   - removed a "keep it short" or "one paragraph" style guide
   - example flag: "system prompt grew from 1 sentence to a 12-bullet checklist — every request now pays those input tokens"

rationale: 1-3 sentences summarizing the change in plain language for a human reviewer. Do not invent facts.
suspect_hints: structured hints about which files, models, params, endpoints, or functions changed — used to route the alert.

If the diff is a no-op for runtime, return 0 latency and empty arrays. Prefer specific concrete flags over generic categories.`,
        },
        { role: "user", content: diff || "(empty diff)" },
      ],
    });

  let parsed: LlmInsight;
  try {
    parsed = JSON.parse((await ask()).choices[0]?.message?.content ?? "{}") as LlmInsight;
  } catch (first) {
    console.error("insight llm retry", first);
    parsed = JSON.parse((await ask()).choices[0]?.message?.content ?? "{}") as LlmInsight;
  }
  const latency = Number(parsed.estimated_latency_delta_pct) || 0;
  const rationale = String(parsed.rationale ?? "").slice(0, 4000);
  const endpointRisks = (parsed.endpoint_risks ?? []).map((s) => String(s).slice(0, 300)).filter(Boolean);
  const errorRisks = (parsed.error_risks ?? []).map((s) => String(s).slice(0, 300)).filter(Boolean);
  const promptRisks = (parsed.prompt_risks ?? []).map((s) => String(s).slice(0, 300)).filter(Boolean);
  const hints = {
    ...(typeof parsed.suspect_hints === "object" && parsed.suspect_hints ? parsed.suspect_hints : {}),
    authors,
    endpoint_risks: endpointRisks,
    error_risks: errorRisks,
    prompt_risks: promptRisks,
    cost_drivers: costWhy,
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
  const primary =
    files.find((f) => /route\.ts|route\.js|chat/i.test(f.filename) && f.patch) ??
    files.find((f) => f.patch);
  const body = formatInsightComment({
    prNumber,
    sha: headSha,
    costPct: cost,
    latencyPct: latency,
    costWhy,
    endpointRisks,
    errorRisks,
    promptRisks,
    touches,
    authors,
    rationale,
    title,
    head,
    base,
    primaryPatch: primary ? { filename: primary.filename, rawPatch: primary.patch } : undefined,
  });
  await commentOnPr(prNumber, body);
  await maybePostInsightChannel({
    prNumber,
    sha: headSha,
    costPct: cost,
    latencyPct: latency,
    title,
    errorRisks,
    endpointRisks,
  });
  console.log(`insight: PR #${prNumber} cost ${cost}% latency ${latency}% authors=${authors.length}`);
}

async function maybePostInsightChannel(input: {
  prNumber: number;
  sha: string;
  costPct: number;
  latencyPct: number;
  title?: string;
  errorRisks: string[];
  endpointRisks: string[];
}) {
  const hot =
    Math.abs(input.costPct) >= config.costRegressionPct ||
    Math.abs(input.latencyPct) >= config.latencyRegressionPct ||
    input.errorRisks.length > 0;
  if (!hot || !config.ambiguousChannelId) return;

  const content = formatInsightChannel(input);
  const key = `insight-pr-${input.prNumber}`;
  const existing = await findMessageByThreadKey(key);
  if (existing) {
    await updateMessage(existing.id, content);
    return;
  }
  await postMessage(content, key, true);
}
