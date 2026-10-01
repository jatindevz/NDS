import { InvalidJobError } from '../jobs/schemas.js';
import { ProviderFailure } from './providers.js';

/**
 * Translates provider failures into the worker's error contract (TDR §8):
 *  - InvalidJobError            => permanent, poisoned on the first attempt
 *  - ProviderFailure('permanent') => permanent, likewise poisoned
 *  - anything else              => transient, BullMQ retries with backoff
 *
 * Keeping this in one place means every channel (email, webhook, future SMS)
 * shares identical poison semantics — a 400 from Resend and a 410 from a
 * webhook both stop retrying, a timeout from either keeps retrying.
 */
export async function runDelivery<T>(fn: () => Promise<T>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof InvalidJobError) {
      throw err;
    }
    if (err instanceof ProviderFailure) {
      if (err.kind === 'permanent') {
        throw new InvalidJobError(err.message);
      }
      throw err; // transient: propagate so BullMQ's retry machinery sees it
    }
    throw err;
  }
}
