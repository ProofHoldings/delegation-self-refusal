import { describe, expect, it } from 'vitest';

import { pollDelegationStatus } from '../poll.js';

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('pollDelegationStatus', () => {
  it('maps valid:true to a valid verdict', async () => {
    const fetchImpl = jsonFetch(200, { valid: true, token_type: 'delegation', proof_id: 'x' });
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'valid' });
  });

  it('maps a revoked answer to a refused verdict carrying the server reason', async () => {
    const fetchImpl = jsonFetch(200, {
      valid: false,
      reason: 'revoked',
      message: 'This delegation has been revoked',
    });
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({
      kind: 'refused',
      reason: 'revoked',
      message: 'This delegation has been revoked',
    });
  });

  it('maps status_unavailable to unresolved, not refused', async () => {
    const fetchImpl = jsonFetch(200, { valid: false, reason: 'status_unavailable' });
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'unresolved' });
  });

  it('maps a non-2xx response to unresolved', async () => {
    const fetchImpl = jsonFetch(503, { error: 'unavailable' });
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'unresolved' });
  });

  it('maps a network error to unresolved', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'unresolved' });
  });

  it('maps a malformed (non-JSON) body to unresolved', async () => {
    const fetchImpl = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'unresolved' });
  });

  it('sends proof_token only, never identifier — a delegation has none to bind', async () => {
    let sentBody: unknown;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await pollDelegationStatus('my-token', 'https://issuer.test', fetchImpl);
    expect(sentBody).toEqual({ proof_token: 'my-token' });
  });

  it('treats a truthy non-boolean `valid` as unresolved, not as valid:true', async () => {
    const fetchImpl = jsonFetch(200, { valid: 'yes' });
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'unresolved' });
  });

  it('treats a missing `valid` field as unresolved', async () => {
    const fetchImpl = jsonFetch(200, { token_type: 'delegation' });
    const result = await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(result).toEqual({ kind: 'unresolved' });
  });

  it('passes an AbortSignal to the fetch call so a hung backend does not block forever', async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await pollDelegationStatus('tok', 'https://issuer.test', fetchImpl);
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });
});
