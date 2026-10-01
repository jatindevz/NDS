import express, { type Express } from 'express';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { asQueryRunner } from '../db/client.js';
import { createPgJobsStore } from '../db/jobs.repository.js';
import { createNotificationsQueue } from '../queues/notifications.js';
import { buildJobsRouter } from './routes/jobs.js';
import { buildHealthRouter } from './routes/health.js';
import { errorHandler, notFoundHandler } from './error-middleware.js';

export type ApiServerDeps = {
  config: {
    apiKey: string | undefined;
  };
  db: Pool;
  redis: Redis;
  logger: Logger;
};

/**
 * Express app factory. Deliberately exported separately from the listen
 * entrypoint so supertest can drive the full stack in-process.
 */
export function createApp(deps: ApiServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(
    buildHealthRouter({
      db: asQueryRunner(deps.db),
      redis: deps.redis,
    }),
  );
  app.use(
    buildJobsRouter({
      store: createPgJobsStore(asQueryRunner(deps.db)),
      queue: createNotificationsQueue(deps.redis),
      logger: deps.logger,
      apiKey: deps.config.apiKey,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
