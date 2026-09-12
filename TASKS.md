# Blast Radius — Tasks

Technical stages only. Each stage ends with something that **runs**. Do not start A4 before A3 is done. A2.5 is required before A3’s prediction bridge. Failure handling is required in A1–A3 and must be listed in README (A8). A5 is optional. A6 is extra drills only — skipping it does not skip the README heading.

### A0 — Skeleton

- `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `Dockerfile`
- Express `GET /health` + SQLite `schema.sql` applied on boot
- **Done:** `npm run dev` → `GET /health` returns `{ ok: true, db: "up" }`. `docker build` succeeds.

### D0 — Demo app (after A0)

- `blast-radius-demo`: Next.js 15, one-page LLM UI, deploy to Vercel
- **Done:** production URL loads and can submit a prompt (OpenAI can still be unwired)

### A1 — Ingest

- `POST /ingest` validates OTel-shaped body, computes `cost_usd`, inserts, bumps `deploys.request_count`
- `INGEST_TOKEN`, reject bad payloads
- `curl` is a smoke test only, not the done criterion
- **Done:** endpoint accepts a real OTel payload and persists cost; ready for D1

### D1 — Demo is the telemetry source

- Demo makes a **real** OpenAI call and POSTs to `/ingest` with OTel fields and `service.version=git SHA`
- **Done:** one prompt in the Vercel app produces a SQLite telemetry row. This is the source of all real data from here on.

### T — seed-traffic.js

- Hit the demo URL ≥ `MIN_REQUESTS` (20) times per deploy. Used by A3, A7, and A8v. Not manual clicking.
- **Done:** `node scripts/seed-traffic.js` yields ≥20 telemetry rows for the current SHA

### A2 — Deploys wired

- GitHub webhook signature, `processed_events` idempotency, retries on GitHub 5xx
- PR opened → store PR metadata (no INSIGHT stub)
- Merge + `POST /deploys` creates `deploys` with `previous_sha`, `origin=release|revert`
- **Done:** a real PR + real deploy record for a real SHA

### A2.5 — INSIGHT estimate (required, same bar as A3)

- Diff → LLM → cost/latency % + rationale → PR comment → `predictions` row
- Not optional. Not stubbable. No row = no prediction-verification bridge.
- **Done:** a real GitHub PR has an estimate comment; prediction is in SQLite and joinable on merge SHA

### A3 — CORE: alert in Ambiguous (required)

- Worker respects `MIN_REQUESTS=20` and **skips `origin=revert`**
- Traffic from demo via `seed-traffic.js` (not curl)
- Baseline compare + prediction bridge (`predicted X, actual Y`) — requires A2.5
- Agent tool loop posts one Markdown alert: regression, ranked suspects + confidence, prediction check
- `thread_key = sha`; second run does not duplicate the alert
- **Done:** Ambiguous channel shows that thread, including the prediction check. Re-running the worker does not post a second root message.

### A4 — Approval + rollback (depends on A3)

- Poll; poll watcher; `execute_rollback` hard-gated; writes `pending_reverts`
- Timeout/no → “I did not roll back, still monitoring” + Task
- After rollback: revert deploy is `skipped_revert`; note in the original thread
- **Done:** yes vote rolls back for real; the follow-up deploy is not evaluated; no/timeout does not roll back, and a Task exists

### D2 — Bad commit for rehearsal / video

- e.g. `gpt-4o-mini` → `gpt-4o` (or max_tokens jump) in the demo app
- **Done:** merging it is what A7 and A8v run against

### A7 — Rehearsal

- Full path against the **demo app**, not curl: PR (INSIGHT comment) → merge → `seed-traffic.js` ≥20 → alert with predicted vs actual → poll → rollback **or** timeout
- **Done:** one uninterrupted run; prediction vs actual spoken in the thread; revert deploy silent

### A8 — Submission pack

- README (how to run, env, demo script)
- README heading **Failure handling** — required even if A6 is skipped. List each scenario from SPEC (LLM timeout, GitHub 5xx, idempotency, insufficient data, revert skip, no-approval / no auto-rollback, bad ingest) and the behavior. Jury will not deep-dive the repo; undocumented handling scores as missing.
- Dockerfile (buildable; not Fly.io)
- Commit history readable by stage
- Written project description
- Social post draft
- **Done:** a stranger can follow the README; Failure handling heading is present and specific; written blurb and social copy exist; git log tells the story. Video is **not** this task.

### A8v — 2-minute video (separate)

- Show: PR estimate → deploy → seed traffic → Ambiguous alert with predicted vs actual → poll
- **Done:** a 2-minute cut exported and upload-ready

### Optional

**A5 — Sheets / Docs.** Ledger row + postmortem Doc. Task already in A4.

**A6 — Extra failure-handling drills.** The behaviors already ship in A1–A3. A6 is only extra exercises (kill OpenAI, kill GitHub, confirm logs/thread copy). Skipping A6 does **not** skip the README **Failure handling** heading in A8.

**Skip order if scope must shrink:** A6 drills → A5 → A4. Never skip D0/D1, T (seed-traffic), A2.5, A3, A8 Failure handling heading, A8v.
