import { canonicalizeDelegate, canonicalizeScopes, DELEGATE_MAX_LENGTH } from '@proof-holdings/delegation-verifier';

/**
 * What the configured delegation token itself says — read so `proof_check_this_server` can name the
 * artifact and domain the token was issued for instead of echoing the publisher's configured
 * `principal`, which is free text (D6, 2026-10-01 live walkthrough).
 *
 * NO signature check here. The handler consults this only beside a `valid` verdict from the DEFAULT
 * issuer, and that verdict is what stands for the signature check: in the ordinary case it is
 * proof.holdings' own answer for this exact token string. It is not proof against the operator: the
 * verdict may be served from the on-disk cache, and a cache file planted by whoever runs the server
 * makes any token read valid here. That is the hostile-operator case the README already places out
 * of reach — nothing inside a process can out-check the person running it.
 */
export interface DelegationClaims {
  principal: string;
  delegate: string;
  scope: string[];
  delegationId: string;
  expiresAt: string | null;
}

/**
 * A DNS name of at most 253 characters — the same ceiling `proof_verify_delegation`'s
 * `expected_principal` takes. The principal is the domain the issuer proved control of, so
 * anything else in that claim is text no proof.holdings token carries.
 */
const PRINCIPAL_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** `ph_dlg_<32hex>` is 39 characters; the margin is for a future handle shape, not for prose. */
const DELEGATION_ID_MAX_LENGTH = 64;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * A delegate the issuer could have minted: already in the canonical form `canonicalizeDelegate`
 * produces for its own type. Length alone admitted any 512 characters of prose — a newline and an
 * instruction included — into the calling agent's context under a "read from the token" label.
 */
function isCanonicalDelegate(value: unknown): value is string {
  if (!boundedString(value, DELEGATE_MAX_LENGTH)) {
    return false;
  }
  const type = value.startsWith('pkg:') ? 'purl' : 'url';
  try {
    return canonicalizeDelegate({ type, value }) === value;
  } catch {
    return false;
  }
}

/**
 * Returns `null` for anything the issuer could not have minted: not a three-segment JWT, a payload
 * that is not base64url JSON, a token that is not a delegation, or a claim of the wrong type, out of
 * canonical form, or outside the issuer's own mint limits. Such claims are REJECTED rather than
 * truncated or repaired — the reader is told to compare `delegate` with what it connected to, and a
 * truncated one would make that comparison false.
 */
export function readDelegationClaims(token: string): DelegationClaims | null {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const claims = payload as Record<string, unknown>;
  if (
    claims.token_type !== 'delegation' ||
    typeof claims.principal !== 'string' ||
    !PRINCIPAL_RE.test(claims.principal) ||
    !isCanonicalDelegate(claims.delegate) ||
    !boundedString(claims.sub, DELEGATION_ID_MAX_LENGTH) ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    !Array.isArray(claims.scope)
  ) {
    return null;
  }

  let scope: string[];
  try {
    scope = canonicalizeScopes(claims.scope as string[]);
  } catch {
    return null;
  }

  let expiresAt: string | null = null;
  try {
    expiresAt = new Date(claims.exp * 1000).toISOString();
  } catch {
    expiresAt = null;
  }

  return {
    principal: claims.principal,
    delegate: claims.delegate,
    scope,
    delegationId: claims.sub,
    expiresAt,
  };
}
