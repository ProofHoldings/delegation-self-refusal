export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The header the issuer counts (SC-11). Named as a surface rather than a product so the same
 * mechanism can carry a future one without a second header; the value is `showcase/<version>`.
 * Backend side: `src/controllers/mcp.ts`.
 */
export const SHOWCASE_SURFACE_HEADER = 'X-Proof-Surface';

/**
 * Wraps a fetch so every outbound call the SHOWCASE makes is attributable, and no other call is.
 *
 * This is the only way the issuer can answer "did the showcase do anything at all" — its single
 * purpose is distribution, and distribution that cannot be measured cannot be judged. It adds a
 * header to calls that were happening anyway; it never introduces a request of its own, and it
 * carries no identity, no token and nothing about the publisher's users.
 */
export function createMarkedFetch(version: string, fetchImpl: typeof fetch = fetch): FetchLike {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(SHOWCASE_SURFACE_HEADER, `showcase/${version}`);
    return fetchImpl(input as RequestInfo, { ...init, headers });
  };
}

/**
 * The prefix marking `installProofLayer`'s OWN verdict poll (l-mcp-showcase-verdict-surface-marker
 * SC-2) — deliberately textually disjoint from `showcase/` above. `proof_verify_delegation` marks
 * its own call to this package's status endpoint (`/api/v1/proofs/validate`) with `showcase/<version>`
 * via `createMarkedFetch` — the SAME route the gate polls — and a shared prefix would make that
 * rare, deliberate signal indistinguishable from this mechanical heartbeat on their one common route.
 */
export const LAYER_SURFACE_PREFIX = 'layer/';

/**
 * Wraps a fetch so the gate's own periodic verdict poll is attributable to an `installProofLayer`
 * install — the denominator half of "did the showcase do anything": `createMarkedFetch` above
 * counts SHOWCASE TOOL CALLS (the numerator), this counts INSTALLATIONS. `guardDelegation` never
 * touches this function, so its poll carries no header at all.
 *
 * Returns `typeof fetch` rather than `FetchLike`: this is the value `install.ts` hands to
 * `ResolvedOptions.fetchImpl`, which is deliberately typed as the built-in `fetch` (verdict.ts) so
 * the gate never imports a type from `showcase/`, the layer built on top of it. Cast rather than
 * structurally satisfied, matching how this package's own test doubles for `fetch` are typed.
 */
export function createLayerSurfaceFetch(version: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set(SHOWCASE_SURFACE_HEADER, `${LAYER_SURFACE_PREFIX}${version}`);
    return fetchImpl(input as RequestInfo, { ...init, headers });
  }) as unknown as typeof fetch;
}
