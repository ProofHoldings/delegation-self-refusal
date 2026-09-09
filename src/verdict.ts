import { defaultCacheDir, writeCache, readCache } from './cache.js';
import { DEFAULT_BASE_URL, pollDelegationStatus } from './poll.js';
import { MAX_GRACE_FAILURES, nextIntervalMs } from './schedule.js';
import type { GuardOptions, PollResult, RefusedVerdict, ValidVerdict } from './types.js';

/**
 * `GuardOptions` with every default already applied. Lives here rather than inside `guard.ts` so
 * the showcase (`showcase/tools.ts`) can read the SAME verdict the gate reads without importing
 * the gate — an import in that direction would close the cycle guard → showcase → guard.
 */
export interface ResolvedOptions extends GuardOptions {
  token: string;
  baseUrl: string;
  cacheDir: string;
  pollIntervalMs: number;
  /**
   * Set ONLY by `installProofLayer` (`install.ts`), never by `guardDelegation` — marks this
   * installation's verdict poll as coming from one that carries the showcase, the denominator half
   * of "did the showcase do anything" (l-mcp-showcase-verdict-surface-marker). Typed as the
   * built-in `fetch` rather than a type from `showcase/`: the gate must not import from the layer
   * built on top of it.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Applies the documented defaults once. Both `guardDelegation` and `installProofLayer` call this
 * exactly once per installation and hand the SAME object to the gate and to the showcase — two
 * independent resolutions could disagree on `cacheDir` and silently split the grace state machine
 * across two files.
 */
export function resolveOptions(opts: GuardOptions & { token: string; fetchImpl?: typeof fetch }): ResolvedOptions {
  return {
    ...opts,
    token: opts.token,
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    pollIntervalMs: opts.pollIntervalMs ?? 60_000,
  };
}

/**
 * Caching is an optimization on top of an already-computed verdict, not a precondition for
 * returning it — a filesystem error here (read-only FS, permission denial, disk full) must not
 * throw out of the gated handler and must not discard a verdict that was already determined.
 * `console.error` (never `console.log`/stdout) is this repo's established safe channel for an
 * MCP stdio server, where stdout is the JSON-RPC transport itself (mcp/src/server.ts:96,100).
 */
export function safeWriteCache(cacheDir: string, token: string, entry: Parameters<typeof writeCache>[2]): void {
  try {
    writeCache(cacheDir, token, entry);
  } catch (error) {
    console.error(
      `delegation-self-refusal: failed to persist cache entry (continuing with the verdict already computed): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Applies the grace-window state machine and returns a definitive verdict. A cold start (no cache
 * file at all) has no grace to extend — an unresolved first poll refuses immediately (SC-12: "a
 * first run has none"). A cached UnresolvedVerdict is never persisted as `lastDecided`: only
 * ValidVerdict/RefusedVerdict are ever served from cache.
 */
export async function currentVerdict(opts: ResolvedOptions): Promise<ValidVerdict | RefusedVerdict> {
  const cache = readCache(opts.cacheDir, opts.token);
  const interval = nextIntervalMs(opts.pollIntervalMs);
  const dueForPoll = !cache || Date.now() - cache.lastCheckedAtMs >= interval;

  let result: PollResult;
  if (dueForPoll) {
    result = await pollDelegationStatus(opts.token, opts.baseUrl, opts.fetchImpl);
  } else if (cache?.lastDecided) {
    return cache.lastDecided;
  } else {
    result = { kind: 'unresolved' };
  }

  if (result.kind !== 'unresolved') {
    safeWriteCache(opts.cacheDir, opts.token, {
      lastDecided: result,
      lastCheckedAtMs: Date.now(),
      consecutiveUnresolved: 0,
    });
    return result;
  }

  const failures = (cache?.consecutiveUnresolved ?? 0) + 1;

  if (cache?.lastDecided && failures <= MAX_GRACE_FAILURES) {
    safeWriteCache(opts.cacheDir, opts.token, {
      lastDecided: cache.lastDecided,
      lastCheckedAtMs: Date.now(),
      consecutiveUnresolved: failures,
    });
    return cache.lastDecided;
  }

  const refusal: RefusedVerdict = cache?.lastDecided
    ? {
        kind: 'refused',
        reason: 'grace_exhausted',
        message: `Could not reconfirm authorization after ${failures} consecutive failed checks`,
      }
    : {
        kind: 'refused',
        reason: 'unresolved_at_startup',
        message: 'Authorization could not be confirmed on the first check',
      };

  safeWriteCache(opts.cacheDir, opts.token, {
    lastDecided: refusal,
    lastCheckedAtMs: Date.now(),
    consecutiveUnresolved: failures,
  });
  return refusal;
}
