import { describe, expect, it } from 'vitest';

import { createBreaker } from '../showcase/breaker.js';
import { createMarkedFetch, SHOWCASE_SURFACE_HEADER } from '../showcase/marked-fetch.js';
import { fetchConnectInfo, OFFLINE_FALLBACK } from '../showcase/connect.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createMarkedFetch — SC-11: showcase calls are marked so the server can count them', () => {
  it('adds the surface header carrying the package version', async () => {
    let seen: Headers | undefined;
    const marked = createMarkedFetch('0.1.0', (async (_input: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse({});
    }) as unknown as typeof fetch);

    await marked('https://api.example.com/x', {});
    expect(seen?.get(SHOWCASE_SURFACE_HEADER)).toBe('showcase/0.1.0');
  });

  it('passes method, body and signal through untouched', async () => {
    const controller = new AbortController();
    let seenInit: RequestInit | undefined;
    const marked = createMarkedFetch('0.1.0', (async (_input: unknown, init?: RequestInit) => {
      seenInit = init;
      return jsonResponse({});
    }) as unknown as typeof fetch);

    await marked('https://api.example.com/x', {
      method: 'POST',
      body: '{"a":1}',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
    });

    expect(seenInit?.method).toBe('POST');
    expect(seenInit?.body).toBe('{"a":1}');
    expect(seenInit?.signal).toBe(controller.signal);
    expect(new Headers(seenInit?.headers).get('content-type')).toBe('application/json');
  });
});

describe('fetchConnectInfo — SC-6: live text, offline fallback, harmless on repeat', () => {
  it('returns the live payload with source "live" when the endpoint answers', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        message: 'live copy',
        install_command: 'npx -y @proof-holdings/mcp-server',
        docs_url: 'https://proof.holdings/docs/mcp',
      })) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);
    expect(result.source).toBe('live');
    expect(result.message).toBe('live copy');
  });

  it('falls back to the packaged text on a network failure and never throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);
    expect(result.source).toBe('offline_fallback');
    expect(result.install_command).toBe(OFFLINE_FALLBACK.install_command);
  });

  it('falls back on a non-2xx answer rather than serving the error body as copy', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 503)) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);
    expect(result.source).toBe('offline_fallback');
  });

  it('is harmless on repeat: two calls in a row return equal payloads and keep no state', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'live copy', install_command: 'x', docs_url: 'y' })) as unknown as typeof fetch;

    const breaker = createBreaker();
    const first = await fetchConnectInfo('https://api.proof.holdings', breaker, fetchImpl);
    const second = await fetchConnectInfo('https://api.proof.holdings', breaker, fetchImpl);
    expect(second).toEqual(first);
  });

  it('refuses to follow a redirect, and refuses an oversized body — this text becomes agent instructions', async () => {
    // Both postures are copied from `packages/delegation-verifier/src/status.ts`, and both are
    // assertions rather than comments because the failure they prevent is silent: the answer would
    // still be served to the agent as ours. `baseUrl` belongs to the publisher, so an open redirect
    // on it moves the read off the origin they configured.
    let seenRedirect: RequestRedirect | undefined;
    const redirectProbe = (async (_input: unknown, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return jsonResponse({ message: 'live copy', install_command: 'x', docs_url: 'y' });
    }) as unknown as typeof fetch;

    const ok = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), redirectProbe);
    expect(ok.source).toBe('live');
    expect(seenRedirect).toBe('error');

    const oversized = 'x'.repeat(70 * 1024);
    const hugeBody = (async () =>
      new Response(JSON.stringify({ message: oversized, install_command: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const refused = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), hugeBody);
    expect(refused.source).toBe('offline_fallback');
  });

  it('refuses on the DECLARED length too, before the body is transferred', async () => {
    // Its own case because the cap is TWO checks and the oversized-body case above reaches only
    // one: `new Response(JSON.stringify(...))` sets no `content-length`, so deleting the
    // pre-transfer branch left all 89 tests green — measured in review. This body is small and
    // perfectly valid; the ONLY thing that can refuse it is the declared-length check, which is
    // also the only one that refuses before buffering, the property its comment claims.
    const liesAboutLength = (async () =>
      new Response(JSON.stringify({ message: 'small', install_command: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '999999' },
      })) as unknown as typeof fetch;

    const refused = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), liesAboutLength);
    expect(refused.source).toBe('offline_fallback');

    // Positive control: the same tiny body with an HONEST length is served, so the case above
    // cannot be passing because something else refuses every response from this stub.
    const honest = (async () =>
      new Response(JSON.stringify({ message: 'small', install_command: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const served = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), honest);
    expect(served.source).toBe('live');
    expect(served.message).toBe('small');
  });

  it('serves the fallback without calling out at all once the breaker is open', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('down');
    }) as unknown as typeof fetch;

    const breaker = createBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    await fetchConnectInfo('https://api.proof.holdings', breaker, fetchImpl);
    await fetchConnectInfo('https://api.proof.holdings', breaker, fetchImpl);
    expect(calls).toBe(2);

    const tripped = await fetchConnectInfo('https://api.proof.holdings', breaker, fetchImpl);
    expect(calls).toBe(2);
    expect(tripped.source).toBe('offline_fallback');
  });
});

/**
 * The payload is whitelisted field by field on the way through, so a field the issuer adds does
 * NOT reach the agent until this function is taught to carry it. That is the right default — the
 * body becomes instructions in someone else's context — but it makes every issuer-side addition
 * silently inert here, which is exactly what happened to the remote-connection route: the backend
 * grew `remote_url`, `remote_config` and `install_caveat` (m-delegation-docs-publish SC-8), and
 * the showcase kept serving a payload that named only the npm package.
 */
describe('fetchConnectInfo — carries the remote-connection route through to the agent', () => {
  it('passes remote_url, remote_config and install_caveat from the live answer', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        message: 'live copy',
        remote_url: 'https://api.example.test/mcp',
        remote_config: { mcpServers: { proof: { type: 'http', url: 'https://api.example.test/mcp' } } },
        install_command: 'npx -y @proof-holdings/mcp-server',
        install_caveat: 'the published build lags',
        docs_url: 'https://proof.holdings/docs/mcp',
      })) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);

    expect(result.remote_url).toBe('https://api.example.test/mcp');
    expect(result.remote_config).toEqual({
      mcpServers: { proof: { type: 'http', url: 'https://api.example.test/mcp' } },
    });
    expect(result.install_caveat).toBe('the published build lags');
  });

  it('the packaged fallback names the remote route too, since that is the copy an offline agent reads', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);

    expect(result.source).toBe('offline_fallback');
    // A frozen copy cannot know the deployment it will be read next to, so it names the production
    // address — the same posture `docs_url` already takes in this object.
    expect(result.remote_url).toBe(OFFLINE_FALLBACK.remote_url);
    expect(typeof OFFLINE_FALLBACK.remote_url).toBe('string');
    expect(OFFLINE_FALLBACK.install_caveat).toContain('@proof-holdings/mcp-server');
  });

  it('omits the remote fields rather than inventing them when the issuer does not send them', async () => {
    // An older issuer deployment answers without these keys. Fabricating a URL here would point an
    // agent at a host that may not serve MCP at all; absence must stay absent.
    const fetchImpl = (async () =>
      jsonResponse({ message: 'live copy', install_command: 'x', docs_url: 'y' })) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);

    expect(result.source).toBe('live');
    expect(result.remote_url).toBeUndefined();
    expect(result.remote_config).toBeUndefined();
    expect(result.install_caveat).toBeUndefined();
  });
});

describe('fetchConnectInfo — carries no response timestamp into the agent\'s context', () => {
  it('drops updated_at even when an older issuer still sends it', async () => {
    // It was the issuer's response time, not a date for the content, so it read as a freshness claim
    // nothing backed (live review 2026-09-26, M12). The issuer no longer sends it; an older deployment
    // still may, and the whitelist is what keeps it out of the instructions an agent reads.
    const fetchImpl = (async () =>
      jsonResponse({ message: 'live copy', install_command: 'x', docs_url: 'y', updated_at: '2026-09-26T00:00:00.000Z' })) as unknown as typeof fetch;

    const result = await fetchConnectInfo('https://api.proof.holdings', createBreaker(), fetchImpl);

    expect(result.source).toBe('live');
    expect(result).not.toHaveProperty('updated_at');
  });
});
