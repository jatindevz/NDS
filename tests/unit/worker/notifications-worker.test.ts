import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import type { Job, Worker } from 'bullmq';
import {
  DEFAULT_MAX_STALLED_COUNT,
  DEFAULT_STALLED_INTERVAL_MS,
  attachWorkerLifecycleLogging,
  buildNotificationsWorkerOptions,
} from '../../../src/worker/notifications-worker.js';

const logger: Logger = { child: () => logger } as unknown as Logger;

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = {
    child: () => logger,
    info: (fields: Record<string, unknown>, msg: string) => entries.push({ level: 'info', msg, fields }),
    warn: (fields: Record<string, unknown>, msg: string) => entries.push({ level: 'warn', msg, fields }),
    error: (fields: Record<string, unknown>, msg: string) => entries.push({ level: 'error', msg, fields }),
  } as unknown as Logger;
  return { logger, entries };
}

describe('buildNotificationsWorkerOptions', () => {
  it('configures concurrency, stall detection, and the custom backoff strategy', () => {
    const opts = buildNotificationsWorkerOptions({ concurrency: 7 });
    expect(opts.concurrency).toBe(7);
    expect(opts.stalledInterval).toBe(DEFAULT_STALLED_INTERVAL_MS);
    expect(opts.maxStalledCount).toBe(DEFAULT_MAX_STALLED_COUNT);
    expect(typeof opts.settings?.backoffStrategy).toBe('function');
  });

  it('allows overriding stall detection bounds', () => {
    const opts = buildNotificationsWorkerOptions({
      concurrency: 1,
      stalledIntervalMs: 5_000,
      maxStalledCount: 1,
    });
    expect(opts.stalledInterval).toBe(5_000);
    expect(opts.maxStalledCount).toBe(1);
  });
});

describe('attachWorkerLifecycleLogging', () => {
  it('logs completions with the final attempt count', () => {
    const { logger, entries } = recordingLogger();
    const w = new EventEmitter();
    attachWorkerLifecycleLogging(w as unknown as Worker, logger);
    const job = { id: 'j1', attemptsMade: 1 } as unknown as Job;
    w.emit('completed', job, 'result', 'active');
    expect(entries).toContainEqual({
      level: 'info',
      msg: 'job completed',
      fields: { jobId: 'j1', attempts: 2 },
    });
  });

  it('warns on failure while attempts remain', () => {
    const { logger, entries } = recordingLogger();
    const w = new EventEmitter();
    attachWorkerLifecycleLogging(w as unknown as Worker, logger);
    const job = { id: 'j2', attemptsMade: 1, opts: { attempts: 5 } } as unknown as Job;
    w.emit('failed', job, new Error('boom'), 'active');
    const entry = entries.find((e) => e.msg === 'job failed, retrying');
    expect(entry?.fields.jobId).toBe('j2');
    expect(entry?.fields.attemptsMade).toBe(1);
    expect(entry?.level).toBe('warn');
  });

  it('errors when attempts are exhausted', () => {
    const { logger, entries } = recordingLogger();
    const w = new EventEmitter();
    attachWorkerLifecycleLogging(w as unknown as Worker, logger);
    const job = { id: 'j3', attemptsMade: 5, opts: { attempts: 5 } } as unknown as Job;
    w.emit('failed', job, new Error('boom'), 'active');
    expect(entries.some((e) => e.msg === 'job exhausted all attempts' && e.level === 'error')).toBe(true);
  });

  it('warns on stalled jobs', () => {
    const { logger, entries } = recordingLogger();
    const w = new EventEmitter();
    attachWorkerLifecycleLogging(w as unknown as Worker, logger);
    w.emit('stalled', 'j4', 'active');
    expect(entries.some((e) => e.msg === 'job stalled and will be retried')).toBe(true);
  });

  it('errors on worker-level errors (e.g. redis outage)', () => {
    const { logger, entries } = recordingLogger();
    const w = new EventEmitter();
    attachWorkerLifecycleLogging(w as unknown as Worker, logger);
    w.emit('error', new Error('connection closed'));
    expect(entries.some((e) => e.msg === 'worker error' && e.level === 'error')).toBe(true);
  });
});
