import OpenAI from "openai";
import { config } from "./config.js";
import { postFormattedAlert } from "./alertFormat.js";
import { evaluateDeploy } from "./evaluator.js";
import { executeTool, toolSpecs } from "./tools.js";
import { openApproval } from "./approval.js";

const gatherTools = toolSpecs.filter(
  (t) => t.function.name !== "post_message" && t.function.name !== "execute_rollback",
);

type EvalResult = NonNullable<ReturnType<typeof evaluateDeploy>>;

async function chatOnce(
  client: OpenAI,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
) {
  return client.chat.completions.create({
    model: config.llmModel,
    messages,
    tools: gatherTools,
  });
}

async function runGatherLoop(system: string, user: string): Promise<string | undefined> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");
  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl || undefined,
    timeout: 30_000,
  });

  const seed: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const run = async () => {
    const messages = [...seed];
    for (let i = 0; i < 8; i++) {
      const res = await chatOnce(client, messages);
      const msg = res.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);
      if (!msg.tool_calls?.length) break;
      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue;
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        const out = await executeTool(call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }
  };

  try {
    await run();
  } catch (first) {
    console.error("agent tools retry", first);
    try {
      await run();
    } catch (second) {
      console.error("agent tools failed", second);
      return "LLM timed out — stats only.";
    }
  }
  return undefined;
}

export async function runActiveAgent(sha: string) {
  const evaln = evaluateDeploy(sha);
  if (!evaln || evaln.verdict === "ok") return;

  const note =
    evaln.verdict === "error_spike"
      ? await runRootCause(sha, evaln)
      : await runActive(sha, evaln);

  await postFormattedAlert(sha, { startsNewBlock: true, note });
  await openApproval(sha);
}

async function runActive(sha: string, evaln: EvalResult): Promise<string | undefined> {
  return runGatherLoop(
    `You are Blast Radius ACTIVE. Post-merge live spans vs the previous release (LLM cost, HTTP/function latency, errors).
Gather context, then record_suspects ONLY for commits that can plausibly explain the regression (model or token changes for cost, new awaits for latency, etc). Omit docs, README, and unrelated refactors — 1-3 real suspects is correct, filler is worse than none.
Set commit_sha on each suspect to the commit's SHA from github_compare (full or 7 chars, never invented). Each suspect must name the author and a concrete file, endpoint, or function.
Do not post chat. Do not roll back. Do not claim certainty.`,
    `Deploy ${sha} looks like a ${evaln.verdict}. Evaluation JSON:\n${JSON.stringify(evaln)}`,
  );
}

async function runRootCause(sha: string, evaln: EvalResult): Promise<string | undefined> {
  return runGatherLoop(
    `You are Blast Radius ROOT CAUSE. Production errors started after a deploy.
Use list_errors and github_compare. Then:
1. Match every error_message to the commit that introduced it: set commit_sha on each suspect to that commit's SHA (copied from github_compare output, full or 7 chars). Example: error "escalated order — fail closed" matches the commit titled "fail closed on escalate". When the commit MESSAGE is vague (e.g. "cleanup", "fix edge case"), match through the commit's DIFF instead — the error text (or the condition it describes) will appear in the changed lines. The commit_sha must come from the compare — never invent one.
2. Rank by how directly a commit explains the errors: the commit whose message or diff matches the error_message is ALWAYS rank 1 with the highest confidence. Other commits follow below it.
3. record_suspects ONLY for commits that can plausibly cause these errors (the erroring code path, changed data shapes, retry/timeout changes). Omit docs, README, model swaps, and unrelated refactors — 1-3 real suspects is correct, filler is worse than none.
4. record_fix: started_after_sha (first SHA where errors appeared), one-sentence root_cause, concrete fix (file or route + what to change). Rollback is a last resort, not the only fix.
Do not post chat. Do not roll back. Do not claim certainty.`,
    `Deploy ${sha} has an error spike. Evaluation JSON:\n${JSON.stringify(evaln)}`,
  );
}
