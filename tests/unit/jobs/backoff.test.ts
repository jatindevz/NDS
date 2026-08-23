import { describe, expect, it } from 'vitest';
import { cappedExponentialBackoff } from '../../../src/jobs/backoff.js';

const NO_JITTER = { rng: () => 1 };

describe('cappedExponentialBackoff', () => {
  it('doubles the delay after each failed attempt', () => {
    const delays = [1, 2, 3, 4, 5].map(
      (attempt) => cappedExponentialBackoff(attempt, { baseMs: 1000, capMs: 60_000, ...NO_JITTER }),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it('caps the delay at capMs', () => {
    const delays = [7, 8, 20].map(
      (attempt) => cappedExponentialBackoff(attempt, { baseMs: 1000, capMs: 60_000, ...NO_JITTER }),
    );
    expect(delays).toEqual([60_000, 60_000, 60_000]);
  });

  it('applies half-jitter: delay lands in [0.5*d, d]', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const raw = cappedExponentialBackoff(attempt, { baseMs: 1000, capMs: 60_000, rng: () => 1 });
      const half = cappedExponentialBackoff(attempt, { baseMs: 1000, capMs: 60_000, rng: () => 0 });
      // rng=1 -> full delay, rng=0 -> half delay (still capped)
      expect(raw).toBe(Math.min(2 ** (attempt - 1) * 1000, 60_000));
      expect(half).toBeGreaterThanOrEqual(Math.floor((raw * 0.5)));
    }
  });

  it('never returns a non-positive or non-finite delay', () => {
    const attempts = [1, 5, 10, 100];
    for (const attempt of attempts) {
      const delay = cappedExponentialBackoff(attempt, { baseMs: 1000, capMs: 60_000 });
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('respects a non-default base delay', () => {
    expect(cappedExponentialBackoff(3, { baseMs: 250, capMs: 60_000, ...NO_JITTER })).toBe(1000);
  });
});
