import { Router, type RequestHandler } from 'express';
import type { QueryRunner } from '../../db/jobs.repository.js';
import { pingDatabase } from '../../db/client.js';

/**
 * Minimal connectivity surface so /health can probe Redis without owning the
 * connection. Satisfied structurally by ioredis.
 */
export interface PingableRedis {
  ping(): Promise<string>;
}

export function buildHealthRouter(deps: { db: QueryRunner; redis: PingableRedis }): Router {
  const router = Router();

  // FR8: /health is unauthenticated — load balancers and orchestrators probe
  // it and must not need credentials.
  router.get('/health', (async (_req, res) => {
    const [redis, postgres] = await Promise.allSettled([
      deps.redis.ping(),
      pingDatabase(deps.db),
    ]);
    const redisOk = redis.status === 'fulfilled' && redis.value === 'PONG';
    const body: Record<string, string> = {
      redis: redisOk ? 'ok' : 'error',
      postgres: postgres.status === 'fulfilled' ? 'ok' : 'error',
    };
    res.status(redisOk && postgres.status === 'fulfilled' ? 200 : 503).json(body);
  }) as RequestHandler);

  return router;
}
