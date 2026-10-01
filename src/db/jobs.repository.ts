import type { NotificationType } from '../jobs/schemas.js';

export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'dead_letter'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobRecord = {
  id: string;
  idempotencyKey: string;
  type: NotificationType;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Minimal query surface the repository needs. pg.Pool satisfies this
 * structurally (see asQueryRunner in db/client.ts); tests inject fakes.
 */
export interface QueryRunner {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type CreateJobInput = {
  idempotencyKey: string;
  type: NotificationType;
  payload: unknown;
  maxAttempts?: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapRow(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    type: row.type as NotificationType,
    payload: row.payload,
    status: row.status as JobStatus,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Race-condition-safe idempotent create (TDR §6.1): the INSERT relies on the
 * UNIQUE constraint on idempotency_key — `on conflict do nothing` is the
 * declarative equivalent of catching the 23505 unique-violation. When the
 * insert loses the race we fetch the existing row; the database constraint,
 * not the application check, is what makes this correct under concurrency.
 */
export async function createOrGetJob(
  db: QueryRunner,
  input: CreateJobInput,
): Promise<{ job: JobRecord; created: boolean }> {
  const inserted = await db.query(
    `insert into jobs (idempotency_key, type, payload, max_attempts)
     values ($1, $2, $3::jsonb, $4)
     on conflict (idempotency_key) do nothing
     returning *`,
    [input.idempotencyKey, input.type, JSON.stringify(input.payload), input.maxAttempts ?? 5],
  );
  const row = inserted.rows[0];
  if (row) {
    return { job: mapRow(row), created: true };
  }
  const existing = await findByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) {
    throw new Error(
      `idempotency conflict on '${input.idempotencyKey}' but no existing row found — data inconsistency`,
    );
  }
  return { job: existing, created: false };
}

export async function findByIdempotencyKey(db: QueryRunner, key: string): Promise<JobRecord | null> {
  const result = await db.query('select * from jobs where idempotency_key = $1', [key]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function findById(db: QueryRunner, id: string): Promise<JobRecord | null> {
  // Never hand a non-uuid to postgres: it answers with a 22P02 error instead
  // of "no rows", and callers only care about "not found" either way.
  if (!UUID_PATTERN.test(id)) return null;
  const result = await db.query('select * from jobs where id = $1', [id]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export type StatusPatch = {
  attempts?: number;
  lastError?: string | null;
  maxAttempts?: number;
};

export async function updateStatus(
  db: QueryRunner,
  id: string,
  status: JobStatus,
  patch: StatusPatch = {},
): Promise<JobRecord> {
  const sets: string[] = ['status = $1', 'updated_at = now()'];
  const values: unknown[] = [status];
  if (patch.attempts !== undefined) {
    values.push(patch.attempts);
    sets.push(`attempts = $${values.length}`);
  }
  if (patch.lastError !== undefined) {
    values.push(patch.lastError);
    sets.push(`last_error = $${values.length}`);
  }
  if (patch.maxAttempts !== undefined) {
    values.push(patch.maxAttempts);
    sets.push(`max_attempts = $${values.length}`);
  }
  values.push(id);
  const result = await db.query(
    `update jobs set ${sets.join(', ')} where id = $${values.length} returning *`,
    values,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateStatus: job '${id}' not found`);
  }
  return mapRow(row);
}

/** Lists jobs newest-first, optionally filtered by status (undefined = all). */
export async function listByStatus(
  db: QueryRunner,
  status?: JobStatus,
  limit = 50,
): Promise<JobRecord[]> {
  const values: unknown[] = [];
  if (status !== undefined) values.push(status);
  values.push(limit);
  const where = status !== undefined ? 'where status = $1' : '';
  const result = await db.query(
    `select * from jobs ${where} order by created_at desc limit $${values.length}`.replace(/\s+/g, ' ').trim(),
    values,
  );
  return result.rows.map(mapRow);
}

/**
 * The operations the API layer needs, decoupled from SQL so routes can be
 * unit-tested against an in-memory store while the pg implementation is
 * exercised (with real SQL semantics) by integration tests.
 */
export interface JobsStore {
  createOrGetJob(input: CreateJobInput): Promise<{ job: JobRecord; created: boolean }>;
  findById(id: string): Promise<JobRecord | null>;
  listByStatus(status?: JobStatus, limit?: number): Promise<JobRecord[]>;
  updateStatus(id: string, status: JobStatus, patch?: StatusPatch): Promise<JobRecord>;
}

export function createPgJobsStore(db: QueryRunner): JobsStore {
  return {
    createOrGetJob: (input) => createOrGetJob(db, input),
    findById: (id) => findById(db, id),
    listByStatus: (status, limit) => listByStatus(db, status, limit),
    updateStatus: (id, status, patch) => updateStatus(db, id, status, patch),
  };
}
