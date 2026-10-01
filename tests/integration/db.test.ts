import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { buildLogger } from '../../src/lib/logger.js';
import { asQueryRunner, closeDbPool, createDbPool } from '../../src/db/client.js';
import {
  createOrGetJob,
  createPgJobsStore,
  findById,
  updateStatus,
} from '../../src/db/jobs.repository.js';
import { runMigrations } from '../../src/db/migrate.js';

const logger = buildLogger({ level: 'fatal', pretty: false });
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/nds';

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

const url = new URL(DATABASE_URL);
const dbUp = await isPortOpen(url.hostname, Number(url.port || 5432));

describe.skipIf(!dbUp)('jobs repository against real postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations({ databaseUrl: DATABASE_URL, logger });
    pool = createDbPool({ databaseUrl: DATABASE_URL, logger });
  });

  afterAll(async () => {
    await closeDbPool(pool);
  });

  /** Unique per-run keys so concurrent runs never collide on idempotency_key. */
  const key = () => `it-${randomUUID()}`;

  it('persists and reads back a job round-trip', async () => {
    const db = asQueryRunner(pool);
    const payload = { to: 'user@example.com', subject: 'Hi', body: 'Hello' };
    const { job, created } = await createOrGetJob(db, {
      idempotencyKey: key(),
      type: 'email',
      payload,
    });
    expect(created).toBe(true);
    const fetched = await findById(db, job.id);
    expect(fetched?.payload).toEqual(payload);
    expect(fetched?.status).toBe('queued');
    expect(fetched?.maxAttempts).toBe(5);
  });

  it('createOrGetJob is race-safe: duplicate key returns the original row', async () => {
    const db = asQueryRunner(pool);
    const k = key();
    const first = await createOrGetJob(db, { idempotencyKey: k, type: 'email', payload: {} });
    // Concurrent duplicates from "two API pods":
    const racers = await Promise.all(
      Array.from({ length: 5 }, () =>
        createOrGetJob(db, { idempotencyKey: k, type: 'email', payload: {} }),
      ),
    );
    for (const { job, created } of racers) {
      expect(created).toBe(false);
      expect(job.id).toBe(first.job.id);
    }
    const all = await pool.query('select count(*)::int as n from jobs where idempotency_key = $1', [k]);
    expect(all.rows[0]?.n).toBe(1);
  });

  it('updateStatus writes attempts and last_error', async () => {
    const db = asQueryRunner(pool);
    const { job } = await createOrGetJob(db, { idempotencyKey: key(), type: 'webhook', payload: {} });
    const updated = await updateStatus(db, job.id, 'failed', {
      attempts: 3,
      lastError: 'resend returned 503',
    });
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(3);
    expect(updated.lastError).toBe('resend returned 503');
    const reread = await findById(db, job.id);
    expect(reread?.attempts).toBe(3);
  });

  it('the status CHECK constraint rejects unknown statuses', async () => {
    const db = asQueryRunner(pool);
    const { job } = await createOrGetJob(db, { idempotencyKey: key(), type: 'email', payload: {} });
    await expect(updateStatus(db, job.id, 'bogus' as never)).rejects.toThrow();
  });

  it('findById returns null (not an error) for a malformed uuid', async () => {
    const db = asQueryRunner(pool);
    expect(await findById(db, '../../../etc/passwd')).toBeNull();
  });

  it('listByStatus filters and lists all when unfiltered', async () => {
    const store = createPgJobsStore(asQueryRunner(pool));
    const deadOne = await createOrGetJob(asQueryRunner(pool), { idempotencyKey: key(), type: 'email', payload: {} });
    await updateStatus(asQueryRunner(pool), deadOne.job.id, 'dead_letter', { attempts: 5, lastError: 'exhausted' });
    const deadTwo = await createOrGetJob(asQueryRunner(pool), { idempotencyKey: key(), type: 'email', payload: {} });
    await updateStatus(asQueryRunner(pool), deadTwo.job.id, 'dead_letter', { attempts: 5, lastError: 'exhausted' });
    const dlq = await store.listByStatus('dead_letter');
    const ids = new Set(dlq.map((j) => j.id));
    expect(ids.has(deadOne.job.id)).toBe(true);
    expect(ids.has(deadTwo.job.id)).toBe(true);
    const everything = await store.listByStatus();
    expect(everything.length).toBeGreaterThanOrEqual(2);
  });

  it('full API lifecycle: queued -> processing -> completed -> dead_letter -> retry', async () => {
    const store = createPgJobsStore(asQueryRunner(pool));
    const { job } = await store.createOrGetJob({ idempotencyKey: key(), type: 'email', payload: {} });

    await store.updateStatus(job.id, 'processing');
    await store.updateStatus(job.id, 'failed', { attempts: 1, lastError: 'attempt 1 failed' });
    await store.updateStatus(job.id, 'processing', { attempts: 2 });
    await store.updateStatus(job.id, 'completed', { attempts: 2 });

    // DLQ story: exhaust retries, then manually resurrect.
    const dead = await store.updateStatus(job.id, 'dead_letter', { attempts: 5, lastError: 'exhausted' });
    expect(dead.status).toBe('dead_letter');
    expect((await store.findById(job.id))?.attempts).toBe(5);

    const revived = await store.updateStatus(job.id, 'queued', { attempts: 0, lastError: null });
    expect(revived.status).toBe('queued');
    expect(revived.attempts).toBe(0);
    expect(revived.lastError).toBeNull();
  });
});

describe.skipIf(dbUp)('jobs repository (skipped: postgres not reachable)', () => {
  it('documents how to enable this suite', () => {
    expect(true).toBe(true);
  });
});
