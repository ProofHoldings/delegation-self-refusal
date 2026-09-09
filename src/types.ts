/**
 * A definitive "yes" from POST /proofs/validate.
 */
export interface ValidVerdict {
  kind: 'valid';
}

/**
 * A definitive "no" from POST /proofs/validate — revoked, suspended, expired, unknown, or
 * otherwise structurally rejected. Never re-tried; the caller acts on it immediately.
 */
export interface RefusedVerdict {
  kind: 'refused';
  reason: string;
  message: string;
}

/**
 * Not an answer at all: the fetch failed (network error, non-2xx), or the server answered but
 * could not itself resolve the delegation's status (`reason: 'status_unavailable'`). Distinct
 * from RefusedVerdict on purpose — this is what the grace window in schedule.ts exists for.
 */
export interface UnresolvedVerdict {
  kind: 'unresolved';
}

export type PollResult = ValidVerdict | RefusedVerdict | UnresolvedVerdict;

/**
 * Persisted on disk between polls (and between process restarts — a stdio MCP server is
 * commonly spawned per session). `lastDecided` is the most recent ValidVerdict/RefusedVerdict —
 * never an UnresolvedVerdict, which is never worth caching.
 */
export interface CacheEntry {
  lastDecided: ValidVerdict | RefusedVerdict | null;
  lastCheckedAtMs: number;
  consecutiveUnresolved: number;
}

export type ArtifactType = 'url' | 'purl';

export interface GuardOptions {
  /** The delegation JWT. Omit or leave empty to disable the gate entirely — see SC-7. */
  token?: string;
  /** The principal named in the refusal message (e.g. the domain that issued the delegation). */
  principal: string;
  /** Base URL of the issuer's API. Defaults to https://api.proof.holdings. */
  baseUrl?: string;
  /**
   * Where publisher-operated (`url`) vs. consumer-installed (`purl`).
   *
   * ⚠️ It shapes NOTHING at runtime, and the claim it used to carry ("shapes refusal wording only")
   * was ALREADY false before the reason→phrase map existed — the template it referred to never read
   * this field either. The map only made the falsehood easy to see. It is read nowhere outside this
   * declaration (grep across `src/`, tests excluded). Kept because it is a documented
   * part of a published option shape and both dashboard snippets teach publishers to pass it —
   * removing it is a breaking change to make deliberately, not a tidy-up.
   */
  artifactType: ArtifactType;
  /** Directory for the on-disk cache. Defaults to ~/.proof-holdings/delegation-self-refusal. */
  cacheDir?: string;
  /** Base poll interval in ms before jitter. Defaults to 60_000. */
  pollIntervalMs?: number;
}
