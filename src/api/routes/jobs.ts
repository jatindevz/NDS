import { Router, type RequestHandler } from 'express';
import type { Logger } from 'pino';
import { InvalidJobError, parseJobRequest } from '../../jobs/schemas.js';
import type { EnqueueableQueue } from '../../services/enqueue.js';
import { enqueueNotification } from '../../services/enqueue.js';
import {
  JOB_STATUSES,
  type JobRecord,
  type JobsStore,
} from '../../db/jobs.repository.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { requireBearerToken } from '../middleware/auth.js';

/**
 * API responses use snake_case to mirror the request format and the database
 * schema (PDR §6/§7) — no client-side translation between what you send,
 * what you store, and what you read back.
 */
function serializeJob(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    idempotency_key: job.idempotencyKey,
    type: job.type,
    payload: job.payload,
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    last_error: job.lastError,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

export function buildJobsRouter(deps: {
  store: JobsStore;
  queue: EnqueueableQueue;
  logger: Logger;
  apiKey: string | undefined;
}): Router {
  const router = Router();
  const authenticate: RequestHandler = requireBearerToken(deps.apiKey);
  router.use(authenticate);

  /**
   * FR1/FR2: enqueue with idempotency. The database unique constraint
   * arbitrates concurrent duplicates; only genuinely new rows reach the
   * queue, so a client network-retry can never double-send.
   */
  router.post('/jobs', (req, res, next) => {
    void (async () => {
      let parsed;
      try {
        parsed = parseJobRequest(req.body);
      } catch (err) {
        if (err instanceof InvalidJobError) {
          next(new ValidationError(err.message));
          return;
        }
        throw err;
      }

      const { job, created } = await deps.store.createOrGetJob({
        idempotencyKey: parsed.idempotencyKey,
        type: parsed.type,
        payload: parsed.payload,
      });
      if (!created) {
        // Duplicate idempotency key: return the existing job, enqueue nothing.
        res.status(200).json(serializeJob(job));
        return;
      }

      try {
        await enqueueNotification({ queue: deps.queue, logger: deps.logger }, req.body);
      } catch (err) {
        // Insert-then-enqueue gap: the row exists but never entered the queue.
        // Mark it failed so it is visible and re-triggerable instead of a
        // silently stuck 'queued' row that nothing will ever process.
        deps.logger.error({ err, jobId: job.id }, 'enqueue failed after persisting job');
        const marked = await deps.store.updateStatus(job.id, 'failed', {
          lastError: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        res.status(503).json({
          error: 'queue_unavailable',
          message: 'job persisted but could not be queued; retry with the same idempotency_key',
          job: serializeJob(marked),
        });
        return;
      }
      res.status(201).json(serializeJob(job));
    })().catch(next);
  });

  router.get('/jobs/:id', (req, res, next) => {
    void (async () => {
      const job = await deps.store.findById(req.params.id ?? '');
      if (!job) {
        throw new NotFoundError('job');
      }
      res.status(200).json(serializeJob(job));
    })().catch(next);
  });

  router.get('/jobs', (req, res, next) => {
    void (async () => {
      const status = req.query.status;
      // FR9: dead-letter listing must work; other statuses are filterable too.
      const allowed = JOB_STATUSES.find((s) => s === status);
      if (status !== undefined && !allowed) {
        throw new ValidationError(
          `status: must be one of ${JOB_STATUSES.join(', ')}`,
        );
      }
      const jobs = await deps.store.listByStatus(allowed);
      res.status(200).json({ jobs: jobs.map(serializeJob) });
    })().catch(next);
  });

  /**
   * FR9 / TDR §7: manually re-queue a dead-lettered job. Resets attempts so
   * the job gets a fresh retry budget; guarded against non-DLQ jobs with 409.
   */
  router.post('/jobs/:id/retry', (req, res, next) => {
    void (async () => {
      const job = await deps.store.findById(req.params.id ?? '');
      if (!job) {
        throw new NotFoundError('job');
      }
      if (job.status !== 'dead_letter') {
        throw new ConflictError('not_in_dead_letter', `job is '${job.status}', not 'dead_letter'`);
      }
      const updated = await deps.store.updateStatus(job.id, 'queued', {
        attempts: 0,
        lastError: null,
      });
      await enqueueNotification(
        { queue: deps.queue, logger: deps.logger },
        {
          type: job.type,
          payload: job.payload,
          idempotency_key: job.idempotencyKey,
        },
      );
      deps.logger.info({ jobId: job.id }, 'dead-lettered job manually requeued');
      res.status(200).json(serializeJob(updated));
    })().catch(next);
  });

  return router;
}
