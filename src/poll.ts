import type { PollResult } from './types.js';

export const DEFAULT_BASE_URL = 'https://api.proof.holdings';
export const DEFAULT_TIMEOUT_MS = 10_000;

/** One spelling per issuer: trailing slashes stripped, lowercased. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').toLowerCase();
}

export function isDefaultBaseUrl(baseUrl: string): boolean {
  return normalizeBaseUrl(baseUrl) === DEFAULT_BASE_URL;
}

/**
 * A `valid: false` reason the issuer can hand back that is NOT a definitive answer — it means
 * the issuer's own registry lookup failed, not that the delegation was checked and rejected.
 * Mirrors `packages/delegation-verifier/src/status.ts`, which fails the same way closed for the
 * identical reason on the read-only verification side.
 */
const UNRESOLVED_REASON = 'status_unavailable';

/**
 * Polls `POST {baseUrl}/api/v1/proofs/validate` with the delegation token and maps the response
 * to a PollResult. Never sends `identifier` — a delegation has none to bind against
 * (src/controllers/proofs.ts validateDelegationBranch rejects that combination outright).
 */
export async function pollDelegationStatus(
  token: string,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PollResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/proofs/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof_token: token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unresolved' };
  }

  if (!response.ok) {
    return { kind: 'unresolved' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unresolved' };
  }

  if (typeof body !== 'object' || body === null) {
    return { kind: 'unresolved' };
  }

  const parsed = body as { valid: unknown; reason?: unknown; message?: unknown };

  // Strict boolean check, not presence + truthy — mirrors
  // packages/delegation-verifier/src/status.ts's `typeof body.valid !== 'boolean'` gate on the
  // identical backend contract. A non-boolean `valid` is a response this package cannot trust.
  if (typeof parsed.valid !== 'boolean') {
    return { kind: 'unresolved' };
  }

  if (parsed.valid) {
    return { kind: 'valid' };
  }

  if (parsed.reason === UNRESOLVED_REASON) {
    return { kind: 'unresolved' };
  }

  return {
    kind: 'refused',
    reason: typeof parsed.reason === 'string' ? parsed.reason : 'invalid',
    message: typeof parsed.message === 'string' ? parsed.message : 'This delegation is not valid',
  };
}
