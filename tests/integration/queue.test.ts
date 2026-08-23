import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queue, Worker} from 'bullmq';
import { type Job } from 'bullmq';
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

describe.skipIf(!redisUp)('notifications queue end-to-end', () => {
  let client: Redis;
  let queue: Queue;
  let worker: Worker;
  // Unique prefix per run so parallel CI jobs never see each other's keys.
  const prefix = `nds-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    client = await createRedisClient({ url: REDIS_URL, connectTimeoutMs: 3_000, logger });
    // BullMQ requires its own `prefix` option (it rejects ioredis keyPrefix);
    // a per-run prefix gives every test run an isolated keyspace.
    queue = createNotificationsQueue(client, { prefix });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await worker?.close().catch(() => {});
    await queue.close().catch(() => {});
    await client.quit().catch(() => client.disconnect());
  });

  function startWorker(registry: HandlerRegistry): Worker {
    worker = createNotificationsWorker({
      connection: client,
      registry,
      logger,
      concurrency: 2,
      prefix,
    });
    return worker;
  }

  function waitForEvent(
    emitter: Worker,
    event: 'completed' | 'failed',
    jobId: string,
    timeoutMs = 10_000,
  ): Promise<{ job: Job; err?: Error }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event} on ${jobId}`)), timeoutMs);
      emitter.on(event, (job: Job, err: Error) => {
        if (String(job.id) === jobId) {
          clearTimeout(timer);
          resolve({ job, err });
        }
      });
    });
  }

  it('delivers a valid job on the first attempt', async () => {
    let deliveries = 0;
    const w = startWorker({
      email: async () => {
        deliveries++;
      },
    });
    const { jobId } = await enqueueNotification(
      { queue: queue as never, logger },
      {
        type: 'email',
        payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
        idempotency_key: `e2e-happy-${Date.now()}`,
      },
    );
    const { job } = await waitForEvent(w, 'completed', jobId);
    expect(deliveries).toBe(1);
    expect(job.attemptsMade).toBe(1);
  });

  it('retries with backoff and completes on the third attempt', async () => {
    let attempts = 0;
    const w = startWorker({
      email: async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient provider outage');
      },
    });
    const { jobId } = await enqueueNotification(
      { queue: queue as never, logger },
      {
        type: 'email',
        payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
        idempotency_key: `e2e-retry-${Date.now()}`,
      },
    );
    // Default cappedExponential backoff (1s base) keeps this under ~3s.
    const { job } = await waitForEvent(w, 'completed', jobId);
    expect(attempts).toBe(3);
    expect(job.attemptsMade).toBe(3);
  }, 20_000);

  it('poisons unregistered job types on the first attempt (no retries)', async () => {
    const w = startWorker({ email: async () => {} }); // no webhook handler
    const { jobId } = await enqueueNotification(
      { queue: queue as never, logger },
      {
        type: 'webhook',
        payload: { url: 'https://example.com/hook', event: 'test' },
        idempotency_key: `e2e-poison-${Date.now()}`,
      },
    );
    const { job, err } = await waitForEvent(w, 'failed', jobId);
    expect(job.attemptsMade).toBe(1);
    expect(err?.message).toMatch(/no handler registered for type 'webhook'/);
  });
});

describe.skipIf(redisUp)('notifications queue end-to-end (skipped: redis not reachable)', () => {
  it('documents how to enable this suite', () => {
    expect(true).toBe(true);
  });
});
