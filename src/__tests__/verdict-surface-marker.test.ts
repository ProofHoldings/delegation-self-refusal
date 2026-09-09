import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { guardDelegation } from '../guard.js';
import { installProofLayer } from '../install.js';
import type { McpServerLike } from '../registrar.js';

/**
 * l-mcp-showcase-verdict-surface-marker SC-1: the verdict poll `currentVerdict` triggers via
 * `pollDelegationStatus` carries a surface marker ONLY when the installation went through
 * `installProofLayer` — `guardDelegation`'s poll must stay byte-identical to today (no header,
 * default global `fetch`). SC-6/SC-7 are exercised incidentally: the probe tool only returns its
 * "ran" body when the gate reads `valid`, so a broken verdict pipeline would fail these cases too.
 */

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

  registerTool = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
    this._registeredTools[name] = true;
    this.handlers[name] = handler;
    return { name };
  };
}

function stubValidFetch(): { restore: () => void; headersSeen: Headers[] } {
  const original = globalThis.fetch;
  const headersSeen: Headers[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headersSeen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    headersSeen,
  };
}

async function invokeProbe(server: FakeServer, tool: McpServerLike['tool']): Promise<unknown> {
  tool('probe', 'desc', async () => ({ content: [{ type: 'text', text: 'ran' }] }));
  return server.handlers.probe();
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-self-refusal-layer-surface-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verdict poll surface marker — SC-1', () => {
  it('a poll triggered through installProofLayer carries a layer/<version> surface header', async () => {
    const { restore, headersSeen } = stubValidFetch();
    try {
      const server = new FakeServer();
      const tool = installProofLayer(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
      });

      const result = (await invokeProbe(server, tool)) as { content: Array<{ text: string }> };
      expect(result.content[0].text).toBe('ran');

      expect(headersSeen.length).toBeGreaterThan(0);
      const value = headersSeen[0].get('X-Proof-Surface');
      expect(value).toBeTruthy();
      expect(value).toMatch(/^layer\//);
      expect(value).not.toMatch(/^showcase\//);
    } finally {
      restore();
    }
  });

  it('a poll triggered through guardDelegation carries no surface header at all', async () => {
    const { restore, headersSeen } = stubValidFetch();
    try {
      const server = new FakeServer();
      const tool = guardDelegation(server, {
        token: 'tok',
        principal: 'bitpulse.app',
        artifactType: 'url',
        cacheDir: dir,
      });

      const result = (await invokeProbe(server, tool)) as { content: Array<{ text: string }> };
      expect(result.content[0].text).toBe('ran');

      expect(headersSeen.length).toBeGreaterThan(0);
      expect(headersSeen[0].has('X-Proof-Surface')).toBe(false);
    } finally {
      restore();
    }
  });
});
