import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryStore } from '../cache.js';
import { GATE_CONSTANTS } from '../constants.js';
import type { PullMode, PullOutcome } from '../core.js';
import { GateEngine } from '../engine.js';
import type { PollResult } from '../reasons.js';

/**
 * The renewal pickup's concurrency (`docs/mcp-delegation-gate-contract.md` § 6a), which the shared
 * decision cases cannot express: they never let an event fall inside a pull's window.
 */

const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenWith = (exp: number, tag: string) =>
  `${b64({ alg: 'ES256', kid: 'k' })}.${b64({ sub: 'ph_dlg_00000000000000000000000000000001', exp, tag })}.sig`;

const inWindow = tokenWith(Math.floor(START / 1000) + 7 * 86_400, 'old');
const expired = tokenWith(Math.floor(START / 1000) - 600, 'old');
const renewed = tokenWith(Math.floor(START / 1000) + 300 * 86_400, 'new');

interface Harness {
  engine: GateEngine;
  pulls: PullMode[];
  release: (outcome: PullOutcome) => void;
}

function harness(token: string, pull?: () => Promise<PullOutcome>): Harness {
  const store = createMemoryStore();
  store.writeRecords(token, { gate: { verdict: { kind: 'valid' }, checked_at: START - 1_000 }, info: { unresolved_since: null } });
  const pulls: PullMode[] = [];
  let release: (outcome: PullOutcome) => void = () => undefined;
  const engine = new GateEngine({
    token,
    store,
    warn: () => undefined,
    poll: async (): Promise<PollResult> => ({ kind: 'valid' }),
    pull: (_token, _timeout, mode) => {
      pulls.push(mode);
      return pull ? pull() : new Promise<PullOutcome>((resolve) => (release = resolve));
    },
  });
  return { engine, pulls, release: (outcome) => release(outcome) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a renewal pull in flight', () => {
  it('is not shared by a status call: status answers while an AWAITED pull (past exp) is still pending', async () => {
    // Only an awaited renewal sits where status looks for an operation to share; a background one never does.
    const h = harness(expired);
    const call = h.engine.gate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pulls).toEqual(['renewal']);
    let answered = false;
    const status = h.engine.status().then((answer) => {
      answered = true;
      return answer;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    await status;
    expect(h.engine.activeToken()).toBe(expired);
    h.release({ kind: 'rejected', reason: 'same_token' });
    expect(await call).toMatchObject({ outcome: 'await_renewal', result: 'refuse', code: 'expired' });
    await h.engine.idle();
  });

  it('a pull that throws synchronously is unreachable too: the ordinary backoff, not the gap', async () => {
    const store = createMemoryStore();
    store.writeRecords(inWindow, { gate: { verdict: { kind: 'valid' }, checked_at: START - 1_000 }, info: { unresolved_since: null } });
    const engine = new GateEngine({
      token: inWindow,
      store,
      warn: () => undefined,
      poll: async (): Promise<PollResult> => ({ kind: 'valid' }),
      pull: () => {
        throw new Error('thrown before any promise exists');
      },
    });
    expect(await engine.gate()).toMatchObject({ outcome: 'serve', result: 'run' });
    await engine.idle();
    expect(engine.mem.renewal_next_at).toBe(START + GATE_CONSTANTS.backoff_cached_ms);
  });
});

describe('background renewal pull', () => {
  it('starts one pull, whatever arrives while it is in flight, and serves every call at once', async () => {
    const h = harness(inWindow);
    const first = await h.engine.gate();
    const second = await h.engine.gate();
    expect(first).toMatchObject({ outcome: 'serve', result: 'run' });
    expect(second).toMatchObject({ outcome: 'serve', result: 'run' });
    expect(h.pulls).toEqual(['renewal']);
    h.release({ kind: 'accepted', token: renewed });
    await h.engine.idle();
    expect(h.engine.activeToken()).toBe(renewed);
    expect(h.engine.mem.renewal_next_at).toBeNull();
  });

  it('a pull that throws never raises, and the next waits only the ordinary backoff (it reached nobody)', async () => {
    const h = harness(inWindow, () => Promise.reject(new Error('boom')));
    expect(await h.engine.gate()).toMatchObject({ outcome: 'serve', result: 'run' });
    await h.engine.idle();
    expect(h.engine.mem.renewal_next_at).toBe(START + GATE_CONSTANTS.backoff_cached_ms);
    expect(h.engine.activeToken()).toBe(inWindow);
    await h.engine.gate();
    expect(h.pulls).toEqual(['renewal']);
  });
});

describe('await_renewal (past exp)', () => {
  it('shares one pull between the calls that arrive while it is in flight', async () => {
    const h = harness(expired);
    const first = h.engine.gate();
    const second = h.engine.gate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pulls).toEqual(['renewal']);
    h.release({ kind: 'accepted', token: renewed });
    expect(await first).toMatchObject({ outcome: 'await_renewal', result: 'run' });
    expect(await second).toMatchObject({ outcome: 'await_renewal', result: 'run' });
    expect(h.engine.activeToken()).toBe(renewed);
  });

  it('a call past exp that joins a BACKGROUND pull refuses expired when that pull is rejected', async () => {
    const h = harness(inWindow);
    expect(await h.engine.gate()).toMatchObject({ outcome: 'serve', result: 'run' });
    vi.setSystemTime(START + 8 * 86_400_000);
    const late = h.engine.gate();
    h.release({ kind: 'rejected', reason: 'same_token' });
    expect(await late).toMatchObject({ outcome: 'await_renewal', result: 'refuse', code: 'expired' });
    expect(h.pulls).toEqual(['renewal']);
  });

  it('refuses expired when the pull is rejected, and makes no other inside the gap', async () => {
    const h = harness(expired, async () => ({ kind: 'rejected', reason: 'same_token' }));
    expect(await h.engine.gate()).toMatchObject({ outcome: 'await_renewal', result: 'refuse', code: 'expired' });
    expect(await h.engine.gate()).toMatchObject({ outcome: 'refuse(local_expired)', result: 'refuse', code: 'expired' });
    expect(h.pulls).toEqual(['renewal']);
  });
});
