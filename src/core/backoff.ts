export type BackoffOptions = {
  initialMs: number;
  maxMs: number;
  factor?: number; // growth per attempt, default 2
  jitter?: number; // +/- fraction of randomness, default 0.2 (so retries don't line up)
  random?: () => number; // injectable for tests
};

// Delay before retry number `attempt` (0 = first retry): initialMs * factor^attempt, capped
// at maxMs, then spread by +/- jitter. Never more than maxMs.
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const { initialMs, maxMs, factor = 2, jitter = 0.2, random = Math.random } = options;
  const base = Math.min(maxMs, initialMs * factor ** Math.max(0, attempt));
  const spread = base * jitter * (2 * random() - 1);
  return Math.round(Math.min(maxMs, Math.max(0, base + spread)));
}
