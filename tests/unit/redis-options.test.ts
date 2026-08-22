import type { RedisOptions } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { buildRedisOptions } from '../../src/lib/redis.js';

describe('buildRedisOptions', () => {
  it('parses password from the redis URL', () => {
    const opts = buildRedisOptions({
      url: 'redis://:secret@localhost:6379',
      connectTimeoutMs: 5_000,
    });
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6379);
    expect(opts.password).toBe('secret');
  });

  it('applies port 6379 default and no password when absent', () => {
    const opts = buildRedisOptions({ url: 'redis://localhost', connectTimeoutMs: 5_000 });
    expect(opts.port).toBe(6379);
    expect(opts.password).toBeUndefined();
  });

  it('uses lazyConnect so startup can fail fast with a clear error', () => {
    const opts = buildRedisOptions({ url: 'redis://localhost', connectTimeoutMs: 5_000 });
    expect(opts.lazyConnect).toBe(true);
  });

  it('disables maxRetriesPerRequest per the BullMQ contract', () => {
    const opts = buildRedisOptions({ url: 'redis://localhost', connectTimeoutMs: 5_000 });
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('caps exponential reconnect delay and gives up after the max', () => {
    const opts = buildRedisOptions({ url: 'redis://localhost', connectTimeoutMs: 5_000 });
    const strategy = opts.retryStrategy as NonNullable<RedisOptions['retryStrategy']>;
    expect(strategy(0)).toBeLessThanOrEqual(200);
    expect(strategy(5)).toBeLessThanOrEqual(2_000); // capped
    expect(strategy(20)).toBeNull(); // give up eventually
  });

  it('honors the configured connect timeout', () => {
    const opts = buildRedisOptions({ url: 'redis://localhost', connectTimeoutMs: 1_234 });
    expect(opts.connectTimeout).toBe(1_234);
  });
});
