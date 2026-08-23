# NDS — Job Queue & Notification Delivery Service

A production-grade background job and notification delivery system: an API enqueues
jobs into a Redis-backed BullMQ queue, workers deliver them to downstream providers
(email via Resend, generic webhooks) with exponential-backoff retries, idempotency
keys, per-destination rate limiting, and a dead-letter queue for undeliverable jobs.
Postgres is the durable source of truth for job status and idempotency.

Design docs: `pdr.txt` (requirements), `TDR-job-queue-service.md` (technical design).

## Stack

- TypeScript (strict), Node.js 20+
- Redis + BullMQ (queueing, backoff, DLQ, rate limiting)
- PostgreSQL (job records, idempotency keys)
- pino (structured JSON logs), zod (fail-fast env validation)
- Vitest (unit + integration), GitHub Actions CI (Node 20/22 matrix)

## Project layout

```
src/
  config.ts            # zod-validated env config; fails fast at startup
  lib/
    logger.ts          # pino structured logging, child loggers for correlation
    redis.ts           # ioredis factory: bounded jittered retry, fail-fast connect
  jobs/
    schemas.ts         # job request/payload validation (zod), InvalidJobError
    backoff.ts         # capped exponential backoff with half-jitter (1s base, 60s cap)
  queues/
    notifications.ts   # queue name, default job options, custom backoff strategy
  services/
    enqueue.ts         # validate-then-enqueue (future HTTP handlers call this)
  worker/
    handlers.ts        # handler registry + poison-message guard (UnrecoverableError)
    notifications-worker.ts # worker factory: concurrency, stall detection, lifecycle logs
    graceful.ts        # ordered shutdown w/ per-component timeout + force-kill
    index.ts           # worker entrypoint (npm run worker)
tests/
  unit/                # fast, deterministic, no I/O
  integration/         # real Redis; auto-skips when Redis is unreachable
docker-compose.yml     # Redis (auth, AOF) + Postgres, both healthchecked
```

## Failure handling (current state)

- **Retries:** 5 attempts, capped exponential backoff (base 1s, cap 60s, half-jitter)
  implemented as a BullMQ custom backoff strategy.
- **Poison messages:** unknown job types, corrupted envelopes, and payloads the
  handler rejects fail unrecoverably on the first attempt (`UnrecoverableError`) —
  they never burn retry budget.
- **Stalled jobs:** workers check every 30s for jobs whose lock died with a
  crashed worker; max 3 stall cycles before the job is failed.
- **Graceful shutdown:** SIGTERM/SIGINT drain the worker before closing Redis;
  each component gets its own timeout with a force-kill fallback.

## Development

```bash
make install        # npm install
make up             # start Redis + Postgres (docker compose)
make test           # unit + integration (integration skips if Redis is down)
make test-unit      # unit only
make lint           # eslint
make typecheck      # tsc --noEmit (strict)
npm run worker      # run the worker against local Redis
```

Copy `.env.example` to `.env` before running the service. Integration tests read
`TEST_REDIS_URL` (default `redis://:nds_dev_password@localhost:6379`).

## Commit conventions

Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `ci:`).
Small, atomic commits — one logical change each, tests alongside the feature.
