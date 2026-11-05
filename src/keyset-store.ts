import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clearTombstones as clearVerifierTombstones, type KeySetStore } from '@proof-holdings/delegation-verifier';

import { defaultCacheDir } from './cache.js';
import { DEFAULT_BASE_URL } from './constants.js';

/** The issuer's JWKS. */
export function jwksUriFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/.well-known/jwks.json`;
}

function keySetFilePath(cacheDir: string, jwksUri: string): string {
  return join(cacheDir, `jwks-${createHash('sha256').update(jwksUri).digest('hex')}.json`);
}

/**
 * The verifier's `KeySetStore`, on disk beside the verdict cache. This is what makes a tombstone
 * the pickup's verification applied survive a restart (a stdio server is spawned per session).
 * Merging with each fetch, stickiness and the `revoked_at + 365d` expiry are the verifier's own
 * logic; this only holds the opaque state.
 *
 * `load` answers null ONLY for a file that does not exist. Any other read error throws, so the
 * verifier marks the store unreadable and refuses to save over it — answering null there would
 * let the next save overwrite tombstones it never read.
 */
export function createDiskKeySetStore(cacheDir: string): KeySetStore {
  return {
    load(jwksUri: string): string | null {
      try {
        return readFileSync(keySetFilePath(cacheDir, jwksUri), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    save(jwksUri: string, state: string): void {
      mkdirSync(cacheDir, { recursive: true });
      const target = keySetFilePath(cacheDir, jwksUri);
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, state, 'utf8');
      renameSync(temporary, target);
    },
  };
}

/**
 * The manual reset for tombstones this package persisted — the only way one is dropped before its
 * retention ends. Defaults match `installProofHoldings`'s: the default issuer and the default cache dir.
 */
export async function clearTombstones(opts: { cacheDir?: string; baseUrl?: string } = {}): Promise<void> {
  await clearVerifierTombstones({
    jwksUri: jwksUriFor(opts.baseUrl ?? DEFAULT_BASE_URL),
    keySetStore: createDiskKeySetStore(opts.cacheDir ?? defaultCacheDir()),
  });
}
