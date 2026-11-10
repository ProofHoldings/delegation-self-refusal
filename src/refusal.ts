import { GATE_CONSTANTS } from './constants.js';
import { refusalCodeOf, UNRECOGNIZED_REFUSAL } from './reasons.js';

/** Refusal text of a gate refusal (`docs/mcp-delegation-gate-contract.md` § 9). */
export const REFUSAL_TEXTS = {
  details: 'proof.holdings/delegation',
  templates: {
    definitive:
      "Refused by Proof: {principal}'s authorization {phrase}. Retrying will not fix this. Details: {details}",
    key_revoked:
      "Refused by Proof: {principal}'s authorization is being re-signed under a new key. Retry in a few minutes. Details: {details}",
    reissue_unavailable:
      "Refused by Proof: {principal}'s authorization was re-signed; this server could not fetch it. Ask its publisher. Details: {details}",
  },
  phrases: {
    revoked: 'was revoked',
    suspended: 'is suspended',
    expired: 'has expired',
    unknown_delegation: 'is not on record',
    invalid: 'is not valid',
    malformed: 'is malformed',
    unsupported_version: 'uses an unsupported format',
    identifier_unverifiable: 'cannot be checked',
    identifier_mismatch: 'names another subject',
    superseded: 'was superseded',
    test_environment: 'was issued in test mode',
  },
  unknown_phrase: 'could not be confirmed',
} as const;

export const REDACTED = '[redacted]';

export interface Envelope {
  error: string;
  message: string;
  retryable: boolean;
}

export interface EnvelopeResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

export function boundText(value: string, limit: number): string {
  const points = [...value];
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : value;
}

export function redact(text: string, token: string | undefined): string {
  return token ? text.split(token).join(REDACTED) : text;
}

function lookup<T extends Record<string, string>>(table: T, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key as keyof T] : undefined;
}

export function refusalText(code: string, principal: string): string {
  const bounded = boundText(principal, GATE_CONSTANTS.principal_max_chars);
  const template = lookup(REFUSAL_TEXTS.templates, code) ?? REFUSAL_TEXTS.templates.definitive;
  const phrase = lookup(REFUSAL_TEXTS.phrases, code) ?? REFUSAL_TEXTS.unknown_phrase;
  return template
    .split('{principal}')
    .join(bounded)
    .split('{phrase}')
    .join(phrase)
    .split('{details}')
    .join(REFUSAL_TEXTS.details);
}

export function refusalEnvelope(code: string, principal: string, token?: string): Envelope {
  const { error, retryable } = refusalCodeOf(code);
  const text = refusalText(error === UNRECOGNIZED_REFUSAL ? UNRECOGNIZED_REFUSAL : code, principal);
  return { error, message: boundText(redact(text, token), GATE_CONSTANTS.message_max_chars), retryable };
}

export function envelopeResult(envelope: Envelope): EnvelopeResult {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true };
}
