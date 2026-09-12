import express from "express";
import { config } from "./config.js";
import { dbHealth } from "./db.js";
import { ingest } from "./ingest.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, db: dbHealth() });
});

app.post("/ingest", ingest);

app.listen(config.port, () => {
  console.log(`blast-radius agent listening on :${config.port}`);
});
