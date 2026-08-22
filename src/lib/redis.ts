import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from './logger.js';

const DEFAULT_RECONNECT_BASE_MS = 50;
const DEFAULT_RECONNECT_MAX_MS = 2_000;
const DEFAULT_MAX_RECONNECT_RETRIES = 20;

/**
 * BullMQ requires maxRetriesPerRequest: null; without it, queued commands
 * can hang forever when Redis is down. lazyConnect lets the caller fail
 * fast at startup instead of retrying silently in the background.
 */
export function buildRedisOptions(opts: {
  url: string;
  connectTimeoutMs: number;
  keyPrefix?: string;
}): RedisOptions {
  const url = new URL(opts.url);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectTimeout: opts.connectTimeoutMs,
    enableReadyCheck: true,
    keyPrefix: opts.keyPrefix,
    // ioredis v6: retryStrategy(times) returns the next delay in ms;
    // returning null stops reconnecting for good.
    retryStrategy: (retries: number): number | null => {
      if (retries > DEFAULT_MAX_RECONNECT_RETRIES) {
        return null; // give up: surface the failure instead of retrying forever
      }
      const delay = Math.min(
        DEFAULT_RECONNECT_BASE_MS * 2 ** retries,
        DEFAULT_RECONNECT_MAX_MS,
      );
      // Full jitter avoids thundering-herd reconnects across many workers.
      return Math.round(delay * (0.5 + Math.random() / 2));
    },
  };
}

/**
 * Creates a Redis client and verifies connectivity with an explicit
 * connect + ping. Rejects if Redis is unreachable within the timeout —
 * callers should treat this as a fatal startup error.
 */
export async function createRedisClient(opts: {
  url: string;
  connectTimeoutMs: number;
  logger: Logger;
  keyPrefix?: string;
}): Promise<Redis> {
  const client = new Redis(buildRedisOptions(opts));
  // Without a listener, an ioredis 'error' event crashes the process.
  client.on('error', (err: Error) =>
    opts.logger.error({ err, component: 'redis' }, 'redis client error'),
  );
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`unexpected PING response: ${pong}`);
    }
  } catch (err) {
    await client.quit().catch(() => client.disconnect());
    throw err;
  }
  return client;
}
