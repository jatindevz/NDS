import { Pool } from 'pg';
import type { Logger } from '../lib/logger.js';
import type { QueryRunner } from './jobs.repository.js';

export function createDbPool(opts: {
  databaseUrl: string;
  logger: Logger;
  max?: number;
  connectionTimeoutMs?: number;
}): Pool {
  const pool = new Pool({
    connectionString: opts.databaseUrl,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
  });
  // Background pool errors (postgres restart, network drop) emit on 'error';
  // without a listener they crash the process.
  pool.on('error', (err) =>
    opts.logger.error({ err, component: 'postgres' }, 'postgres pool error'),
  );
  return pool;
}

/** Adapts a pg.Pool to the repository's minimal QueryRunner surface. */
export function asQueryRunner(pool: Pool): QueryRunner {
  return {
    query: (text, values) => pool.query(text, values as unknown[]),
  };
}

export async function pingDatabase(db: QueryRunner): Promise<void> {
  await db.query('select 1');
}

/**
 * Ends the pool with a timeout so a wedged connection cannot hang shutdown;
 * returns false if the timeout won (shutdown then reports non-clean).
 */
export async function closeDbPool(pool: Pool, timeoutMs = 5_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const end = pool.end().then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([end, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
