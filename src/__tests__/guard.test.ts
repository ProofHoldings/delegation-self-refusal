import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCache, writeCache } from '../cache.js';
import { guardDelegation, type McpServerLike } from '../guard.js';
import { MAX_GRACE_FAILURES } from '../schedule.js';

class FakeServer implements McpServerLike {
  _registeredTools: Record<string, unknown> = {};
  handlers: Record<string, (...args: unknown[]) => unknown> = {};

  tool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
    this._registeredTools[name] = true;
    this.handlers[name] = handler;
    return { name };
  };

  // Mirrors the real SDK's second, independent registration entry point
  // (registerTool(name, config, cb) — mcp.js:701), which also populates _registeredTools.
  registerTool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
    this._registeredTools[name] = true;
    this.handlers[name] = handler;
    return { name };
  };
}

function stubFetchSequence(
  responses: Array<{ status: number; body: unknown }>,
): () => void {
  let i = 0;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function forceDue(dir: string, token: string): void {
  const entry = readCache(dir, token);
  if (!entry) throw new Error('forceDue called with no existing cache entry');
  writeCache(dir, token, { ...entry, lastCheckedAtMs: 0 });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-guard-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('guardDelegation — SC-9: throw when installed late', () => {
  it('throws when a tool was already registered before the gate runs', () => {
    const server = new FakeServer();
    server.tool('preexisting', 'desc', async () => ({ content: [] }));

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already registered/);
  });

  it('names the pre-existing tool in the error message', () => {
    const server = new FakeServer();
    server.tool('send_email', 'desc', async () => ({ content: [] }));

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/send_email/);
  });

  it('does not throw when installed before any registration', () => {
    const server = new FakeServer();
    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir }),
    ).not.toThrow();
  });
});

describe('guardDelegation — SC-7: opt-out with no token', () => {
  it('makes zero network calls and skips the SC-9 check when no token is configured', async () => {
    const server = new FakeServer();
    // A pre-existing registration would normally trip SC-9 — must NOT throw here, since the
    // gate is inert without a token.
    server.tool('preexisting', 'desc', async () => ({ content: [] }));

    let fetchCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('fetch must not be called when opted out');
    }) as unknown as typeof fetch;

    try {
      const tool = guardDelegation(server, { principal: 'example.com', artifactType: 'url', cacheDir: dir });
      tool('another', 'desc', async () => ({ content: [{ type: 'text', text: 'ran' }] }));
      const result = await server.handlers.another();
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchCalls).toBe(0);
  });
});

describe('guardDelegation — dispatch gating end-to-end', () => {
  it('lets the tool run when the delegation is valid', async () => {
    const restore = stubFetchSequence([{ status: 200, body: { valid: true } }]);
    try {
      const server = new FakeServer();
      const tool = guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir });
      tool('t', 'd', async () => ({ content: [{ type: 'text', text: 'ran' }] }));
      const result = await server.handlers.t();
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    } finally {
      restore();
    }
  });

  it('works identically for a purl artifact (SC-11)', async () => {
    const restore = stubFetchSequence([{ status: 200, body: { valid: true } }]);
    try {
      const server = new FakeServer();
      const tool = guardDelegation(server, { token: 'tok', principal: 'pkg:npm/example', artifactType: 'purl', cacheDir: dir });
      tool('t', 'd', async () => ({ content: [{ type: 'text', text: 'ran' }] }));
      const result = await server.handlers.t();
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    } finally {
      restore();
    }
  });

  it('refuses and never runs the handler when the delegation is revoked (SC-10)', async () => {
    const restore = stubFetchSequence([
      { status: 200, body: { valid: false, reason: 'revoked', message: 'This delegation has been revoked' } },
    ]);
    try {
      const server = new FakeServer();
      const tool = guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir });
      let ran = false;
      tool('t', 'd', async () => {
        ran = true;
        return { content: [] };
      });
      const result = (await server.handlers.t()) as { content: Array<{ text: string }>; isError: boolean };
      expect(ran).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('example.com');
      expect(result.content[0].text).toMatch(/was revoked/);
      expect(result.content[0].text).toMatch(/retrying will not fix this/i);
      // The wording itself is `refusal.test.ts`'s subject; what this case adds is that the gate
      // routes the verdict's own reason into it, rather than rendering one fixed string.
      expect(result.content[0].text).toContain('proof.holdings/delegation');
    } finally {
      restore();
    }
  });

  it('refuses on a cold start when the first poll is unresolved — no grace on a first run (SC-12)', async () => {
    const restore = stubFetchSequence([{ status: 503, body: {} }]);
    try {
      const server = new FakeServer();
      const tool = guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'purl', cacheDir: dir });
      tool('t', 'd', async () => ({ content: [{ type: 'text', text: 'ran' }] }));
      const result = (await server.handlers.t()) as { isError: boolean };
      expect(result.isError).toBe(true);
    } finally {
      restore();
    }
  });

  it('serves the cached valid verdict through MAX_GRACE_FAILURES unresolved polls, then refuses (SC-5, SC-6)', async () => {
    writeCache(dir, 'tok', { lastDecided: { kind: 'valid' }, lastCheckedAtMs: 0, consecutiveUnresolved: 0 });

    const server = new FakeServer();
    const tool = guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir });
    tool('t', 'd', async () => ({ content: [{ type: 'text', text: 'ran' }] }));

    const restore = stubFetchSequence([{ status: 503, body: {} }]);
    try {
      for (let i = 0; i < MAX_GRACE_FAILURES; i++) {
        const result = await server.handlers.t();
        expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
        forceDue(dir, 'tok');
      }

      const finalResult = (await server.handlers.t()) as { content: Array<{ text: string }>; isError: boolean };
      expect(finalResult.isError).toBe(true);
      // Exhausted grace is UNREACHABILITY, not a publisher decision — the branch that must never
      // send the reader to ask the publisher about something the publisher did not do.
      expect(finalResult.content[0].text).toMatch(/unreachable/i);
      expect(finalResult.content[0].text).toMatch(/not a decision by example\.com/i);
      expect(finalResult.content[0].text).not.toMatch(/contact/i);
    } finally {
      restore();
    }
  });
});

describe('guardDelegation — registerTool is gated too, not just tool (bypass fix)', () => {
  it('refuses a tool registered via server.registerTool when the delegation is revoked', async () => {
    const restore = stubFetchSequence([
      { status: 200, body: { valid: false, reason: 'revoked', message: 'This delegation has been revoked' } },
    ]);
    try {
      const server = new FakeServer();
      guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir });

      // Publisher uses registerTool directly, NOT the ToolRegistrar returned by guardDelegation —
      // the instance-level patch must still gate this call.
      let ran = false;
      server.registerTool('t', { description: 'd' }, async () => {
        ran = true;
        return { content: [] };
      });

      const result = (await server.handlers.t()) as { isError: boolean };
      expect(ran).toBe(false);
      expect(result.isError).toBe(true);
    } finally {
      restore();
    }
  });

  it('lets a registerTool-registered tool run when the delegation is valid', async () => {
    const restore = stubFetchSequence([{ status: 200, body: { valid: true } }]);
    try {
      const server = new FakeServer();
      guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir });

      server.registerTool('t', { description: 'd' }, async () => ({ content: [{ type: 'text', text: 'ran' }] }));
      const result = await server.handlers.t();
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    } finally {
      restore();
    }
  });

  it('SC-9 throw also covers a tool pre-registered via registerTool (shared _registeredTools)', () => {
    const server = new FakeServer();
    server.registerTool('preexisting', { description: 'd' }, async () => ({ content: [] }));

    expect(() =>
      guardDelegation(server, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir }),
    ).toThrow(/already registered/);
  });
});

describe('guardDelegation — a cache write failure never breaks the already-computed verdict', () => {
  it('still returns the freshly polled result when the cache directory cannot be written', async () => {
    // A file at this path makes mkdirSync(..., {recursive:true}) fail for any path nested under
    // it (ENOTDIR) — a stand-in for a read-only filesystem or a permission denial.
    const blockedPath = join(dir, 'blocked-not-a-directory');
    writeFileSync(blockedPath, 'not a directory', 'utf8');
    const unwritableCacheDir = join(blockedPath, 'nested', 'cache');

    const restore = stubFetchSequence([{ status: 200, body: { valid: true } }]);
    const originalConsoleError = console.error;
    let loggedFailure = false;
    console.error = (...args: unknown[]) => {
      if (String(args[0]).includes('failed to persist cache entry')) loggedFailure = true;
    };

    try {
      const server = new FakeServer();
      const tool = guardDelegation(server, {
        token: 'tok',
        principal: 'example.com',
        artifactType: 'url',
        cacheDir: unwritableCacheDir,
      });
      tool('t', 'd', async () => ({ content: [{ type: 'text', text: 'ran' }] }));

      const result = await server.handlers.t();
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
      expect(loggedFailure).toBe(true);
    } finally {
      console.error = originalConsoleError;
      restore();
    }
  });
});

describe('guardDelegation — SC-6: never touches `instructions` (that is installProofLayer\'s job)', () => {
  it('leaves a preset `server.server._instructions` byte-for-byte unchanged, token or not', () => {
    const withInstructions = (): FakeServer & { server: { _instructions: string } } =>
      Object.assign(new FakeServer(), { server: { _instructions: 'PUBLISHER TEXT, UNTOUCHED' } });

    const a = withInstructions();
    guardDelegation(a, { token: 'tok', principal: 'example.com', artifactType: 'url', cacheDir: dir });
    expect(a.server._instructions).toBe('PUBLISHER TEXT, UNTOUCHED');

    const b = withInstructions();
    guardDelegation(b, { principal: 'example.com', artifactType: 'url', cacheDir: dir });
    expect(b.server._instructions).toBe('PUBLISHER TEXT, UNTOUCHED');
  });
});
