import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryStore, type RecordStore } from '../cache.js';
import { GATE_CONSTANTS, SURFACE_HEADER, SURFACE_VALUE, TRIGGER_HEADER } from '../constants.js';
import type { TokenRecords } from '../core.js';
import { GateEngine } from '../engine.js';
import { pollValidate, type FetchLike } from '../poll.js';

const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const BASE_URL = 'https://issuer.test';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const TOKEN = `${b64({ alg: 'ES256', kid: 'k1' })}.${b64({
  sub: 'ph_dlg_00000000000000000000000000000001',
  principal: 'example.com',
  delegate: 'pkg:npm/example-mcp',
  iat: Math.floor(START / 1000) - 60,
  exp: Math.floor(START / 1000) + 86_400,
})}.sig`;

interface Call {
  at: number;
  surface: string | null;
  trigger: string | null;
  body: unknown;
}

/** A fetch whose every answer is scripted; an answer of `'hang'` never settles until aborted. */
function scriptedFetch(answers: Array<'hang' | 'throw' | { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (_input, init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      at: Date.now(),
      surface: headers.get(SURFACE_HEADER),
      trigger: headers.get(TRIGGER_HEADER),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answer = answers.shift() ?? 'hang';
    if (answer === 'throw') return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  };
  return { calls, fetchImpl };
}

function engineWith(fetchImpl: FetchLike, store: RecordStore = createMemoryStore(), token = TOKEN) {
  return new GateEngine({
    token,
    store,
    warn: () => undefined,
    poll: (pollToken, trigger, timeoutMs) => pollValidate(pollToken, { baseUrl: BASE_URL, timeoutMs, trigger, fetch: fetchImpl }),
    pull: async () => ({ kind: 'rejected', reason: 'pull_unavailable' }),
  });
}

const valid = { status: 200, body: { valid: true } };

function cached(checkedAt: number): TokenRecords {
  return { gate: { verdict: { kind: 'valid' }, checked_at: checkedAt }, info: { unresolved_since: null } };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pollValidate', () => {
  it('posts the token to the validate route with the surface header and no trigger', async () => {
    const net = scriptedFetch([valid]);
    expect(await pollValidate(TOKEN, { baseUrl: `${BASE_URL}/`, timeoutMs: 4_000, trigger: 'gate', fetch: net.fetchImpl })).toEqual({
      kind: 'valid',
    });
    expect(net.calls).toEqual([{ at: START, surface: SURFACE_VALUE, trigger: null, body: { proof_token: TOKEN } }]);
    expect(SURFACE_VALUE).toMatch(/^gate\/ts\/\d+\.\d+\.\d+$/);
  });

  it('adds X-Proof-Trigger: status to a status poll', async () => {
    const net = scriptedFetch([valid]);
    await pollValidate(TOKEN, { baseUrl: BASE_URL, timeoutMs: 4_000, trigger: 'status', fetch: net.fetchImpl });
    expect(net.calls[0]).toMatchObject({ surface: SURFACE_VALUE, trigger: 'status' });
  });

  it('times out at the attempt budget', async () => {
    const net = scriptedFetch(['hang']);
    const result = pollValidate(TOKEN, { baseUrl: BASE_URL, timeoutMs: 4_000, trigger: 'gate', fetch: net.fetchImpl });
    await vi.advanceTimersByTimeAsync(3_999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ kind: 'unresolved', reason: 'timeout' });
  });

  it('classifies a refused connection as network_error and a certificate failure as tls_error', async () => {
    const network = scriptedFetch(['throw']);
    expect(await pollValidate(TOKEN, { baseUrl: BASE_URL, timeoutMs: 4_000, trigger: 'gate', fetch: network.fetchImpl })).toEqual({
      kind: 'unresolved',
      reason: 'network_error',
    });
    const tls: FetchLike = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }));
    expect(await pollValidate(TOKEN, { baseUrl: BASE_URL, timeoutMs: 4_000, trigger: 'gate', fetch: tls })).toEqual({
      kind: 'unresolved',
      reason: 'tls_error',
    });
  });

  it('reads a non-JSON 2xx body as http_error', async () => {
    const html: FetchLike = async () => new Response('<html>', { status: 200 });
    expect(await pollValidate(TOKEN, { baseUrl: BASE_URL, timeoutMs: 4_000, trigger: 'gate', fetch: html })).toEqual({
      kind: 'unresolved',
      reason: 'http_error',
    });
  });
});

describe('the engine over a real poll', () => {
  it('a blocking await gives up at 4 000 ms and serves the cached verdict', async () => {
    const store = createMemoryStore();
    store.writeRecords(TOKEN, cached(START - 4 * GATE_CONSTANTS.poll_interval_default_ms));
    const net = scriptedFetch(['hang']);
    const engine = engineWith(net.fetchImpl, store);
    const decision = engine.gate();
    await vi.advanceTimersByTimeAsync(GATE_CONSTANTS.blocking_attempt_timeout_ms);
    expect(await decision).toMatchObject({ outcome: 'await', result: 'run' });
    expect(engine.mem.backoff_until).toBe(START + GATE_CONSTANTS.blocking_attempt_timeout_ms + GATE_CONSTANTS.backoff_cached_ms);
  });

  it('a background refresh gives up at 10 000 ms, not 4 000', async () => {
    const store = createMemoryStore();
    store.writeRecords(TOKEN, cached(START - GATE_CONSTANTS.poll_interval_default_ms));
    const net = scriptedFetch(['hang']);
    const engine = engineWith(net.fetchImpl, store);
    expect(await engine.gate()).toMatchObject({ outcome: 'serve+refresh', result: 'run' });
    await vi.advanceTimersByTimeAsync(GATE_CONSTANTS.blocking_attempt_timeout_ms);
    expect(store.readRecords(TOKEN).info.unresolved_since).toBeNull();
    await vi.advanceTimersByTimeAsync(GATE_CONSTANTS.background_refresh_timeout_ms - GATE_CONSTANTS.blocking_attempt_timeout_ms);
    expect(store.readRecords(TOKEN).info.unresolved_since).toBe(START + GATE_CONSTANTS.background_refresh_timeout_ms);
    expect(engine.mem.backoff_until).toBeNull();
  });

  it('runs the cold cycle as an attempt plus one retry 1 000 ms later, shared by concurrent calls', async () => {
    const net = scriptedFetch(['hang', 'hang']);
    const engine = engineWith(net.fetchImpl);
    const first = engine.gate();
    await vi.advanceTimersByTimeAsync(2_000);
    const second = engine.gate();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toMatchObject({ outcome: 'await_cold', result: 'run', neverValidated: true });
    expect(await second).toMatchObject({ outcome: 'await_cold', result: 'run', neverValidated: true });
    expect(net.calls.map((call) => call.at - START)).toEqual([0, GATE_CONSTANTS.blocking_attempt_timeout_ms + GATE_CONSTANTS.cold_retry_delay_ms]);
  });

  it('keeps the backoff in memory only: a new process over the same records waits again', async () => {
    const store = createMemoryStore();
    const first = engineWith(scriptedFetch(['hang', 'hang']).fetchImpl, store);
    const exhausted = first.gate();
    await vi.advanceTimersByTimeAsync(20_000);
    await exhausted;
    expect(first.mem.backoff_until).not.toBeNull();
    expect(await first.gate()).toMatchObject({ outcome: 'run_unvalidated' });

    const net = scriptedFetch([valid]);
    const restarted = engineWith(net.fetchImpl, store);
    expect(restarted.mem.backoff_until).toBeNull();
    expect(await restarted.gate()).toMatchObject({ outcome: 'await_cold', result: 'run' });
    expect(net.calls).toHaveLength(1);
  });

  it('a background refresh never produces an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const failingWrites: RecordStore = {
        ...createMemoryStore(),
        readRecords: () => cached(START - GATE_CONSTANTS.poll_interval_default_ms),
        writeRecords: () => {
          throw new Error('disk gone');
        },
      };
      const throwingFetch: FetchLike = () => {
        throw new Error('synchronous fetch failure');
      };
      const stale = createMemoryStore();
      stale.writeRecords(TOKEN, cached(START - GATE_CONSTANTS.poll_interval_default_ms));
      const engines = [engineWith(throwingFetch, stale), engineWith(scriptedFetch([valid]).fetchImpl, failingWrites)];
      const pollThrows = new GateEngine({
        token: TOKEN,
        store: failingWrites,
        warn: () => undefined,
        poll: () => Promise.reject(new Error('poll rejected')),
        pull: async () => ({ kind: 'rejected', reason: 'pull_unavailable' }),
      });
      for (const engine of [...engines, pollThrows]) {
        expect(await engine.gate()).toMatchObject({ outcome: 'serve+refresh', result: 'run' });
        await vi.advanceTimersByTimeAsync(GATE_CONSTANTS.background_refresh_timeout_ms);
        await engine.idle();
      }
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('marks gate polls without a trigger and status polls with X-Proof-Trigger: status', async () => {
    const net = scriptedFetch([valid, valid]);
    const engine = engineWith(net.fetchImpl);
    await engine.gate();
    await engine.status();
    expect(net.calls.map((call) => [call.surface, call.trigger])).toEqual([
      [SURFACE_VALUE, null],
      [SURFACE_VALUE, 'status'],
    ]);
  });

  it('a status poll in the throttle window answers from the records without a request', async () => {
    const net = scriptedFetch([valid]);
    const engine = engineWith(net.fetchImpl);
    expect((await engine.status()).output.delegation).toMatchObject({ status: 'valid', source: 'live' });
    await vi.advanceTimersByTimeAsync(GATE_CONSTANTS.status_poll_throttle_ms - 1);
    expect((await engine.status()).output.delegation).toMatchObject({ status: 'valid', source: 'cache' });
    expect(net.calls).toHaveLength(1);
  });

  it("a status poll's unresolved answer leaves the gate verdict alone and sets no backoff", async () => {
    const store = createMemoryStore();
    store.writeRecords(TOKEN, cached(START - 1_000));
    const engine = engineWith(scriptedFetch([{ status: 429, body: {} }]).fetchImpl, store);
    expect((await engine.status()).output.delegation).toMatchObject({ status: 'unresolved', source: 'cache' });
    expect(store.readRecords(TOKEN).gate).toEqual(cached(START - 1_000).gate);
    expect(engine.mem.backoff_until).toBeNull();
    expect(await engine.gate()).toMatchObject({ outcome: 'serve', result: 'run' });
  });
});

describe('a status call during a pull (contract § 10: it shares a poll, not a pull)', () => {
  it('polls the token itself instead of waiting on the pull', async () => {
    const store = createMemoryStore();
    store.writeRecords(TOKEN, {
      gate: { verdict: { kind: 'refused', code: 'key_revoked' }, checked_at: START - 1_000, key_rotation: { pulls: 0, next_pull_at: START } },
      info: { unresolved_since: null },
    });
    const net = scriptedFetch([{ status: 429, body: {} }]);
    let releasePull: () => void = () => undefined;
    const engine = new GateEngine({
      token: TOKEN,
      store,
      warn: () => undefined,
      poll: (pollToken, trigger, timeoutMs) => pollValidate(pollToken, { baseUrl: BASE_URL, timeoutMs, trigger, fetch: net.fetchImpl }),
      pull: () =>
        new Promise((resolve) => {
          releasePull = () => resolve({ kind: 'rejected', reason: 'pull_unavailable' });
        }),
    });
    const gate = engine.gate();
    let answered = false;
    const status = engine.status().then((answer) => {
      answered = true;
      return answer;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    expect(net.calls.map((call) => call.trigger)).toEqual(['status']);
    expect((await status).output.delegation).toMatchObject({ source: 'cache' });
    releasePull();
    expect(await gate).toMatchObject({ outcome: 'await_pull', result: 'refuse', code: 'key_revoked' });
  });
});

describe('restart: the persisted replacement record (contract § 6 Restart)', () => {
  const lineage = (overrides: Record<string, unknown>, kid: string) =>
    `${b64({ alg: 'ES256', kid })}.${b64({
      iss: 'proof.holdings',
      sub: 'ph_dlg_00000000000000000000000000000001',
      jti: 'ph_jti_1',
      principal: 'example.com',
      delegate: 'pkg:npm/example-mcp',
      iat: Math.floor(START / 1000) - 3_600,
      exp: Math.floor(START / 1000) + 86_400,
      ...overrides,
    })}.sig`;
  const configured = lineage({}, 'k-old');

  function restarted(replacement: string): GateEngine {
    const store = createMemoryStore();
    store.writeReplacement(configured, replacement);
    return engineWith(scriptedFetch([valid]).fetchImpl, store, configured);
  }

  it('uses a replacement that passes the acceptance checks against the configured token', () => {
    const replacement = lineage({ iat: Math.floor(START / 1000) - 60 }, 'k-new');
    expect(restarted(replacement).activeToken()).toBe(replacement);
  });

  it.each([
    ['another handle', { sub: 'ph_dlg_00000000000000000000000000000009', iat: Math.floor(START / 1000) - 60 }, 'k-new'],
    ['a widened exp', { exp: Math.floor(START / 1000) + 90_000, iat: Math.floor(START / 1000) - 60 }, 'k-new'],
    ['an iat before the configured one', { iat: Math.floor(START / 1000) - 7_200 }, 'k-new'],
    ['the configured kid', { iat: Math.floor(START / 1000) - 60 }, 'k-old'],
    ['another principal', { principal: 'evil.example', iat: Math.floor(START / 1000) - 60 }, 'k-new'],
    ['another issuer', { iss: 'evil.issuer', iat: Math.floor(START / 1000) - 60 }, 'k-new'],
  ])('does not use a replacement with %s', (_label, overrides, kid) => {
    expect(restarted(lineage(overrides, kid)).activeToken()).toBe(configured);
  });
});
