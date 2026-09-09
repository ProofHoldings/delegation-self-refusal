export { guardDelegation } from './guard.js';
export { installProofLayer, SHOWCASE_VERSION } from './install.js';
export type { InstallProofLayerOptions } from './install.js';
export type { McpServerLike, ToolRegistrar } from './registrar.js';
export { SHOWCASE_TOOL_NAMES } from './showcase/tools.js';
export { SHOWCASE_TIMEOUT_MS } from './showcase/breaker.js';
export { SHOWCASE_SURFACE_HEADER } from './showcase/marked-fetch.js';
/**
 * `currentVerdict` and `resolveOptions` are exported so a publisher can read the SAME verdict the
 * gate enforces (the showcase's `proof_check_this_server` does exactly this) instead of polling
 * separately — an independent poll writes the cache outside the jittered grace schedule and breaks
 * the SEC-DLG-02 fix in `schedule.ts`.
 *
 * Note what is deliberately NOT exported: the un-gated registrar `installProofLayer` captures
 * internally. Anything routed through it bypasses self-refusal entirely while the installation
 * still looks correct from outside — `src/__tests__/no-ungated-registrar.test.ts` walks this
 * module's whole surface to keep it that way.
 */
export { currentVerdict, resolveOptions } from './verdict.js';
/**
 * The refusal text itself, for the same reason `currentVerdict` is exported above: a publisher who
 * reads the gate's verdict to render their own status page gets a machine `reason` and no way to
 * show the sentence their callers are actually receiving — so they write their own, which is the
 * divergence `proof_check_this_server`'s `refusal_message` and the README pin exist to prevent.
 * Withheld for one review round on "no criterion asks for it"; the argument that the export next to
 * it already serves this exact reader is the stronger one.
 */
export { refusalMessage, REFUSAL_DETAILS_URL } from './refusal.js';
export type { ResolvedOptions } from './verdict.js';
export { MAX_GRACE_FAILURES, nextIntervalMs } from './schedule.js';
export { pollDelegationStatus, DEFAULT_BASE_URL } from './poll.js';
export { readCache, writeCache, defaultCacheDir } from './cache.js';
export type {
  ArtifactType,
  CacheEntry,
  GuardOptions,
  PollResult,
  RefusedVerdict,
  UnresolvedVerdict,
  ValidVerdict,
} from './types.js';
