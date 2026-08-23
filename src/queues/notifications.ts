import { Queue } from 'bullmq';
import type { JobsOptions, AdvancedOptions, BackoffStrategy } from 'bullmq';
import type { Redis } from 'ioredis';
import { cappedExponentialBackoff } from '../jobs/backoff.js';

export const NOTIFICATIONS_QUEUE = 'notifications';

/** PDR section 8: base 1s, cap 60s, max 5 attempts. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
export const MAX_ATTEMPTS = 5;

export function buildBackoffStrategy(rng: () => number = Math.random): BackoffStrategy {
  return (attemptsMade: number) =>
    cappedExponentialBackoff(attemptsMade, {
      baseMs: BACKOFF_BASE_MS,
      capMs: BACKOFF_CAP_MS,
      rng,
    });
}

/**
 * BullMQ resolves a custom backoff strategy from `settings.backoffStrategy`
 * of whichever instance moves a job to the delayed set — the worker on
 * failure, the queue on manual retries. Register it on both.
 */
export const notificationsQueueSettings: AdvancedOptions = {
  backoffStrategy: buildBackoffStrategy(),
};

export const notificationsDefaultJobOptions: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'cappedExponential', delay: BACKOFF_BASE_MS },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: false,
};

export function createNotificationsQueue(
  connection: Redis,
  opts: { prefix?: string } = {},
): Queue {
  return new Queue(NOTIFICATIONS_QUEUE, {
    connection,
    defaultJobOptions: notificationsDefaultJobOptions,
    settings: notificationsQueueSettings,
    prefix: opts.prefix,
  });
}
