import OpenAI from "openai";
import { config } from "./config.js";
import { postFormattedAlert } from "./alertFormat.js";
import { evaluateDeploy } from "./evaluator.js";
import { executeTool, toolSpecs } from "./tools.js";

const gatherTools = toolSpecs.filter((t) => t.function.name !== "post_message");

export async function runActiveAgent(sha: string) {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");
  const evaln = evaluateDeploy(sha);
  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl || undefined,
    timeout: 30_000,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are Blast Radius. Gather context, then record_suspects (ranked, never a single culprit).
Suspect reasons must cite a concrete file or config change (e.g. model bump, max_tokens), not generic "this could impact cost".
Do not post chat. Do not roll back. Do not claim certainty.`,
    },
    {
      role: "user",
      content: `Deploy ${sha} looks like a regression. Evaluation JSON:\n${JSON.stringify(evaln)}`,
    },
  ];

  let note: string | undefined;
  try {
    for (let i = 0; i < 8; i++) {
      const res = await client.chat.completions.create({
        model: config.llmModel,
        messages,
        tools: gatherTools,
      });
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
  } catch (err) {
    note = "LLM timed out — stats only.";
    console.error(`agent tools ${sha.slice(0, 7)}`, err);
  }

  await postFormattedAlert(sha, { startsNewBlock: true, note });
}
