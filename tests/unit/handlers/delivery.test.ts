import { describe, expect, it } from 'vitest';
import { InvalidJobError } from '../../../src/jobs/schemas.js';
import { ProviderFailure } from '../../../src/handlers/providers.js';
import { runDelivery } from '../../../src/handlers/delivery.js';

describe('runDelivery (provider error translation)', () => {
  it('lets success pass through untouched', async () => {
    let ran = false;
    await runDelivery(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('propagates InvalidJobError as-is (poison contract)', async () => {
    await expect(
      runDelivery(async () => {
        throw new InvalidJobError('bad payload');
      }),
    ).rejects.toThrow(InvalidJobError);
  });

  it('translates permanent ProviderFailure into InvalidJobError (poison, no retries burned)', async () => {
    await expect(
      runDelivery(async () => {
        throw new ProviderFailure('permanent', 'resend returned 400 invalid to address');
      }),
    ).rejects.toThrow(InvalidJobError);
  });

  it('propagates transient ProviderFailure so BullMQ retries', async () => {
    const err = new ProviderFailure('transient', 'resend returned 503');
    await expect(
      runDelivery(async () => {
        throw err;
      }),
    ).rejects.toThrow(ProviderFailure);
    await expect(
      runDelivery(async () => {
        throw err;
      }),
    ).rejects.not.toThrow(InvalidJobError);
  });

  it('propagates unknown errors untouched (treated as transient by the worker)', async () => {
    await expect(
      runDelivery(async () => {
        throw new Error('ETIMEDOUT');
      }),
    ).rejects.toThrow('ETIMEDOUT');
  });
});
