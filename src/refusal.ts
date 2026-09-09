/**
 * What a refused tool call says.
 *
 * This gate is SILENT on success and speaks only when it refuses. Under `guardDelegation` alone,
 * that makes this string the first — often the only — thing a cold reader ever sees from Proof.
 * Under `installProofLayer` it is not: the showcase's own tool descriptions already name Proof and
 * the same revocation risk before any call is ever refused. Either way this string names Proof,
 * names the publisher, gives one short link, and gives ONE action that can actually resolve the
 * state it describes.
 *
 * The reason→phrase MAP is the load-bearing part, not decoration. `RefusedVerdict.reason` carries
 * two categorically different classes of fact and one template cannot tell them apart:
 *
 *   - the issuer ANSWERED and said no (`poll.ts` maps the `/proofs/validate` body straight
 *     through) — a decision, which retrying cannot change and which the publisher can explain;
 *   - `verdict.ts` gave up asking (`unresolved_at_startup`, `grace_exhausted`) — WE COULD NOT ASK,
 *     which is a connectivity failure wherever this server runs.
 *
 * Rendered identically, a publisher with blocked egress reads a message that looks exactly like a
 * real revocation, and the one action offered ("contact the publisher") sends them to ask about a
 * decision nobody made while the actual fault goes unmentioned.
 */

export const REFUSAL_DETAILS_URL = 'proof.holdings/delegation';

/**
 * Where the definitive-refusal wording comes from — the issuer answered and the answer was no.
 *
 * The last two are DEFENSIVE rather than reachable: `poll.ts` never sends an `identifier` (a
 * delegation has none to bind against), and the issuer emits `identifier_unverifiable` only when
 * one was supplied, `identifier_mismatch` only from the proof branch. They are carried because the
 * cost of a phrase is nothing and the cost of an unmapped reason is the fallback below, which is
 * deliberately vaguer than a mapped one.
 */
export const PUBLISHER_DECISION_REASONS = [
  'revoked',
  'suspended',
  'expired',
  'unknown_delegation',
  'invalid',
  'identifier_unverifiable',
  'identifier_mismatch',
] as const;

/**
 * Produced by `verdict.ts`, never by the issuer. Kept as its own list rather than as a `default`
 * arm, because the branch is defined by what it must NOT say.
 */
export const UNREACHABLE_REASONS = ['unresolved_at_startup', 'grace_exhausted'] as const;

export function isUnreachableRefusal(reason: string): boolean {
  return (UNREACHABLE_REASONS as readonly string[]).includes(reason);
}

/**
 * The lead sentence per reason. Each states WHAT happened in words a non-specialist reads
 * correctly on the first pass, and each definitive one carries "retrying will not fix this" —
 * the single instruction an agent needs in order to stop.
 */
const PUBLISHER_DECISION_LEADS: Record<string, (principal: string) => string> = {
  revoked: (principal) =>
    `${principal}'s authorization to run this was revoked, and Proof (proof.holdings) cannot ` +
    'confirm it as valid — retrying will not fix this.',
  suspended: (principal) =>
    `${principal}'s authorization to run this is paused, and Proof (proof.holdings) cannot ` +
    'confirm it as valid while the pause holds — retrying will not fix this.',
  expired: (principal) =>
    `${principal}'s authorization to run this has expired, and Proof (proof.holdings) cannot ` +
    'confirm it as valid — retrying will not fix this.',
  unknown_delegation: (principal) =>
    `Proof (proof.holdings) has no record of an authorization for ${principal} to run this, so ` +
    'it cannot be confirmed as valid — retrying will not fix this.',
  // Deliberately NOT "rejected … as invalid". `poll.ts` synthesises `reason: 'invalid'` when the
  // issuer answers `valid: false` with no reason string at all, so an attributed act here would be
  // manufactured from an absent field — the same over-claim the fallback below exists to avoid, one
  // arm over. "does not consider valid" is true whether the issuer named the reason or not.
  invalid: (principal) =>
    `Proof (proof.holdings) does not consider ${principal}'s authorization to run this valid — ` +
    'retrying will not fix this.',
  identifier_unverifiable: (principal) =>
    `Proof (proof.holdings) could not check ${principal}'s authorization to run this against the ` +
    'identifier it was asked to bind, so it cannot confirm it — retrying will not fix this.',
  identifier_mismatch: (principal) =>
    `${principal}'s authorization to run this names a different subject than the one it was ` +
    'checked against, so Proof (proof.holdings) cannot confirm it — retrying will not fix this.',
};

export const UNREACHABLE_LEADS: Record<string, (principal: string) => string> = {
  unresolved_at_startup: (principal) =>
    `Proof (proof.holdings) could not be reached to confirm ${principal}'s authorization to run ` +
    `this, so this call is refused rather than assumed — a connectivity failure here, not a ` +
    `decision by ${principal}.`,
  grace_exhausted: (principal) =>
    'Proof (proof.holdings) has been unreachable for several consecutive checks, so ' +
    `${principal}'s authorization to run this can no longer be confirmed — a connectivity ` +
    `failure here, not a decision by ${principal}.`,
};

/**
 * The issuer may introduce a reason this version has never heard of — `poll.ts` passes
 * `parsed.reason` through verbatim rather than validating it against a list, carving out exactly
 * ONE string (`status_unavailable`) as non-definitive. Everything else arrives here as a refusal.
 *
 * So the call is refused — an unrecognized verdict fails CLOSED everywhere else in this package —
 * but the SENTENCE claims less than a mapped one does. It deliberately omits "retrying will not fix
 * this": that phrase is a statement about a state this version cannot classify, and if the issuer's
 * new reason turns out to be transient, it is simply false. It names no act, and carries the reason
 * through so an operator can look it up — TRUNCATED past `MAX_ISSUER_REASON`, comfortably above
 * every code the issuer emits (the longest, `identifier_unverifiable`, is 23). ("raw" and "verbatim" stood here and in the README for one round after the bound
 * landed, and the note written to record that claimed BOTH were fixed while the README still
 * said verbatim — the same drift one file over, hidden by its own correction. Fixed the round
 * after that, by a reviewer who read the document instead of the note about it.)
 */
/**
 * Bounds on issuer-controlled text that reaches an agent's context, sized BY WHAT EACH BOUNDS.
 *
 * `poll.ts` accepts any string of any length for both `reason` and `message`, and whatever it
 * accepts lands in the caller's context. `showcase/connect.ts` already caps and refuses redirects
 * on its remote read for exactly the "this becomes instructions" reason; these paths had none.
 *
 * Two constants rather than one, and the split is not tidiness — one shared number was measured
 * doing real damage. `reason` is a CODE (longest the issuer emits: `identifier_unverifiable`, 23),
 * `message` is free-form PROSE, and `verdict.ts` writes its own 67-character sentence for
 * `grace_exhausted`. A single code-sized cap therefore truncated the one string in the whole
 * reachable set that is OURS, in the unreachable branch SC-6 exists to make legible. The package
 * already separates budgets this way (`SHOWCASE_TIMEOUT_MS` vs `SHOWCASE_PER_REQUEST_TIMEOUT_MS`).
 *
 * Both numbers are stated against the reachable set rather than chosen. Longest reason the issuer
 * emits: `identifier_unverifiable`, 23. Longest MESSAGE that can reach this package: 52
 * (`Invalid delegation token: unsupported schema version`, from the token-validation catch arm in
 * `controllers/proofs.ts` — an earlier version of this comment said 42, having enumerated only the
 * registry branches and missed the arm that emits `invalid`/`expired`). Ours: `grace_exhausted` at
 * 67, growing one character per 10× failure count. So the prose bound sits ~3× above anything
 * reachable.
 *
 * Pinned on both sides, but not where this comment first claimed: below ~68 the grace case reddens;
 * ABOVE, the ceiling is the whole-payload assertion (~450), not the per-field one — that field is a
 * function of the reason bound, not this one. Measured after a reviewer mutated the constant.
 */
export const MAX_ISSUER_REASON = 64;
export const MAX_ISSUER_MESSAGE = 200;

/**
 * Truncates by CODE POINT, not code unit: `slice` at a fixed index can cut a surrogate pair in half
 * and leave a lone surrogate in the output. Unreachable against our own issuer (its codes are ASCII)
 * — but this bound exists for the case of a hostile one, which is precisely the caller that would
 * send such a string deliberately.
 */
export function boundIssuerText(value: string, limit: number): string {
  // `wrapRegistrar`'s dispatch is an ALLOW-list precisely so a shape the return type does not admit
  // still refuses rather than runs — and that arm then calls through here. Spreading a non-string
  // throws, which would turn the fail-closed path's own refusal into a thrown error inside a
  // publisher's process: the defensive posture asserted in two places and implemented in one.
  if (typeof value !== 'string') return String(value);
  const points = [...value];
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : value;
}

function fallbackLead(principal: string, reason: string): string {
  const echoed = boundIssuerText(reason, MAX_ISSUER_REASON);
  return (
    `Proof (proof.holdings) cannot confirm ${principal}'s authorization to run this: it answered ` +
    `with a reason this version of the check does not recognise (${echoed}).`
  );
}

/**
 * Reads a lead WITHOUT inheriting one from `Object.prototype`.
 *
 * `reason` is network-derived and unvalidated — `poll.ts` passes the issuer's own string through
 * for every value except `status_unavailable` — so a plain `map[reason]` answered EVERY
 * `Object.prototype` member truthy. No count is written here: `refusal.test.ts` derives the set
 * from `Object.getOwnPropertyNames(Object.prototype)` and covers all of it, so a number typed in
 * this sentence could only ever disagree with the runtime. (It did: it read "eight".)
 * `constructor` rendered the principal and nothing else, `toString` produced
 * "[object Undefined] Details: …", and `valueOf` / `__proto__` threw a TypeError OUT of the gated
 * handler, inside someone else's production process, from the one code path whose entire job is to
 * say no gracefully. Measured against the built module, not reasoned about.
 *
 * `Object.hasOwn` is the same fix `web/src/app/(dashboard)/lookalike-watch/eligibility.ts` already
 * carries for the same reason ("a code of `constructor` would otherwise resolve to a function").
 */
function ownLead(
  map: Record<string, (principal: string) => string>,
  reason: string,
): ((principal: string) => string) | undefined {
  return Object.hasOwn(map, reason) ? map[reason] : undefined;
}

export function refusalMessage(principal: string, reason: string): string {
  if (isUnreachableRefusal(reason)) {
    // Read through a local, exactly like the decision branch below. `noUncheckedIndexedAccess` is
    // off in this package, so a reason added to UNREACHABLE_REASONS without a lead would compile
    // and then throw a TypeError out of a gated handler inside someone else's production process.
    // `refusal.test.ts` pins the pairing (added after a reviewer measured that it did not — a
    // third reason with no lead ran green), and this local is the runtime half of the same rule:
    // a behavioural pin is not a reason to let a gated handler throw in someone else's process.
    // Consequence worth knowing: this inline sentence is UNREACHABLE today, so it is the one piece
    // of refusal copy no test reads and no review round judged. On the day it fires it ships
    // unreviewed.
    const lead = ownLead(UNREACHABLE_LEADS, reason);
    return (
      `${
        lead
          ? lead(principal)
          : `Proof (proof.holdings) could not be reached to confirm ${principal}'s authorization ` +
            `to run this — a connectivity failure here, not a decision by ${principal}.`
      } Details: ${REFUSAL_DETAILS_URL}. ` +
      'Check outbound network access to proof.holdings from wherever this server runs.'
    );
  }

  const lead = ownLead(PUBLISHER_DECISION_LEADS, reason);
  return (
    `${lead ? lead(principal) : fallbackLead(principal, reason)} ` +
    `Details: ${REFUSAL_DETAILS_URL}. If this is unexpected, contact ${principal}.`
  );
}
