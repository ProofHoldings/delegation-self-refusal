import { z } from 'zod';

import type { GateConstants } from './constants.js';
import { localExpiry, type LocalExpiry, type TokenRecords } from './core.js';
import type { StatusClaims } from './token.js';

/** `proof_holdings_status` output (`docs/mcp-delegation-gate-contract.md` § 10). */

export const PROOF_HOLDINGS_ABOUT = {
  about:
    "Proof Holdings issued the delegation this server presents. The status above, from proof.holdings, says whether that delegation is in force; it says nothing about the quality or safety of the server.",
  url: 'https://proof.holdings',
  llms_txt: 'https://proof.holdings/llms.txt',
} as const;

export type StatusValue = 'valid' | 'refused' | 'unresolved' | 'not_configured';

export interface StatusOutput {
  delegation: {
    status: StatusValue;
    reason: string | null;
    principal: string | null;
    delegate: string | null;
    issued_at: string | null;
    expires_at: string | null;
    expires_soon: boolean;
    checked_at: string | null;
    source: 'live' | 'cache';
    never_validated: boolean;
    unresolved_since: string | null;
  };
  proof_holdings: typeof PROOF_HOLDINGS_ABOUT;
}

export interface StatusInput {
  configured: boolean;
  claims: StatusClaims | null;
  records: TokenRecords;
  now: number;
  source: 'live' | 'cache';
}

function iso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function statusOf(records: TokenRecords, local: LocalExpiry): { status: StatusValue; reason: string | null } {
  const gate = records.gate;
  const refusal = gate?.verdict.kind === 'refused' ? gate.verdict.code : null;
  if (local !== 'ok') return { status: 'refused', reason: local };
  if (gate?.key_rotation) return { status: 'refused', reason: refusal };
  if (records.info.unresolved_since !== null || !gate) return { status: 'unresolved', reason: refusal };
  return { status: gate.verdict.kind === 'valid' ? 'valid' : 'refused', reason: refusal };
}

export function statusOutput(input: StatusInput, c: GateConstants): StatusOutput {
  const { records } = input;
  if (!input.configured) {
    return {
      delegation: {
        status: 'not_configured',
        reason: null,
        principal: null,
        delegate: null,
        issued_at: null,
        expires_at: null,
        expires_soon: false,
        checked_at: null,
        source: 'cache',
        never_validated: true,
        unresolved_since: null,
      },
      proof_holdings: PROOF_HOLDINGS_ABOUT,
    };
  }
  if (!input.claims) {
    return {
      delegation: {
        status: 'refused',
        reason: 'malformed',
        principal: null,
        delegate: null,
        issued_at: null,
        expires_at: null,
        expires_soon: false,
        checked_at: iso(records.gate?.checked_at ?? null),
        source: input.source,
        never_validated: records.gate === null,
        unresolved_since: iso(records.info.unresolved_since),
      },
      proof_holdings: PROOF_HOLDINGS_ABOUT,
    };
  }
  const { claims, now } = input;
  const { status, reason } = statusOf(records, localExpiry(claims.exp, now, c));
  const expMs = typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  const expiresAt = iso(expMs);
  return {
    delegation: {
      status,
      reason,
      principal: claims.principal,
      delegate: claims.delegate,
      issued_at: iso(claims.iat === null ? null : claims.iat * 1000),
      expires_at: expiresAt,
      expires_soon: expiresAt !== null && expMs !== null && expMs - now <= c.expires_soon_ms,
      checked_at: iso(records.gate?.checked_at ?? null),
      source: input.source,
      never_validated: records.gate === null,
      unresolved_since: iso(records.info.unresolved_since),
    },
    proof_holdings: PROOF_HOLDINGS_ABOUT,
  };
}

const nullableDateTime = () => z.string().datetime().nullable();

export function statusOutputSchema() {
  return z
    .object({
      delegation: z
        .object({
          status: z.enum(['valid', 'refused', 'unresolved', 'not_configured']),
          reason: z.string().nullable(),
          principal: z.string().nullable(),
          delegate: z.string().nullable(),
          issued_at: nullableDateTime(),
          expires_at: nullableDateTime(),
          expires_soon: z.boolean(),
          checked_at: nullableDateTime(),
          source: z.enum(['live', 'cache']),
          never_validated: z.boolean(),
          unresolved_since: nullableDateTime(),
        })
        .strict(),
      proof_holdings: z
        .object({
          about: z.literal(PROOF_HOLDINGS_ABOUT.about),
          url: z.literal(PROOF_HOLDINGS_ABOUT.url),
          llms_txt: z.literal(PROOF_HOLDINGS_ABOUT.llms_txt),
        })
        .strict(),
    })
    .strict();
}
