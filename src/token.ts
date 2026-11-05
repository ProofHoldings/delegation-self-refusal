/** Unsigned reads of the configured delegation token. The issuer's poll is what checks the signature. */

export interface DecodedToken {
  kid: string | undefined;
  claims: Record<string, unknown>;
}

export interface StatusClaims {
  principal: string | null;
  delegate: string | null;
  iat: number | null;
  exp: unknown;
}

export const UNNAMED_PRINCIPAL = 'the delegating domain';

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Header and payload of a three-segment JWT, or null. */
export function decodeToken(token: string): DecodedToken | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const header = decodeSegment(segments[0]);
  const claims = decodeSegment(segments[1]);
  if (!header || !claims) return null;
  return { kid: typeof header.kid === 'string' ? header.kid : undefined, claims };
}

/** What the local `exp` rule reads: `undefined` for a token that does not decode. */
export function tokenExp(token: string): unknown {
  return decodeToken(token)?.claims.exp;
}

export function statusClaims(token: string): StatusClaims | null {
  const decoded = decodeToken(token);
  if (!decoded) return null;
  const { principal, delegate, iat, exp } = decoded.claims;
  return {
    principal: typeof principal === 'string' ? principal : null,
    delegate: typeof delegate === 'string' ? delegate : null,
    iat: typeof iat === 'number' && Number.isFinite(iat) ? iat : null,
    exp,
  };
}

export function principalOf(token: string): string {
  const principal = decodeToken(token)?.claims.principal;
  return typeof principal === 'string' && principal.length > 0 ? principal : UNNAMED_PRINCIPAL;
}
