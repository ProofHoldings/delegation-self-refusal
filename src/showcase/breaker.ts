/**
 * Hard timeout for a whole showcase call — not for each HTTP request inside it.
 *
 * Scope, stated because the name does not carry it: this bounds the two showcase tools that call
 * out on their OWN behalf (`proof_verify_delegation`, `proof_connect`).
 * `proof_check_this_server` is deliberately outside it — it reads the gate's shared verdict
 * (SC-3), so its network cost is `poll.ts`'s 10s budget, the same one every gated publisher tool
 * already pays, and wrapping it would fork the grace state machine `schedule.ts` owns.
 *
 * Deliberately BELOW both library defaults it sits in front of — `@proof-holdings/delegation-verifier`
 * defaults to 5000ms and `poll.ts` to 10000ms — and applied to the ENTIRE operation, because the
 * verifier's own budget is PER FETCH and one verification walks up to `SHOWCASE_MAX_LEGS` requests
 * sequentially. Giving both bounds the same number would permit a ~9s user-facing stall, which is
 * exactly the "our slowness is indistinguishable from the publisher's code" failure this constant
 * exists to prevent. Pinned by `breaker.test.ts`.
 */
export const SHOWCASE_TIMEOUT_MS = 4_500;

/**
 * How many sequential HTTP legs one verification can take: JWKS → status list → status endpoint.
 *
 * THREE, not two. `checkDelegationStatus` (packages/delegation-verifier/src/status.ts) falls
 * through to the status ENDPOINT whenever the status list cannot answer, so the third leg is
 * reachable on a live issuer. An earlier version of this file derived the per-request budget from
 * a two-leg walk while the comment above it said three — and at two legs the arithmetic was a
 * photo finish (2 × 1500 = 3000, exactly the whole-call bound), so any parse or verify time
 * between them pushed a healthy-but-slow issuer over the deadline and charged it as a failure.
 */
export const SHOWCASE_MAX_LEGS = 3;

/**
 * The budget handed to a LIBRARY that applies it per request, derived from the leg count PLUS ONE
 * so the whole-call bound is a real ceiling with headroom rather than a photo finish.
 *
 * Dividing by the leg count exactly (the first attempt at this fix) reproduced the very defect the
 * comment above rejects: `3 × 1000 = 3000` IS the whole-call bound, leaving zero milliseconds for
 * the work BETWEEN the legs — JWKS parsing, JWT signature verification, JSON decoding — all of
 * which sit inside the same deadline, because the timer starts before `fn` is invoked. The `+ 1`
 * is that work's share.
 *
 * It also matters which way the arithmetic errs. A per-fetch budget squeezed too tight aborts a leg
 * against a merely-average issuer, the verifier reports `jwks_unavailable`, `isIssuerUnreachable`
 * charges it to the breaker, and three of those deny verification of EVERY artifact for a cooldown
 * — a false `issuer_unreachable_cooldown` against a live service. So the total was raised (still
 * strictly below the verifier's 5000ms and `poll.ts`'s 10000ms, which SC-7 requires) rather than
 * the per-request budget being cut further.
 */
export const SHOWCASE_PER_REQUEST_TIMEOUT_MS = Math.floor(SHOWCASE_TIMEOUT_MS / (SHOWCASE_MAX_LEGS + 1));

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export type BreakerResult<T> =
  | { ok: true; value: T }
  | { ok: false; tripped: true }
  | { ok: false; tripped: false; error: unknown };

export interface RunOptions<T> {
  /**
   * Decides whether a RETURNED value counts as a failure.
   *
   * Required because "did it throw" is the wrong question for this package's own dependencies:
   * `@proof-holdings/delegation-verifier` reports an unreachable issuer by RETURNING
   * `{valid: false, outcome: 'unconfirmed'}` rather than throwing, so a throw-only breaker read a
   * dead issuer as a success, reset its counter on every call, and never opened — measured in code
   * review as 10 outbound attempts with 0 trips. Without this hook SC-7 is unmet for the very tool
   * that makes the most outbound calls.
   */
  isFailure?: (value: T) => boolean;
}

export interface Breaker {
  run<T>(fn: (signal: AbortSignal) => Promise<T>, options?: RunOptions<T>): Promise<BreakerResult<T>>;
}

export interface BreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  timeoutMs?: number;
  /** Injected clock. Tests advance it directly rather than reaching for fake global timers. */
  now?: () => number;
}

class ShowcaseTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`showcase call exceeded its ${timeoutMs}ms budget`);
    this.name = 'ShowcaseTimeoutError';
  }
}

/**
 * A per-installation circuit breaker for the showcase's outbound calls.
 *
 * State lives in this closure, NOT on disk: the cache directory belongs to the self-refusal grace
 * state machine, and writing showcase state into it would move `lastCheckedAtMs` outside the
 * jittered schedule `schedule.ts` exists to keep (the SEC-DLG-02 fix). The showcase therefore does
 * not inherit the grace window and needs its own failure accounting — which is exactly what SC-7
 * asks for.
 */
export function createBreaker(options: BreakerOptions = {}): Breaker {
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? SHOWCASE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let consecutiveFailures = 0;
  let openUntilMs = 0;

  function recordFailure(): void {
    consecutiveFailures++;
    if (consecutiveFailures >= failureThreshold) {
      openUntilMs = now() + cooldownMs;
    }
  }

  return {
    async run<T>(fn: (signal: AbortSignal) => Promise<T>, runOptions: RunOptions<T> = {}): Promise<BreakerResult<T>> {
      if (openUntilMs > now()) {
        return { ok: false, tripped: true };
      }

      // The window elapsed: forget the streak that opened it, so one more failure does not
      // instantly re-open on a stale count.
      if (openUntilMs !== 0) {
        openUntilMs = 0;
        consecutiveFailures = 0;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const deadline = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new ShowcaseTimeoutError(timeoutMs)),
          { once: true },
        );
      });

      try {
        // Bounds the WHOLE call, not each request inside it — a callee that ignores the signal
        // (the verifier applies its own per-fetch budget instead) is still cut off here.
        const value = await Promise.race([fn(controller.signal), deadline]);

        // A throwing `isFailure` is a bug in THIS package, so it is neither charged to the issuer
        // (which would open the breaker against a service that answered fine) nor allowed to CLEAR
        // the streak — a predicate that threw on exactly the dead-issuer shape would otherwise
        // erase real failures and hold the breaker closed forever, which is the original defect
        // wearing a new disguise. It is also logged: `verdict.ts` uses the same channel, and a
        // silent swallow here would hide the one condition that makes the breaker inert.
        let predicateThrew = false;
        let predicateSaysFailure = false;
        try {
          predicateSaysFailure = runOptions.isFailure?.(value) === true;
        } catch (error) {
          predicateThrew = true;
          console.error(
            `delegation-self-refusal: showcase isFailure predicate threw (failure count left ` +
              `untouched): ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (predicateSaysFailure) {
          recordFailure();
          return { ok: false, tripped: false, error: value };
        }

        if (!predicateThrew) {
          consecutiveFailures = 0;
        }
        return { ok: true, value };
      } catch (error) {
        recordFailure();
        return { ok: false, tripped: false, error };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
