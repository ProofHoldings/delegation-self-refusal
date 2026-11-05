import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyDelegation } from '@proof-holdings/delegation-verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearTombstones, createDiskKeySetStore, jwksUriFor } from '../keyset-store.js';
import {
  getJwksDiagnostics,
  refreshJwks,
  resetJwksCache,
  setJwksClockForTests,
} from '../../../delegation-verifier/src/jwks.js';
import {
  delegationClaims,
  generateKey,
  ISSUER,
  mockFetch,
  signJwt,
  type TestKey,
} from '../../../delegation-verifier/src/__tests__/helpers.js';

const DAY = 86_400;
const BASE_URL = 'https://issuer.test';
const JWKS_URI = jwksUriFor(BASE_URL);

let dir: string;
let key: TestKey;
let nowSeconds: number;

function registryJwk(testKey: TestKey): Record<string, unknown> {
  return {
    ...testKey.publicJwk,
    proof_purpose: 'delegation',
    not_before: nowSeconds - 30 * DAY,
    not_after: nowSeconds + 30 * DAY,
    max_token_lifetime: 365 * DAY,
  };
}

async function verify(token: string, fetchImpl: typeof fetch) {
  return verifyDelegation(token, {
    trustedIssuers: [{ issuer: ISSUER, jwksUri: JWKS_URI }],
    delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
    statusCheck: 'skip',
    fetch: fetchImpl,
    keySetStore: createDiskKeySetStore(dir),
  });
}

/** Two fetches of the tombstone at least five minutes apart: the verifier's own confirmation rule. */
async function applyTombstone(): Promise<{ token: string; fetchImpl: typeof fetch }> {
  const routes: Record<string, { json: unknown }> = { [JWKS_URI]: { json: { keys: [registryJwk(key)] } } };
  const net = mockFetch(routes);
  const fetchImpl = net.fetch as unknown as typeof fetch;
  const store = createDiskKeySetStore(dir);
  const token = await signJwt(delegationClaims({ iat: nowSeconds - 60, exp: nowSeconds + 3600 }), key);
  expect((await verify(token, fetchImpl)).valid).toBe(true);

  routes[JWKS_URI] = { json: { keys: [], proof_tombstones: [{ kid: key.kid, revoked_at: nowSeconds }] } };
  nowSeconds += 300;
  await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch, keySetStore: store });
  nowSeconds += 300;
  await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch, keySetStore: store });
  return { token, fetchImpl };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'self-refusal-keyset-'));
  resetJwksCache();
  nowSeconds = Math.floor(Date.now() / 1000);
  setJwksClockForTests({ monotonicMs: () => nowSeconds * 1000, wallMs: () => nowSeconds * 1000 });
  key = await generateKey('dlg-key-1');
});

afterEach(() => {
  setJwksClockForTests(null);
  resetJwksCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('jwksUriFor', () => {
  it('appends the well-known path to the issuer origin, trailing slashes stripped', () => {
    expect(jwksUriFor('https://api.proof.holdings/')).toBe('https://api.proof.holdings/.well-known/jwks.json');
    expect(jwksUriFor('https://issuer.test')).toBe('https://issuer.test/.well-known/jwks.json');
  });
});

describe('createDiskKeySetStore', () => {
  it('answers null on a cold start and round-trips what it saved', async () => {
    const store = createDiskKeySetStore(dir);
    expect(await store.load(JWKS_URI)).toBeNull();
    await store.save(JWKS_URI, '{"v":1}');
    expect(await createDiskKeySetStore(dir).load(JWKS_URI)).toBe('{"v":1}');
  });

  it('keeps one file per key set, beside the verdict cache and named apart from it', async () => {
    const store = createDiskKeySetStore(dir);
    await store.save(JWKS_URI, 'a');
    await store.save(jwksUriFor('https://other.test'), 'b');
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    for (const file of files) expect(file).toMatch(/^jwks-[0-9a-f]{64}\.json$/);
  });

  it('throws on an unreadable file rather than answering "nothing stored"', async () => {
    const store = createDiskKeySetStore(dir);
    await store.save(JWKS_URI, 'a');
    const [file] = readdirSync(dir);
    rmSync(join(dir, file));
    // A directory where the file should be: a read error that is not ENOENT. Answering null here
    // would let the verifier save over a store it never read — tombstones included.
    mkdirSync(join(dir, file));
    expect(() => store.load(JWKS_URI)).toThrow();
  });
});

describe('SC-7: an applied tombstone survives a restart', () => {
  it('persists the tombstone and refuses after the in-memory key set is gone', async () => {
    const { token, fetchImpl } = await applyTombstone();
    const first = await verify(token, fetchImpl);
    expect(first.valid ? 'valid' : first.reason).toBe('key_revoked');

    const [file] = readdirSync(dir);
    const persisted = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { applied: Array<{ kid: string }> };
    expect(persisted.applied.map((entry) => entry.kid)).toEqual([key.kid]);

    // Restart: the process forgets everything; the issuer now serves the key again (a stale edge).
    resetJwksCache();
    const net = mockFetch({ [JWKS_URI]: { json: { keys: [registryJwk(key)] } } });
    const afterRestart = await verify(token, net.fetch as unknown as typeof fetch);
    expect(afterRestart.valid ? 'valid' : afterRestart.reason).toBe('key_revoked');
  });

  it('is merged with each fetch: a later fetch without it does not drop it from disk', async () => {
    const { token } = await applyTombstone();
    const net = mockFetch({ [JWKS_URI]: { json: { keys: [registryJwk(key)] } } });
    nowSeconds += 900;
    await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch, keySetStore: createDiskKeySetStore(dir) });

    const [file] = readdirSync(dir);
    const persisted = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { applied: Array<{ kid: string }> };
    expect(persisted.applied.map((entry) => entry.kid)).toEqual([key.kid]);
    const result = await verify(token, net.fetch as unknown as typeof fetch);
    expect(result.valid ? 'valid' : result.reason).toBe('key_revoked');
  });

  it('expires the tombstone at revoked_at + 365 days', async () => {
    await applyTombstone();
    const other = await generateKey('dlg-key-2');
    const net = mockFetch({ [JWKS_URI]: { json: { keys: [registryJwk(other)] } } });

    nowSeconds += 364 * DAY;
    resetJwksCache();
    await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch, keySetStore: createDiskKeySetStore(dir) });
    expect(getJwksDiagnostics(JWKS_URI)?.appliedTombstones.map((entry) => entry.kid)).toEqual([key.kid]);

    nowSeconds += 2 * DAY;
    resetJwksCache();
    await refreshJwks({ jwksUri: JWKS_URI, fetch: net.fetch, keySetStore: createDiskKeySetStore(dir) });
    expect(getJwksDiagnostics(JWKS_URI)?.appliedTombstones).toEqual([]);
  });

  it('is cleared only by clearTombstones, in memory and on disk', async () => {
    const { token } = await applyTombstone();
    await clearTombstones({ cacheDir: dir, baseUrl: BASE_URL });
    expect(getJwksDiagnostics(JWKS_URI)?.appliedTombstones).toEqual([]);

    resetJwksCache();
    const net = mockFetch({ [JWKS_URI]: { json: { keys: [registryJwk(key)] } } });
    const result = await verify(token, net.fetch as unknown as typeof fetch);
    expect(result.valid ? 'valid' : result.reason).toBe('valid');
  });
});
