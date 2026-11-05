import { refreshJwks, verifyDelegation } from '@proof-holdings/delegation-verifier';

import { GATE_CONSTANTS, MAX_PULL_BODY_BYTES } from './constants.js';
import type { PullOutcome } from './core.js';
import { createDiskKeySetStore, jwksUriFor } from './keyset-store.js';
import { boundedFetch, joinUrl, surfaceHeaders, type FetchLike } from './poll.js';
import { decodeToken } from './token.js';

/**
 * Picking up a re-signed delegation after the issuer answered `key_revoked`
 * (`docs/mcp-delegation-gate-contract.md` § 6). A pull is an anonymous read, so what comes back is
 * a claim to check, never an instruction.
 */

export type PullRejection =
  | 'old_token_unreadable'
  | 'jwks_refetch_failed'
  | 'pull_unavailable'
  | 'pull_not_found'
  | 'malformed_response'
  | 'same_token'
  | 'same_kid'
  | 'verification_failed'
  | 'lineage_sub'
  | 'lineage_jti'
  | 'lineage_delegate'
  | 'iat_before_old'
  | 'iat_in_future'
  | 'exp_widened';

export interface LineageView {
  kid: string | null | undefined;
  token: string;
  claims: Record<string, unknown>;
}

interface LineageClaims {
  iss: string;
  sub: string;
  jti: string;
  principal: string;
  delegate: string;
  iat: number;
  exp: number;
}

const DELEGATION_HANDLE = /^ph_dlg_[a-f0-9]{32}$/;
const PULL_PATH = '/api/v1/proofs/delegation-token/';

function lineageClaims(claims: Record<string, unknown>): LineageClaims | null {
  const { iss, sub, jti, principal, delegate, iat, exp } = claims;
  if (
    typeof iss !== 'string' ||
    typeof sub !== 'string' ||
    !DELEGATION_HANDLE.test(sub) ||
    typeof jti !== 'string' ||
    jti.length === 0 ||
    typeof principal !== 'string' ||
    typeof delegate !== 'string' ||
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  return { iss, sub, jti, principal, delegate, iat, exp };
}

export function lineageViewOf(token: string): LineageView | null {
  const decoded = decodeToken(token);
  return decoded ? { kid: decoded.kid, token, claims: decoded.claims } : null;
}

/** Every acceptance check but the signature, in the contract's order; the first failing one names the rejection. */
export function checkPulledToken(old: LineageView, pulled: LineageView, nowMs: number): 'accepted' | PullRejection {
  const before = lineageClaims(old.claims);
  if (!before) return 'old_token_unreadable';
  if (pulled.token === old.token) return 'same_token';
  if (typeof pulled.kid !== 'string' || pulled.kid.length === 0) return 'malformed_response';
  if (pulled.kid === old.kid) return 'same_kid';
  const after = lineageClaims(pulled.claims);
  if (!after) return 'malformed_response';
  if (after.sub !== before.sub) return 'lineage_sub';
  if (after.jti !== before.jti) return 'lineage_jti';
  if (after.delegate !== before.delegate) return 'lineage_delegate';
  if (after.iat < before.iat) return 'iat_before_old';
  if (after.iat > Math.floor(nowMs / 1000) + GATE_CONSTANTS.lineage_clock_tolerance_ms / 1000) return 'iat_in_future';
  if (after.exp > before.exp) return 'exp_widened';
  return 'accepted';
}

/**
 * The restart re-check (§ 6 Restart): a persisted replacement is used only if it passes every check
 * but the signature against the configured token and names the same `iss` and `principal`; the
 * signature was verified when it was accepted.
 */
export function replacementAcceptable(configuredToken: string, replacement: string, nowMs: number): boolean {
  const old = lineageViewOf(configuredToken);
  const pulled = lineageViewOf(replacement);
  if (!old || !pulled || checkPulledToken(old, pulled, nowMs) !== 'accepted') return false;
  return pulled.claims.iss === old.claims.iss && pulled.claims.principal === old.claims.principal;
}

export interface PullParams {
  previousToken: string;
  baseUrl: string;
  cacheDir: string;
  timeoutMs: number;
  fetch?: FetchLike;
  nowMs?: () => number;
}

export type PullResult = PullOutcome & { detail?: string };

function markedFetch(fetchImpl: FetchLike): FetchLike {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(surfaceHeaders())) headers.set(name, value);
    return fetchImpl(input, { ...init, headers });
  };
}

async function fetchCurrentToken(
  fetchImpl: FetchLike,
  baseUrl: string,
  handle: string,
  timeoutMs: number,
): Promise<{ ok: true; token: string } | { ok: false; reason: PullRejection }> {
  const outcome = await boundedFetch(
    fetchImpl,
    joinUrl(baseUrl, `${PULL_PATH}${handle}`),
    { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error' },
    timeoutMs,
    async (response) => ({ status: response.status, text: response.ok ? await response.text() : '' }),
  );
  if (!outcome.ok) return { ok: false, reason: 'pull_unavailable' };
  const { status, text } = outcome.value;
  if (status === 404) return { ok: false, reason: 'pull_not_found' };
  if (status < 200 || status > 299) return { ok: false, reason: 'pull_unavailable' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PULL_BODY_BYTES) return { ok: false, reason: 'malformed_response' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed_response' };
  }
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'malformed_response' };
  return { ok: true, token };
}

/** One pull: forced key-set refetch, the pull by handle, every acceptance check. Never throws. */
export async function pullReissuedDelegation(params: PullParams): Promise<PullResult> {
  const now = params.nowMs ?? Date.now;
  const old = lineageViewOf(params.previousToken);
  const oldClaims = old ? lineageClaims(old.claims) : null;
  if (!old || !oldClaims) return { kind: 'rejected', reason: 'old_token_unreadable' };

  const fetchImpl = markedFetch(params.fetch ?? ((input, init) => fetch(input, init)));
  const jwksUri = jwksUriFor(params.baseUrl);
  try {
    const keySetStore = createDiskKeySetStore(params.cacheDir);
    const refreshed = await refreshJwks({ jwksUri, fetch: fetchImpl, keySetStore, timeoutMs: params.timeoutMs });
    if (!refreshed.ok) return { kind: 'rejected', reason: 'jwks_refetch_failed' };

    const pulled = await fetchCurrentToken(fetchImpl, params.baseUrl, oldClaims.sub, params.timeoutMs);
    if (!pulled.ok) return { kind: 'rejected', reason: pulled.reason };

    const candidate = lineageViewOf(pulled.token) ?? { kid: undefined, token: pulled.token, claims: {} };
    const checked = checkPulledToken(old, candidate, now());
    if (checked !== 'accepted') return { kind: 'rejected', reason: checked };

    const verified = await verifyDelegation(pulled.token, {
      trustedIssuers: [{ issuer: oldClaims.iss, jwksUri }],
      delegate: { type: oldClaims.delegate.startsWith('pkg:') ? 'purl' : 'url', value: oldClaims.delegate },
      expectedPrincipal: oldClaims.principal,
      statusCheck: 'skip',
      clockToleranceSeconds: GATE_CONSTANTS.lineage_clock_tolerance_ms / 1000,
      fetch: fetchImpl,
      keySetStore,
      now: new Date(now()),
    });
    if (!verified.valid) return { kind: 'rejected', reason: 'verification_failed', detail: verified.reason };
    return { kind: 'accepted', token: pulled.token };
  } catch {
    return { kind: 'rejected', reason: 'pull_unavailable' };
  }
}
