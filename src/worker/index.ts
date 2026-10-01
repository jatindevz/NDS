import type { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { buildLogger } from '../lib/logger.js';
import { createRedisClient } from '../lib/redis.js';
import { createNotificationsWorker } from './notifications-worker.js';
import { registerGracefulShutdown } from './graceful.js';
import { buildHandlerRegistry } from '../handlers/registry.js';

/**
 * Registry is built from config: email via Resend when credentials exist,
 * webhook always. Missing config surfaces as a startup warning and the
 * affected job type fails unrecoverably at processing time — visible, not
 * silent.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger({ level: config.logLevel, pretty: !config.isProduction });
  const { registry, warnings } = buildHandlerRegistry({ config, logger });
  for (const warning of warnings) {
    logger.warn(warning);
  }

  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection in worker process');
    process.exit(1);
  });

  let redis: Redis;
  try {
    redis = await createRedisClient({
      url: config.redisUrl,
      connectTimeoutMs: 5_000,
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'cannot reach redis at startup — failing fast');
    process.exit(1);
  }

  const worker = createNotificationsWorker({
    connection: redis,
    registry,
    logger,
    concurrency: config.workerConcurrency,
  });

  registerGracefulShutdown({
    components: [
      { name: 'worker', close: () => worker.close() },
      { name: 'redis', close: async () => void (await redis.quit()), forceKill: () => redis.disconnect() },
    ],
    signals: ['SIGTERM', 'SIGINT'],
    timeoutMs: config.gracefulShutdownTimeoutMs,
    logger,
    onShutdownComplete: ({ clean }) => process.exit(clean ? 0 : 1),
  });

  logger.info(
    { queue: 'notifications', concurrency: config.workerConcurrency, pid: process.pid },
    'worker started',
  );
}

main().catch((err) => {
  // Logger may not exist yet (config can fail to load); stderr is the floor.
  process.stderr.write(`fatal startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
