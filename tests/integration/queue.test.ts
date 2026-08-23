import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Queue, type Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { buildLogger } from '../../src/lib/logger.js';
import { createRedisClient } from '../../src/lib/redis.js';
import { createNotificationsQueue } from '../../src/queues/notifications.js';
import { createNotificationsWorker } from '../../src/worker/notifications-worker.js';
import type { HandlerRegistry } from '../../src/worker/handlers.js';
import { enqueueNotification } from '../../src/services/enqueue.js';

const logger = buildLogger({ level: 'fatal', pretty: false });
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://:nds_dev_password@localhost:6379';

async function isPortOpen(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const url = new URL(REDIS_URL);
const redisUp = await isPortOpen(url.hostname, Number(url.port || 6379));

type CapturedEvent = { event: 'completed' | 'failed'; job: Job; err?: Error };

/**
 * Captures worker events as they arrive so assertions can be made after the
 * fact — a fast handler can complete a job before a wait-promise is set up,
 * so listening "from now on" is a race we must not lose.
 */
function captureEvents(worker: Worker): {
  events: CapturedEvent[];
  waitFor(
    event: 'completed' | 'failed',
    jobId: string,
    timeoutMs?: number,
  ): Promise<CapturedEvent>;
} {
  const events: CapturedEvent[] = [];
  let notify: (() => void) | undefined;
  worker.on('completed', (job) => {
    events.push({ event: 'completed', job });
    notify?.();
  });
  worker.on('failed', (job, err) => {
    if (!job) return; // "failed without job" events aren't waitable on
    events.push({ event: 'failed', job, err });
    notify?.();
  });
  return {
    events,
    waitFor(event, jobId, timeoutMs = 10_000) {
      const matches = (e: CapturedEvent) => e.event === event && String(e.job.id) === jobId;
      const existing = events.find(matches);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${event} on ${jobId}`)),
          timeoutMs,
        );
        notify = () => {
          const match = events.find(matches);
          if (match) {
            clearTimeout(timer);
            resolve(match);
          }
        };
      });
    },
  };
}

describe.skipIf(!redisUp)('notifications queue end-to-end', () => {
  let client: Redis;
  let queue: Queue;
  const workers: Worker[] = [];
  // BullMQ requires its own `prefix` option (it rejects ioredis keyPrefix);
  // a per-run prefix gives every test run an isolated keyspace.
  const prefix = `nds-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    client = await createRedisClient({ url: REDIS_URL, connectTimeoutMs: 3_000, logger });
    queue = createNotificationsQueue(client, { prefix });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    for (const w of workers) {
      await w.close().catch(() => {});
    }
    await queue?.close().catch(() => {});
    await client?.quit().catch(() => client?.disconnect());
  });

  /**
   * Each test owns its worker for its full lifetime: a worker left running
   * after its test would compete for the next test's jobs and complete them
   * with the wrong handler, invisibly.
   */
  async function withWorker(
    registry: HandlerRegistry,
    fn: (worker: Worker, captured: ReturnType<typeof captureEvents>) => Promise<void>,
  ): Promise<void> {
    const worker = createNotificationsWorker({
      connection: client,
      registry,
      logger,
      concurrency: 2,
      prefix,
    });
    workers.push(worker);
    try {
      await fn(worker, captureEvents(worker));
    } finally {
      await worker.close().catch(() => {});
    }
  }

  async function enqueue(payload: Record<string, unknown>): Promise<string> {
    const { jobId } = await enqueueNotification({ queue: queue as never, logger }, payload);
    return jobId;
  }

  it('delivers a valid job on the first attempt', async () => {
    let deliveries = 0;
    await withWorker({ email: async () => void deliveries++ }, async (_w, captured) => {
      const jobId = await enqueue({
        type: 'email',
        payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
        idempotency_key: `e2e-happy-${Date.now()}`,
      });
      const { job } = await captured.waitFor('completed', jobId);
      expect(deliveries).toBe(1);
      expect(job.attemptsMade).toBe(1);
    });
  });

  it('retries with backoff and completes on the third attempt', async () => {
    let attempts = 0;
    await withWorker(
      {
        email: async () => {
          attempts++;
          if (attempts < 3) throw new Error('transient provider outage');
        },
      },
      async (_w, captured) => {
        const jobId = await enqueue({
          type: 'email',
          payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
          idempotency_key: `e2e-retry-${Date.now()}`,
        });
        // Default cappedExponential backoff (1s base) keeps this under ~3s.
        const { job } = await captured.waitFor('completed', jobId);
        expect(attempts).toBe(3);
        expect(job.attemptsMade).toBe(3);
      },
    );
  }, 20_000);

  it('poisons unregistered job types on the first attempt (no retries)', async () => {
    await withWorker({ email: async () => {} }, async (_w, captured) => {
      // no webhook handler registered
      const jobId = await enqueue({
        type: 'webhook',
        payload: { url: 'https://example.com/hook', event: 'test' },
        idempotency_key: `e2e-poison-${Date.now()}`,
      });
      const { job, err } = await captured.waitFor('failed', jobId);
      expect(job.attemptsMade).toBe(1);
      expect(err?.message).toMatch(/no handler registered for type 'webhook'/);
    });
  });
});

describe.skipIf(redisUp)('notifications queue end-to-end (skipped: redis not reachable)', () => {
  it('documents how to enable this suite', () => {
    expect(true).toBe(true);
  });
});
