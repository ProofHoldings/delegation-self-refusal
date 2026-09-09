import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  REFUSAL_DETAILS_URL,
  isUnreachableRefusal,
  refusalMessage,
  PUBLISHER_DECISION_REASONS,
  UNREACHABLE_LEADS,
  UNREACHABLE_REASONS,
} from '../refusal.js';

const PRINCIPAL = 'bitpulse.app';

/**
 * The gate is SILENT on success and speaks only when it refuses. Under `guardDelegation` alone
 * that makes this string the first thing a cold reader ever sees from Proof; under
 * `installProofLayer` the showcase's own descriptions already speak first. Either way, every case
 * below is a property of this string itself, not of the mechanism — the mechanism is covered by
 * `guard.test.ts`.
 */
describe('refusalMessage — what a refused caller actually reads', () => {
  it.each(PUBLISHER_DECISION_REASONS)(
    'names Proof, the publisher, one link and one action for %s',
    (reason) => {
      const message = refusalMessage(PRINCIPAL, reason);

      expect(message).toContain('Proof (proof.holdings)');
      expect(message).toContain(PRINCIPAL);
      expect(message).toContain(REFUSAL_DETAILS_URL);
      // ONE action, and it is the one that can actually resolve a publisher-side decision.
      expect(message).toContain(`contact ${PRINCIPAL}`);
      expect(message).toMatch(/retrying will not fix this/i);
    },
  );

  /**
   * The single fact that must survive an agent summarising this sentence: WHICH domain lost its
   * authorization, and that it was lost rather than mistyped by the user. A shortened rendering
   * that keeps only "authorization error" has dropped the whole content.
   */
  it('keeps the word revoked for a revocation', () => {
    // The PHRASE, not the bare word: a template that merely interpolates the machine `reason`
    // contains "revoked" too, and would satisfy a bare-word assertion while saying nothing.
    expect(refusalMessage(PRINCIPAL, 'revoked')).toMatch(/was revoked/);
  });

  it('says a suspension is a pause rather than an ending', () => {
    const message = refusalMessage(PRINCIPAL, 'suspended');
    expect(message).toMatch(/is paused/i);
    expect(message).not.toMatch(/revoked/i);
  });

  it('says an expiry ran out rather than that anyone acted', () => {
    const message = refusalMessage(PRINCIPAL, 'expired');
    expect(message).toMatch(/has expired/i);
    expect(message).not.toMatch(/revoked/i);
  });

  it('reports an unknown delegation as an absent record, not as a rejection', () => {
    const message = refusalMessage(PRINCIPAL, 'unknown_delegation');
    expect(message).toMatch(/no record/i);
    expect(message).not.toMatch(/revoked/i);
  });

  /**
   * A map, not one template with the reason interpolated: the whole point of SC-6 is that these
   * states are DIFFERENT facts. If every arm produced the same sentence, every case above would
   * still pass while the reader learned nothing.
   */
  it('gives a distinct sentence per reason', () => {
    // The machine `reason` is STRUCK OUT before comparing. Without that, one template with the
    // reason interpolated into it produces N distinct strings and passes this case while every arm
    // says the identical thing — which is exactly the shape being replaced.
    const rendered = PUBLISHER_DECISION_REASONS.map((reason) =>
      refusalMessage(PRINCIPAL, reason).split(reason).join(''),
    );
    expect(new Set(rendered).size).toBe(PUBLISHER_DECISION_REASONS.length);
  });
});

/**
 * `unresolved_at_startup` and `grace_exhausted` are produced by `verdict.ts`, not by the issuer:
 * they mean WE COULD NOT ASK, not that the publisher said no. Telling that reader to contact the
 * publisher sends them to ask about a decision nobody made, while the actual fault — outbound
 * network access from wherever this server runs — goes unmentioned.
 */
describe('refusalMessage — the unreachable branch is not a publisher decision', () => {
  it.each(UNREACHABLE_REASONS)('does not tell the reader to contact the publisher for %s', (reason) => {
    const message = refusalMessage(PRINCIPAL, reason);

    expect(message).not.toMatch(/contact/i);
    // Retrying is exactly what MIGHT fix a connectivity failure, so the definitive-refusal line
    // must not appear here either.
    expect(message).not.toMatch(/retrying will not fix/i);
  });

  it.each(UNREACHABLE_REASONS)('names connectivity as the fault and Proof as unreached for %s', (reason) => {
    const message = refusalMessage(PRINCIPAL, reason);

    expect(message).toContain('Proof (proof.holdings)');
    expect(message).toMatch(/could not be reached|unreachable/i);
    expect(message).toMatch(/outbound network access/i);
    // States what it is NOT, because the reader's default reading of any refusal is "the publisher
    // lost their authorization" — the two are indistinguishable without this sentence.
    expect(message).toMatch(/not a decision by/i);
  });

  it('still names the publisher, so the reader knows which server is refusing', () => {
    expect(refusalMessage(PRINCIPAL, 'grace_exhausted')).toContain(PRINCIPAL);
  });

  /**
   * Every unreachable reason has its OWN lead. Without this, adding a reason to the list gets the
   * inline fallback — which satisfies every other assertion in this block (it contains "could not
   * be reached", "not a decision by" and the outbound-access line), so the addition passes with a
   * generic sentence where a specific one was intended. Measured: a third reason with no lead ran
   * green until this case existed.
   *
   * The publisher-decision half is pinned incidentally — `fallbackLead` deliberately omits
   * "retrying will not fix this", so a missing lead there reddens `it.each` above. This branch had
   * no such tell, and a comment in `refusal.ts` claimed it did.
   */
  it('gives every unreachable reason its own lead rather than the fallback', () => {
    for (const reason of UNREACHABLE_REASONS) {
      expect(UNREACHABLE_LEADS[reason]).toBeTypeOf('function');
    }
    expect(Object.keys(UNREACHABLE_LEADS).sort()).toEqual([...UNREACHABLE_REASONS].sort());
  });

  it('classifies the two branches disjointly', () => {
    for (const reason of UNREACHABLE_REASONS) {
      expect(isUnreachableRefusal(reason)).toBe(true);
    }
    for (const reason of PUBLISHER_DECISION_REASONS) {
      expect(isUnreachableRefusal(reason)).toBe(false);
    }
  });
});

/**
 * The issuer is free to introduce a reason this package has never heard of — `poll.ts` passes
 * `parsed.reason` through verbatim. The fallback must therefore refuse without inventing a story
 * about what happened.
 */
describe('refusalMessage — a reason this version has never seen', () => {
  it('carries the reason through, bounded, so the operator can look it up', () => {
    expect(refusalMessage(PRINCIPAL, 'some_future_reason')).toContain('some_future_reason');
  });

  it('does not claim the publisher revoked, paused or outlived anything', () => {
    const message = refusalMessage(PRINCIPAL, 'some_future_reason');
    expect(message).not.toMatch(/revoked|paused|expired|no record/i);
  });

  it('does not echo an unbounded issuer string into the caller\'s context', () => {
    // `poll.ts` accepts any string as `reason`, and this sentence is read by an agent. A hostile or
    // merely broken issuer could otherwise paste a page of text into that context through a field
    // nothing bounds.
    const long = 'x'.repeat(5000);
    const message = refusalMessage(PRINCIPAL, long);

    expect(message.length).toBeLessThan(600);
    expect(message).toContain('xxx');
    expect(message).toContain('…');
    // A short reason is still repeated whole — the bound must not cost the diagnostic value.
    expect(refusalMessage(PRINCIPAL, 'some_future_reason')).toContain('some_future_reason');
  });

  it('refuses without claiming to know the state is permanent', () => {
    // Refused, because everything except `status_unavailable` reaches this package as a definitive
    // answer and an unrecognized verdict fails closed. But NOT "retrying will not fix this": that
    // is a claim about a state this version cannot classify, and a future transient reason from
    // the issuer would make it false — the same over-claim the unreachable branch exists to avoid.
    expect(isUnreachableRefusal('some_future_reason')).toBe(false);
    const message = refusalMessage(PRINCIPAL, 'some_future_reason');
    expect(message).not.toMatch(/retrying will not fix/i);
    expect(message).toMatch(/does not recognise/i);
  });

  /**
   * `reason` is a NETWORK-DERIVED string with no allowlist — `poll.ts` passes the issuer's
   * `parsed.reason` through verbatim for every value except `status_unavailable`. So a reason that
   * happens to name an `Object.prototype` member reaches the lookup, and a plain object literal
   * answers it truthy:
   *
   *   'constructor' → a function, rendering the principal and nothing else
   *   'toString'    → "[object Undefined] Details: …"
   *   'valueOf'     → TypeError, thrown out of the gated handler in someone else's process
   *   '__proto__'   → TypeError: lead is not a function
   *
   * The four behaviours above were measured against the built module; the `it.each` below
   * derives its cases from the prototype itself, so it covers every member without naming a
   * count anywhere. The fallback the module documents as covering "a reason this version has
   * never heard of" covered NONE of the prototype members. Same defect the
   * dashboard's own lookalike-watch eligibility map fixed with `Object.hasOwn`.
   */
  // DERIVED from the prototype rather than hand-listed: a typed list covers whichever names its
  // author thought of (it was five of twelve), and the prose beside it then has to carry a count
  // nothing checks. Asking the runtime means the set is complete by construction and grows by
  // itself if a future engine adds a member.
  it('derives a non-empty prototype-member list to drive the cases below', () => {
    // Symmetry with the two reason lists' own anti-vacuity case. The language guarantees these
    // members exist, so this cannot fail today — which is the point: if it ever does, every case
    // below has silently stopped running rather than started failing.
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBeGreaterThan(5);
  });

  it.each(Object.getOwnPropertyNames(Object.prototype).map((name) => [name]))(
    'refuses %s like any other unrecognised reason instead of inheriting it',
    (reason) => {
      const message = refusalMessage(PRINCIPAL, reason);
      expect(message).toContain('Proof (proof.holdings)');
      expect(message).toContain(PRINCIPAL);
      expect(message).toContain(reason);
      expect(message).toMatch(/does not recognise/i);
    },
  );

  it('classifies a prototype-named reason as definitive, not as unreachability', () => {
    expect(isUnreachableRefusal('constructor')).toBe(false);
    expect(isUnreachableRefusal('toString')).toBe(false);
  });

  /**
   * Anti-vacuity for the two exported lists: an empty one would make every `it.each` above run zero
   * cases and report green.
   */
  it('has both reason lists populated', () => {
    expect(PUBLISHER_DECISION_REASONS.length).toBeGreaterThanOrEqual(5);
    expect(UNREACHABLE_REASONS.length).toBe(2);
  });
});

/**
 * The README quotes this text verbatim, and that quotation is what a publisher reads BEFORE
 * installing — the one place they meet the refusal without a refusal having happened. It rotted
 * once already: the block it replaced still showed the pre-map machine string long after the map
 * existed nowhere else, and nothing was red. Comparing the file against the live output is the only
 * thing that makes the document a claim rather than a memory.
 */
describe('the README shows what this module actually produces', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf-8');
  // The document wraps its examples across lines for width; the string does not.
  const flattened = readme.replace(/\s+/g, ' ');

  // Every reason the README quotes a block for. `unresolved_at_startup` is here because it was
  // MISSING: the first version pinned two of the three quoted blocks, and a reword of the third
  // left the suite green while the document quoted a string this module can no longer emit — the
  // same rot the pin exists to stop, surviving inside the pin's own blind spot.
  it.each([['revoked'], ['suspended'], ['grace_exhausted'], ['unresolved_at_startup']])(
    'quotes the real %s message',
    (reason) => {
      const real = refusalMessage('example.com', reason).replace(/\s+/g, ' ');
      expect(flattened).toContain(real);
    },
  );

  /**
   * The README also PARAPHRASES three reasons in one line instead of quoting them. That sentence
   * sat beside the verbatim pin and outside it, so rewording any of the three arms left it stale
   * with everything green — the rot the pin exists for, in the gap next to it.
   */
  it.each([
    ['expired', 'has expired'],
    ['unknown_delegation', 'no record'],
    ['invalid', 'does not consider'],
  ])('keeps its one-line paraphrase of %s true of the real lead', (reason, phrase) => {
    expect(refusalMessage('example.com', reason)).toContain(phrase);
    expect(flattened).toContain(phrase);
  });

  it('labels every quoted block with the reason it belongs to', () => {
    // The blocks differ in their lead clause, so one labelled as covering several reasons
    // describes a message the package never sends for all but one of them. That was the state
    // this document was in: a heading listing four reasons above a fence containing only the
    // `revoked` sentence, which reads as though a paused delegation tells the caller "revoked".
    for (const reason of ['revoked', 'suspended', 'grace_exhausted', 'unresolved_at_startup']) {
      expect(readme).toContain(`\`${reason}\``);
    }
  });
});
