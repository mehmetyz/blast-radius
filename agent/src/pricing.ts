const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
};

const FALLBACK = { input: 1, output: 5 };

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const name = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  const p = PRICES[name] ?? FALLBACK;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
