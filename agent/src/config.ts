import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  databasePath: process.env.DATABASE_PATH ?? "./data/blast-radius.db",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  ambiguousApiKey: process.env.AMBIGUOUS_API_KEY ?? "",
  ambiguousChannelId: process.env.AMBIGUOUS_CHANNEL_ID ?? "",
  ambiguousSheetId: process.env.AMBIGUOUS_SHEET_ID ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  githubRepo: process.env.GITHUB_REPO ?? "",
  ingestToken: process.env.INGEST_TOKEN ?? "",
  minRequests: Number(process.env.MIN_REQUESTS ?? 20),
  costRegressionPct: Number(process.env.COST_REGRESSION_PCT ?? 20),
  latencyRegressionPct: Number(process.env.LATENCY_REGRESSION_PCT ?? 20),
  pollMinutes: Number(process.env.POLL_MINUTES ?? 15),
  vercelToken: process.env.VERCEL_TOKEN ?? "",
  vercelProjectId: process.env.VERCEL_PROJECT_ID ?? "",
  demoUrl: process.env.DEMO_URL ?? "",
};
