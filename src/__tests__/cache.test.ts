import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCache, writeCache } from '../cache.js';
import type { CacheEntry } from '../types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cache', () => {
  it('returns null for a token with no cache file (cold start)', () => {
    expect(readCache(dir, 'never-seen-token')).toBeNull();
  });

  it('round-trips a written entry', () => {
    const entry: CacheEntry = {
      lastDecided: { kind: 'valid' },
      lastCheckedAtMs: 1234,
      consecutiveUnresolved: 0,
    };
    writeCache(dir, 'tok', entry);
    expect(readCache(dir, 'tok')).toEqual(entry);
  });

  it('keys by token, not by a shared file', () => {
    writeCache(dir, 'tok-a', {
      lastDecided: { kind: 'valid' },
      lastCheckedAtMs: 1,
      consecutiveUnresolved: 0,
    });
    expect(readCache(dir, 'tok-b')).toBeNull();
  });

  it('creates the cache directory on first write', () => {
    const nested = join(dir, 'does', 'not', 'exist', 'yet');
    writeCache(nested, 'tok', {
      lastDecided: { kind: 'valid' },
      lastCheckedAtMs: 1,
      consecutiveUnresolved: 0,
    });
    expect(readCache(nested, 'tok')).not.toBeNull();
  });

  it('returns null for a corrupt cache file rather than throwing', () => {
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('tok').digest('hex');
    writeFileSync(join(dir, `${digest}.json`), 'not valid json{{{', 'utf8');
    expect(() => readCache(dir, 'tok')).not.toThrow();
    expect(readCache(dir, 'tok')).toBeNull();
  });

  it('rejects a lastDecided with an unrecognized kind rather than trusting it', () => {
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('tok').digest('hex');
    writeFileSync(
      join(dir, `${digest}.json`),
      JSON.stringify({ lastDecided: { kind: 'bogus' }, lastCheckedAtMs: 1, consecutiveUnresolved: 0 }),
      'utf8',
    );
    expect(readCache(dir, 'tok')).toBeNull();
  });

  it('rejects a lastDecided: refused with a missing reason/message field', () => {
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('tok').digest('hex');
    writeFileSync(
      join(dir, `${digest}.json`),
      JSON.stringify({ lastDecided: { kind: 'refused' }, lastCheckedAtMs: 1, consecutiveUnresolved: 0 }),
      'utf8',
    );
    expect(readCache(dir, 'tok')).toBeNull();
  });

  it('accepts a null lastDecided (the shape a fresh, never-decided cache row would have)', () => {
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('tok').digest('hex');
    writeFileSync(
      join(dir, `${digest}.json`),
      JSON.stringify({ lastDecided: null, lastCheckedAtMs: 1, consecutiveUnresolved: 0 }),
      'utf8',
    );
    expect(readCache(dir, 'tok')).toEqual({ lastDecided: null, lastCheckedAtMs: 1, consecutiveUnresolved: 0 });
  });
});
