import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLogger } from '../../src/lib/logger.js';
import { createRedisClient } from '../../src/lib/redis.js';
import type { Redis } from 'ioredis';

const logger = buildLogger({ level: 'fatal', pretty: false });

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://:nds_dev_password@localhost:6379';

/**
 * Probe the port once before loading the suite: if Redis isn't running
 * (e.g. no Docker on this machine), skip instead of failing CI.
 */
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

describe.skipIf(!redisUp)('redis integration', () => {
  let client: Redis | undefined;

  afterAll(async () => {
    await client?.quit().catch(() => client?.disconnect());
  });

  it('connects and answers PING', async () => {
    client = await createRedisClient({
      url: REDIS_URL,
      connectTimeoutMs: 3_000,
      logger,
    });
    expect(await client.ping()).toBe('PONG');
  });

  it('sets and gets a value', async () => {
    client =
      client ??
      (await createRedisClient({ url: REDIS_URL, connectTimeoutMs: 3_000, logger }));
    await client.set('nds:test:key', 'value');
    expect(await client.get('nds:test:key')).toBe('value');
    await client.del('nds:test:key');
  });

  // Only meaningful against a password-protected Redis (local docker-compose).
  // CI runs Redis passwordless, so there is no credential to get wrong.
  it.skipIf(!url.password)('rejects bad credentials quickly instead of hanging', async () => {
    const badUrl = REDIS_URL.replace(/:([^@]*)@/, ':definitely-wrong-password@');
    await expect(
      createRedisClient({ url: badUrl, connectTimeoutMs: 3_000, logger }),
    ).rejects.toThrow(/auth|invalid password|noauth/i);
  });
});

describe.skipIf(redisUp)('redis integration (skipped: redis not reachable)', () => {
  it('documents how to enable this suite', () => {
    // Info for the developer: run `docker compose up -d redis` to enable these tests.
    expect(true).toBe(true);
  });
});
