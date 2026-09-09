/**
 * Hard ceiling on how many consecutive unresolved polls may be bridged by serving the last good
 * verdict before the gate refuses outright. This is a library constant, not a GuardOptions field
 * — SEC-DLG-02 (b-brainstorm-delegation-revocation) found an unbounded grace window CRITICAL, and
 * the recorded fix was a bound the caller cannot raise, not a documented recommendation.
 */
export const MAX_GRACE_FAILURES = 3;

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const JITTER_FRACTION = 0.2;

/**
 * Returns baseMs plus a jitter in [1, baseMs * JITTER_FRACTION), guaranteeing the result is never
 * an exact multiple of 60_000 when baseMs is (the default case) — a fleet of installs polling on
 * the wall-clock minute is a self-inflicted thundering herd against /proofs/validate.
 */
export function nextIntervalMs(baseMs: number = DEFAULT_POLL_INTERVAL_MS): number {
  const jitterCeiling = Math.max(1, Math.floor(baseMs * JITTER_FRACTION));
  const jitter = 1 + Math.floor(Math.random() * jitterCeiling);
  return baseMs + jitter;
}
