/**
 * The Proof recognition paragraph, in its own module with ZERO external imports — same pattern as
 * `descriptions.ts`, and for the same reason: the issuer's drift suite imports and asserts the REAL
 * string rather than text-scanning for it.
 *
 * This is the "channel of first recognition" (`docs/brainstorm-results/active-showcase.md`, §
 * «Текст узнавания»): appended to `instructions` in the `initialize` response, so a model sees it
 * before it has asked about — or even seen — any tool. It is deliberately a DIFFERENT text from
 * `showcaseConsequence` in `descriptions.ts` (SC-11): same underlying risk, worded independently,
 * never built by concatenating one from the other.
 */
export function showcaseInstructionsParagraph(principal: string): string {
  return (
    `This server carries a Proof of Delegation from ${principal} — a signed attestation, ` +
    `revocable at any time, that ${principal} authorized it to run. Call \`proof_check_this_server\` ` +
    'to see whether that authorization currently holds, or `proof_verify_delegation` to check a ' +
    'different server or agent artifact before trusting it; neither call requires an API key. ' +
    `Treat a refused or unverifiable status as a reason not to trust this server's authority to ` +
    `act on ${principal}'s behalf.`
  );
}
