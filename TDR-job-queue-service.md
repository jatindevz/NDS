# Technical Design Report (TDR)
## Job Queue & Notification Delivery Service

**Companion to:** PDR-job-queue-service.md (defines *what* and *why*; this defines *how*)
**Author:** Jatin Patil

---

## 1. Scope of This Document

The PDR defines requirements and architecture at a black-box level. This TDR specifies implementation details: file structure, interfaces, algorithms, config, and error handling — precise enough that writing code from it is mostly transcription.

---

## 2. Tech Stack & Justification

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (Node.js 20 LTS) | Type safety on job payloads catches bugs the compiler can point at, not the debugger. |
| Queue | BullMQ 5.x on Redis 7 | Provides backoff, DLQ, and rate-limiting as configuration, not custom code — using it correctly is the senior move. |
| Database | PostgreSQL 16 | ACID guarantees needed for the idempotency check (see §6.1) — a NoSQL store without transactional uniqueness constraints would reintroduce the race condition this project exists to solve. |
| API framework | Express (or Next.js route handlers if reusing DSA Console patterns) | Minimal surface area; the interesting engineering is in the queue/worker, not the HTTP layer. |
| Email provider | Resend | Already integrated in DSA Console — reuse known-working credentials/config. |
| Validation | Zod | Runtime validation of job payloads at the API boundary; pairs naturally with TypeScript types. |
| Testing | Vitest | Fast, TS-native, minimal config. |
| Containerization | Docker + docker-compose | NFR5 (one-command runnable). |
| CI | GitHub Actions | NFR6. |

---

## 3. Repository Structure

```
job-queue-service/
├── src/
│   ├── api/
│   │   ├── server.ts              # Express app bootstrap
│   │   ├── routes/
│   │   │   ├── jobs.ts            # POST /jobs, GET /jobs/:id, GET /jobs, POST /jobs/:id/retry
│   │   │   └── health.ts          # GET /health
│   │   └── middleware/
│   │       └── validate.ts        # Zod schema validation middleware
│   ├── queue/
│   │   ├── connection.ts          # Redis connection singleton
│   │   ├── queue.ts               # BullMQ Queue instance + config (backoff, attempts)
│   │   └── worker.ts              # BullMQ Worker: consumes jobs, dispatches to handlers
│   ├── handlers/
│   │   ├── index.ts               # type → handler map
│   │   ├── email.handler.ts       # calls Resend
│   │   └── webhook.handler.ts     # POSTs to a target URL
│   ├── db/
│   │   ├── client.ts              # pg / Prisma client singleton
│   │   ├── schema.sql             # DDL (from PDR §6, reproduced here as source of truth)
│   │   └── jobs.repository.ts     # createJob, findByIdempotencyKey, updateStatus, listDeadLetter
│   ├── lib/
│   │   ├── backoff.ts             # pure function: computeBackoffMs(attempt) — unit tested directly
│   │   └── logger.ts              # structured JSON logger (pino or console wrapper)
│   └── types.ts                   # JobType, JobStatus, JobPayload, Job interfaces
├── test/
│   ├── unit/
│   │   ├── backoff.test.ts
│   │   ├── idempotency.test.ts
│   │   └── dlq-routing.test.ts
│   └── integration/
│       └── enqueue-fail-retry-succeed.test.ts
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── .github/workflows/ci.yml
└── README.md
```

---

## 4. Core Interfaces

```typescript
// src/types.ts
type JobType = 'email' | 'webhook';
type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'dead_letter';

interface JobPayload {
  email: { to: string; subject: string; body: string };
  webhook: { url: string; body: Record<string, unknown> };
}

interface Job<T extends JobType = JobType> {
  id: string;
  idempotencyKey: string;
  type: T;
  payload: JobPayload[T];
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// src/handlers/index.ts
type JobHandler<T extends JobType> = (payload: JobPayload[T]) => Promise<void>;
// Handler throws on failure; BullMQ's retry mechanism catches the throw.
```

---

## 5. Sequence: Enqueue → Success

```
Client              API                 Postgres            Redis/BullMQ         Worker            Resend
  │  POST /jobs        │                    │                     │                  │                │
  │───────────────────>│                    │                     │                  │                │
  │                     │  find by idem_key  │                     │                  │                │
  │                     │───────────────────>│                     │                  │                │
  │                     │<─── not found ──────                     │                  │                │
  │                     │  insert (status=queued)                  │                  │                │
  │                     │───────────────────>│                     │                  │                │
  │                     │  queue.add(job)                          │                  │                │
  │                     │─────────────────────────────────────────>│                  │                │
  │<── 201 {id,status} ─│                    │                     │                  │                │
  │                     │                    │                     │  dequeue         │                │
  │                     │                    │                     │─────────────────>│                │
  │                     │                    │                     │                  │  send email    │
  │                     │                    │                     │                  │───────────────>│
  │                     │                    │                     │                  │<── 200 ────────│
  │                     │                    │  update status=completed               │                │
  │                     │                    │<────────────────────────────────────────│                │
```

## 6. Detailed Algorithms

### 6.1 Idempotency Check (race-condition-safe)

The naive approach — `SELECT then INSERT` — has a race window: two concurrent requests with the same key can both pass the `SELECT` before either `INSERT`s. Fix: enforce uniqueness at the database level, not just in application logic.

```sql
-- schema: idempotency_key has a UNIQUE constraint (already in PDR §6)
```

```typescript
// jobs.repository.ts
async function createOrGetJob(input: CreateJobInput): Promise<{ job: Job; created: boolean }> {
  try {
    const job = await db.insertJob(input); // relies on UNIQUE constraint
    return { job, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.findByIdempotencyKey(input.idempotencyKey);
      return { job: existing, created: false };
    }
    throw err;
  }
}
```

This is the detail worth explaining in an interview: **the constraint, not the check, is what makes it correct under concurrency.** An application-level check-then-act is inherently racy; a database uniqueness constraint is atomic.

### 6.2 Backoff Calculation (pure function, directly unit-testable)

```typescript
// lib/backoff.ts
export function computeBackoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}
// attempt 0 → 1000ms, 1 → 2000ms, 2 → 4000ms, 3 → 8000ms, 4 → 16000ms, capped at 60000ms
```

In BullMQ this is supplied via the job options:
```typescript
queue.add(name, data, {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
});
```
(BullMQ's built-in exponential backoff follows the same formula — the pure function above exists primarily so the *logic* is directly unit-testable outside the queue library, per NFR3.)

### 6.3 Dead-Letter Routing

BullMQ moves a job to `failed` state automatically once `attempts` is exhausted. The **worker's failure listener** is what promotes it into the application's `dead_letter` status in Postgres (BullMQ's internal "failed" list is not itself the DLQ record of truth — Postgres is):

```typescript
worker.on('failed', async (bullJob, err) => {
  if (bullJob.attemptsMade >= (bullJob.opts.attempts ?? 1)) {
    await db.updateStatus(bullJob.data.jobId, 'dead_letter', err.message);
  }
});
```

### 6.4 Rate Limiting

BullMQ queue-level limiter, configured per queue (one queue per destination domain, or a single queue with a limiter keyed by a grouping field — start with the simpler global limiter and note the per-domain refinement as a stretch goal):

```typescript
new Worker(queueName, processor, {
  connection,
  limiter: { max: 10, duration: 1000 }, // 10 jobs/sec
});
```

---

## 7. Error Handling & Status Codes

| Scenario | API Response | Job Status |
|----------|---------------|------------|
| New job, valid payload | `201 { id, status: 'queued' }` | `queued` |
| Duplicate idempotency key | `200 { id, status: <current> }` | unchanged |
| Invalid payload (Zod fails) | `400 { error: 'validation_failed', details }` | — |
| Job not found (`GET /jobs/:id`) | `404` | — |
| Handler throws, attempts remain | — (async) | `failed` → re-queued |
| Handler throws, attempts exhausted | — (async) | `dead_letter` |
| Retry on non-DLQ job | `409 { error: 'not_in_dead_letter' }` | unchanged |
| Redis or Postgres unreachable | `/health` → `503 { redis: 'error' \| 'ok', postgres: 'error' \| 'ok' }` | — |

---

## 8. Logging Schema

Every job lifecycle event emits one structured log line (JSON), so failures are diagnosable from logs alone (NFR2):

```json
{ "ts": "2026-08-22T10:00:00Z", "level": "info", "event": "job.enqueued", "job_id": "...", "type": "email", "idempotency_key": "..." }
{ "ts": "2026-08-22T10:00:01Z", "level": "warn", "event": "job.attempt_failed", "job_id": "...", "attempt": 2, "error": "ETIMEDOUT" }
{ "ts": "2026-08-22T10:00:02Z", "level": "error", "event": "job.dead_lettered", "job_id": "...", "attempts": 5, "last_error": "..." }
{ "ts": "2026-08-22T10:00:03Z", "level": "info", "event": "job.completed", "job_id": "...", "duration_ms": 340 }
```

---

## 9. Configuration

```bash
# .env.example
DATABASE_URL=postgres://user:pass@localhost:5432/jobqueue
REDIS_URL=redis://localhost:6379
RESEND_API_KEY=
PORT=3000
DEFAULT_MAX_ATTEMPTS=5
RATE_LIMIT_PER_SEC=10
```

---

## 10. Test Plan (concrete cases, mapped to PDR §9)

| Test | Type | Asserts |
|------|------|---------|
| `computeBackoffMs(0..4)` returns expected values, caps at 60000 | Unit | §6.2 formula correctness |
| `createOrGetJob` called twice with same key returns `created:false` second time, no duplicate row | Unit (mocked db) | §6.1 idempotency |
| Worker `failed` handler sets `dead_letter` only when `attemptsMade >= attempts` | Unit | §6.3 DLQ threshold |
| Full flow: enqueue → mock destination fails twice → succeeds on 3rd → status `completed`, `attempts: 3` | Integration | End-to-end retry correctness |
| `POST /jobs` with malformed payload → `400` | Unit (supertest) | Input validation |
| `POST /jobs/:id/retry` on a `completed` job → `409` | Unit | Retry endpoint guards |

---

## 11. Security Considerations (brief — not the focus of this project, but worth one paragraph in the README)

- API requires a static bearer token (`Authorization: Bearer <API_KEY>`) — sufficient for a portfolio project; note in README that production would need per-client keys and scoping.
- Webhook handler should reject internal/private IP ranges as destination URLs (basic SSRF guard) — worth implementing given it's a two-line check and demonstrates security awareness.
- No payload encryption at rest for this scope — noted as an explicit non-goal, not an oversight.

---

## 12. Open Technical Decisions

1. **Single queue vs. per-type queues?** Start with one queue, route by `type` field inside the worker. Split into `email-queue` / `webhook-queue` only if rate-limiting per type turns out to need it — avoid the split preemptively.
2. **ORM or raw SQL?** Raw `pg` with hand-written queries for this scope — small enough schema that an ORM adds indirection without much benefit, and raw SQL makes the idempotency constraint's role more visible in code review.
3. **Prisma migrations vs. plain `schema.sql`?** Plain SQL file for a project this size; revisit if the schema grows past ~3 tables.
