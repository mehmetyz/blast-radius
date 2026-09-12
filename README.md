# Blast Radius

**The agent that owns a bad LLM deploy — where your team already works.**

Blast Radius joins your workspace as a real member (Ambiguous AI), watches every deploy of your LLM app, and closes the risk loop end to end: it estimates the impact of a pull request *before* merge, verifies that estimate against live traffic *after* deploy, alerts the team with evidence — not opinion — and rolls back the offending commit *only when a human says so*. Every outcome is written back to the workspace: a Task, a postmortem Doc, a Ledger Sheet row. Nobody ever leaves the channel.

> It's not a chatbot you talk to. It's a teammate that watches production while you keep doing your job.

---

## The problem

A bad LLM deploy looks like this: someone bumps `gpt-4o-mini` to `gpt-4o` on Friday. Cost per request jumps 24×. Errors start on the "escalate" path. Nobody notices until the bill arrives — then the rollback is a panic, the blame is a meeting, and the postmortem is a Word doc nobody reads.

Monitoring tools show you dashboards. Blast Radius shows you **which commit did it**, **what it will cost before you merge**, and **a one-command way back** — in the channel where your team already talks.

## What it does — a real run

From a rehearsal deploy (`blast-radius-demo`, PR #31 — 11 commits):

| Step | What happened |
|---|---|
| **Pre-merge** | INSIGHT analyzed every hunk of the PR: model swap → 🔴 **Cost +1567%** (deterministic price table), new endpoints → Data-flow, fail-closed paths → Errors. Comment on the PR, summary in the channel. |
| **Deploy** | Vercel deployed the merge; the agent recorded it automatically (git SHA from the deployment). |
| **Live check** | Clean traffic seeded. The agent compared against the previous release: **$0.000013 → $0.000317 per request (24×), errors 0% → 16.7% after trigger traffic.** |
| **Alerts** | Two alerts in the channel, each with a table: cost regression (commit · message · impact · author) and error spike (**error log ↔ commit ↔ author**). The commit titled *"handle special orders"* — whose message says nothing about errors — was caught **from its diff** (it added a payment-hold 503). |
| **Prediction bridge** | INSIGHT predicted +1567%; live showed +2338%; the 771pp error is recorded in the ledger — the estimate is scored, not forgotten. The miss is honest: the estimate prices the model swap but not the prompt growth in the same PR (input tokens rose with the longer system prompt) — and the ledger keeps that gap visible instead of hiding it. |
| **Rollback** | A human typed `/blast-radius rollback 460f033` — **only that commit was reverted** (production went back to just before it; quarantine, escalate, and the model swap stayed). Revert deploy recorded, never evaluated, noted in the thread. |
| **Paper trail** | One postmortem Doc per evaluation (cost regression *and* error spike each get their own), one Ledger Sheet row per evaluation, a Watch Task for every kept deploy. |

The prediction bridge, the diff-based blame, and the surgical commit rollback are the parts you won't find in a chatbox.

## Quick start

```bash
cd agent
cp .env.example .env        # fill in the keys (table below)
npm install
npm run bootstrap           # provisions the "Blast Radius" agent user + Ledger sheet
npm run dev                 # tsx watch — hot reload
```

`GET /health` → `{ "ok": true, "db": "up" }` — the agent listens on port **3001**.

### Docker (recommended)

```bash
docker build -t blast-radius-agent ./agent
docker run -d --init --name blast-radius -p 3001:3001 \
  -v blast-radius-data:/data --env-file ./agent/.env blast-radius-agent
```

Multi-stage build, base image pinned by digest to the latest patched Node 22, non-root user, healthcheck, lockfile-pinned deps, and a build-time `npm audit` gate (fails on high/critical). The image ships **zero secrets**.

## Reproduce the demo (≈10 minutes)

1. **Webhooks** — expose the agent (`cloudflared tunnel --url http://localhost:3001`) and point GitHub webhooks of the *demo repo* at it (Pull requests + Pushes, secret = `GITHUB_WEBHOOK_SECRET`). Smoke test: `POST /deploys` with a SHA.
2. **Baseline** — deploy the current state of `blast-radius-demo` and send ≥ `MIN_REQUESTS` (5) requests so there is a previous release to compare against.
3. **Big PR** — open a PR with several commits (model bump, prompt change, new endpoints, error paths). INSIGHT comments within seconds.
4. **Merge** — Vercel deploys; the agent records the deploy (the demo app reports `service.version` from `VERCEL_GIT_COMMIT_SHA` automatically).
5. **Seed** — `scripts/seed-traffic.js` or any ≥5 clean requests → 🔴 cost regression alert with a commit table.
6. **Trigger errors** — any of:

   | Trigger | Endpoint | Result |
   |---|---|---|
   | prompt contains `escalate` | `POST /api/chat` | 502 |
   | `order_id % 7 === 0` | `GET /api/orders?order_id=14` | 503 quarantined |
   | `order_id % 13 === 0` | `GET /api/orders?order_id=13` | 503 payment hold |
   | missing `order_id` | `GET /api/orders` | 500 |
   | item without `name` | `POST /api/report` | 500 |

   → 🚨 error spike alert: error log ↔ commit ↔ author table, the vague-message commit blamed from its diff.
7. **Decide in the channel** — `status <deploy>` (fresh numbers + evaluation history), then `rollback <commit-id>` from the table → "reverting to just before `X`" → the revert deploy ships, and the ledger + postmortems update.
8. **Inspect the workspace** — per-evaluation postmortem Docs, the Ledger Sheet, the Watch Task.

## Commands (typed by humans, in the channel)

| Command | Targets | Effect |
|---|---|---|
| `/blast-radius rollback <commit-id>` | a commit from the alert table | production reverts to **just before that commit** — everything else stays |
| `/blast-radius keep <deploy-sha>` | the deploy | accept and keep watching → Watch Task + postmortem + ledger row |
| `/blast-radius status <deploy-sha>` | any known deploy | fresh numbers + evaluation history (+ state for closed deploys) |

Guards: rollback requires an open approval window and the deploy must be the tip of the default branch — refusals always come with a reason, in the command's own thread.

## How it works

```
PR ──► INSIGHT (per-hunk estimate, PR comment + channel)
 └─► merge ──► deploy recorded ──► traffic ──► evaluation vs previous release
      └─► breach ──► alert (evidence table) ──► human command ──► rollback
            └─► postmortem Doc + Ledger row + Watch Task  (per evaluation)
```

- **Verdicts** — `cost_regression` (≥ `COST_REGRESSION_PCT`, default 30%), `latency_regression` (≥ `LATENCY_REGRESSION_PCT`), `error_spike` (error rate up). `ok`/`insufficient_data`/`skipped_revert` stay silent. One verdict per deploy — but every evaluation is preserved: the same deploy can be documented first as cost regression, then as error spike, each with its own doc and ledger row.
- **Evidence over opinion** — error messages are matched to the commit that introduced them by message *and* by diff; deterministic matches outrank the LLM's ranking.
- **Deterministic fallbacks** — the price table computes cost impact; hunk ids anchor the INSIGHT table; if the LLM fails, the pipeline degrades to pattern inference instead of stopping.
- **Crash-safe rollback queue** — SQLite-backed intents with CAS claiming; a crash mid-rollback recovers on boot.

## Message catalog

**Channel (13 types):** INSIGHT pre-merge post · cost/latency regression alerts · error spike alert (evidence table) · status reply (+ history) · keep reply · timeout reply · rollback queued ack · rollback result · rollback skipped · already-rolled-back note · revert-deploy note · unknown-command reply.
**GitHub:** INSIGHT PR comment. **Workspace objects:** postmortem Doc · Ledger Sheet row · Watch Task.

## Environment

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` / `LLM_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` | LLM calls (INSIGHT, root cause, classification) |
| `AMBIGUOUS_AGENT_API_KEY`, `AMBIGUOUS_API_KEY`, `AMBIGUOUS_AGENT_ID`, `AMBIGUOUS_CHANNEL_ID`, `AMBIGUOUS_SHEET_ID` | the workspace the agent lives in |
| `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_REPO` | PR analysis, webhooks, revert commits |
| `INGEST_TOKEN` | telemetry ingestion auth |
| `MIN_REQUESTS` (5) · `COST_REGRESSION_PCT` (30) · `LATENCY_REGRESSION_PCT` (30) | evaluation thresholds |
| `COMMAND_MINUTES` / `POLL_MINUTES` (15) | approval window + channel poll |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` | optional Vercel API access |
| `DATABASE_PATH` | SQLite location |

`npm run reset` wipes DB, channel, tasks, docs and sheet for a clean rehearsal.

`MIN_REQUESTS` defaults to **5** to keep rehearsals fast; raise it to **20+** for production statistical confidence (the original rehearsal spec used 20).

## Failure handling

| Scenario | Behavior |
|---|---|
| LLM timeout / failure | retried once → deterministic fallbacks (price table, patterns, message+diff matching) keep the pipeline running |
| GitHub 5xx / rate limits | retries; degraded content still lands on the PR and channel |
| Duplicate webhook deliveries | `processed_events` idempotency — handled exactly once |
| < `MIN_REQUESTS` traffic | `insufficient_data`; recovered and evaluated automatically when traffic arrives |
| Revert deploys | `skipped_revert`, never evaluated, noted in the original thread |
| No approval in time | "I did not roll back, still watching" + Watch Task + postmortem (`timeout`) |
| Crash mid-rollback | queue recovers on boot: re-queued or resolved |
| Bad ingest payload | 400 listing required fields; token-gated |
| Missing baseline | "no baseline with enough traffic" — no false alerts |
| Unknown command / SHA | channel reply — never silent |

## Security

GitHub webhooks verified with HMAC-SHA256 + `timingSafeEqual`; ingest/deploys token-gated; parameterized SQL throughout; no shell execution; outbound HTTP only to fixed hosts; `.env` never tracked (history scanned clean); Dependabot alerts enabled; `npm audit` clean.
