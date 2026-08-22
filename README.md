# NDS — Job Queue & Notification Delivery Service

A production-grade background job and notification delivery system: an API enqueues
jobs into a Redis-backed BullMQ queue, workers deliver them to downstream providers
(email via Resend, generic webhooks) with exponential-backoff retries, idempotency
keys, per-destination rate limiting, and a dead-letter queue for undeliverable jobs.
Postgres is the durable source of truth for job status and idempotency.

See `pdr.txt` for the full Project Design Requirements and `TDR-job-queue-service.md`
for the technical design.

## Stack

- TypeScript (strict), Node.js 20+
- Redis + BullMQ (queueing, backoff, DLQ, rate limiting)
- PostgreSQL (job records, idempotency keys)
- pino (structured JSON logging), zod (env validation)
- Vitest (unit + integration tests), GitHub Actions CI

## Development

```bash
make up     # start Redis + Postgres via docker compose
make test   # run unit + integration tests
make lint   # eslint + prettier check
```

## Commit Conventions

Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). Small, atomic
commits — one logical change each.
