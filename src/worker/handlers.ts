import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import type { Logger } from 'pino';
import { InvalidJobError, jobEnvelopeSchema, type NotificationType } from '../jobs/schemas.js';

export type HandlerContext = {
  jobId: string;
  /** Surfaced so handlers can propagate it end-to-end (webhook receivers dedupe on it, TDR §8). */
  idempotencyKey: string;
  logger: Logger;
};

export type NotificationHandler = (payload: unknown, ctx: HandlerContext) => Promise<void>;

export type HandlerRegistry = Partial<Record<NotificationType, NotificationHandler>>;

/**
 * Wraps a handler error so BullMQ stops retrying. Poison messages must fail
 * fast and visibly — retrying a job that can never succeed just burns
 * worker capacity and log volume.
 */
function poison(reason: string): Error {
  return new UnrecoverableError(`unrecoverable job: ${reason}`);
}

export function buildProcessor(registry: HandlerRegistry, baseLogger: Logger): Processor {
  return async (job: Job) => {
    const envelope = jobEnvelopeSchema.safeParse(job.data);
    if (!envelope.success) {
      throw poison(`envelope failed validation (${envelope.error.issues.map((i) => i.path.join('.')).join(', ')})`);
    }
    const { type, payload } = envelope.data;
    const handler = registry[type];
    if (!handler) {
      throw poison(`no handler registered for type '${type}'`);
    }
    const logger = baseLogger.child({
      jobId: String(job.id),
      jobType: type,
      attempt: job.attemptsMade + 1,
      idempotencyKey: envelope.data.idempotencyKey,
    });
    logger.info('job processing started');
    try {
      await handler(payload, {
        jobId: String(job.id),
        idempotencyKey: envelope.data.idempotencyKey,
        logger,
      });
    } catch (err) {
      if (err instanceof InvalidJobError) {
        // The handler re-validated the payload and rejected it: permanent.
        throw poison(err.message);
      }
      logger.error({ err, attempt: job.attemptsMade + 1 }, 'job attempt failed');
      throw err;
    }
    logger.info({ attempt: job.attemptsMade + 1 }, 'job processing completed');
  };
}
