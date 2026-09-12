import OpenAI from "openai";
import { config } from "./config.js";
import { db } from "./db.js";
import { commitFiles, githubCompare } from "./github.js";

const insertCommit = db.prepare(`
  INSERT INTO commit_analysis
    (sha, deploy_sha, baseline_sha, author_login, message, category, severity, summary, diff_blob, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sha) DO UPDATE SET
    deploy_sha = excluded.deploy_sha,
    baseline_sha = excluded.baseline_sha,
    category = excluded.category,
    severity = excluded.severity,
    summary = excluded.summary,
    diff_blob = excluded.diff_blob
`);

const getCommitsForDeploy = db.prepare(
  `SELECT sha, author_login, message, category, severity, summary, diff_blob
     FROM commit_analysis WHERE deploy_sha = ? ORDER BY rowid ASC`,
);

const alreadyAnalyzed = db.prepare(
  `SELECT COUNT(*) AS n FROM commit_analysis WHERE deploy_sha = ? AND baseline_sha = ?`,
);

export type CommitClassification = {
  sha: string;
  author_login: string | null;
  message: string;
  category: string;
  severity: string;
  summary: string;
  diff_blob?: string | null;
};

type LlmClassification = {
  commits?: {
    sha: string;
    category: string;
    severity: string;
    summary: string;
  }[];
};

const ALLOWED_CATEGORIES = new Set([
  "cost",
  "latency",
  "errors",
  "prompt",
  "dataflow",
  "docs",
  "refactor",
]);

const ALLOWED_SEVERITIES = new Set(["high", "medium", "low"]);

function inferCategoryFromMessage(message: string): string | null {
  const m = message.toLowerCase();
  // Docs first: a commit whose message says README/docs is docs even if it mentions a model.
  if (/readme|docs|note the/.test(m)) return "docs";
  if (/\bgpt-4|\bmodel\b|richer replies|bump chat/.test(m)) return "cost";
  if (/fail closed|escalat|throw|5xx|error/.test(m)) return "errors";
  if (/enrich|latency|request path|timeout/.test(m)) return "latency";
  if (/system prompt|house style|prompt/.test(m)) return "prompt";
  return null;
}

export function loadCommitAnalysis(deploySha: string): CommitClassification[] {
  return getCommitsForDeploy.all(deploySha) as CommitClassification[];
}

export async function analyzeDeployCommits(deploySha: string, baselineSha: string): Promise<void> {
  const existing = alreadyAnalyzed.get(deploySha, baselineSha) as { n: number };
  if (existing.n > 0) return;

  const cmp = await githubCompare(baselineSha, deploySha);
  const commits = (cmp.commits ?? []).filter(
    (c) => !/^(Merge( pull request)? |Revert )/i.test(c.commit.message),
  );
  if (!commits.length) return;

  const commitBlobs = commits.map((c) => ({
    sha: c.sha,
    author: c.author?.login ?? c.commit.author?.name ?? "unknown",
    message: (c.commit.message ?? "").split("\n")[0]!.slice(0, 200),
  }));

  // Per-commit diffs: blame must work even when the commit message is vague —
  // the diff is where the bug actually lives. The compare is oldest-first, so
  // take the NEWEST commits.
  const diffBySha = new Map<string, string>();
  for (const c of commitBlobs.slice(-8)) {
    try {
      const files = await commitFiles(c.sha);
      const blob = files
        .map((f) => `--- ${f.filename}\n${f.patch ?? ""}`)
        .join("\n\n")
        .slice(0, 2_500);
      if (blob.trim()) diffBySha.set(c.sha, blob);
    } catch (err) {
      console.error(`commit files ${c.sha.slice(0, 7)}`, err);
    }
  }

  const patchByFile = new Map<string, string>();
  for (const f of cmp.files ?? []) {
    if (f.patch) patchByFile.set(f.filename, f.patch.slice(0, 4000));
  }
  const diffBlob = [...patchByFile.entries()]
    .map(([file, patch]) => `--- ${file}\n${patch}`)
    .join("\n\n")
    .slice(0, 16_000);

  if (!config.openaiApiKey) {
    for (const c of commitBlobs) {
      insertCommit.run(
        c.sha,
        deploySha,
        baselineSha,
        c.author,
        c.message,
        "refactor",
        "low",
        c.message.slice(0, 200),
        diffBySha.get(c.sha) ?? null,
        new Date().toISOString(),
      );
    }
    return;
  }

  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl || undefined,
    timeout: 30_000,
  });

  const commitList = commitBlobs
    .map((c, i) => `${i + 1}. ${c.sha.slice(0, 7)} — ${c.author} — "${c.message}"`)
    .join("\n");

  const commitDiffs = commitBlobs
    .map((c, i) => {
      const d = diffBySha.get(c.sha);
      return d ? `${i + 1}. ${c.sha.slice(0, 7)} own diff:\n${d.slice(0, 700)}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  const system = `You classify each commit in a merged deploy by production impact.

Return JSON only:
{"commits": [{"sha": "<7-char>", "category": "cost"|"latency"|"errors"|"prompt"|"dataflow"|"docs"|"refactor", "severity": "high"|"medium"|"low", "summary": "<one short sentence>"}]}

Categories:
- cost: LLM cost impact (model swap, tokens, extra calls)
- latency: request path latency (sequential awaits, new dependencies, blocking I/O)
- errors: new 4xx/5xx paths, removed try/catch, unchecked null
- prompt: system/user prompt template changes affecting output length or quality
- dataflow: new external calls, changed retry/timeout, data shape changes
- docs: documentation, comments, README
- refactor: code moves, renames, no runtime impact

Severity: high (user-facing, cost >100%, new 5xx), medium (moderate), low (no runtime impact).

HARD RULES:
- Classify from the commit's OWN diff, not its message. A vague message like "handle special orders" whose diff adds a 503/throw path is ALWAYS errors, never refactor.
- You must return one entry per commit, using the 7-char sha prefix as identifier. Do not merge commits.`;

  const user = `Deploy: ${deploySha.slice(0, 7)} (baseline ${baselineSha.slice(0, 7)}).

Commits in order:
${commitList}

Per-commit diffs — use these to attribute each change:
${commitDiffs || "(no per-commit diffs available)"}

Full diff of the compare (for context — attribute changes to the commits based on message and file patterns):
${diffBlob}`;

  let parsed: LlmClassification = {};
  try {
    const res = await client.chat.completions.create({
      model: config.llmModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}") as LlmClassification;
  } catch (err) {
    console.error(`commit analysis LLM ${deploySha.slice(0, 7)}`, err);
  }

  const byShaPrefix = new Map<string, { category: string; severity: string; summary: string }>();
  for (const c of parsed.commits ?? []) {
    if (!c || typeof c.sha !== "string") continue;
    const prefix = c.sha.slice(0, 7).toLowerCase();
    const category = ALLOWED_CATEGORIES.has(c.category) ? c.category : "refactor";
    const severity = ALLOWED_SEVERITIES.has(c.severity) ? c.severity : "low";
    const summary = String(c.summary ?? "").slice(0, 300);
    byShaPrefix.set(prefix, { category, severity, summary });
  }

  const now = new Date().toISOString();
  for (const c of commitBlobs) {
    const prefix = c.sha.slice(0, 7).toLowerCase();
    const inferred = inferCategoryFromMessage(c.message);
    const llm = byShaPrefix.get(prefix);
    // A deterministic docs signal (README/note the/docs in the message) always wins —
    // the LLM must not upgrade a docs commit to cost/latency because it mentions a model.
    const category =
      inferred === "docs"
        ? "docs"
        : inferred && (!llm || llm.category === "docs" || llm.category === "refactor")
          ? inferred
          : (llm?.category ?? inferred ?? "refactor");
    const severity =
      category === "docs"
        ? "low"
        : category === "cost" || category === "errors"
          ? llm?.severity === "low"
            ? "high"
            : (llm?.severity ?? "high")
          : (llm?.severity ?? "low");
    const summary = llm?.summary || c.message.slice(0, 200);
    insertCommit.run(
      c.sha,
      deploySha,
      baselineSha,
      c.author,
      c.message,
      category,
      severity,
      summary,
      diffBySha.get(c.sha) ?? null,
      now,
    );
  }
  console.log(`commit analysis: ${commitBlobs.length} commits classified for ${deploySha.slice(0, 7)}`);
}
