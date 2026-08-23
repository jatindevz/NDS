import { describe, expect, it } from 'vitest';
import { cappedExponentialBackoff } from '../../../src/jobs/backoff.js';
import {
  NOTIFICATIONS_QUEUE,
  buildBackoffStrategy,
  notificationsDefaultJobOptions,
  notificationsQueueSettings,
} from '../../../src/queues/notifications.js';

describe('notificationsDefaultJobOptions', () => {
  it('retries up to 5 attempts with the cappedExponential strategy', () => {
    expect(notificationsDefaultJobOptions.attempts).toBe(5);
    expect(notificationsDefaultJobOptions.backoff).toEqual({
      type: 'cappedExponential',
      delay: 1000,
    });
  });

  it('keeps completed jobs around for audit (bounded), never drops failed jobs', () => {
    expect(notificationsDefaultJobOptions.removeOnComplete).toEqual({ age: 24 * 3600, count: 5000 });
    expect(notificationsDefaultJobOptions.removeOnFail).toBe(false);
  });
});

describe('notificationsQueueSettings', () => {
  it('registers the custom backoff strategy so this side can also move jobs to delayed', () => {
    expect(typeof notificationsQueueSettings.backoffStrategy).toBe('function');
  });
});

describe('buildBackoffStrategy', () => {
  it('delegates to cappedExponentialBackoff with PDR limits (base 1s, cap 60s)', () => {
    const strategy = buildBackoffStrategy(() => 1);
    expect(strategy(1)).toBe(cappedExponentialBackoff(1, { baseMs: 1000, capMs: 60_000, rng: () => 1 }));
    expect(strategy(7)).toBe(60_000);
  });

  it('returns a positive integer for any attempt count', () => {
    const strategy = buildBackoffStrategy();
    for (const attempt of [1, 3, 12, 50]) {
      const delay = strategy(attempt);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });
});

describe('NOTIFICATIONS_QUEUE', () => {
  it('is a stable, documented queue name', () => {
    expect(NOTIFICATIONS_QUEUE).toBe('notifications');
  });
});
