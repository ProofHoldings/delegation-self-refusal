/** Reasons the backend sends that refuse for good (`docs/mcp-delegation-gate-contract.md` § 7). */
export const BACKEND_DEFINITIVE_REASONS = [
  'revoked',
  'suspended',
  'expired',
  'unknown_delegation',
  'invalid',
  'unsupported_version',
  'identifier_unverifiable',
  'identifier_mismatch',
  'superseded',
] as const;

/** Definitive reasons the gate decides itself, from the token's own `exp`. */
export const LOCAL_DEFINITIVE_REASONS = ['expired', 'malformed'] as const;

export const KEY_ROTATION_REASONS = ['key_revoked', 'reissue_unavailable'] as const;

/** The one `valid: false` reason that is not an answer: the issuer's own lookup failed. */
export const UNRESOLVED_BACKEND_REASONS = ['status_unavailable'] as const;

export const LOCAL_TRANSPORT_REASONS = ['network_error', 'http_error', 'tls_error', 'timeout'] as const;

export const UNRECOGNIZED_REFUSAL = 'unrecognized_refusal';

/** Retryable per reason; every other refusal code is not. */
const RETRYABLE_REFUSALS: ReadonlySet<string> = new Set(['key_revoked']);

const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ...BACKEND_DEFINITIVE_REASONS,
  ...LOCAL_DEFINITIVE_REASONS,
  ...KEY_ROTATION_REASONS,
]);

export type UnresolvedReason = (typeof LOCAL_TRANSPORT_REASONS)[number] | (typeof UNRESOLVED_BACKEND_REASONS)[number];

export type PollResult =
  | { kind: 'valid' }
  | { kind: 'refused'; code: string }
  | { kind: 'key_revoked' }
  | { kind: 'unresolved'; reason: UnresolvedReason };

export function refusalCodeOf(reason: string): { error: string; retryable: boolean } {
  if (!REFUSAL_CODES.has(reason)) return { error: UNRECOGNIZED_REFUSAL, retryable: false };
  return { error: reason, retryable: RETRYABLE_REFUSALS.has(reason) };
}

/** One validate answer, classified before `applyPoll` (§ 4). */
export function classifyPollAnswer(answer: { httpStatus: number; body: unknown }): PollResult {
  if (answer.httpStatus < 200 || answer.httpStatus > 299) return { kind: 'unresolved', reason: 'http_error' };
  const body = answer.body as { valid?: unknown; reason?: unknown } | null;
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.valid !== 'boolean') {
    return { kind: 'unresolved', reason: 'http_error' };
  }
  if (body.valid) return { kind: 'valid' };
  if (body.reason === undefined || body.reason === null) return { kind: 'refused', code: 'invalid' };
  const reason = String(body.reason);
  if ((UNRESOLVED_BACKEND_REASONS as readonly string[]).includes(reason)) {
    return { kind: 'unresolved', reason: 'status_unavailable' };
  }
  if (reason === 'key_revoked') return { kind: 'key_revoked' };
  if ((BACKEND_DEFINITIVE_REASONS as readonly string[]).includes(reason)) return { kind: 'refused', code: reason };
  return { kind: 'refused', code: UNRECOGNIZED_REFUSAL };
}
