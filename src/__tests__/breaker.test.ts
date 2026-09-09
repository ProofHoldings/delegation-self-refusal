import { describe, expect, it } from 'vitest';

import {
  createBreaker,
  SHOWCASE_MAX_LEGS,
  SHOWCASE_PER_REQUEST_TIMEOUT_MS,
  SHOWCASE_TIMEOUT_MS,
} from '../showcase/breaker.js';
import { DEFAULT_TIMEOUT_MS as POLL_TIMEOUT_MS } from '../poll.js';

describe('showcase circuit breaker — SC-7', () => {
  it('stops calling out after the failure threshold and resumes after the cooldown', async () => {
    let clock = 1_000;
    let calls = 0;

    const breaker = createBreaker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      now: () => clock,
    });

    const failing = async () => {
      calls++;
      throw new Error('network down');
    };

    for (let i = 0; i < 3; i++) {
      const result = await breaker.run(failing);
      expect(result.ok).toBe(false);
    }
    expect(calls).toBe(3);

    // Fourth call inside the cooldown window: the breaker must answer without touching the network.
    const tripped = await breaker.run(failing);
    expect(tripped).toEqual({ ok: false, tripped: true });
    expect(calls).toBe(3);

    // Still inside the window one millisecond before it closes.
    clock += 59_999;
    await breaker.run(failing);
    expect(calls).toBe(3);

    // Window elapsed — outbound calls resume.
    clock += 2;
    const afterCooldown = await breaker.run(failing);
    expect(calls).toBe(4);
    expect(afterCooldown.ok).toBe(false);
  });

  it('a success resets the consecutive-failure count', async () => {
    let clock = 0;
    let calls = 0;
    const breaker = createBreaker({ failureThreshold: 3, cooldownMs: 60_000, now: () => clock });

    const failing = async () => {
      calls++;
      throw new Error('nope');
    };
    const succeeding = async () => {
      calls++;
      return 'fine';
    };

    await breaker.run(failing);
    await breaker.run(failing);
    const good = await breaker.run(succeeding);
    expect(good).toEqual({ ok: true, value: 'fine' });

    // Two more failures must NOT trip it — the counter restarted at the success.
    await breaker.run(failing);
    await breaker.run(failing);
    expect(calls).toBe(5);

    const stillOpen = await breaker.run(failing);
    expect(calls).toBe(6);
    expect(stillOpen.ok).toBe(false);
  });

  it('hands the wrapped call an AbortSignal that is not already aborted', async () => {
    const breaker = createBreaker();
    let received: AbortSignal | undefined;

    await breaker.run(async (signal) => {
      received = signal;
      return 'ok';
    });

    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });

  it('aborts that signal when the deadline fires, so the in-flight request is cancelled', async () => {
    // The case above cannot prove this and used to claim it: `instanceof AbortSignal` plus
    // `aborted === false` are true of ANY fresh controller, so swapping `controller.signal` for an
    // unrelated one left the suite green. The signal is not decoration — `connect.ts` hands it
    // straight to `fetch`, so if it never fires the deadline still returns the offline fallback
    // while the request keeps running and the socket stays open in the PUBLISHER's process.
    const breaker = createBreaker({ timeoutMs: 25 });
    let received: AbortSignal | undefined;

    const result = await breaker.run(
      (signal) =>
        new Promise<string>((resolve) => {
          received = signal;
          setTimeout(() => resolve('too late'), 2_000).unref?.();
        }),
    );

    expect(result.ok).toBe(false);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(true);
  });

  it('bounds the WHOLE call, not each request inside it', async () => {
    // The verifier applies its own budget PER FETCH and walks JWKS → status list → status
    // endpoint sequentially, so a per-request bound of 3s still permits a ~9s user-facing stall.
    // A callee that ignores the signal entirely must still be cut off.
    const breaker = createBreaker({ timeoutMs: 25 });

    const started = Date.now();
    const result = await breaker.run(
      () => new Promise((resolve) => setTimeout(() => resolve('too late'), 2_000)),
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  it('counts a timeout as a failure, so a persistently slow issuer opens the breaker', async () => {
    let calls = 0;
    const breaker = createBreaker({ timeoutMs: 10, failureThreshold: 2, cooldownMs: 60_000 });
    const slow = () =>
      new Promise((resolve) => {
        calls++;
        setTimeout(() => resolve('too late'), 2_000);
      });

    await breaker.run(slow);
    await breaker.run(slow);
    expect(calls).toBe(2);

    const tripped = await breaker.run(slow);
    expect(tripped).toEqual({ ok: false, tripped: true });
    expect(calls).toBe(2);
  });

  it('treats a RETURNED value as a failure when isFailure says so', async () => {
    let calls = 0;
    const breaker = createBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    const returnsFailure = async () => {
      calls++;
      return { valid: false, outcome: 'unconfirmed' };
    };
    const isFailure = (v: { valid: boolean; outcome: string }) => !v.valid && v.outcome === 'unconfirmed';

    await breaker.run(returnsFailure, { isFailure });
    await breaker.run(returnsFailure, { isFailure });
    expect(calls).toBe(2);

    // Nothing ever threw — a throw-only breaker would still be closed here.
    const tripped = await breaker.run(returnsFailure, { isFailure });
    expect(tripped).toEqual({ ok: false, tripped: true });
    expect(calls).toBe(2);
  });

  it("the showcase timeout is strictly below the libraries' own defaults", () => {
    // SC-7's actual requirement. The verifier's default is 5000ms (packages/delegation-verifier
    // src/verify.ts DEFAULT_TIMEOUT_MS); the self-refusal poll's is exported here. The showcase
    // runs INSIDE someone else's user-facing call, so it must give up first — otherwise our
    // slowness is indistinguishable from the publisher's own code.
    expect(SHOWCASE_TIMEOUT_MS).toBeLessThan(5_000);
    expect(SHOWCASE_TIMEOUT_MS).toBeLessThan(POLL_TIMEOUT_MS);
  });

  it('leaves room for EVERY sequential leg inside the whole-call bound', () => {
    // The operative relation, not a weaker one that cannot fail: a bare
    // `PER_REQUEST < TOTAL` is satisfied by any divisor >= 2, including a two-leg split that puts
    // a maximally-slow-but-ALIVE issuer exactly on the deadline and charges it as a failure.
    // STRICTLY less, not `<=`. Equality is the zero-headroom photo finish: every leg may use its
    // full budget and the work BETWEEN legs (JWKS parse, signature verify, JSON decode) then has
    // nothing left, so a healthy-but-slow issuer trips the deadline and is charged as unreachable.
    expect(SHOWCASE_MAX_LEGS * SHOWCASE_PER_REQUEST_TIMEOUT_MS).toBeLessThan(SHOWCASE_TIMEOUT_MS);
    // And the headroom must be a real share, not a rounding remainder.
    expect(SHOWCASE_TIMEOUT_MS - SHOWCASE_MAX_LEGS * SHOWCASE_PER_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      SHOWCASE_PER_REQUEST_TIMEOUT_MS,
    );
    expect(SHOWCASE_PER_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    // And the leg count must match what the verifier can actually walk: JWKS, status list, and the
    // status endpoint it falls through to when the list cannot answer.
    expect(SHOWCASE_MAX_LEGS).toBeGreaterThanOrEqual(3);
  });
});
