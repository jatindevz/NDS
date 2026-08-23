import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { registerGracefulShutdown } from '../../../src/worker/graceful.js';

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as unknown as Logger;

afterEach(() => {
  vi.useRealTimers();
});

function never(): Promise<void> {
  return new Promise(() => {});
}

describe('registerGracefulShutdown', () => {
  it('closes components in order (worker first so active jobs drain)', async () => {
    const order: string[] = [];
    const { shutdown } = registerGracefulShutdown({
      components: [
        { name: 'worker', close: async () => void order.push('worker') },
        { name: 'queue', close: async () => void order.push('queue') },
        { name: 'redis', close: async () => void order.push('redis') },
      ],
      signals: [],
      timeoutMs: 1_000,
      logger,
    });
    await shutdown();
    expect(order).toEqual(['worker', 'queue', 'redis']);
  });

  it('force-kills a component whose close() exceeds the timeout', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const { shutdown } = registerGracefulShutdown({
      components: [
        { name: 'worker', close: () => never(), forceKill: () => void events.push('force') },
        { name: 'redis', close: async () => void events.push('redis-closed') },
      ],
      signals: [],
      timeoutMs: 5_000,
      logger,
    });
    const promise = shutdown();
    await vi.advanceTimersByTimeAsync(5_001);
    await promise;
    expect(events).toEqual(['force', 'redis-closed']);
  });

  it('continues closing remaining components when one fails', async () => {
    const events: string[] = [];
    const { shutdown } = registerGracefulShutdown({
      components: [
        { name: 'worker', close: async () => { throw new Error('close failed'); } },
        { name: 'redis', close: async () => void events.push('redis-closed') },
      ],
      signals: [],
      timeoutMs: 1_000,
      logger,
    });
    const result = await shutdown();
    expect(events).toEqual(['redis-closed']);
    expect(result.clean).toBe(false);
  });

  it('reports a clean shutdown when everything closed', async () => {
    const { shutdown } = registerGracefulShutdown({
      components: [{ name: 'redis', close: async () => {} }],
      signals: [],
      timeoutMs: 1_000,
      logger,
    });
    expect((await shutdown()).clean).toBe(true);
  });

  it('ignores repeated shutdown calls (re-entry guard)', async () => {
    let closes = 0;
    const { shutdown } = registerGracefulShutdown({
      components: [{ name: 'redis', close: async () => void closes++ }],
      signals: [],
      timeoutMs: 1_000,
      logger,
    });
    await Promise.all([shutdown(), shutdown(), shutdown()]);
    expect(closes).toBe(1);
  });

  it('wires signal handlers to the shutdown routine', async () => {
    const listenersBefore = process.listenerCount('SIGTERM');
    const { shutdown, unregister } = registerGracefulShutdown({
      components: [],
      signals: ['SIGTERM'],
      timeoutMs: 1_000,
      logger,
    });
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore + 1);
    process.emit('SIGTERM');
    // signal-triggered shutdown must complete without hanging
    await shutdown();
    unregister();
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore);
  });
});

describe('registerGracefulShutdown onShutdownComplete', () => {
  it('notifies the caller with the final result', async () => {
    const results: Array<{ clean: boolean }> = [];
    const { shutdown } = registerGracefulShutdown({
      components: [{ name: 'redis', close: async () => {} }],
      signals: [],
      timeoutMs: 1_000,
      logger,
      onShutdownComplete: (result) => results.push(result),
    });
    await shutdown();
    expect(results).toEqual([{ clean: true }]);
  });
});
