# Blast Radius

**An agent that lives where deploys happen — not in a chatbox.**

Blast Radius is a production-safety agent for LLM apps. It joins your team's workspace (Ambiguous AI) as a provisioned member and owns the risk loop around every deploy: it estimates the impact of a pull request before merge, verifies that estimate against live traffic after deploy, raises evidence-backed regression alerts in the channel, waits for a human decision, and — only on command — rolls back the offending commit. Every decision lands in the workspace as a Task, a postmortem Doc, and a Ledger Sheet row. The human never leaves the channel.

It watches **LLM cost**, **LLM latency**, **HTTP/endpoint latency** (non-LLM spans), and **error rate**. Rollback is never automatic.

---

## The loop

```
PR opened ──► INSIGHT (per-hunk risk estimate on the PR + channel)
   │
merge ──► deploy recorded (Vercel webhook or first ingest for a new SHA)
   │
traffic ──► evaluation vs previous release (≥ MIN_REQUESTS requests)
   │
breach? ──► alert in Ambiguous (evidence table: error log ↔ commit ↔ author)
   │
human:  /blast-radius keep|status|rollback <commit-id>
   │
rollback ──► git revert commit on master (only the chosen commit is undone)
   │         revert deploy recorded, never evaluated
   ▼
postmortem Doc + Ledger Sheet row + Watch Task — per evaluation, automatically
```

**One deploy, one verdict** — but every evaluation is preserved: the same deploy can be documented first as a cost regression and later as an error spike, each with its own postmortem and ledger row. `status` shows the full evaluation history.

## Verdicts & thresholds

| Verdict | Breach condition | Alert |
|---|---|---|
| `cost_regression` | cost/request vs previous release ≥ `COST_REGRESSION_PCT` (default 30) | 🔴 |
| `latency_regression` | http/llm span latency ≥ `LATENCY_REGRESSION_PCT` (default 30) | 🟡 |
| `error_spike` | error rate rises from the previous release | 🚨 |
| `ok` / `insufficient_data` / `skipped_revert` | no breach / < `MIN_REQUESTS` traffic / revert deploy | silent |

## Commands (in the Ambiguous channel)

| Command | Targets | Effect |
|---|---|---|
| `/blast-radius rollback <commit-id>` | a commit from the alert table | production reverts to **just before that commit** — everything else stays |
| `/blast-radius keep <deploy-sha>` | the deploy | accept and keep watching; creates a Watch Task, postmortem, ledger row |
| `/blast-radius status <deploy-sha>` | any known deploy | fresh numbers + evaluation history (+ deploy state for closed deploys) |

Rollback safety guards: the deploy must be awaiting approval, and it must be the tip of the default branch — otherwise the rollback is refused with a reason in the thread.

## Architecture

```
blast-radius (this repo)
├── agent/                  the agent — Express + SQLite + LLM orchestration
│   ├── src/insight.ts      pre-merge analysis (deterministic price table + per-hunk LLM)
│   ├── src/evaluator.ts    live vs baseline comparison, evaluation history
│   ├── src/alertFormat.ts  alert rendering: evidence tables, diff-based blame
│   ├── src/approval.ts     channel commands, approval window, timeout
│   ├── src/rollbackQueue.ts  crash-safe rollback queue (CAS claim, dedupe)
│   ├── src/commitAnalysis.ts per-commit classification (own diff aware)
│   ├── src/ledger.ts       postmortem Docs + Ledger Sheet (per evaluation)
│   └── src/webhooks/       GitHub (HMAC-SHA256) + Vercel webhooks
└── scripts/seed-traffic.js   drives real traffic against the demo app
```

`blast-radius-demo` (separate repo) is the observed app: a Next.js LLM endpoint that ingests OTel-shaped spans (`http`, `llm`, `function`) with `service.version` = the deploy SHA.

## Setup

```bash
cd agent
cp .env.example .env   # fill in the keys
npm install
npm run dev            # tsx watch — hot reload
```

`GET /health` → `{ "ok": true, "db": "up" }`. The agent listens on `PORT` (default **3001**; the demo app uses 3000).

| Env var | Purpose |
|---|---|
| `OPENAI_API_KEY` / `LLM_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` | LLM calls (INSIGHT, root cause, commit classification) |
| `AMBIGUOUS_AGENT_API_KEY`, `AMBIGUOUS_API_KEY`, `AMBIGUOUS_AGENT_ID`, `AMBIGUOUS_CHANNEL_ID`, `AMBIGUOUS_SHEET_ID` | the workspace the agent lives in |
| `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPO` | PR analysis, webhooks, revert commits |
| `INGEST_TOKEN` | telemetry ingestion auth |
| `MIN_REQUESTS` (5), `COST_REGRESSION_PCT` (30), `LATENCY_REGRESSION_PCT` (30) | evaluation thresholds |
| `COMMAND_MINUTES` / `POLL_MINUTES` (15) | approval window + channel poll |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` | optional Vercel API access |
| `DATABASE_PATH` | SQLite location (default `./data/blast-radius.db`) |

`npm run bootstrap` provisions the "Blast Radius" agent user in the workspace and the Ledger sheet. `npm run reset` wipes DB, channel messages, tasks, docs and sheet rows for a clean rehearsal.

## Docker

Security-conscious image: multi-stage build, non-root user, healthcheck, no secrets, dependency audit gate in the build.

```bash
docker build -t blast-radius-agent ./agent
docker run -d --init --name blast-radius \
  -p 3001:3001 \
  -v blast-radius-data:/data \
  --env-file ./agent/.env \
  blast-radius-agent
```

- Runs as a non-root user; writes only to `/data` (volume).
- `HEALTHCHECK` hits `/health` every 30s.
- The image contains no credentials — all secrets come from the env file at runtime.
- The build stage runs `npm ci` (lockfile-pinned) and fails on high/critical `npm audit` findings.

## Webhooks

GitHub and Vercel cannot reach localhost — expose the agent while testing:

```bash
cloudflared tunnel --url http://localhost:3001
```

1. **GitHub** — on **blast-radius-demo** (not the agent repo): Settings → Webhooks → `https://<tunnel>/webhooks/github`. Content type `application/json`. Secret = `GITHUB_WEBHOOK_SECRET`. Events: **Pull requests** and **Pushes**. A `push` to the default branch records the deploy; the first `/ingest` for an unknown SHA does the same.
2. Smoke test without GitHub: `POST /deploys` `{"sha":"<git sha>"}` with `Authorization: Bearer $INGEST_TOKEN`.

## Failure handling

Every scenario is handled explicitly; undocumented handling scores as missing. Summary:

| Scenario | Behavior |
|---|---|
| LLM timeout / failure (INSIGHT, root cause, classification) | retried once, then degrades: deterministic fallbacks (price table, pattern inference, commit message + diff matching) keep the pipeline running |
| GitHub 5xx / rate limit | retries; PR comment and channel post still degrade to the deterministic content |
| Duplicate webhook deliveries | `processed_events` idempotency — each delivery handled once |
| Insufficient data (< `MIN_REQUESTS`) | deploy marked `insufficient_data`; when traffic later arrives it is **recovered and evaluated** automatically |
| Revert deploys | recorded as `skipped_revert`, never evaluated, noted in the original thread |
| No approval in time (default 15 min) | "I did not roll back, still watching" + Watch Task + postmortem (outcome `timeout`) |
| No auto-rollback | rollback only via channel command, behind guards (awaiting approval, tip of branch, queue dedupe) |
| Crash mid-rollback | rollback queue (`rollback_intents`) recovers on boot: `in_progress` intents are re-queued or resolved |
| Bad ingest payload | 400 with required fields listed; auth required (`INGEST_TOKEN`) |
| Baseline missing | "no baseline with enough traffic" — no false alerts |
| Unknown command / SHA | channel reply: "no deploy or commit matches" — never silent |

## Message catalog

**Channel:** INSIGHT pre-merge post · cost regression alert · latency regression alert · error spike alert (evidence table) · status reply (+ evaluation history) · keep reply · timeout reply · rollback queued ack · rollback result · rollback skipped · already-rolled-back note · revert-deploy note · unknown-command reply.

**GitHub:** INSIGHT PR comment (full per-hunk breakdown). **Workspace objects:** postmortem Doc per evaluation · Ledger Sheet row per evaluation · Watch Task per keep.

## Security notes

- GitHub webhooks verified with HMAC-SHA256 (`timingSafeEqual`); ingest/deploys endpoints are token-gated.
- All SQL is parameterized; no shell execution; outbound HTTP only to fixed hosts (github.com, app.ambiguous.ai).
- No secrets in the image or the repository — `.env` is never tracked; history has been scanned clean.
- Dependabot vulnerability alerts enabled; `npm audit` clean.
