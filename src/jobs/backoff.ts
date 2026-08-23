export type BackoffOptions = {
  baseMs: number;
  capMs: number;
  /** Injectable for determinism in tests; defaults to Math.random. */
  rng?: () => number;
};

/**
 * BullMQ v6 custom backoff strategy: `attemptsMade` is the 1-based number of
 * the *upcoming* attempt. Half-jitter ("delay/2 + random(delay/2)") keeps
 * ordering roughly intact while spreading retry storms across the window
 * instead of synchronizing every job onto the same millisecond.
 */
export function cappedExponentialBackoff(attemptsMade: number, opts: BackoffOptions): number {
  const { baseMs, capMs, rng = Math.random } = opts;
  const raw = baseMs * 2 ** Math.max(0, attemptsMade - 1);
  const capped = Math.min(raw, capMs);
  return Math.max(1, Math.floor(capped / 2 + capped / 2 * rng()));
}
