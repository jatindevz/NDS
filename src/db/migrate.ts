import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { buildLogger } from '../lib/logger.js';
import { closeDbPool, createDbPool } from './client.js';

const MIGRATION_NAME = '001_initial_schema';

/**
 * Applies pending migrations. Transactional: DDL in postgres is atomic, so
 * the schema either lands completely or not at all. Safe to run repeatedly —
 * applied migrations are recorded in schema_migrations and skipped.
 */
export async function runMigrations(opts: {
  databaseUrl: string;
  logger: ReturnType<typeof buildLogger>;
}): Promise<void> {
  const pool = createDbPool({ databaseUrl: opts.databaseUrl, logger: opts.logger });
  try {
    await pool.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = await pool.query('select name from schema_migrations');
    if (applied.rows.some((row) => row.name === MIGRATION_NAME)) {
      opts.logger.info({ migration: MIGRATION_NAME }, 'database schema is up to date');
      return;
    }
    const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
    const schemaSql = await readFile(schemaPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(schemaSql);
      await client.query('insert into schema_migrations (name) values ($1)', [MIGRATION_NAME]);
      await client.query('commit');
      opts.logger.info({ migration: MIGRATION_NAME }, 'database schema applied');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await closeDbPool(pool);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger({ level: config.logLevel, pretty: !config.isProduction });
  await runMigrations({ databaseUrl: config.databaseUrl, logger });
}

// Only auto-run when invoked directly (`npm run migrate`), not when imported
// by tests or other modules.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
