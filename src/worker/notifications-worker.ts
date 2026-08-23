import { Worker, type WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
  NOTIFICATIONS_QUEUE,
  notificationsQueueSettings,
} from '../queues/notifications.js';
import { buildProcessor, type HandlerRegistry } from './handlers.js';

export const DEFAULT_STALLED_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_STALLED_COUNT = 3;

export type WorkerTuning = Omit<WorkerOptions, 'connection'>;

export function buildNotificationsWorkerOptions(opts: {
  concurrency: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
}): WorkerTuning {
  return {
    concurrency: opts.concurrency,
    stalledInterval: opts.stalledIntervalMs ?? DEFAULT_STALLED_INTERVAL_MS,
    maxStalledCount: opts.maxStalledCount ?? DEFAULT_MAX_STALLED_COUNT,
    settings: notificationsQueueSettings,
  };
}

/**
 * A worker that dies mid-job leaves the job in "active" state holding a stale
 * lock. stalledInterval is how often other workers check for that; the check
 * is cheap (a sorted-set scan) so 30s is comfortably safe. maxStalledCount
 * bounds how many times a crash-looping job gets retried before it is marked
 * failed for good — otherwise one poison loop can stall forever.
 */
export function createNotificationsWorker(deps: {
  connection: Redis;
  registry: HandlerRegistry;
  logger: Logger;
  concurrency: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
}): Worker {
  const worker = new Worker(
    NOTIFICATIONS_QUEUE,
    buildProcessor(deps.registry, deps.logger),
    {
      ...buildNotificationsWorkerOptions({
        concurrency: deps.concurrency,
        stalledIntervalMs: deps.stalledIntervalMs,
        maxStalledCount: deps.maxStalledCount,
      }),
      connection: deps.connection,
    },
  );
  attachWorkerLifecycleLogging(worker, deps.logger);
  return worker;
}

export function attachWorkerLifecycleLogging(worker: Worker, logger: Logger): void {
  worker.on('completed', (job) => {
    logger.info({ jobId: String(job.id), attempts: job.attemptsMade + 1 }, 'job completed');
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error({ err }, 'job failed (job unavailable — moved to failed set)');
      return;
    }
    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 1;
    const fields = {
      jobId: String(job.id),
      attemptsMade,
      maxAttempts,
      err,
    };
    if (attemptsMade >= maxAttempts) {
      logger.error(fields, 'job exhausted all attempts');
    } else {
      logger.warn(fields, 'job failed, retrying');
    }
  });

  worker.on('stalled', (jobId, prev) => {
    logger.warn({ jobId, previousState: prev }, 'job stalled and will be retried');
  });

  // Worker-level errors (redis outage, protocol failures) never reach the
  // processor; without this listener they crash the process.
  worker.on('error', (err) => {
    logger.error({ err, component: 'worker' }, 'worker error');
  });
}
