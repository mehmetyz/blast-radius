# Blast Radius

An AI agent that owns a bad LLM deploy: estimate impact on the PR, verify that estimate after deploy, alert in Ambiguous, wait for a human, then rollback.

See [SPEC.md](SPEC.md) and [TASKS.md](TASKS.md).

## Run

```bash
cd agent
cp .env.example .env   # fill in keys
npm install
npm run dev
```

Agent listens on port **3001** (demo app uses 3000). `GET /health` should return `{ "ok": true, "db": "up" }`.

GitHub and Vercel cannot reach localhost. While the agent stays local, expose it:

```bash
cloudflared tunnel --url http://localhost:3001
```

Then:

1. **GitHub** — on **blast-radius-demo** (not the agent repo): Settings → Webhooks → `https://<tunnel>/webhooks/github`. Content type `application/json`. Secret = `GITHUB_WEBHOOK_SECRET`. Events: **Pull requests** and **Pushes**. Vercel paid webhooks are not used; a `push` to `main`/`master` records the deploy, and the first `/ingest` for a new SHA does the same.

Local smoke test without GitHub: `POST /deploys` `{"sha":"<git sha>"}`.

```bash
docker build -t blast-radius-agent ./agent
```

Demo app lives in the separate `blast-radius-demo` repo. Telemetry is generated there and posted to this agent; `scripts/seed-traffic.js` drives ≥20 real requests per deploy.

## Failure handling

Required behaviors ship in A1–A3 (see SPEC). This heading will list each scenario and the behavior before submission — jury reads README, not the source tree.
