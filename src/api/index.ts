import { loadConfig } from '../config.js';
import { buildLogger } from '../lib/logger.js';
import { createRedisClient } from '../lib/redis.js';
import { createDbPool } from '../db/client.js';
import { createApp } from './server.js';

/**
 * API entrypoint (`npm run api`). Boot order: config → logger → redis →
 * postgres → listen. Any failure before listen is fatal by design —
 * a half-up API is worse than a dead one behind a load balancer.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger({ level: config.logLevel, pretty: !config.isProduction });

  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection in api process');
    process.exit(1);
  });

  const redis = await createRedisClient({
    url: config.redisUrl,
    connectTimeoutMs: 5_000,
    logger,
  });
  const db = createDbPool({ databaseUrl: config.databaseUrl, logger });

  const app = createApp({ config, db, redis, logger });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, pid: process.pid }, 'api listening');
  });

  const shutdown = async (): Promise<void> => {
    logger.info('api shutting down');
    server.close(() => logger.info('http server closed'));
    await redis.quit().catch(() => redis.disconnect());
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
