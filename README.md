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
  config.ts        # zod-validated env config; fails fast at startup
  lib/
    logger.ts      # pino structured logging, child loggers for correlation
    redis.ts       # ioredis factory: bounded jittered retry, fail-fast connect
tests/
  unit/            # fast, deterministic, no I/O
  integration/     # real Redis; auto-skips when Redis is unreachable
docker-compose.yml # Redis (auth, AOF) + Postgres, both healthchecked
```

## Development

```bash
make install        # npm install
make up             # start Redis + Postgres (docker compose)
make test           # unit + integration (integration skips if Redis is down)
make test-unit      # unit only
make lint           # eslint
make typecheck      # tsc --noEmit (strict)
```

Copy `.env.example` to `.env` before running the service. Integration tests read
`TEST_REDIS_URL` (default `redis://:nds_dev_password@localhost:6379`).

## Commit conventions

Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `ci:`).
Small, atomic commits — one logical change each, tests alongside the feature.
