import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { InvalidJobError } from '../../../src/jobs/schemas.js';
import { buildProcessor, type NotificationHandler } from '../../../src/worker/handlers.js';

const logger: Logger = { child: () => logger, info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as unknown as Logger;

function fakeJob(data: unknown, attemptsMade = 0): Job {
  return { id: 'job-1', name: 'notification', attemptsMade, data } as unknown as Job;
}

const emailHandler: NotificationHandler = async (payload: unknown) => {
  const p = payload as { to?: string };
  if (!p.to) throw new InvalidJobError('payload missing "to"');
};

describe('buildProcessor', () => {
  it('dispatches to the handler registered for the job type', async () => {
    const email = vi.fn(async () => {});
    const processor = buildProcessor({ email }, logger);
    await processor(
      fakeJob({ type: 'email', payload: { to: 'a@b.co', subject: 's', body: 'b' }, idempotencyKey: 'k1' }),
      'token',
    );
    expect(email).toHaveBeenCalledOnce();
  });

  it('poisons unknown job types instead of retrying them', async () => {
    const processor = buildProcessor({ email: async () => {} }, logger);
    await expect(
      processor(fakeJob({ type: 'sms', payload: {}, idempotencyKey: 'k1' }), 'token'),
    ).rejects.toThrow(UnrecoverableError);
  });

  it('poisons a corrupted envelope (fails schema)', async () => {
    const processor = buildProcessor({ email: async () => {} }, logger);
    await expect(processor(fakeJob({ something: 'else' }), 'token')).rejects.toThrow(
      UnrecoverableError,
    );
  });

  it('poisons payloads the handler rejects as invalid (InvalidJobError)', async () => {
    const processor = buildProcessor({ email: emailHandler }, logger);
    await expect(
      processor(fakeJob({ type: 'email', payload: { subject: 's' }, idempotencyKey: 'k1' }), 'token'),
    ).rejects.toThrow(UnrecoverableError);
  });

  it('propagates transient handler errors so BullMQ retries them', async () => {
    const flaky = async (): Promise<void> => {
      throw new Error('ETIMEDOUT calling provider');
    };
    const processor = buildProcessor({ email: flaky }, logger);
    const rejection = processor(
      fakeJob({ type: 'email', payload: { to: 'a@b.co', subject: 's', body: 'b' }, idempotencyKey: 'k1' }),
      'token',
    );
    await expect(rejection).rejects.toThrow('ETIMEDOUT');
    await expect(rejection).rejects.not.toThrow(UnrecoverableError);
  });

  it('gives the handler a child logger bound to the jobId', async () => {
    const seen: Array<{ jobId?: string }> = [];
    const probe: NotificationHandler = async (_payload, ctx) => {
      seen.push({ jobId: ctx.jobId });
    };
    const processor = buildProcessor({ email: probe }, logger);
    await processor(
      fakeJob({ type: 'email', payload: { to: 'a@b.co', subject: 's', body: 'b' }, idempotencyKey: 'k1' }),
      'token',
    );
    expect(seen[0]?.jobId).toBe('job-1');
  });
});
