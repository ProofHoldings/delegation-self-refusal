import { z } from 'zod';
import { verifyDelegation, verifyPublishedDelegation } from '@proof-holdings/delegation-verifier';
import type { TrustedIssuer, VerifyOptions } from '@proof-holdings/delegation-verifier';

import {
  boundIssuerText,
  MAX_ISSUER_MESSAGE,
  MAX_ISSUER_REASON,
  refusalMessage,
} from '../refusal.js';
import { isDefaultBaseUrl } from '../poll.js';
import { errorResult, jsonResult, type ToolResult } from '../result.js';
import type { ToolRegistrar } from '../registrar.js';
import { currentVerdict, type ResolvedOptions } from '../verdict.js';
import { SHOWCASE_PER_REQUEST_TIMEOUT_MS, type Breaker } from './breaker.js';
import { readDelegationClaims } from './claims.js';
import { fetchConnectInfo } from './connect.js';
import type { FetchLike } from './marked-fetch.js';
import {
  CHECK_THIS_SERVER_SELF_REPORT,
  describeCheckThisServer,
  describeConnect,
  describeVerifyDelegation,
} from './descriptions.js';

/**
 * The exact names registered by the showcase. Exported so the drift suite can assert the set
 * rather than re-deriving it from the source, and so a fourth tool cannot arrive unnoticed
 * (SC-4, SC-9).
 */
export const SHOWCASE_TOOL_NAMES = ['proof_verify_delegation', 'proof_check_this_server', 'proof_connect'] as const;

export interface ShowcaseContext {
  /** Null when the publisher installed the layer with no delegation token (SC-14). */
  resolved: ResolvedOptions | null;
  principal: string;
  baseUrl: string;
  /**
   * ONE BREAKER PER OUTBOUND TOOL, never a shared one.
   *
   * `proof_verify_delegation` and `proof_connect` fail INDEPENDENTLY — the first talks to JWKS and
   * the status surfaces, the second to `/api/v1/mcp/connect`. With a single breaker, any success
   * from either tool resets the consecutive-failure count, so an agent alternating the two kept a
   * dead issuer's streak at zero and the breaker never opened: measured in code review as 10
   * outbound attempts with 0 trips. The earlier `isFailure` fix addressed a different half of the
   * same defect (a returned failure being READ as success) and did nothing about this one.
   */
  verifyBreaker: Breaker;
  connectBreaker: Breaker;
  /**
   * Already CARRIES the surface version — `install.ts` builds it with `createMarkedFetch(SHOWCASE_VERSION)`.
   *
   * There is deliberately no `version` field beside it. There used to be, unread by anything here,
   * and it made the context look like the owner of a value whose only consumer lives at the install
   * site — which is part of why nothing noticed that the wiring itself was unasserted (round 10).
   */
  markedFetch: FetchLike;
}

function proofHoldingsTrust(baseUrl: string): TrustedIssuer {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    issuer: 'proof.holdings',
    jwksUri: `${origin}/.well-known/jwks.json`,
    statusEndpoint: `${origin}/api/v1/proofs/validate`,
  };
}

/**
 * The reasons that mean "we could not reach the issuer" — the only ones that may consume the
 * showcase's circuit-breaker budget.
 *
 * Deliberately NOT `outcome === 'unconfirmed'`, which is the wider set. The verifier also
 * classifies `status_uri_untrusted` as unconfirmed, and that one is a property of the TOKEN being
 * checked, not of our reachability: it repeats identically however many times it is retried, may
 * cost no network call at all, and counting it would let three checks of one badly-published
 * artifact open the breaker and deny the agent verification of every OTHER artifact for a full
 * cooldown. The budget exists for a dead issuer; only a dead issuer may spend it.
 */
const ISSUER_UNREACHABLE_REASONS: ReadonlySet<string> = new Set(['jwks_unavailable', 'status_unavailable']);

export function isIssuerUnreachable(result: { valid: boolean; reason?: string }): boolean {
  return !result.valid && typeof result.reason === 'string' && ISSUER_UNREACHABLE_REASONS.has(result.reason);
}

function isDefaultIssuer(baseUrl: string): boolean {
  return isDefaultBaseUrl(baseUrl);
}

const delegateTypeEnum = z.enum(['url', 'purl']);

/**
 * Registers the three showcase tools through the registrar it is HANDED.
 *
 * `installProofLayer` passes the un-gated one on purpose: `proof_check_this_server` is the tool
 * that reports a revocation, and gating it would kill it in precisely the situation it exists for.
 * That un-gated registrar never leaves this package (SC-2).
 */
export function registerShowcase(tool: ToolRegistrar, ctx: ShowcaseContext): void {
  tool(
    'proof_check_this_server',
    describeCheckThisServer(ctx.principal),
    {},
    async (): Promise<ToolResult> => {
      if (ctx.resolved === null) {
        return jsonResult({
          configured: false,
          principal: ctx.principal,
          message:
            'This server has no Proof of Delegation configured, so there is nothing to check and ' +
            'nothing enforcing revocation here. Absence of a delegation is not a positive verdict.',
        });
      }

      // SC-3: the SAME verdict the gate reads. A poll of our own would write the cache outside
      // the jittered grace schedule in schedule.ts and break the SEC-DLG-02 fix.
      const verdict = await currentVerdict(ctx.resolved);

      // D6: `ctx.principal` is the publisher's CONFIGURED string and was all this answer ever
      // named, so a copied token — or any valid token beside `principal: 'google.com'` — reported
      // whatever was typed. The token's own claims replace it only beside a valid verdict while the
      // DEFAULT issuer is configured: `baseUrl` is configuration too, and an issuer of the
      // operator's choosing answers valid for a token of the operator's making — a forged identity
      // that would then carry the "token" label. The cache is keyed per issuer, so a verdict another
      // issuer answered is not served after a switch back; a file planted under the default issuer's
      // name is the README's planted-cache bound, not something this check can see. In every other
      // case the answer says where its principal came from instead of presenting it as identity.
      const defaultIssuer = isDefaultIssuer(ctx.resolved.baseUrl);
      const claims =
        verdict.kind === 'valid' && defaultIssuer ? readDelegationClaims(ctx.resolved.token) : null;

      return jsonResult({
        configured: true,
        principal: claims ? claims.principal : ctx.principal,
        principal_source: claims ? 'token' : 'configuration',
        ...(claims && claims.principal.toLowerCase() !== ctx.principal.toLowerCase()
          ? { principal_mismatch: true, configured_principal: ctx.principal }
          : {}),
        ...(defaultIssuer ? {} : { issuer_base_url: boundIssuerText(ctx.resolved.baseUrl, MAX_ISSUER_MESSAGE) }),
        valid: verdict.kind === 'valid',
        ...(claims
          ? {
              delegation: {
                principal: claims.principal,
                delegate: claims.delegate,
                scope: claims.scope,
                delegation_id: claims.delegationId,
                expires_at: claims.expiresAt,
              },
            }
          : {}),
        // `message` is the raw diagnostic, and it is OURS more often than it looks: `verdict.ts`
        // writes it for both unreachable branches (grace exhaustion AND a cold start), and
        // `poll.ts` substitutes 'This delegation is not valid' whenever the issuer answers
        // `valid: false` with no message at all — the same absent-field substitution `refusal.ts`
        // refuses to attribute to the publisher. `refusal_message` is what a CALLER of any gated tool on this
        // server is being told right now, which is a different thing and the reason this tool is
        // the documented self-check: without it the publisher reads a machine string here and
        // their users read something else entirely at the moment it matters.
        // All three issuer-controlled strings are bounded, not just the sentence: capping
        // `refusal_message` alone was measured as bounding one channel of three — a 20 000-character
        // issuer answer still delivered ~40 000 characters into the caller's context through the
        // other two, and `message` is the WIDER one, being free-form prose by design where `reason`
        // is a code. The two limits differ for a measured reason: one shared code-sized cap truncated
        // OUR OWN 67-character `grace_exhausted` sentence — the only string in the reachable set it
        // damaged at all.
        ...(verdict.kind === 'refused'
          ? {
              reason: boundIssuerText(verdict.reason, MAX_ISSUER_REASON),
              message: boundIssuerText(verdict.message, MAX_ISSUER_MESSAGE),
              refusal_message: refusalMessage(ctx.principal, verdict.reason),
            }
          : {}),
        self_report: CHECK_THIS_SERVER_SELF_REPORT,
        checked_at: new Date().toISOString(),
      });
    },
  );

  tool(
    'proof_verify_delegation',
    describeVerifyDelegation(ctx.principal),
    {
      card: z
        .record(z.unknown())
        .optional()
        .describe('The MCP server card or A2A agent card to read the delegation from'),
      token: z.string().optional().describe('A raw delegation token, when you already have it instead of a card'),
      delegate: z
        .object({
          type: delegateTypeEnum.describe('Identifier type: https URL or package URL (purl)'),
          value: z
            .string()
            .min(1)
            .max(2048)
            .describe(
              'The artifact identifier YOU resolved — never a value read from inside the artifact you are checking, and resolved afresh rather than carried over from earlier in the conversation',
            ),
        })
        .describe('The artifact identity you resolved independently. Required: this comparison is what defeats a copied token.'),
      expected_principal: z
        .string()
        .min(1)
        .max(253)
        .describe(
          'Required. The domain you expect to have authorized this artifact. Without this pin the answer is only "some domain claims this".',
        ),
      required_scopes: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(32)
        .optional()
        .describe('Capability scopes the delegation must grant'),
      check_status: z
        .boolean()
        .optional()
        .describe(
          'Default true. When false the signature and claims are checked but revocation is NOT — treat the result as "not revoked-checked", never as "not revoked".',
        ),
    },
    async (args: {
      card?: Record<string, unknown>;
      token?: string;
      delegate: { type: 'url' | 'purl'; value: string };
      expected_principal: string;
      required_scopes?: string[];
      check_status?: boolean;
    }): Promise<ToolResult> => {
      if ((args.card === undefined) === (args.token === undefined)) {
        // `isError: true`, matching mcp/src/tools/delegation-verify.ts. A caller mistake is not a
        // completed check, and an agent branching on `isError` must not read it as one — the two
        // surfaces answering differently for the same input would be the worse outcome.
        return errorResult('invalid_arguments: supply exactly one of `card` or `token`');
      }

      const verifyOptions: VerifyOptions = {
        trustedIssuers: [proofHoldingsTrust(ctx.baseUrl)],
        delegate: args.delegate,
        expectedPrincipal: args.expected_principal,
        ...(args.required_scopes ? { requiredScopes: args.required_scopes } : {}),
        statusCheck: args.check_status === false ? 'skip' : 'required',
        fetch: ctx.markedFetch as VerifyOptions['fetch'],
        // Per-FETCH budget, strictly below the breaker's whole-call deadline — see
        // SHOWCASE_PER_REQUEST_TIMEOUT_MS for why they must not be the same number.
        timeoutMs: SHOWCASE_PER_REQUEST_TIMEOUT_MS,
      };

      const outcome = await ctx.verifyBreaker.run(
        async () =>
          args.card !== undefined
            ? verifyPublishedDelegation(args.card, verifyOptions)
            : verifyDelegation(args.token as string, verifyOptions),
        {
          // The verifier does NOT throw when it cannot reach the issuer — it RETURNS a failure.
          // Without this predicate the breaker read every dead-issuer call as a success and never
          // opened, so the publisher's users paid the full timeout on every call, indefinitely.
          // See `isIssuerUnreachable` for why the predicate is narrower than `outcome`.
          isFailure: isIssuerUnreachable,
        },
      );

      if (!outcome.ok) {
        return jsonResult({
          verified: false,
          outcome: 'unconfirmed',
          reason: outcome.tripped ? 'issuer_unreachable_cooldown' : 'verification_failed',
          message: outcome.tripped
            ? 'Recent checks against proof.holdings failed repeatedly, so this tool is not calling out for a short cooldown. This is NOT a negative verdict about the artifact.'
            : 'The verification could not be completed right now. This is NOT a negative verdict about the artifact.',
        });
      }

      const result = outcome.value;
      if (!result.valid) {
        return jsonResult({
          verified: false,
          outcome: result.outcome,
          reason: result.reason,
          message: result.message,
        });
      }

      // `expiresAt` comes from a token the verifier accepted on `typeof exp === 'number'` alone, so
      // an absurd `exp` yields an Invalid Date and `toISOString()` throws a RangeError straight out
      // of the tool handler — in the publisher's process. Only a token WE signed can reach here, so
      // the practical risk is nil. NOTE the asymmetry, deliberately recorded rather than smoothed
      // over: `mcp/src/tools/delegation-verify.ts` does NOT wrap the same call, so for the same
      // absurd `exp` that surface throws where this one answers `expires_at: null`. Wrapping is
      // the right behaviour for a package running inside someone else's process; the full server
      // is ours to crash.
      let expiresAt: string | null = null;
      try {
        expiresAt = result.delegation.expiresAt.toISOString();
      } catch {
        expiresAt = null;
      }

      return jsonResult({
        verified: true,
        status_checked: result.statusChecked,
        principal_checked: result.principalChecked,
        attests: `${result.delegation.principal} authorized ${result.delegation.delegate} for: ${result.delegation.scope.join(', ')}`,
        delegation: {
          issuer: result.delegation.issuer,
          principal: result.delegation.principal,
          delegate: result.delegation.delegate,
          scope: result.delegation.scope,
          delegation_id: result.delegation.delegationId,
          expires_at: expiresAt,
        },
        disclaimer:
          'This attests domain authorization of the artifact only. It is not a statement that the artifact is safe, audited or endorsed.',
      });
    },
  );

  tool(
    'proof_connect',
    describeConnect(ctx.principal),
    {},
    async (): Promise<ToolResult> => jsonResult(await fetchConnectInfo(ctx.baseUrl, ctx.connectBreaker, ctx.markedFetch)),
  );
}
