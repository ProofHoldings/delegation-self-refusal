import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CacheEntry } from './types.js';

export function defaultCacheDir(): string {
  return join(homedir(), '.proof-holdings', 'delegation-self-refusal');
}

function cacheFilePath(cacheDir: string, token: string): string {
  const digest = createHash('sha256').update(token).digest('hex');
  return join(cacheDir, `${digest}.json`);
}

/**
 * Validates `lastDecided` against the exact discriminated shape guard.ts's dispatch check
 * assumes. A cache file is untrusted input the moment it is read back from disk (a future
 * version writing a different shape, or a hand-edited file) — an unrecognized `kind` must be
 * treated as corrupt, not silently trusted, since the dispatch check downstream only allows
 * `kind === 'valid'` through and denies everything else.
 */
function isValidLastDecided(value: unknown): value is CacheEntry['lastDecided'] {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'valid') return true;
  if (record.kind === 'refused') {
    return typeof record.reason === 'string' && typeof record.message === 'string';
  }
  return false;
}

/**
 * Reads the cached verdict for this token. Returns null on a cold start (no file yet) or a
 * corrupt/unreadable/unrecognized cache file — either way there is nothing usable to serve, so
 * the caller falls back to a live poll.
 */
export function readCache(cacheDir: string, token: string): CacheEntry | null {
  try {
    const raw = readFileSync(cacheFilePath(cacheDir, token), 'utf8');
    const parsed = JSON.parse(raw) as CacheEntry;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.lastCheckedAtMs !== 'number' ||
      typeof parsed.consecutiveUnresolved !== 'number' ||
      !isValidLastDecided(parsed.lastDecided)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeCache(cacheDir: string, token: string, entry: CacheEntry): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFilePath(cacheDir, token), JSON.stringify(entry), 'utf8');
}
