import type { Logger } from 'pino';
import { parseJobRequest } from '../jobs/schemas.js';

export type EnqueueableQueue = {
  add(name: string, data: unknown, opts?: unknown): Promise<{ id?: string | number | null }>;
};

/**
 * Validates the request *before* it enters the queue — invalid jobs must
 * be rejected at the door, not discovered by the worker five attempts later.
 */
export async function enqueueNotification(
  deps: { queue: EnqueueableQueue; logger: Logger },
  request: unknown,
): Promise<{ jobId: string }> {
  const parsed = parseJobRequest(request);
  const job = await deps.queue.add('notification', parsed, undefined);
  const jobId = String(job.id);
  deps.logger.info({ jobId, type: parsed.type, idempotencyKey: parsed.idempotencyKey }, 'job enqueued');
  return { jobId };
}
