# Caribbean Hub social import worker

A small credential-safe Node 24 worker for the Caribbean Hub. The public service exposes only health and wake endpoints. Account jobs are leased over an authenticated HTTPS RPC; Meta access tokens never enter an HTTP queue or an article URL. This repository contains no application source, account credentials or deployment values.

Run tests: `node --test worker.test.mjs`.
Build check: `node --check worker.mjs`.
Start: `node worker.mjs`.

Set `SUPABASE_URL`, public `SUPABASE_ANON_KEY`, and private `WORKER_TOKEN` using hosting environment settings. The matching worker-token SHA-256 digest belongs in the application's private database configuration. Never commit token values. `/health` returns only service readiness metadata; `/wake` accepts no credentials and returns no job data.

This service can run on a Render free web instance. It sleeps when idle; a wake request starts it again, which can take about a minute. Persistent application data and encrypted account credentials remain in the application's database. Deploy updates manually after tests pass when using an unconnected public repository URL.
