import express from "express";
import { config } from "./config.js";
import { dbHealth } from "./db.js";
import { ingest } from "./ingest.js";
import { githubWebhook } from "./webhooks/github.js";
import { getDeployBySha, postDeploy, vercelWebhook } from "./deploys.js";
import { startWorker } from "./worker.js";

const app = express();

app.post("/webhooks/github", express.raw({ type: "application/json" }), githubWebhook);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: dbHealth() });
});

app.post("/ingest", ingest);
app.post("/deploys", postDeploy);
app.get("/deploys/:sha", getDeployBySha);
app.post("/webhooks/vercel", vercelWebhook);

app.listen(config.port, () => {
  console.log(`blast-radius agent listening on :${config.port}`);
  startWorker();
});
