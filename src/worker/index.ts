import { loadConfig } from '../config.js';
import { buildLogger } from '../lib/logger.js';
import { createRedisClient } from '../lib/redis.js';
import { createNotificationsWorker } from './notifications-worker.js';
import { registerGracefulShutdown } from './graceful.js';
import type { HandlerRegistry } from './handlers.js';

/**
 * Provider handlers (Resend email, webhook POST) land with the delivery
 * layer. Until then the registry is intentionally empty: a job whose type
 * has no handler fails unrecoverably and visibly, rather than being
 * "completed" by a silent no-op.
 */
const registry: HandlerRegistry = {};

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger({ level: config.logLevel, pretty: !config.isProduction });

  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection in worker process');
    process.exit(1);
  });

  let redis;
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
