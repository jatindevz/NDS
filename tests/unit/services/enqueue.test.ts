import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { enqueueNotification } from '../../../src/services/enqueue.js';
import { InvalidJobError } from '../../../src/jobs/schemas.js';

type AddCall = { name: string; data: unknown; opts: unknown };

function fakeQueue() {
  const calls: AddCall[] = [];
  return {
    calls,
    add: vi.fn(async (name: string, data: unknown, opts: unknown) => {
      calls.push({ name, data, opts });
      return { id: 'job-123' };
    }),
  };
}

const logger: Logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as unknown as Logger;

const validRequest = {
  type: 'email',
  payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
  idempotency_key: 'welcome-user-42',
};

describe('enqueueNotification', () => {
  it('adds a notification job with the validated envelope and returns the jobId', async () => {
    const queue = fakeQueue();
    const result = await enqueueNotification(
      { queue: queue as never, logger },
      validRequest,
    );
    expect(result).toEqual({ jobId: 'job-123' });
    expect(queue.add).toHaveBeenCalledOnce();
    const call = queue.calls[0];
    if (!call) throw new Error('no call recorded');
    expect(call.name).toBe('notification');
    expect(call.data).toEqual({
      type: 'email',
      payload: validRequest.payload,
      idempotencyKey: 'welcome-user-42',
    });
  });

  it('never touches the queue when the request is invalid', async () => {
    const queue = fakeQueue();
    await expect(
      enqueueNotification({ queue: queue as never, logger }, { ...validRequest, type: 'sms' }),
    ).rejects.toThrow(InvalidJobError);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('propagates queue failures to the caller (the API will map them to 503)', async () => {
    const queue = {
      add: vi.fn(async () => {
        throw new Error('redis connection lost');
      }),
    };
    await expect(
      enqueueNotification({ queue: queue as never, logger }, validRequest),
    ).rejects.toThrow('redis connection lost');
  });
});
