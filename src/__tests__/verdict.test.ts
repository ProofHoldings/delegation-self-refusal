import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCache } from '../cache.js';
import { currentVerdict, resolveOptions } from '../verdict.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-verdict-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function countingFetch(body: unknown): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('currentVerdict — cache freshness', () => {
  it('polls when the cached check is stamped in the future (clock rolled back)', async () => {
    writeCache(dir, 'tok', {
      lastDecided: { kind: 'valid' },
      lastCheckedAtMs: Date.now() + 60 * 60 * 1000,
      consecutiveUnresolved: 0,
    });
    const { fetchImpl, calls } = countingFetch({ valid: false, reason: 'revoked', message: 'Revoked' });

    const verdict = await currentVerdict(resolveOptions({ token: 'tok', cacheDir: dir, fetchImpl }));

    expect(calls()).toBe(1);
    expect(verdict).toEqual({ kind: 'refused', reason: 'revoked', message: 'Revoked' });
  });

  it('still serves a fresh cached verdict without polling', async () => {
    writeCache(dir, 'tok', {
      lastDecided: { kind: 'valid' },
      lastCheckedAtMs: Date.now(),
      consecutiveUnresolved: 0,
    });
    const { fetchImpl, calls } = countingFetch({ valid: false, reason: 'revoked', message: 'Revoked' });

    const verdict = await currentVerdict(resolveOptions({ token: 'tok', cacheDir: dir, fetchImpl }));

    expect(calls()).toBe(0);
    expect(verdict).toEqual({ kind: 'valid' });
  });
});

describe('currentVerdict — cache is per issuer', () => {
  it('does not serve a verdict cached under another baseUrl after switching to the default issuer', async () => {
    const other = resolveOptions({
      token: 'tok',
      cacheDir: dir,
      baseUrl: 'https://issuer.example',
      fetchImpl: countingFetch({ valid: true }).fetchImpl,
    });
    expect(await currentVerdict(other)).toEqual({ kind: 'valid' });

    const { fetchImpl, calls } = countingFetch({ valid: false, reason: 'revoked', message: 'Revoked' });
    const verdict = await currentVerdict(resolveOptions({ token: 'tok', cacheDir: dir, fetchImpl }));

    expect(calls()).toBe(1);
    expect(verdict.kind).toBe('refused');
  });

  it('does not serve a default-issuer verdict to another baseUrl', async () => {
    const fresh = resolveOptions({ token: 'tok', cacheDir: dir, fetchImpl: countingFetch({ valid: true }).fetchImpl });
    expect(await currentVerdict(fresh)).toEqual({ kind: 'valid' });

    const { fetchImpl, calls } = countingFetch({ valid: false, reason: 'revoked', message: 'Revoked' });
    const verdict = await currentVerdict(
      resolveOptions({ token: 'tok', cacheDir: dir, baseUrl: 'https://issuer.example', fetchImpl }),
    );

    expect(calls()).toBe(1);
    expect(verdict.kind).toBe('refused');
  });

  it('shares one cache between spellings of the same issuer (trailing slash, case)', async () => {
    const first = resolveOptions({
      token: 'tok',
      cacheDir: dir,
      baseUrl: 'https://Issuer.example/',
      fetchImpl: countingFetch({ valid: true }).fetchImpl,
    });
    expect(await currentVerdict(first)).toEqual({ kind: 'valid' });

    const { fetchImpl, calls } = countingFetch({ valid: false, reason: 'revoked', message: 'Revoked' });
    const verdict = await currentVerdict(
      resolveOptions({ token: 'tok', cacheDir: dir, baseUrl: 'https://issuer.example', fetchImpl }),
    );

    expect(calls()).toBe(0);
    expect(verdict).toEqual({ kind: 'valid' });
  });
});
