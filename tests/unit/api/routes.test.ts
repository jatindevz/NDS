import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import express, { type Express } from 'express';
import { buildJobsRouter } from '../../../src/api/routes/jobs.js';
import { buildHealthRouter } from '../../../src/api/routes/health.js';
import { errorHandler, notFoundHandler } from '../../../src/api/error-middleware.js';
import type { EnqueueableQueue } from '../../../src/services/enqueue.js';
import type { JobRecord, JobStatus, JobsStore } from '../../../src/db/jobs.repository.js';

const logger: Logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const API_KEY = 'test-key-1234567890';
const AUTH = { authorization: `Bearer ${API_KEY}` };

function seed(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: 'key-' + crypto.randomUUID(),
    type: 'email',
    payload: { to: 'a@b.co', subject: 's', body: 'b' },
    status: 'queued',
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** In-memory JobsStore: API tests assert routing/mapping, not SQL. */
function memoryStore(jobs: JobRecord[] = []): JobsStore & { jobs: JobRecord[] } {
  return {
    jobs,
    async createOrGetJob(input) {
      const existing = jobs.find((j) => j.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: existing, created: false };
      const job: JobRecord = {
        id: crypto.randomUUID(),
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        payload: input.payload,
        status: 'queued',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      jobs.push(job);
      return { job, created: true };
    },
    async findById(id) {
      return jobs.find((j) => j.id === id) ?? null;
    },
    async listByStatus(status) {
      return jobs.filter((j) => status === undefined || j.status === status);
    },
    async updateStatus(id, status, patch = {}) {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new Error(`job '${id}' not found`);
      job.status = status;
      if (patch.attempts !== undefined) job.attempts = patch.attempts;
      if (patch.lastError !== undefined) job.lastError = patch.lastError;
      return job;
    },
  };
}

function fakeQueue() {
  const calls: Array<{ name: string; data: unknown }> = [];
  return {
    calls,
    add: vi.fn(async (name: string, data: unknown) => {
      calls.push({ name, data });
      return { id: 'bull-1' };
    }),
  } as unknown as EnqueueableQueue & { calls: Array<{ name: string; data: unknown }> };
}

function buildApp(store: JobsStore, queue: EnqueueableQueue): Express {
  const app = express();
  app.use(express.json());
  app.use(buildJobsRouter({ store, queue, logger, apiKey: API_KEY }));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

const validBody = {
  type: 'email',
  payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
  idempotency_key: 'idem-1',
};

describe('POST /jobs', () => {
  it('returns 201 and enqueues a new job', async () => {
    const store = memoryStore();
    const queue = fakeQueue();
    const res = await request(buildApp(store, queue)).post('/jobs').set(AUTH).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    expect(queue.add).toHaveBeenCalledOnce();
    // Persisted BEFORE enqueueing (insert-then-enqueue ordering).
    expect(store.jobs).toHaveLength(1);
  });

  it('returns 200 with the existing job for a duplicate idempotency_key and does not enqueue twice', async () => {
    const store = memoryStore();
    const queue = fakeQueue();
    const app = buildApp(store, queue);
    const first = await request(app).post('/jobs').set(AUTH).send(validBody);
    const second = await request(app).post('/jobs').set(AUTH).send(validBody);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.idempotency_key).toBe(validBody.idempotency_key);
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('rejects an invalid payload with 400 without touching the store or queue', async () => {
    const store = memoryStore();
    const queue = fakeQueue();
    const res = await request(buildApp(store, queue))
      .post('/jobs')
      .set(AUTH)
      .send({ ...validBody, type: 'sms' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(store.jobs).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('marks the job failed and returns 503 when the queue is down (insert-then-enqueue gap)', async () => {
    const store = memoryStore();
    const queue = {
      add: vi.fn(async () => {
        throw new Error('redis connection lost');
      }),
    } as unknown as EnqueueableQueue;
    const res = await request(buildApp(store, queue)).post('/jobs').set(AUTH).send(validBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('queue_unavailable');
    expect(store.jobs[0]?.status).toBe('failed');
    expect(store.jobs[0]?.lastError).toMatch(/enqueue failed/);
  });
});

describe('GET /jobs/:id', () => {
  it('returns the job', async () => {
    const job = seed();
    const app = buildApp(memoryStore([job]), fakeQueue());
    const res = await request(app).get(`/jobs/${job.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(job.id);
    expect(res.body.idempotency_key).toBe(job.idempotencyKey);
  });

  it('returns 404 for an unknown or malformed id', async () => {
    const app = buildApp(memoryStore(), fakeQueue());
    expect((await request(app).get('/jobs/not-a-uuid').set(AUTH)).status).toBe(404);
    expect((await request(app).get(`/jobs/${crypto.randomUUID()}`).set(AUTH)).status).toBe(404);
  });
});

describe('GET /jobs?status=', () => {
  it('lists dead_letter jobs', async () => {
    const dlq = seed({ status: 'dead_letter' });
    const app = buildApp(memoryStore([dlq, seed()]), fakeQueue());
    const res = await request(app).get('/jobs?status=dead_letter').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].id).toBe(dlq.id);
  });

  it('rejects an unknown status filter with 400', async () => {
    const app = buildApp(memoryStore(), fakeQueue());
    const res = await request(app).get('/jobs?status=bogus').set(AUTH);
    expect(res.status).toBe(400);
  });

  it('lists all jobs when no filter is given', async () => {
    const app = buildApp(memoryStore([seed(), seed()]), fakeQueue());
    const res = await request(app).get('/jobs').set(AUTH);
    expect(res.body.jobs).toHaveLength(2);
  });
});

describe('POST /jobs/:id/retry', () => {
  it('resets attempts, requeues, and returns 200 for a dead_letter job', async () => {
    const job = seed({ status: 'dead_letter', attempts: 5, lastError: 'boom' });
    const store = memoryStore([job]);
    const queue = fakeQueue();
    const res = await request(buildApp(store, queue)).post(`/jobs/${job.id}/retry`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(res.body.attempts).toBe(0);
    expect(queue.add).toHaveBeenCalledOnce();
    const enqueued = (queue.calls[0]?.data ?? {}) as { idempotency_key?: string };
    expect(enqueued.idempotency_key).toBe(job.idempotencyKey);
  });

  it('returns 409 for a job not in dead_letter', async () => {
    const job = seed({ status: 'completed' as JobStatus });
    const app = buildApp(memoryStore([job]), fakeQueue());
    const res = await request(app).post(`/jobs/${job.id}/retry`).set(AUTH);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_in_dead_letter');
  });

  it('returns 404 for an unknown job', async () => {
    const app = buildApp(memoryStore(), fakeQueue());
    expect((await request(app).post(`/jobs/${crypto.randomUUID()}/retry`).set(AUTH)).status).toBe(404);
  });
});

describe('auth (fail-closed bearer token)', () => {
  it('rejects requests without a token', async () => {
    const app = buildApp(memoryStore(), fakeQueue());
    const res = await request(app).post('/jobs').send(validBody);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const app = buildApp(memoryStore(), fakeQueue());
    const res = await request(app)
      .post('/jobs')
      .set({ authorization: 'Bearer wrong-wrong-wrong' })
      .send(validBody);
    expect(res.status).toBe(401);
  });
});

describe('GET /health', () => {
  function healthApp(
    redis: { ping: () => Promise<string> },
    db: { query: (t: string) => Promise<{ rows: Record<string, unknown>[] }> },
  ): Express {
    const app = express();
    app.use(buildHealthRouter({ db, redis }));
    return app;
  }

  it('returns 200 when both dependencies answer', async () => {
    const res = await request(
      healthApp({ ping: async () => 'PONG' }, { query: async () => ({ rows: [] }) }),
    ).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redis: 'ok', postgres: 'ok' });
  });

  it('returns 503 naming postgres when postgres is down', async () => {
    const res = await request(
      healthApp(
        { ping: async () => 'PONG' },
        { query: async () => { throw new Error('connection refused'); } },
      ),
    ).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.postgres).toBe('error');
    expect(res.body.redis).toBe('ok');
  });

  it('returns 503 naming redis when redis is down', async () => {
    const res = await request(
      healthApp(
        { ping: async () => { throw new Error('ECONNREFUSED'); } },
        { query: async () => ({ rows: [] }) },
      ),
    ).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.redis).toBe('error');
  });
});
