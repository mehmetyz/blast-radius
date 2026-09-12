import OpenAI from "openai";
import { config } from "./config.js";
import { db } from "./db.js";
import { commentOnPr, getPull, listPrAuthors, listPrFiles } from "./github.js";
import { findMessageByThreadKey, postMessage, updateMessage } from "./ambiguous.js";
import { formatInsightChannel, formatInsightComment, sliceHunk, type InsightHunk, type InsightImpact, type InsightSeverity } from "./copy.js";
import type { PrFile } from "./github.js";
import { costDeltaPct, costDriversFromFiles, describeCostDrivers } from "./insightCost.js";

const ALLOWED_IMPACTS = new Set<InsightImpact>(["cost", "latency", "errors", "prompt", "dataflow", "docs"]);

function inferImpactsFromPatch(file: string, patch?: string): InsightImpact[] {
  if (/\.(md|txt)$/i.test(file) || /README/i.test(file)) return ["docs"];
  if (!patch) return [];
  const found = new Set<InsightImpact>();
  if (/(?:MODEL\s*=|model:\s*|gpt-4|gpt-3|claude-|o1-|o3-)/i.test(patch)) found.add("cost");
  if (/\bthrow\b|status:\s*50[0-9]|fail closed|includes\(["'`](?:escalate|refund)|\w+!\.|\bcrashes?\b/i.test(patch)) {
    found.add("errors");
  }
  // Latency patterns only count on request-path files — a shared telemetry/util
  // helper doing a fetch is not request-path latency.
  const isRoute = /api\/|route\.(ts|js)/i.test(file);
  if (isRoute && /enrichPrompt|setTimeout\s*\(|new Promise\s*\(|await fetch\s*\(/i.test(patch)) {
    found.add("latency");
  }
  if (/role:\s*["']system["']|system prompt|house style/i.test(patch)) found.add("prompt");
  return [...found];
}

function mergeImpacts(llm: InsightImpact[], inferred: InsightImpact[]): InsightImpact[] {
  if (inferred.length) {
    const merged = new Set<InsightImpact>(inferred);
    if (llm.length > 0 && llm.length <= 2) {
      for (const i of llm) {
        if (i !== "docs") merged.add(i);
      }
    }
    return [...merged];
  }
  return llm;
}

type PrHunk = {
  id: string;
  file: string;
  range: string;
  patch: string;
};

function hunkRange(header: string): { start: number; end: number } | null {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const len = Number(m[2] ?? 1);
  return { start, end: start + len - 1 };
}

function enumerateHunks(files: PrFile[]): { list: PrHunk[]; byId: Map<string, PrHunk> } {
  const list: PrHunk[] = [];
  const byId = new Map<string, PrHunk>();
  let n = 0;
  for (const f of files) {
    if (!f.patch) continue;
    for (const part of f.patch.split(/(?=^@@)/m).filter(Boolean)) {
      const header = part.slice(0, part.indexOf("\n") === -1 ? part.length : part.indexOf("\n"));
      const range = hunkRange(header);
      if (!range) continue;
      n += 1;
      const hunk: PrHunk = {
        id: `h${n}`,
        file: f.filename,
        range: range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`,
        patch: part,
      };
      list.push(hunk);
      byId.set(hunk.id, hunk);
    }
  }
  return { list, byId };
}

function parseHunks(
  raw: LlmHunk[] | undefined,
  files: PrFile[],
  hunks: { list: PrHunk[]; byId: Map<string, PrHunk> },
): InsightHunk[] {
  const rawList = Array.isArray(raw) ? raw : [];
  const patchByFile = new Map(files.map((f) => [f.filename, f.patch]));
  const firstHunkForFile = (file: string) => hunks.list.find((h) => h.file === file);
  const out: InsightHunk[] = [];
  const seen = new Set<string>();
  for (const h of rawList) {
    if (!h || typeof h !== "object") continue;
    const llmImpacts = (Array.isArray(h.impacts) ? h.impacts : [])
      .map((i) => String(i).toLowerCase() as InsightImpact)
      .filter((i) => ALLOWED_IMPACTS.has(i));
    const ids = String(h.hunk_id ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const resolved = ids.map((id) => hunks.byId.get(id)).filter((x): x is PrHunk => Boolean(x));
    let file: string | undefined;
    let lineRange: string;
    let hunkPatch: string | undefined;
    if (resolved.length) {
      // Deterministic: id → exact hunk, line range and diff snippet always match the summary.
      file = resolved[0]!.file;
      lineRange = resolved[0]!.range;
      hunkPatch = resolved[0]!.patch;
    } else {
      // Legacy fallback when the LLM ignored the hunk_id format.
      file = String(h.file ?? "").slice(0, 200);
      if (!file) continue;
      lineRange = String(h.line_range ?? "?").slice(0, 40);
      const filePatch = patchByFile.get(file);
      hunkPatch = filePatch ? sliceHunk(filePatch, lineRange) ?? filePatch : undefined;
    }
    const inferred = inferImpactsFromPatch(file, hunkPatch);
    const impacts = mergeImpacts(llmImpacts, inferred);
    if (!impacts.length) continue;
    const sevRaw = String(h.severity ?? "").toLowerCase();
    let severity: InsightSeverity = sevRaw === "high" ? "high" : sevRaw === "low" ? "low" : "medium";
    if ((impacts.includes("cost") || impacts.includes("errors")) && severity === "low") {
      severity = "high";
    }
    const summary = String(h.summary ?? "").slice(0, 400).trim();
    if (!summary) continue;
    seen.add(file);
    out.push({
      file,
      lineRange,
      impacts,
      severity,
      summary,
      detail: h.detail ? String(h.detail).slice(0, 800) : undefined,
      diff: hunkPatch,
    });
  }
  for (const f of files) {
    if (seen.has(f.filename)) continue;
    const inferred = inferImpactsFromPatch(f.filename, f.patch);
    if (!inferred.length) continue;
    const first = firstHunkForFile(f.filename);
    out.push({
      file: f.filename,
      lineRange: first?.range ?? "?",
      impacts: inferred,
      severity: inferred.includes("docs") && inferred.length === 1 ? "low" : "medium",
      summary: `${f.filename} changed`,
      diff: first?.patch ?? f.patch,
    });
  }
  return out;
}

const insertPrediction = db.prepare(`
  INSERT INTO predictions (
    pr_number, head_sha, merged_sha, estimated_cost_delta_pct,
    estimated_latency_delta_pct, rationale, suspect_hints
  ) VALUES (?, ?, NULL, ?, ?, ?, ?)
`);

const markMerged = db.prepare(
  `UPDATE predictions SET merged_sha = ? WHERE pr_number = ? AND (merged_sha IS NULL OR merged_sha = '')`,
);

type LlmHunk = {
  hunk_id?: string;
  file?: string;
  line_range?: string;
  impacts: string[];
  severity: string;
  summary: string;
  detail?: string;
};

type LlmInsight = {
  estimated_latency_delta_pct: number;
  rationale: string;
  endpoint_risks?: string[];
  error_risks?: string[];
  prompt_risks?: string[];
  hunks?: LlmHunk[];
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

  const hunkIndex = enumerateHunks(files);
  const fileList = files.map((f) => `- ${f.filename} (${f.status})`).join("\n");
  const hunkLines = hunkIndex.list
    .map((h) => {
      const preview = h.patch
        .split("\n")
        .filter((l) => /^[+-]/.test(l))
        .slice(0, 2)
        .join(" ")
        .slice(0, 140);
      return `${h.id} · ${h.file} · lines +${h.range} · ${preview}`;
    })
    .join("\n");
  const diffBody = files
    .map((f) => `--- ${f.filename} (${f.status})\n${f.patch ?? ""}`)
    .join("\n\n")
    .slice(0, 24_000);
  const diff = `Changed files (${files.length}):\n${fileList}\n\nHUNKS — reference every meaningful hunk by its exact hunk_id (e.g. "h3"). Never invent an id:\n${hunkLines || "(no hunks available — fall back to file + line_range)"}\n\nFull diff:\n${diffBody}`;

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
{"estimated_latency_delta_pct": number, "rationale": string, "endpoint_risks": string[], "error_risks": string[], "prompt_risks": string[], "hunks": [{"hunk_id": string, "impacts": string[], "severity": "high"|"medium"|"low", "summary": string, "detail": string}], "suspect_hints": {"files": string[], "models": string[], "params": string[], "endpoints": string[], "functions": string[]}}

hunks is the MOST IMPORTANT field. The user message contains a HUNKS list where every hunk of the diff has an id (h1, h2, ...). For every meaningful hunk, produce one entry:
- hunk_id: copied EXACTLY from the HUNKS list — never invent an id, never reuse an id. One entry per hunk. If a logical change spans two hunks, use the hunk that contains the core of the change and mention the other in detail.
- impacts: exactly ONE primary impact from ["cost","latency","errors","prompt","dataflow","docs"] — what this hunk affects most. Add a second impact ONLY if the same lines genuinely do two things (e.g. a longer system prompt that also adds tokens → ["prompt","cost"]). Do not sprinkle tags.
- severity: "high" for anything meaningfully user-facing (cost >100%, new 5xx path, blocked request path), "medium" for moderate (extra tokens, mild slowdown, new dependency), "low" for docs/typos/comments/refactors that don't change runtime behavior
- summary: one short sentence, high-signal, human-readable — e.g. 'model "mini" → "gpt-4o" (~12x per output token)'
- detail: optional 1-2 sentences of deeper explanation for the PR comment

Do not create hunks for whitespace-only or import-order changes.

HARD RULES for impacts:
- A model id / MODEL constant change (e.g. gpt-4o-mini → gpt-4o) is ALWAYS impacts=["cost"], never "docs".
- A new throw / 5xx / fail-closed branch is ALWAYS impacts=["errors"].
- A new sequential await / helper on an EXISTING request path is impacts=["latency"].
- A brand-new endpoint or new file with no await on an existing path is impacts=["dataflow"], never "latency" or "cost".
- A longer system prompt is impacts=["prompt"] (and "cost" only if it adds meaningful tokens).
- "docs" is ONLY for README/markdown/comments with no runtime effect.

IMPORTANT: You will receive a list of changed files at the top of the user message. Every changed file that has runtime effect MUST have at least one hunk in your response — you cannot silently drop a file. If a file is docs-only or truly no-op, emit a single hunk with impacts=["docs"] and severity="low". Missing a file is the worst failure mode.

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
  const hunks = parseHunks(parsed.hunks, files, hunkIndex).map((h) =>
    // A cost decrease is a recovery, not a risk: never render it as high severity.
    cost < 0 && h.impacts.includes("cost") && h.severity === "high" ? { ...h, severity: "low" as InsightSeverity } : h,
  );
  const hints = {
    ...(typeof parsed.suspect_hints === "object" && parsed.suspect_hints ? parsed.suspect_hints : {}),
    authors,
    endpoint_risks: endpointRisks,
    error_risks: errorRisks,
    prompt_risks: promptRisks,
    hunks,
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
    hunks,
  });
  await commentOnPr(prNumber, body);
  await maybePostInsightChannel({
    prNumber,
    sha: headSha,
    costPct: cost,
    latencyPct: latency,
    title,
    authorLogin: authors[0],
    errorRisks,
    endpointRisks,
    hunks,
  });
  console.log(`insight: PR #${prNumber} cost ${cost}% latency ${latency}% authors=${authors.length}`);
}

async function maybePostInsightChannel(input: {
  prNumber: number;
  sha: string;
  costPct: number;
  latencyPct: number;
  title?: string;
  authorLogin?: string;
  errorRisks: string[];
  endpointRisks: string[];
  hunks?: InsightHunk[];
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
