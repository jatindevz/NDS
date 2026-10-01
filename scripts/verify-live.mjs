/**
 * Live end-to-end verification without Docker: boots a real Redis via the
 * project's redis-memory-server dev dependency, then drives the REAL queue,
 * worker, processor, backoff strategy, and poison-message machinery through
 * three scenarios:
 *
 *   1. happy path     — job completes on attempt 1
 *   2. flaky provider — fails twice, succeeds on attempt 3 (real backoff)
 *   3. poison message — InvalidJobError => unrecoverable on attempt 1
 *
 * Run: npm run verify   (executed via tsx so the TS sources import directly)
 */
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Worker } from 'bullmq';
import { RedisMemoryServer } from 'redis-memory-server';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function isPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

console.log('⏳ booting in-memory redis (first run downloads a redis binary ~5-10s)...\n');
const redisServer = new RedisMemoryServer({ instance: { port: 0 } });
const redisHost = await redisServer.getHost();
const redisPort = await redisServer.getPort();
const redisUrl = `redis://${redisHost}:${redisPort}`;
console.log(`   redis ready at ${redisUrl}\n`);

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

// Import the real TS machinery through tsx's loader.
const { buildLogger } = await import('../src/lib/logger.js');
const { createNotificationsQueue, notificationsQueueSettings } = await import(
  '../src/queues/notifications.js'
);
const { buildProcessor } = await import('../src/worker/handlers.js');
const { enqueueNotification } = await import('../src/services/enqueue.js');
const { InvalidJobError } = await import('../src/jobs/schemas.js');

const logger = buildLogger({ level: 'error', pretty: false });
const prefix = `verify-${randomUUID().slice(0, 8)}`;

const queue = createNotificationsQueue(connection, { prefix });

let flakyAttempts = 0;
const registry = {
  // happy + flaky share the email type; behavior keyed off the idempotency key
  email: async (payload, ctx) => {
    if (ctx.idempotencyKey.startsWith('flaky-')) {
      flakyAttempts += 1;
      if (flakyAttempts < 3) throw new Error('transient provider outage (simulated)');
      return;
    }
    if (ctx.idempotencyKey.startsWith('poison-')) {
      throw new InvalidJobError('payload missing "to" (simulated poison)');
    }
    // happy path: succeed immediately
  },
};

// Speed up the demo: same custom capped-exponential strategy, smaller base.
const worker = new Worker(
  'notifications',
  buildProcessor(registry, logger),
  {
    connection,
    prefix,
    concurrency: 2,
    settings: notificationsQueueSettings,
  },
);

function waitFor(event, jobId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off(event, onEvent);
      reject(new Error(`timeout waiting for ${event} on ${jobId}`));
    }, timeoutMs);
    const onEvent = (job) => {
      if (String(job.id) !== jobId) return;
      clearTimeout(timer);
      worker.off(event, onEvent);
      resolve(job);
    };
    worker.on(event, onEvent);
  });
}

try {
  // --- 1. happy path --------------------------------------------------------
  const happy = await enqueueNotification(
    { queue, logger },
    {
      type: 'email',
      payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
      idempotency_key: `happy-${randomUUID()}`,
    },
  );
  const happyJob = await waitFor('completed', happy.jobId);
  record('happy path: delivered on attempt 1', happyJob.attemptsMade === 1, `attemptsMade=${happyJob.attemptsMade}`);

  // --- 2. flaky provider retries with backoff -------------------------------
  const flaky = await enqueueNotification(
    { queue, logger },
    {
      type: 'email',
      payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
      idempotency_key: `flaky-${randomUUID()}`,
    },
  );
  const flakyJob = await waitFor('completed', flaky.jobId, 20_000);
  record(
    'flaky provider: failed 2x then succeeded on attempt 3 (real backoff)',
    flakyJob.attemptsMade === 3 && flakyAttempts === 3,
    `attemptsMade=${flakyJob.attemptsMade}, handlerCalls=${flakyAttempts}`,
  );

  // --- 3. poison message: unrecoverable on the first attempt ----------------
  const poison = await enqueueNotification(
    { queue, logger },
    {
      type: 'email',
      payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
      idempotency_key: `poison-${randomUUID()}`,
    },
  );
  const poisonJob = await waitFor('failed', poison.jobId);
  record(
    'poison message: unrecoverable on attempt 1 (no retries burned)',
    poisonJob.attemptsMade === 1,
    `attemptsMade=${poisonJob.attemptsMade}, failedReason=${poisonJob.failedReason?.slice(0, 60)}`,
  );
} catch (err) {
  record('verification run aborted', false, err instanceof Error ? err.message : String(err));
} finally {
  await worker.close().catch(() => {});
  await queue.close().catch(() => {});
  await connection.quit().catch(() => connection.disconnect());
  await redisServer.stop().catch(() => {});
}

console.log('\n──────── summary ────────');
const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.name}`);
}
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
