import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jwksUriFor } from '../keyset-store.js';
import { GATE_CONSTANTS, SURFACE_HEADER, SURFACE_VALUE } from '../constants.js';
import { pullReissuedDelegation, rejectionForVerification, replacementAcceptable } from '../pickup.js';
import { refreshJwks, resetJwksCache, setJwksClockForTests } from '../../../delegation-verifier/src/jwks.js';
import {
  delegationClaims,
  generateKey,
  mockFetch,
  signJwt,
  type TestKey,
} from '../../../delegation-verifier/src/__tests__/helpers.js';

const DAY = 86_400;
const BASE_URL = 'https://issuer.test';
const JWKS_URI = jwksUriFor(BASE_URL);
const HANDLE = 'ph_dlg_00000000000000000000000000000001';
const PULL_URL = `${BASE_URL}/api/v1/proofs/delegation-token/${HANDLE}`;
const CLOCK_TOLERANCE_SECONDS = GATE_CONSTANTS.lineage_clock_tolerance_ms / 1000;

let dir: string;
let nowSeconds: number;
let oldKey: TestKey;
let newKey: TestKey;
let oldToken: string;

function registryJwk(key: TestKey): Record<string, unknown> {
  return {
    ...key.publicJwk,
    proof_purpose: 'delegation',
    not_before: nowSeconds - 30 * DAY,
    not_after: nowSeconds + 30 * DAY,
    max_token_lifetime: 365 * DAY,
  };
}

function rotatedJwks(...live: TestKey[]): { json: unknown } {
  return {
    json: { keys: live.map(registryJwk), proof_tombstones: [{ kid: oldKey.kid, revoked_at: nowSeconds - 60 }] },
  };
}

/** The issuer's re-sign: every claim kept except `iat`, now under the new key. */
async function resign(overrides: Record<string, unknown> = {}, key: TestKey = newKey): Promise<string> {
  return signJwt(delegationClaims({ iat: nowSeconds - 10, exp: nowSeconds + 3600, ...overrides }), key);
}

function routes(pulled: unknown, jwks: { json: unknown } = rotatedJwks(newKey)) {
  const table: Record<string, { json?: unknown; status?: number; body?: string }> = {
    [JWKS_URI]: jwks,
    [PULL_URL]: typeof pulled === 'string' ? { json: { token: pulled } } : (pulled as { status: number }),
  };
  return mockFetch(table);
}

async function pull(net: ReturnType<typeof mockFetch>, previousToken = oldToken) {
  return pullReissuedDelegation({
    previousToken,
    baseUrl: BASE_URL,
    cacheDir: dir,
    timeoutMs: GATE_CONSTANTS.blocking_attempt_timeout_ms,
    mode: 'rotation',
    fetch: net.fetch as unknown as typeof fetch,
    nowMs: () => nowSeconds * 1000,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'self-refusal-pickup-'));
  resetJwksCache();
  nowSeconds = Math.floor(Date.now() / 1000);
  setJwksClockForTests({ monotonicMs: () => nowSeconds * 1000, wallMs: () => nowSeconds * 1000 });
  oldKey = await generateKey('dlg-old');
  newKey = await generateKey('dlg-new');
  oldToken = await signJwt(delegationClaims({ iat: nowSeconds - 3600, exp: nowSeconds + 3600 }), oldKey);
});

afterEach(() => {
  setJwksClockForTests(null);
  resetJwksCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('pullReissuedDelegation — the positive swap', () => {
  it('accepts the re-signed token and refetches the JWKS before the pull', async () => {
    const fresh = await resign();
    const net = routes(fresh);

    expect(await pull(net)).toEqual({ kind: 'accepted', token: fresh });
    expect(net.calls[0]).toBe(JWKS_URI);
    expect(net.calls).toContain(PULL_URL);
    expect(net.calls.indexOf(JWKS_URI)).toBeLessThan(net.calls.indexOf(PULL_URL));
  });

  it('forces the refetch even when a fresh key set is already cached', async () => {
    const fresh = await resign();
    const net = routes(fresh);
    await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch });
    const before = net.calls.filter((url) => url === JWKS_URI).length;

    await pull(net);
    expect(net.calls.filter((url) => url === JWKS_URI).length).toBeGreaterThan(before);
  });
});

describe('pullReissuedDelegation — one rejection per acceptance condition (SC-2)', () => {
  it('rejects when the forced JWKS refetch fails, without pulling', async () => {
    const net = mockFetch({ [JWKS_URI]: { status: 503 } });
    expect(await pull(net)).toEqual({ kind: 'rejected', reason: 'jwks_refetch_failed' });
    expect(net.calls).not.toContain(PULL_URL);
  });

  it('rejects a token signed under a tombstoned kid', async () => {
    // A third key the verifier first saw live, then saw tombstoned twice five minutes apart — the
    // confirmation rule — so its tombstone is APPLIED, not merely pending, when the pull lands.
    const third = await generateKey('dlg-third');
    const table: Record<string, { json: unknown }> = {
      [JWKS_URI]: rotatedJwks(newKey, third),
      [PULL_URL]: { json: { token: await resign({}, third) } },
    };
    const net = mockFetch(table);
    await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch });
    table[JWKS_URI] = {
      json: {
        keys: [registryJwk(newKey)],
        proof_tombstones: [
          { kid: oldKey.kid, revoked_at: nowSeconds - 60 },
          { kid: third.kid, revoked_at: nowSeconds },
        ],
      },
    };
    await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch });
    nowSeconds += 300;

    expect(await pull(net)).toEqual({ kind: 'rejected', reason: 'verification_failed', detail: 'key_revoked' });
  });

  it('rejects a token whose signature does not verify', async () => {
    const stranger = await generateKey('dlg-new');
    expect(await pull(routes(await resign({}, stranger)))).toEqual({
      kind: 'rejected',
      reason: 'verification_failed',
      detail: 'bad_signature',
    });
  });

  it('rejects the old token served back (the re-sign has not reached it)', async () => {
    expect(await pull(routes(oldToken))).toEqual({ kind: 'rejected', reason: 'same_token' });
  });

  it('rejects a different token under the revoked kid', async () => {
    const sameKid = await resign({}, oldKey);
    expect(await pull(routes(sameKid))).toEqual({ kind: 'rejected', reason: 'same_kid' });
  });

  it('rejects another handle', async () => {
    const other = await resign({ sub: 'ph_dlg_00000000000000000000000000000009' });
    expect(await pull(routes(other))).toEqual({ kind: 'rejected', reason: 'lineage_sub' });
  });

  it('rejects another jti', async () => {
    const other = await resign({ jti: 'ph_jti_00000000000000000000000000000009' });
    expect(await pull(routes(other))).toEqual({ kind: 'rejected', reason: 'lineage_jti' });
  });

  it('rejects another delegate', async () => {
    const other = await resign({ delegate: 'pkg:npm/other-mcp' });
    expect(await pull(routes(other))).toEqual({ kind: 'rejected', reason: 'lineage_delegate' });
  });

  it('rejects another principal', async () => {
    const other = await resign({ principal: 'attacker.example' });
    expect(await pull(routes(other))).toEqual({
      kind: 'rejected',
      reason: 'verification_failed',
      detail: 'principal_mismatch',
    });
  });

  it('rejects an iat earlier than the old token', async () => {
    const other = await resign({ iat: nowSeconds - 7200 });
    expect(await pull(routes(other))).toEqual({ kind: 'rejected', reason: 'iat_before_old' });
  });

  it('rejects an iat in the future', async () => {
    const other = await resign({ iat: nowSeconds + 120 });
    expect(await pull(routes(other))).toEqual({ kind: 'rejected', reason: 'iat_in_future' });
  });

  it("allows the verifier's clock tolerance on iat, and not a second more", async () => {
    const withinTolerance = await resign({ iat: nowSeconds + CLOCK_TOLERANCE_SECONDS });
    expect((await pull(routes(withinTolerance))).kind).toBe('accepted');
    resetJwksCache();
    const pastTolerance = await resign({ iat: nowSeconds + CLOCK_TOLERANCE_SECONDS + 1 });
    expect(await pull(routes(pastTolerance))).toEqual({ kind: 'rejected', reason: 'iat_in_future' });
  });

  it('rejects a widened exp', async () => {
    const other = await resign({ exp: nowSeconds + 3601 });
    expect(await pull(routes(other))).toEqual({ kind: 'rejected', reason: 'exp_widened' });
  });

  it('accepts the boundaries: iat equal to the old one, iat equal to now, exp unchanged', async () => {
    const atOld = await resign({ iat: nowSeconds - 3600 });
    expect((await pull(routes(atOld))).kind).toBe('accepted');
    resetJwksCache();
    const atNow = await resign({ iat: nowSeconds });
    expect((await pull(routes(atNow))).kind).toBe('accepted');
  });
});

describe('pullReissuedDelegation — renewal mode (contract § 6a)', () => {
  // A renewal is signed under the family's CURRENT key, usually the one that signed the old token:
  // no tombstone, and the same kid is allowed.
  const liveJwks = (...live: TestKey[]) => ({ json: { keys: live.map(registryJwk), proof_tombstones: [] } });
  const renew = (net: ReturnType<typeof mockFetch>) =>
    pullReissuedDelegation({
      previousToken: oldToken,
      baseUrl: BASE_URL,
      cacheDir: dir,
      timeoutMs: GATE_CONSTANTS.blocking_attempt_timeout_ms,
      mode: 'renewal',
      fetch: net.fetch as unknown as typeof fetch,
      nowMs: () => nowSeconds * 1000,
    });

  it('accepts a renewed token under the same kid with a later exp', async () => {
    const renewed = await resign({ exp: nowSeconds + 300 * DAY }, oldKey);
    expect(await renew(routes(renewed, liveJwks(oldKey)))).toEqual({ kind: 'accepted', token: renewed });
  });

  it('accepts a renewed token under a new kid', async () => {
    const renewed = await resign({ exp: nowSeconds + 300 * DAY });
    expect(await renew(routes(renewed, liveJwks(oldKey, newKey)))).toEqual({ kind: 'accepted', token: renewed });
  });

  it('answers same_token until the owner renews', async () => {
    expect(await renew(routes(oldToken, liveJwks(oldKey)))).toEqual({ kind: 'rejected', reason: 'same_token' });
  });

  it('rejects an exp that is not later than the old one', async () => {
    const same = await resign({ exp: nowSeconds + 3600 }, oldKey);
    expect(await renew(routes(same, liveJwks(oldKey)))).toEqual({ kind: 'rejected', reason: 'exp_not_widened' });
  });

  it('still verifies the signature', async () => {
    const stranger = await generateKey('dlg-stranger');
    const forged = await resign({ exp: nowSeconds + 300 * DAY }, stranger);
    expect(await renew(routes(forged, liveJwks(oldKey)))).toMatchObject({ kind: 'rejected', reason: 'verification_failed' });
  });
});

describe('pullReissuedDelegation — what the pull itself can answer', () => {
  it('maps the uniform 404 to pull_not_found', async () => {
    expect(await pull(routes({ status: 404 }))).toEqual({ kind: 'rejected', reason: 'pull_not_found' });
  });

  it.each([429, 503])('maps %s to pull_unavailable', async (status) => {
    expect(await pull(routes({ status }))).toEqual({ kind: 'rejected', reason: 'pull_unavailable' });
  });

  it('maps a network error to pull_unavailable', async () => {
    const net = mockFetch({
      [JWKS_URI]: rotatedJwks(newKey),
      [PULL_URL]: () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(await pull(net)).toEqual({ kind: 'rejected', reason: 'pull_unavailable' });
  });

  it.each([
    ['not JSON', { status: 200, body: 'nope' }],
    ['no token field', { status: 200, json: { ok: true } }],
    ['an empty token', { status: 200, json: { token: '' } }],
  ])('rejects a body with %s', async (_label, handler) => {
    expect(await pull(routes(handler))).toEqual({ kind: 'rejected', reason: 'malformed_response' });
  });

  it('rejects an oversized body even when it carries a valid re-signed token', async () => {
    const fresh = await resign();
    const padded = `{"token":"${fresh}"${' '.repeat(64 * 1024)}}`;
    expect(await pull(routes({ status: 200, body: padded }))).toEqual({ kind: 'rejected', reason: 'malformed_response' });
  });

  it('never pulls for a token it cannot name a handle for', async () => {
    const net = routes(await resign());
    expect(await pull(net, 'tok')).toEqual({ kind: 'rejected', reason: 'old_token_unreadable' });
    const notAHandle = await signJwt(delegationClaims({ sub: '../../admin' }), oldKey);
    expect(await pull(net, notAHandle)).toEqual({ kind: 'rejected', reason: 'old_token_unreadable' });
    expect(net.calls).toEqual([]);
  });
});

describe('replacementAcceptable — the restart re-check (contract § 6 Restart)', () => {
  it('accepts a persisted replacement that passes every claim check against the configured token', async () => {
    expect(replacementAcceptable(oldToken, await resign(), nowSeconds * 1000)).toBe(true);
  });

  it.each([
    ['garbage', async () => 'garbage'],
    ['the configured token itself', async () => oldToken],
    ['another handle', async () => resign({ sub: 'ph_dlg_00000000000000000000000000000009' })],
    ['a token under the configured kid', async () => resign({}, oldKey)],
  ])('refuses %s', async (_label, make) => {
    expect(replacementAcceptable(oldToken, await make(), nowSeconds * 1000)).toBe(false);
  });

  it.each([
    ['under the configured kid', () => oldKey],
    ['under a new kid', () => newKey],
  ])('uses a renewed replacement (§ 6a, a later exp) %s', async (_label, key) => {
    expect(replacementAcceptable(oldToken, await resign({ exp: nowSeconds + 3601 }, key()), nowSeconds * 1000)).toBe(true);
  });
});

describe('pullReissuedDelegation — headers', () => {
  it('marks the key-set refetch and the pull with the surface header', async () => {
    const fresh = await resign();
    const seen: Array<{ url: string; surface: string | null }> = [];
    const net = routes(fresh);
    const recording = (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), surface: new Headers(init?.headers).get(SURFACE_HEADER) });
      return (net.fetch as unknown as typeof fetch)(input, init);
    }) as typeof fetch;
    const result = await pullReissuedDelegation({
      previousToken: oldToken,
      baseUrl: BASE_URL,
      cacheDir: dir,
      timeoutMs: GATE_CONSTANTS.blocking_attempt_timeout_ms,
      mode: 'rotation',
      fetch: recording,
      nowMs: () => nowSeconds * 1000,
    });
    expect(result.kind).toBe('accepted');
    expect(seen.map((call) => call.url)).toEqual(expect.arrayContaining([JWKS_URI, PULL_URL]));
    for (const call of seen) expect(call.surface).toBe(SURFACE_VALUE);
  });
});

describe('rejectionForVerification — a key set the signature step could not read is not an answer (§ 6a)', () => {
  it.each(['jwks_unavailable', 'jwks_stale'])('%s is a failed refetch', (reason) => {
    expect(rejectionForVerification(reason)).toEqual({ kind: 'rejected', reason: 'jwks_refetch_failed', detail: reason });
  });
  it.each(['invalid_signature', 'key_revoked', 'delegate_mismatch', 'expired'])('%s is an answer: verification_failed', (reason) => {
    expect(rejectionForVerification(reason)).toEqual({ kind: 'rejected', reason: 'verification_failed', detail: reason });
  });
});
