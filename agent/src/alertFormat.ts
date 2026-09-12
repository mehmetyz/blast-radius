import { config } from "./config.js";
import { db } from "./db.js";
import { findMessageByThreadKey, postMessage, updateMessage } from "./ambiguous.js";
import { evaluateDeploy } from "./evaluator.js";

type Slice = {
  sha: string;
  n: number;
  cost_usd: number;
  cost_per_req: number;
  latency_ms: number;
  error_rate: number;
};

export type AlertSuspect = {
  rank: number;
  pr_number?: number | null;
  author_login?: string | null;
  confidence: number;
  reason: string;
};

const suspectsFor = db.prepare(
  `SELECT rank, pr_number, author_login, confidence, reason FROM suspects WHERE sha = ? ORDER BY rank, id`,
);
const predFor = db.prepare(
  `SELECT estimated_cost_delta_pct, estimated_latency_delta_pct
     FROM predictions
    WHERE merged_sha = ? OR head_sha = ?
    ORDER BY id DESC LIMIT 1`,
);

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function pct(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
  return `${sign}${body}%`;
}

function pp(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
  return `${sign}${body} pp`;
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const s = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `$${s}`;
}

function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

function errPct(n: number): string {
  return `${(n * 100).toFixed(n >= 0.01 ? 1 : 0)}%`;
}

function bar(ratio: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function pairBars(a: number, b: number, width = 16): { a: string; b: string; log: boolean } {
  const aAbs = Math.abs(a);
  const bAbs = Math.abs(b);
  const hi = Math.max(aAbs, bAbs, 1);
  const lo = Math.max(Math.min(aAbs, bAbs), 1);
  if (hi / lo > 4) {
    const maxLog = Math.log10(hi);
    return {
      a: bar(Math.log10(Math.max(aAbs, 1)) / maxLog, width),
      b: bar(Math.log10(Math.max(bAbs, 1)) / maxLog, width),
      log: true,
    };
  }
  return { a: bar(aAbs / hi, width), b: bar(bAbs / hi, width), log: false };
}

function confBar(confidence: number): string {
  const pctVal = confidence <= 1 ? confidence * 100 : confidence;
  return bar(pctVal / 100, 10);
}

function verdictLabel(verdict: string): string {
  if (verdict === "cost_regression") return "cost regression";
  if (verdict === "latency_regression") return "latency regression";
  if (verdict === "error_spike") return "error spike";
  return verdict.replaceAll("_", " ");
}

function compareUrl(base?: string, head?: string): string | null {
  if (!config.githubRepo || !base || !head) return null;
  return `https://github.com/${config.githubRepo}/compare/${base}...${head}`;
}

function prUrl(n: number): string {
  return `https://github.com/${config.githubRepo}/pull/${n}`;
}

function times(actual: number, predicted: number): string | null {
  if (predicted === 0) return null;
  const ratio = actual / predicted;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const body = ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1);
  return `${body}x`;
}

function padPct(n: number, width = 7): string {
  return pct(n).padStart(width);
}

export function formatRegressionAlert(input: {
  sha: string;
  baseline_sha?: string;
  verdict: string;
  actual_cost_delta_pct: number;
  actual_latency_delta_pct: number;
  predicted_cost_delta_pct: number | null;
  predicted_latency_delta_pct?: number | null;
  prediction_error_pp: number | null;
  current: Slice;
  baseline: Slice;
  suspects: AlertSuspect[];
  compareUrl?: string | null;
  note?: string;
}): string {
  const sha7 = shortSha(input.sha);
  const base7 = input.baseline_sha ? shortSha(input.baseline_sha) : "n/a";
  const predCost = input.predicted_cost_delta_pct;
  const predLat = input.predicted_latency_delta_pct ?? null;
  const multiple = predCost != null ? times(input.actual_cost_delta_pct, predCost) : null;
  const costBars =
    predCost != null
      ? pairBars(predCost, input.actual_cost_delta_pct)
      : { a: bar(0), b: bar(1), log: false };
  const reqHi = Math.max(input.current.cost_per_req, input.baseline.cost_per_req, 1e-12);
  const reqThen = bar(input.baseline.cost_per_req / reqHi);
  const reqNow = bar(input.current.cost_per_req / reqHi);
  const reqX = input.baseline.cost_per_req > 0 ? input.current.cost_per_req / input.baseline.cost_per_req : null;
  const reqXLabel = reqX && Number.isFinite(reqX) ? `${reqX >= 10 ? reqX.toFixed(0) : reqX.toFixed(1)}x` : null;
  const latWord = input.actual_latency_delta_pct < 0 ? "faster" : "slower";

  const headline =
    predCost != null && multiple
      ? `**${verdictLabel(input.verdict)}** on \`${sha7}\`. Live cost is **${multiple}** the INSIGHT forecast.`
      : `**${verdictLabel(input.verdict)}** on \`${sha7}\` vs \`${base7}\`.`;

  const liveCostMeta = [multiple, costBars.log ? "log" : ""].filter(Boolean).join("  ");
  const insightInner =
    predCost == null
      ? [
          `cost     live     ${padPct(input.actual_cost_delta_pct)}  ${costBars.b}`,
          `latency  live     ${padPct(input.actual_latency_delta_pct)}`,
        ]
      : [
          `cost     INSIGHT  ${padPct(predCost)}  ${costBars.a}`,
          `         live     ${padPct(input.actual_cost_delta_pct)}  ${costBars.b}${liveCostMeta ? `  ${liveCostMeta}` : ""}`,
          ...(predLat == null
            ? [`latency  live     ${padPct(input.actual_latency_delta_pct)}  ${latWord}`]
            : [
                `latency  INSIGHT  ${padPct(predLat)}`,
                `         live     ${padPct(input.actual_latency_delta_pct)}  ${latWord}`,
              ]),
        ];
  const insightBlock = ["```", ...insightInner, "```"];

  const miss = input.prediction_error_pp == null ? null : `Miss **${pp(input.prediction_error_pp)}**.`;

  const suspects =
    input.suspects.length === 0
      ? "_No ranked suspects yet._"
      : input.suspects
          .map((s) => {
            const who = s.author_login ? `**${s.author_login}**` : "_unknown_";
            const pr =
              s.pr_number != null && config.githubRepo
                ? ` [#${s.pr_number}](${prUrl(s.pr_number)})`
                : s.pr_number != null
                  ? ` #${s.pr_number}`
                  : "";
            const conf = s.confidence <= 1 ? s.confidence * 100 : s.confidence;
            return `${s.rank}. ${who}${pr}  \`${confBar(conf)}\` ${Math.round(conf)}%\n    ${s.reason}`;
          })
          .join("\n");

  const link = input.compareUrl ? `[Compare ${base7}...${sha7}](${input.compareUrl})` : null;

  return [
    "## Blast Radius",
    headline,
    input.note ? `> ${input.note}` : "",
    "",
    "### INSIGHT vs live",
    ...insightBlock,
    miss ?? "",
    "",
    "### Traffic",
    `**$/req**  ${usd(input.baseline.cost_per_req)} \`${base7}\` n=${input.baseline.n}  →  **${usd(input.current.cost_per_req)}** \`${sha7}\` n=${input.current.n}${reqXLabel ? `  ·  **${reqXLabel}**` : ""}`,
    `**latency**  ${ms(input.baseline.latency_ms)} → ${ms(input.current.latency_ms)}`,
    `**errors**  ${errPct(input.baseline.error_rate)} → ${errPct(input.current.error_rate)}`,
    "",
    "```",
    `$/req  then  ${reqThen}  ${base7}`,
    `       now   ${reqNow}  ${sha7}`,
    "```",
    "",
    "### Suspects (ranked, not a culprit)",
    suspects,
    "",
    "_No rollback. This thread owns the deploy._",
    link ?? "",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n")
    .trim() + "\n";
}

export async function postFormattedAlert(
  sha: string,
  opts: { startsNewBlock?: boolean; note?: string } = {},
) {
  const evaln = evaluateDeploy(sha);
  if (!evaln || !("current" in evaln) || !evaln.current || !evaln.baseline) {
    throw new Error(`cannot format alert for ${sha}`);
  }
  const suspects = suspectsFor.all(sha) as AlertSuspect[];
  const pred = predFor.get(sha, sha) as
    | { estimated_cost_delta_pct: number | null; estimated_latency_delta_pct: number | null }
    | undefined;
  const content = formatRegressionAlert({
    sha: evaln.sha,
    baseline_sha: evaln.baseline_sha,
    verdict: evaln.verdict,
    actual_cost_delta_pct: evaln.actual_cost_delta_pct,
    actual_latency_delta_pct: evaln.actual_latency_delta_pct,
    predicted_cost_delta_pct: evaln.predicted_cost_delta_pct,
    predicted_latency_delta_pct: pred?.estimated_latency_delta_pct ?? null,
    prediction_error_pp: evaln.prediction_error_pp,
    current: evaln.current,
    baseline: evaln.baseline,
    suspects,
    compareUrl: compareUrl(evaln.baseline_sha, evaln.sha),
    note: opts.note,
  });
  const existing = await findMessageByThreadKey(sha);
  if (existing) return updateMessage(existing.id, content);
  try {
    return await postMessage(content, sha, opts.startsNewBlock ?? true);
  } catch (err) {
    console.error(`alert post ${sha.slice(0, 7)} retry without thread_key`);
    console.error(err);
    return postMessage(content, null, opts.startsNewBlock ?? true);
  }
}
