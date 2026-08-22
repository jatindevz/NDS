import { describe, expect, it } from 'vitest';
import { buildLogger } from '../../src/lib/logger.js';

function captureStdout(): { lines: unknown[]; restore: () => void } {
  const lines: unknown[] = [];
  const original = process.stdout.write;
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    lines.push(chunk);
    return true;
  };
  return {
    lines,
    restore: () => {
      process.stdout.write = original as typeof process.stdout.write;
    },
  };
}

describe('buildLogger', () => {
  it('emits structured JSON with level and message', () => {
    const { lines, restore } = captureStdout();
    const logger = buildLogger({ level: 'info', pretty: false });
    logger.info({ jobId: 'abc' }, 'job enqueued');
    restore();
    const entry = JSON.parse(String(lines[0]).trim()) as Record<string, unknown>;
    expect(entry.level).toBe(30); // pino: info
    expect(entry.msg).toBe('job enqueued');
    expect(entry.jobId).toBe('abc');
    expect(typeof entry.time).toBe('string'); // ISO timestamp
  });

  it('child loggers inherit bindings for correlation', () => {
    const { lines, restore } = captureStdout();
    const logger = buildLogger({ level: 'info', pretty: false });
    const child = logger.child({ jobId: 'job-42', queue: 'notifications' });
    child.info('attempt started');
    restore();
    const entry = JSON.parse(String(lines[0]).trim()) as Record<string, unknown>;
    expect(entry.jobId).toBe('job-42');
    expect(entry.queue).toBe('notifications');
  });

  it('respects level filtering (debug suppressed at info)', () => {
    const { lines, restore } = captureStdout();
    const logger = buildLogger({ level: 'info', pretty: false });
    logger.debug('should not appear');
    restore();
    expect(lines).toHaveLength(0);
  });

  it('serializes errors with type and message', () => {
    const { lines, restore } = captureStdout();
    const logger = buildLogger({ level: 'error', pretty: false });
    logger.error({ err: new Error('boom') }, 'delivery failed');
    restore();
    const entry = JSON.parse(String(lines[0]).trim()) as {
      err: { type: string; message: string };
    };
    expect(entry.err.type).toBe('Error');
    expect(entry.err.message).toBe('boom');
  });

  it('redacts nothing by default but logs safely with bindings only', () => {
    const { lines, restore } = captureStdout();
    const logger = buildLogger({ level: 'info', pretty: false });
    logger.info({ attempt: 2, maxAttempts: 5 }, 'retry scheduled');
    restore();
    const entry = JSON.parse(String(lines[0]).trim()) as Record<string, unknown>;
    expect(entry.attempt).toBe(2);
    expect(entry.maxAttempts).toBe(5);
  });
});
