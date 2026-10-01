import { describe, expect, it } from 'vitest';
import {
  createOrGetJob,
  findById,
  listByStatus,
  updateStatus,
  type JobRecord,
  type QueryRunner,
} from '../../../src/db/jobs.repository.js';

/**
 * The repository is where correctness lives (idempotency!), so the fake
 * mimics the SQL semantics we rely on: ON CONFLICT DO NOTHING returns no row
 * when the key exists, and parameterized queries match only on the columns
 * we filter by. Rows are stored/returned snake_case like real pg output.
 */
function toRow(j: JobRecord): Record<string, unknown> {
  return {
    id: j.id,
    idempotency_key: j.idempotencyKey,
    type: j.type,
    payload: j.payload,
    status: j.status,
    attempts: j.attempts,
    max_attempts: j.maxAttempts,
    last_error: j.lastError,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  };
}

function fakeDb(tables: { jobs: JobRecord[]; nextId?: string }): QueryRunner & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string, values: readonly unknown[] = []) {
      queries.push(text);
      const t = tables;
      if (/insert into jobs/.test(text)) {
        const [key, type, payload, maxAttempts] = values as [string, string, unknown, number];
        if (t.jobs.some((j) => j.idempotencyKey === key)) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        const row: JobRecord = {
          id: t.nextId ?? crypto.randomUUID(),
          idempotencyKey: key,
          type: type as JobRecord['type'],
          payload,
          status: 'queued',
          attempts: 0,
          maxAttempts: maxAttempts ?? 5,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        t.jobs.push(row);
        return { rows: [toRow(row)] };
      }
      if (/select \* from jobs where id = \$1/.test(text)) {
        const id = values[0] as string;
        const row = t.jobs.find((j) => j.id === id);
        return { rows: row ? [toRow(row)] : [] };
      }
      if (/select \* from jobs where idempotency_key/.test(text)) {
        const key = values[0] as string;
        const row = t.jobs.find((j) => j.idempotencyKey === key);
        return { rows: row ? [toRow(row)] : [] };
      }
      if (/update jobs set/.test(text)) {
        const id = values[values.length - 1] as string;
        const row = t.jobs.find((j) => j.id === id);
        if (!row) return { rows: [] };
        row.status = values[0] as JobRecord['status'];
        if (values.length === 4) {
          row.attempts = values[1] as number;
          row.lastError = values[2] as string | null;
        }
        return { rows: [toRow(row)] };
      }
      if (/select \* from jobs (where status = \$1 )?order by created_at/.test(text)) {
        const status = values.length === 2 ? (values[0] as JobRecord['status']) : undefined;
        const limit = (values.length === 2 ? (values[1] as number) : (values[0] as number)) ?? 50;
        const rows = t.jobs
          .filter((j) => status === undefined || j.status === status)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit);
        return { rows: rows.map(toRow) };
      }
      throw new Error(`fakeDb: unexpected query ${text}`);
    },
  } as QueryRunner & { queries: string[] };
}

function seed(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: 'key-' + crypto.randomUUID(),
    type: 'email',
    payload: { to: 'a@b.co', subject: 's', body: 'b' },
    status: 'queued',
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('createOrGetJob (idempotency core)', () => {
  it('creates a new job and reports created: true', async () => {
    const jobs: JobRecord[] = [];
    const db = fakeDb({ jobs });
    const { job, created } = await createOrGetJob(db, {
      idempotencyKey: 'k1',
      type: 'email',
      payload: { to: 'a@b.co', subject: 's', body: 'b' },
    });
    expect(created).toBe(true);
    expect(job.idempotencyKey).toBe('k1');
    expect(job.status).toBe('queued');
  });

  it('returns the existing job with created: false on a duplicate key', async () => {
    const jobs: JobRecord[] = [seed({ idempotencyKey: 'dup' })];
    const db = fakeDb({ jobs });
    const { job, created } = await createOrGetJob(db, {
      idempotencyKey: 'dup',
      type: 'email',
      payload: { to: 'x@y.co', subject: 'different', body: 'payload' },
    });
    expect(created).toBe(false);
    expect(job.id).toBe(jobs[0]!.id);
    expect(jobs).toHaveLength(1); // no duplicate row
  });
});

describe('updateStatus', () => {
  it('applies the status and patch fields', async () => {
    const jobs: JobRecord[] = [seed()];
    const db = fakeDb({ jobs });
    const updated = await updateStatus(db, jobs[0]!.id, 'failed', {
      attempts: 3,
      lastError: 'boom',
    });
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(3);
    expect(updated.lastError).toBe('boom');
  });

  it('throws when the job does not exist', async () => {
    const db = fakeDb({ jobs: [] });
    await expect(updateStatus(db, crypto.randomUUID(), 'completed')).rejects.toThrow(/not found/);
  });
});

describe('findById', () => {
  it('returns null for a malformed uuid instead of throwing', async () => {
    const db = fakeDb({ jobs: [] });
    expect(await findById(db, 'not-a-uuid')).toBeNull();
  });
});

describe('listByStatus', () => {
  it('filters by status and sorts newest first', async () => {
    const old = seed({ status: 'dead_letter', createdAt: new Date(Date.now() - 10_000) });
    const recent = seed({ status: 'dead_letter' });
    const completed = seed({ status: 'completed' });
    const db = fakeDb({ jobs: [old, recent, completed] });
    const rows = await listByStatus(db, 'dead_letter');
    expect(rows.map((r) => r.id)).toEqual([recent.id, old.id]);
  });

  it('lists all jobs when no status is given', async () => {
    const db = fakeDb({ jobs: [seed(), seed()] });
    expect((await listByStatus(db)).length).toBe(2);
  });
});
